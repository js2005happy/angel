// src/hooks.ts — 确定性钩子层。
// 调研报告第 1 项：Hooks 确定性钩子层（学 Claude Code）。
// 区别于 CLAUDE.md / Skill 里的“请求，不保证执行”，钩子是事件发生了就一定执行：
// PreToolUse 返回退出码 2 即拦截该次工具调用，无论模型怎么想；钩子本身不占上下文。
// 设计要点（见 docs/hooks.md）：默认不装任何钩子 = 零打扰、零性能损耗；
// 钩子自身出错 / 超时一律 fail-open（警告 + 继续，绝不把主流程拖死）；
// 脚本拿不到任何密钥，只注入 NYRA_HOOK_EVENT / NYRA_HOOK_TOOL 两个只读变量。
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HookEvent = "PreToolUse" | "PostToolUse" | "SessionStart" | "SessionEnd";

// 调研报告第 1 项：Hooks 确定性钩子层（学 Claude Code）。
export const HOOK_EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse", "SessionStart", "SessionEnd"];

// 调研报告第 1 项：Hooks 确定性钩子层（学 Claude Code）。
export interface HookResult {
  blocked: boolean;
  reason?: string;
  output?: string;
  /** 拦截（或最后一次产出）时命中的钩子脚本绝对路径，便于报错时写明是谁拦的。 */
  hook?: string;
  /** P0-4：钩子在 stdout 里给出的决策（退出码 0 时的结构化约定）。 */
  decision?: HookDecision;
  /** P0-4：钩子要求改写本次工具入参（已合并后的结果）。 */
  updatedInput?: Record<string, unknown>;
}

/** P0-4：钩子的结构化决策，与 Claude Code 的 PreToolUse 输出契约对齐。 */
export type HookDecisionValue = "allow" | "deny" | "ask";

export interface HookDecision {
  decision: HookDecisionValue;
  reason?: string;
  /** 决策来自哪个钩子脚本（报错时回显）。 */
  hook?: string;
}

/** 优先级 deny > ask > allow —— 与 permissionRules 的求值次序保持一致。 */
const DECISION_RANK: Record<HookDecisionValue, number> = { deny: 3, ask: 2, allow: 1 };

/**
 * P0-4：解析钩子 stdout 的结构化决策。
 *
 * 约定（与 Claude Code 对齐）：
 * ```json
 * {"permissionDecision":"allow|deny|ask","permissionDecisionReason":"...","updatedInput":{"path":"..."}}
 * ```
 * 也接受平铺写法 `{"decision":...}`。任何解析失败（非 JSON、未知决策值、updatedInput
 * 不是对象）一律返回 null —— 钩子写错格式不能影响主流程，更不能被当成"放行"。
 */
export function parseHookStdout(stdout: string): {
  decision?: HookDecisionValue;
  reason?: string;
  updatedInput?: Record<string, unknown>;
} | null {
  const text = (stdout ?? "").trim();
  if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const decisionRaw = obj.permissionDecision ?? obj.decision;
  const decision = typeof decisionRaw === "string" && decisionRaw in DECISION_RANK
    ? (decisionRaw as HookDecisionValue)
    : undefined;
  const reasonRaw = obj.permissionDecisionReason ?? obj.reason;
  const reason = typeof reasonRaw === "string" ? reasonRaw : undefined;
  const updatedRaw = obj.updatedInput ?? obj.updated_input;
  const updatedInput = updatedRaw && typeof updatedRaw === "object" && !Array.isArray(updatedRaw)
    ? (updatedRaw as Record<string, unknown>)
    : undefined;
  if (!decision && !updatedInput) return null;
  return { ...(decision ? { decision } : {}), ...(reason ? { reason } : {}), ...(updatedInput ? { updatedInput } : {}) };
}

/** P0-4：多次决策按 deny > ask > allow 取最严；平级保留先到者（先声明者优先）。 */
export function pickStricter(current: HookDecision | undefined, next: HookDecision): HookDecision {
  if (!current) return next;
  return DECISION_RANK[next.decision] > DECISION_RANK[current.decision] ? next : current;
}

export interface RunHooksContext {
  tool?: string;
  args?: Record<string, unknown>;
  home: string;
  workdir: string;
  /** 单个脚本超时（毫秒），优先于 config.json 的 hooks.timeout_ms。 */
  timeoutMs?: number;
}

// 调研报告第 1 项：Hooks 确定性钩子层（学 Claude Code）。
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 2000;

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(ms)));
}

interface HooksConfig {
  enabled: boolean;
  timeoutMs: number;
  explicit: Partial<Record<HookEvent, string[]>>;
}

