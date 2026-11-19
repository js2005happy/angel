// src/hooks.ts — 确定性钩子层。
// 调研报告第 1 项：Hooks 确定性钩子层（学 Claude Code）。
// 区别于 CLAUDE.md / Skill 里的“请求，不保证执行”，钩子是事件发生了就一定执行：
// PreToolUse 返回退出码 2 即拦截该次工具调用，无论模型怎么想；钩子本身不占上下文。
// 缺口 19（2026-11-20）：事件从 4 个扩到 10 个（+ PermissionRequest、
// SubagentStart/Stop、Stop、PreCompact/PostCompact），handler 从仅 shell 扩到
// command / prompt / agent 三种；**失败语义从 fail-open 改为 fail-closed**——
// 阻塞型事件上钩子自身出错 / 超时 / 未接线一律拦截，不静默放行（不学 Goose 的
// fail-open）。只通知的事件（PostToolUse、SessionStart/End、SubagentStop、
// PostCompact）没有东西可拦，出错只警告、由 /status 诊断清单事后发现。
// 设计要点（见 docs/hooks.md）：默认不装任何钩子 = 零打扰、零性能损耗；
// 脚本拿不到任何密钥，只注入 NYRA_HOOK_EVENT / NYRA_HOOK_TOOL 两个只读变量。
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeToolName } from "./permissionRules.ts";

// 缺口 19：10 个事件。Claude Code 有 20+，Nyra 先补最常用的 6 个：
// PermissionRequest（审批前）、SubagentStart/Stop（委派前后）、Stop（模型想
// 结束时）、PreCompact/PostCompact（压缩前后）。
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "SessionStart"
  | "SessionEnd"
  | "PermissionRequest"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop"
  | "PreCompact"
  | "PostCompact";

// 调研报告第 1 项：Hooks 确定性钩子层（学 Claude Code）。
export const HOOK_EVENTS: HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "SessionEnd",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreCompact",
  "PostCompact",
];

/**
 * 缺口 19：阻塞型事件——钩子失败即阻塞（fail-closed）。
 * 其余 5 个是只通知事件：钩子出错只警告，不拦截（没东西可拦），失败由
 * /status 诊断清单事后发现。
 */
export const BLOCKING_HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PermissionRequest",
  "SubagentStart",
  "Stop",
  "PreCompact",
];

export function isBlockingHookEvent(event: HookEvent): boolean {
  return (BLOCKING_HOOK_EVENTS as readonly HookEvent[]).includes(event);
}

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

/**
 * 缺口 19：宽松决策解析——只用于 prompt/agent handler 的输出。
 * 小模型/子 agent 的输出常带一句说明再贴 JSON（如"核查完毕。\n{...}"），
 * 严格按整段解析会判"解析不出决策"而 fail-closed 拦截。宽松版先按整段
 * 解析，失败时从后往前找最后一个能解析出决策的配对 JSON 对象。
 * command hook 的 stdout 仍走严格的 parseHookStdout（既有测试锁定）。
 */