/** 只读 config.json 里的 hooks 一节；缺文件 / 损坏时按默认值处理，绝不建文件、不抛错。 */
function readHooksConfig(home: string): HooksConfig {
  const defaults: HooksConfig = { enabled: true, timeoutMs: DEFAULT_TIMEOUT_MS, explicit: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(home, "config.json"), "utf-8"));
  } catch {
    return defaults;
  }
  if (!raw || typeof raw !== "object") return defaults;
  const section = (raw as Record<string, unknown>).hooks;
  if (!section || typeof section !== "object" || Array.isArray(section)) return defaults;
  const cfg = section as Record<string, unknown>;
  const out: HooksConfig = {
    enabled: cfg.enabled !== false,
    timeoutMs: typeof cfg.timeout_ms === "number" ? clampTimeout(cfg.timeout_ms) : DEFAULT_TIMEOUT_MS,
    explicit: {},
  };
  for (const event of HOOK_EVENTS) {
    const list = cfg[event];
    if (Array.isArray(list)) {
      out.explicit[event] = list.filter((p): p is string => typeof p === "string");
    }
  }
  return out;
}

/** 展开 ~/ 开头的显式钩子路径；其余路径原样使用。 */
export function resolveHookPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// 调研报告第 1 项：Hooks 确定性钩子层（学 Claude Code）。
// 钩子位置：<home>/hooks/<Event>.d/ 下的 *.sh（按文件名排序）+ config.json
// hooks.<Event> 显式列出的脚本；两者都支持，目录方式优先写文档。
export function listHooks(home: string): { event: HookEvent; path: string }[] {
  const config = readHooksConfig(home);
  const out: { event: HookEvent; path: string }[] = [];
  const seen = new Set<string>();
  const push = (event: HookEvent, path: string): void => {
    if (!seen.has(path)) {
      seen.add(path);
      out.push({ event, path });
    }
  };
  for (const event of HOOK_EVENTS) {
    const dir = join(home, "hooks", `${event}.d`);
    try {
      if (existsSync(dir) && statSync(dir).isDirectory()) {
        for (const name of readdirSync(dir).sort()) {
          if (!name.endsWith(".sh")) continue;
          const full = join(dir, name);
          try {
            if (statSync(full).isFile()) push(event, full);
          } catch {
            // 读不到的文件跳过，不破坏列表。
          }
        }
      }
    } catch {
      // 钩子目录读不到 = 当作没有钩子，不破坏主流程。
    }
    for (const p of config.explicit[event] ?? []) push(event, resolveHookPath(p));
  }
  return out;
}

interface HookRunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** Windows 不能直接执行 .sh 脚本（CreateProcess 不认 shebang）：走 Git Bash 的 sh
 * （GitHub Windows 运行器自带；用户机器没装 Git Bash 时 spawn 失败，按 fail-open
 * 跳过并警告——钩子本就是 best-effort，见 runHooks 的约定）。
 * 非 .sh 的显式钩子（如 .bat/.cmd）仍直接 spawn，Node 在 Windows 上会走 cmd.exe。
 * POSIX 下直接执行，shebang 生效。 */
function hookSpawnCommand(script: string): { command: string; args: string[] } {
  if (process.platform === "win32" && /\.sh$/i.test(script)) {
    return { command: "sh", args: [toPosixPath(script)] };
  }
  return { command: script, args: [] };
}

/** C:\Users\x\y.sh → /c/Users/x/y.sh（MSYS/Git Bash 路径）；POSIX 路径原样返回。 */
export function toPosixPath(p: string): string {
  const slashed = p.replace(/\\/g, "/");
  const m = /^([A-Za-z]):\/(.*)$/.exec(slashed);
  if (m) return `/${m[1].toLowerCase()}/${m[2]}`;
  return slashed;
}

/** 跑单个钩子脚本：stdin 收一份 JSON，只注入两个只读环境变量，不透传进程环境（含密钥）。 */
function runOneHook(script: string, payload: string, event: HookEvent, tool: string | undefined, timeoutMs: number): Promise<HookRunOutcome> {
  return new Promise((resolvePromise) => {
    // 调研报告第 1 项：Hooks 确定性钩子层（学 Claude Code）。
    // 脚本拿不到任何密钥：只给 PATH（脚本自身要能跑命令）+ 两个只读变量，
    // 不把 process.env 整体透传过去。
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      NYRA_HOOK_EVENT: event,
      NYRA_HOOK_TOOL: tool ?? "",
    };
    let child;
    try {
      const { command, args } = hookSpawnCommand(script);
      child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err: unknown) {
      resolvePromise({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (outcome: HookRunOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // 杀不掉也照常按超时收尾，不阻塞。
      }
      // 进程被杀后 close 事件会到；再宽限 1 秒兜底，避免孤儿管道拖住。
      setTimeout(() => {
        // 孤儿孙子进程（如钩子里的 `sleep`）可能还攥着管道写端，close 迟迟
        // 不到：直接销毁管道，让主进程事件循环能排空——否则 /exit 或网关关停后
        // 进程要等孙子进程退出才退得出（超时本就只取已输出的内容，不再等新输出）。
        try { child.stdin?.destroy(); } catch { /* ignore */ }
        try { child.stdout?.destroy(); } catch { /* ignore */ }
        try { child.stderr?.destroy(); } catch { /* ignore */ }
        finish({ code: null, stdout: stdout.slice(0, MAX_OUTPUT_CHARS), stderr: stderr.slice(0, MAX_OUTPUT_CHARS), timedOut: true });
      }, 1000);
      // 注意：这里不立即 finish，等 close 事件先到可带回已输出的内容。
      // 若 close 迟迟不到，上面的兜底定时器会收尾。
      void 0;
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString("utf-8").slice(0, MAX_OUTPUT_CHARS - stdout.length);
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString("utf-8").slice(0, MAX_OUTPUT_CHARS - stderr.length);
    });
    child.on("error", (err: Error) => {
      finish({ code: null, stdout: stdout.slice(0, MAX_OUTPUT_CHARS), stderr: stderr.slice(0, MAX_OUTPUT_CHARS), timedOut, spawnError: err.message });
    });
    child.on("close", (code: number | null) => {
      finish({ code, stdout: stdout.slice(0, MAX_OUTPUT_CHARS), stderr: stderr.slice(0, MAX_OUTPUT_CHARS), timedOut });
    });
    try {
      // 脚本可能在读 stdin 前就退出（如立即 exit 2）：stdin 的 EPIPE 只当错误事件抛，
      // 必须先挂 error 处理器，否则会变成未捕获异常炸掉主流程。
      child.stdin?.on("error", () => { /* 钩子不等 stdin，直接按其退出码处理 */ });
      child.stdin?.end(payload);
    } catch {
      // stdin 写不进去时脚本会读到空输入，按钩子自身出错处理，不阻塞。
    }
  });
}