export function parseHookDecisionLoose(text: string): ReturnType<typeof parseHookStdout> {
  const strict = parseHookStdout(text);
  if (strict) return strict;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const parsed = parseHookStdout(text.slice(i, j + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

// ---- 缺口 19：三类 handler 与 matcher ----

/** 缺口 19：handler 种类。command 是原来的 shell 脚本；prompt 用小模型做一次核验；agent 派一个子 agent 做复杂核验。 */
export type HookHandlerKind = "command" | "prompt" | "agent";

/**
 * 缺口 19：config.json 里 hooks.<Event> 数组的一项。
 * 字符串 = 老写法，等价于 { type: "command", command: "<路径>" }。
 * 对象写法：
 * ```json
 * { "type": "prompt", "prompt": "检查这次调用是否合规，只输出 JSON 决策", "model": "deepseek-flash", "tools": ["shell"] }
 * { "type": "agent", "prompt": "核查子任务的改动是否越权", "max_turns": 3 }
 * { "type": "command", "command": "/abs/check.sh", "tools": ["write_file", "edit_file"] }
 * ```
 * `tools` 是 matcher：只对列出的工具生效（`*`/`?` 通配，如 `write_*`）；
 * 不写 = 对该事件的全部调用生效。没有 tool 的事件（Stop、PreCompact 等）
 * 上带 matcher 的条目永远匹配不上，/status 会把它报出来。
 */
export type HookEntry =
  | string
  | {
      type?: string;
      command?: string;
      path?: string;
      prompt?: string;
      model?: string;
      max_turns?: number;
      tools?: string | string[];
    };

/** 缺口 19：解析后的一条钩子（含来源标注，供 runHooks 与 /status 共用）。 */
export interface HookEntryRef {
  event: HookEvent;
  kind: HookHandlerKind | "invalid";
  /** 人类可读的来源：目录脚本是绝对路径；config 条目是 `config:hooks.<Event>[i]`。 */
  label: string;
  /** command handler 的脚本路径（prompt/agent handler 为 undefined）。 */
  path?: string;
  /** prompt/agent handler 的提示词。 */
  prompt?: string;
  /** prompt/agent handler 要求用的模型（不写时调用方用便宜模型或主模型）。 */
  model?: string;
  /** agent handler 的最大轮数（不写时默认 3）。 */
  maxTurns?: number;
  /** matcher：只对这些工具生效的 glob 列表（不写 = 全部）。 */
  tools?: string[];
  /** kind 为 invalid 时的解析失败原因。 */
  invalidReason?: string;
}

/**
 * 缺口 19：prompt/agent handler 的运行回调，由调用方（Agent）注入——hooks.ts
 * 本身不认识模型、不派子 agent，只定契约。回调返回核验者的原始文本输出，
 * 由 parseHookStdout 解析成决策；回调抛错 = handler 失败，阻塞型事件上
 * fail-closed。没有注入回调时 prompt/agent 条目按"未接线"处理（阻塞型事
 * 件上拦截、只通知事件上警告）。
 */
export type PromptHookRunner = (input: {
  prompt: string;
  model?: string;
  payload: Record<string, unknown>;
}) => Promise<string>;
export type AgentHookRunner = (input: {
  prompt: string;
  model?: string;
  maxTurns?: number;
  payload: Record<string, unknown>;
}) => Promise<string>;
export interface HookRunners {
  prompt?: PromptHookRunner;
  agent?: AgentHookRunner;
}

export interface RunHooksContext {
  tool?: string;
  args?: Record<string, unknown>;
  home: string;
  workdir: string;
  /** 单个脚本超时（毫秒），优先于 config.json 的 hooks.timeout_ms。 */
  timeoutMs?: number;
  /** 缺口 19：事件特有的附加载荷（如子任务 id、压缩前消息数），原样进 stdin JSON。 */
  extra?: Record<string, unknown>;
  /** 缺口 19：prompt/agent handler 的运行回调（Agent 注入；不传则未接线）。 */
  hookRunners?: HookRunners;
}

// 调研报告第 1 项：Hooks 确定性钩子层（学 Claude Code）。
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 2000;
/** 缺口 19：agent handler 默认最多 3 轮——核验不是做任务，轮数多了就是浪费。 */
const DEFAULT_AGENT_HOOK_TURNS = 3;

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(ms)));
}

interface HooksConfig {
  enabled: boolean;
  timeoutMs: number;
  explicit: Partial<Record<HookEvent, HookEntry[]>>;
  /** hooks 一节里写错的事件名（如 PreTool 拼错），供 /status 报出来。 */
  unknownEvents: string[];
}