function warn(message: string): void {
  process.stderr.write(`警告：${message}\n`);
}

// 调研报告第 1 项：Hooks 确定性钩子层（学 Claude Code）。
// 拦截约定（学 Claude Code）：退出码 2 = 拦截（仅 PreToolUse 能拦截；
// PostToolUse / SessionStart / SessionEnd 只通知，退出码 2 也不拦截）；
// 其他非零退出码 = 钩子自身出错，不拦截、只记警告继续跑（fail-open）；
// 退出码 0 = 通过。超时按钩子出错处理（警告 + 继续，不拦截）。
export async function runHooks(event: HookEvent, ctx: RunHooksContext): Promise<HookResult> {
  // 全局开关：NYRA_HOOKS=0 关闭全部钩子。
  if (process.env.NYRA_HOOKS === "0") return { blocked: false };
  const config = readHooksConfig(ctx.home);
  if (!config.enabled) return { blocked: false };
  const hooks = listHooks(ctx.home).filter((h) => h.event === event);
  // 默认不装任何钩子 = 零打扰、零性能损耗：没有钩子文件时直接返回，不 spawn 任何进程。
  if (hooks.length === 0) return { blocked: false };
  const timeoutMs = clampTimeout(ctx.timeoutMs ?? config.timeoutMs);
  const payload = JSON.stringify({ event, tool: ctx.tool ?? null, args: ctx.args ?? {}, workdir: ctx.workdir });
  let decision: HookDecision | undefined;
  let updatedInput: Record<string, unknown> | undefined;
  for (const { path } of hooks) {
    const outcome = await runOneHook(path, payload, event, ctx.tool, timeoutMs);
    if (outcome.spawnError !== undefined) {
      warn(`钩子 ${path} 无法启动（${outcome.spawnError}），已跳过，主流程继续`);
      continue;
    }
    if (outcome.timedOut) {
      warn(`钩子 ${path} 超时（>${timeoutMs} 毫秒），已跳过，主流程继续`);
      continue;
    }
    if (outcome.code === 2) {
      const reason = firstLine(outcome.stdout) || firstLine(outcome.stderr) || "钩子未说明原因";
      const output = outcome.stdout.slice(0, MAX_OUTPUT_CHARS) || undefined;
      if (event === "PreToolUse") {
        return { blocked: true, reason, output, hook: path, decision: { decision: "deny", reason, hook: path } };
      }
      // 非 PreToolUse 事件只通知、不拦截：记一条警告并继续跑后面的钩子。
      warn(`钩子 ${path} 在 ${event} 返回退出码 2（${reason}），该事件不拦截，主流程继续`);
      continue;
    }
    if (outcome.code !== 0) {
      warn(`钩子 ${path} 退出码 ${outcome.code ?? "?"}（钩子自身出错），已跳过，主流程继续`);
      continue;
    }
    // P0-4：退出码 0 时允许钩子用 stdout JSON 表达决策与参数改写。
    // 只有 PreToolUse 的决策有意义（其余事件没有"入参"可改，也不该放行/拦截）。
    if (event !== "PreToolUse") continue;
    const parsed = parseHookStdout(outcome.stdout);
    if (!parsed) continue;
    if (parsed.decision) {
      decision = pickStricter(decision, { decision: parsed.decision, reason: parsed.reason, hook: path });
    }
    if (parsed.updatedInput) {
      updatedInput = { ...(updatedInput ?? {}), ...parsed.updatedInput };
    }
  }
  if (decision?.decision === "deny") {
    // 结构化 deny 与退出码 2 等价：阻止这次调用，并把原因带给模型。
    return { blocked: true, reason: decision.reason, hook: decision.hook, decision };
  }
  return {
    blocked: false,
    ...(decision ? { decision } : {}),
    ...(updatedInput ? { updatedInput } : {}),
  };
}