/** 只读 config.json 里的 hooks 一节；缺文件 / 损坏时按默认值处理，绝不建文件、不抛错。 */
function readHooksConfig(home: string): HooksConfig {
  const defaults: HooksConfig = { enabled: true, timeoutMs: DEFAULT_TIMEOUT_MS, explicit: {}, unknownEvents: [] };
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
    unknownEvents: [],
  };
  for (const key of Object.keys(cfg)) {
    if (key === "enabled" || key === "timeout_ms") continue;
    if (!(HOOK_EVENTS as readonly string[]).includes(key)) {
      out.unknownEvents.push(key);
      continue;
    }
    const list = cfg[key];
    if (Array.isArray(list)) {
      out.explicit[key as HookEvent] = list.filter(
        (p): p is HookEntry => typeof p === "string" || (typeof p === "object" && p !== null && !Array.isArray(p)),
      );
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

/** 缺口 19：把 config 里的一条原始条目解析成 HookEntryRef；解析失败时 kind 为 invalid。 */
export function parseHookEntry(event: HookEvent, raw: HookEntry, label: string): HookEntryRef {
  const toolsOf = (v: unknown): string[] | undefined => {
    if (typeof v === "string") return v.trim() ? [v.trim()] : undefined;
    if (Array.isArray(v)) {
      const items = v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
      return items.length ? items : undefined;
    }
    return undefined;
  };
  if (typeof raw === "string") {
    if (!raw.trim()) return { event, kind: "invalid", label, invalidReason: "空路径" };
    return { event, kind: "command", label: resolveHookPath(raw.trim()), path: resolveHookPath(raw.trim()) };
  }
  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  const tools = toolsOf(raw.tools);
  if (type === "prompt" || (type === "" && typeof raw.prompt === "string" && raw.prompt.trim())) {
    if (typeof raw.prompt !== "string" || !raw.prompt.trim()) {
      return { event, kind: "invalid", label, invalidReason: "prompt handler 缺少 prompt" };
    }
    return {
      event,
      kind: "prompt",
      label,
      prompt: raw.prompt.trim(),
      ...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
      ...(tools ? { tools } : {}),
    };
  }
  if (type === "agent") {
    if (typeof raw.prompt !== "string" || !raw.prompt.trim()) {
      return { event, kind: "invalid", label, invalidReason: "agent handler 缺少 prompt" };
    }
    const maxTurns = typeof raw.max_turns === "number" && Number.isInteger(raw.max_turns) && raw.max_turns >= 1
      ? raw.max_turns
      : DEFAULT_AGENT_HOOK_TURNS;
    return {
      event,
      kind: "agent",
      label,
      prompt: raw.prompt.trim(),
      ...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
      maxTurns,
      ...(tools ? { tools } : {}),
    };
  }
  if (type === "command" || type === "") {
    const cmd = typeof raw.command === "string" ? raw.command : typeof raw.path === "string" ? raw.path : "";
    if (!cmd.trim()) return { event, kind: "invalid", label, invalidReason: "command handler 缺少 command/path" };
    return { event, kind: "command", label: resolveHookPath(cmd.trim()), path: resolveHookPath(cmd.trim()), ...(tools ? { tools } : {}) };
  }
  return { event, kind: "invalid", label, invalidReason: `未知 handler 类型：${raw.type}` };
}

/**
 * 缺口 19：列出全部钩子条目（目录 .sh 脚本 + config 显式条目），供 runHooks
 * 与 /status 共用。无效条目也列出（kind 为 invalid），调用方跳过并警告、
 * /status 报出来；无效条目不是"钩子失败"，不触发 fail-closed（它根本没跑）。
 */
export function listHookEntries(home: string): HookEntryRef[] {
  const config = readHooksConfig(home);
  const out: HookEntryRef[] = [];
  const seen = new Set<string>();
  const push = (ref: HookEntryRef): void => {
    const key = `${ref.event}\0${ref.kind}\0${ref.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ref);
  };
  for (const event of HOOK_EVENTS) {
    const dir = join(home, "hooks", `${event}.d`);
    try {
      if (existsSync(dir) && statSync(dir).isDirectory()) {
        for (const name of readdirSync(dir).sort()) {
          if (!name.endsWith(".sh")) continue;
          const full = join(dir, name);
          try {
            if (statSync(full).isFile()) push({ event, kind: "command", label: full, path: full });
          } catch {
            // 读不到的文件跳过，不破坏列表。
          }
        }
      }
    } catch {
      // 钩子目录读不到 = 当作没有钩子，不破坏主流程。
    }
    const explicit = config.explicit[event] ?? [];
    explicit.forEach((raw, i) => {
      push(parseHookEntry(event, raw, `config:hooks.${event}[${i}]`));
    });
  }
  return out;
}

/** 缺口 19：config 里写错的事件名（如把 PreToolUse 写成 PreTool），供 /status 报出。 */
export function listUnknownHookEvents(home: string): string[] {
  return readHooksConfig(home).unknownEvents;
}

// 调研报告第 1 项：Hooks 确定性钩子层（学 Claude Code）。
// 钩子位置：<home>/hooks/<Event>.d/ 下的 *.sh（按文件名排序）+ config.json
// hooks.<Event> 显式列出的脚本；两者都支持，目录方式优先写文档。
export function listHooks(home: string): { event: HookEvent; path: string }[] {
  const out: { event: HookEvent; path: string }[] = [];
  const seen = new Set<string>();
  for (const ref of listHookEntries(home)) {
    if (ref.kind !== "command" || !ref.path) continue;
    if (!seen.has(ref.path)) {
      seen.add(ref.path);
      out.push({ event: ref.event, path: ref.path });
    }
  }
  return out;
}

/** 缺口 19：matcher glob（`*` 任意串、`?` 单个字符），工具名不含 `/`，单段匹配就够。 */
export function matchHookTool(pattern: string, tool: string): boolean {
  let pi = 0, si = 0, star = -1, mark = 0;
  while (si < tool.length) {
    if (pi < pattern.length && (pattern[pi] === "?" || pattern[pi] === tool[si])) { pi++; si++; }
    else if (pi < pattern.length && pattern[pi] === "*") { star = pi++; mark = si; }
    else if (star !== -1) { pi = star + 1; si = ++mark; }
    else return false;
  }
  while (pi < pattern.length && pattern[pi] === "*") pi++;
  return pi === pattern.length;
}

/** 缺口 19：matcher 是否命中当前工具（无 matcher = 全命中；无 tool 的事件上 matcher 永远不命中；matcher 里的 Claude 风格名同样归一化，如 Bash → shell）。 */
export function hookEntryMatches(ref: HookEntryRef, tool: string | undefined): boolean {
  if (!ref.tools) return true;
  if (tool === undefined) return false;
  return ref.tools.some((p) => {
    if (matchHookTool(p, tool)) return true;
    // 无通配符的纯名字先归一化再比（如 matcher 写 Bash，实际工具是 shell）。
    if (!/[*?]/.test(p) && matchHookTool(normalizeToolName(p), tool)) return true;
    return false;
  });
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
 * （GitHub Windows 运行器自带；用户机器没装 Git Bash 时 spawn 失败，按 runHooks
 * 的约定处理：阻塞型事件上 fail-closed 拦截、只通知事件上警告并跳过）。
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

// 缺口 19：fail-closed —— 阻塞型事件上钩子失败即拦截。
// 拦截约定（学 Claude Code，缺口 19 改为 fail-closed）：
//   退出码 2 = 拦截（仅阻塞型事件能拦截；只通知事件上退出码 2 也只记警告）；
//   退出码 0 + stdout JSON = 结构化决策（deny 拦截、ask 交回人工、allow 放行）；
//   其他非零退出码 / 超时 / 无法启动 / prompt-agent handler 未接线或抛错或
//   输出解析不出决策 = **钩子自身出错，阻塞型事件上拦截、只通知事件上警告**。
//   （0.5.1 及之前是 fail-open：钩子出错只警告、主流程继续；缺口 19 改为
//   fail-closed——坏了的钩子静默失效比拦住一次操作更危险，见 docs/hooks.md。）
export async function runHooks(event: HookEvent, ctx: RunHooksContext): Promise<HookResult> {
  // 全局开关：NYRA_HOOKS=0 关闭全部钩子。
  if (process.env.NYRA_HOOKS === "0") return { blocked: false };
  const config = readHooksConfig(ctx.home);
  if (!config.enabled) return { blocked: false };
  const entries = listHookEntries(ctx.home).filter((h) => h.event === event);
  // 默认不装任何钩子 = 零打扰、零性能损耗：没有钩子文件时直接返回，不 spawn 任何进程。
  if (entries.length === 0) return { blocked: false };
  const blocking = isBlockingHookEvent(event);
  const timeoutMs = clampTimeout(ctx.timeoutMs ?? config.timeoutMs);
  const payload = JSON.stringify({ event, tool: ctx.tool ?? null, args: ctx.args ?? {}, workdir: ctx.workdir, ...(ctx.extra ?? {}) });
  // fail-closed 时的拦截结果：reason 写清是谁、为什么拦（钩子失败也要写清失败原因）。
  const failClosed = (label: string, reason: string): HookResult => ({
    blocked: true,
    reason,
    hook: label,
    decision: { decision: "deny", reason, hook: label },
  });
  let decision: HookDecision | undefined;
  let updatedInput: Record<string, unknown> | undefined;
  for (const ref of entries) {
    if (ref.kind === "invalid") {
      warn(`钩子配置无效（${ref.label}：${ref.invalidReason ?? "格式错误"}），已跳过；用 /status 查看`);
      continue;
    }
    if (!hookEntryMatches(ref, ctx.tool)) continue;
    if (ref.kind === "prompt" || ref.kind === "agent") {
      const runner = ref.kind === "prompt" ? ctx.hookRunners?.prompt : ctx.hookRunners?.agent;
      const runnerInput = {
        prompt: ref.prompt ?? "",
        ...(ref.model ? { model: ref.model } : {}),
        ...(ref.kind === "agent" && ref.maxTurns !== undefined ? { maxTurns: ref.maxTurns } : {}),
        payload: JSON.parse(payload) as Record<string, unknown>,
      };
      if (!runner) {
        const reason = `${ref.kind} handler 未接线（没有可用的模型回调），钩子无法核验`;
        if (blocking) return failClosed(ref.label, reason);
        warn(`钩子 ${ref.label}：${reason}，主流程继续`);
        continue;
      }
      let raw: string;
      try {
        raw = await runner(runnerInput);
      } catch (err: unknown) {
        const reason = `${ref.kind} handler 执行失败：${err instanceof Error ? err.message : String(err)}`;
        if (blocking) return failClosed(ref.label, reason);
        warn(`钩子 ${ref.label}：${reason}，主流程继续`);
        continue;
      }
      const parsed = parseHookDecisionLoose(raw);
      if (!parsed) {
        const reason = `${ref.kind} handler 输出解析不出决策（须输出 {"permissionDecision":"allow|deny|ask"}）`;
        if (blocking) return failClosed(ref.label, reason);
        warn(`钩子 ${ref.label}：${reason}，主流程继续`);
        continue;
      }
      // 只有 PreToolUse 有"入参"可改；其余事件的 updatedInput 忽略。
      if (event === "PreToolUse" && parsed.updatedInput) {
        updatedInput = { ...(updatedInput ?? {}), ...parsed.updatedInput };
      }
      if (parsed.decision) {
        const d: HookDecision = { decision: parsed.decision, reason: parsed.reason, hook: ref.label };
        decision = pickStricter(decision, d);
        if (parsed.decision === "deny") {
          return { blocked: true, reason: parsed.reason, hook: ref.label, decision: d };
        }
      }
      continue;
    }
    // command handler：跑脚本。
    const path = ref.path ?? "";
    const outcome = await runOneHook(path, payload, event, ctx.tool, timeoutMs);
    if (outcome.spawnError !== undefined) {
      const reason = `钩子无法启动（${outcome.spawnError}）`;
      if (blocking) return failClosed(path, reason);
      warn(`钩子 ${path} ${reason}，已跳过，主流程继续`);
      continue;
    }
    if (outcome.timedOut) {
      const reason = `钩子超时（>${timeoutMs} 毫秒）`;
      if (blocking) return failClosed(path, reason);
      warn(`钩子 ${path} ${reason}，已跳过，主流程继续`);
      continue;
    }
    if (outcome.code === 2) {
      const reason = firstLine(outcome.stdout) || firstLine(outcome.stderr) || "钩子未说明原因";
      const output = outcome.stdout.slice(0, MAX_OUTPUT_CHARS) || undefined;
      if (blocking) {
        return { blocked: true, reason, output, hook: path, decision: { decision: "deny", reason, hook: path } };
      }
      // 只通知事件：退出码 2 也不拦截，记一条警告并继续跑后面的钩子。
      warn(`钩子 ${path} 在 ${event} 返回退出码 2（${reason}），该事件不拦截，主流程继续`);
      continue;
    }
    if (outcome.code !== 0) {
      // Windows 上 .sh 脚本经 sh 启动：脚本不存在时 sh 本身能启动、只报退出码 127，
      // 不像 POSIX 那样直接 spawn 失败。脚本文件本身不存在 = 钩子从未启动，
      // 原因统一写成“无法启动”，三平台文案一致、诊断时一眼看清是脚本丢了；
      // 脚本存在但内部命令缺失同样退 127，那是钩子自身出错，仍走下面的分支。
      if (outcome.code === 127 && !existsSync(path)) {
        const reason = `钩子无法启动（脚本不存在：${path}）`;
        if (blocking) return failClosed(path, reason);
        warn(`钩子 ${path} ${reason}，已跳过，主流程继续`);
        continue;
      }
      const reason = `钩子退出码 ${outcome.code ?? "?"}（钩子自身出错）`;
      if (blocking) return failClosed(path, reason);
      warn(`钩子 ${path} ${reason}，已跳过，主流程继续`);
      continue;
    }
    // P0-4：退出码 0 时允许钩子用 stdout JSON 表达决策与参数改写。
    // 只有阻塞型事件的决策有意义（只通知事件没有"入参"可改，也不该放行/拦截）。
    if (!blocking) continue;
    const parsed = parseHookStdout(outcome.stdout);
    if (!parsed) continue;
    if (parsed.decision) {
      decision = pickStricter(decision, { decision: parsed.decision, reason: parsed.reason, hook: path });
    }
    if (event === "PreToolUse" && parsed.updatedInput) {
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
