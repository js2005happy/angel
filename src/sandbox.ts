// src/sandbox.ts — OS 级分级沙箱（隔离执行）。
// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI + Gemini CLI + OpenClaw）。
// 沙箱与审批拆成两轴：沙箱定“物理上能做什么”，审批定“何时问人”。
// 本文件只管沙箱这一轴：后端探测、后端解析、bwrap 命令行拼接、在 bwrap 内执行。
// 审批仍在 src/tools.ts 的 checkApproval 里，钩子（PreToolUse/PostToolUse）
// 仍在宿主机跑（src/hooks.ts），不在沙箱内——职责分工见 docs/sandbox.md。
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { seatbeltAvailable } from "./seatbelt.ts";
import { delimiter, join } from "node:path";

// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——三档模式。
// read-only：只读，任何写/执行/联网都要审批；
// workspace-write：默认，工作区内可读写跑命令，出工作区写与联网被挡住；
// danger-full-access：无限制，不推荐，与沙箱互斥（见 buildBwrapArgs）。
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——后端选择。
// auto：Linux 且有 bwrap 时用 bwrap，否则工具级；local：显式只要工具级；
// bwrap：强制 bwrap，缺失即 fail-closed 报错；e2b：0.5.1 暂不支持。
export type SandboxBackend = "auto" | "local" | "bwrap" | "seatbelt" | "e2b";

export const SANDBOX_MODES: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
export const SANDBOX_BACKENDS: readonly SandboxBackend[] = ["auto", "local", "bwrap", "seatbelt", "e2b"];

export type SandboxLevel = "bwrap" | "seatbelt" | "tool-level" | "none";

export interface SandboxStatus {
  backend: string;
  mode: SandboxMode;
  bwrapAvailable: boolean;
  level: SandboxLevel;
  detail: string;
}

export interface ResolvedSandbox {
  /** 生效的后端（auto 已解析为 bwrap 或 local）。 */
  backend: "bwrap" | "seatbelt" | "local";
  /** 用户原始选择（auto/local/bwrap/seatbelt），用于提示文案。 */
  requested: SandboxBackend;
  mode: SandboxMode;
  level: SandboxLevel;
  allowNet: boolean;
  bwrapAvailable: boolean;
  /** macOS 上 sandbox-exec 是否可用（其他平台恒 false）。 */
  seatbeltAvailable?: boolean;
}

/** bwrap 不可用时抛出的错误：调用方据此降级或 fail-closed，绝不静默裸奔。 */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/** bwrap 安装指引（fail-closed 报错里复用，doctor 与文档也用同一句话）。 */
export const BWRAP_INSTALL_HINT =
  "安装 bwrap：Debian/Ubuntu 用 sudo apt install bubblewrap；Fedora 用 sudo dnf install bubblewrap；Arch 用 sudo pacman -S bubblewrap；或改回 --sandbox auto（无 bwrap 时自动用工具级隔离）或 --sandbox local（显式只要工具级隔离）。";

/** 读 NYRA_<name>，旧 ANGEL_<name> 作回退（与 src/config.ts 的 envVar 同语义）。 */
function sandboxEnv(name: string): string | undefined {
  return process.env["NYRA_" + name] || process.env["ANGEL_" + name] || undefined;
}

function envFlagOn(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}

// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——bwrap 探测。
// 只在 Linux 上找：遍历 PATH 查 bwrap 可执行文件（`which` 思路，查可执行位）；
// Windows/macOS 直接返回 false（本机 macOS/Windows 没有 bwrap，OS 级 Seatbelt 后续再接）。
export function detectBwrap(pathEnv?: string): boolean {
  if (process.platform !== "linux") return false;
  const pathValue = pathEnv ?? process.env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "bwrap");
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return true;
    } catch { /* 不存在或不可读就继续找下一个 PATH 目录 */ }
  }
  return false;
}

/** 解析沙箱模式：显式值 > NYRA_SANDBOX_MODE 环境变量 > config.sandbox_mode > 默认 workspace-write。 */
export function resolveSandboxMode(config?: Record<string, unknown> | null): SandboxMode {
  const raw = sandboxEnv("SANDBOX_MODE") ?? (config?.sandbox_mode as string | undefined) ?? "workspace-write";
  if (!(SANDBOX_MODES as readonly string[]).includes(raw)) {
    throw new Error(`Invalid sandbox_mode: ${raw}. Valid modes: ${SANDBOX_MODES.join(", ")}`);
  }
  return raw as SandboxMode;
}

/** 解析是否放开网络：NYRA_SANDBOX_ALLOW_NET=1 > config.sandbox_allow_net > 默认 false（断网）。 */
export function resolveSandboxAllowNet(config?: Record<string, unknown> | null): boolean {
  const fromEnv = envFlagOn(sandboxEnv("SANDBOX_ALLOW_NET"));
  if (fromEnv !== undefined) return fromEnv;
  return (config?.sandbox_allow_net as boolean | undefined) === true;
}

// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——后端解析（本项的核心决定）。
// 优先级：显式 flag 参数 > NYRA_SANDBOX / ANGEL_SANDBOX 环境变量 > config.sandbox > 默认 auto。
// auto：Linux 且 bwrap 可用 → bwrap；否则 → 工具级（现有 workspace containment + shell 黑名单）。
// local：显式只要工具级，即使用户机器上有 bwrap 也不用——这是退出 OS 沙箱的开关。
// bwrap：强制要求 bwrap；找不到或非 Linux → 直接抛错（fail-closed），绝不静默降级。
// e2b：保持不支持报错（文案写目标版本 0.5.1；VERSION 常量本身不动，总协调最后统一升版）。
// danger-full-access 与沙箱互斥：显式 bwrap + danger 直接抛错；auto + danger 解析为工具级。
export function resolveSandboxBackend(
  config?: Record<string, unknown> | null,
  flag?: string | null,
): ResolvedSandbox {
  const cfg = config ?? {};
  const raw = flag ?? sandboxEnv("SANDBOX") ?? (cfg.sandbox as string | undefined) ?? "auto";
  if (!(SANDBOX_BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(`Invalid sandbox backend: ${raw}. Valid backends: ${SANDBOX_BACKENDS.join(", ")}`);
  }
  const requested = raw as SandboxBackend;
  const mode = resolveSandboxMode(cfg);
  const allowNet = resolveSandboxAllowNet(cfg);
  const bwrapAvailable = detectBwrap();

  if (requested === "e2b") {
    throw new Error("--sandbox e2b 在 0.5.1 暂不支持（Python 已移除，Node 版 E2B 后端尚未移植）；当前只支持 auto、local、bwrap");
  }
  if (requested === "bwrap" && mode === "danger-full-access") {
    throw new Error("danger-full-access 与沙箱互斥：该模式要求无限制执行，不能进 bwrap；如需无限制请用 --sandbox local 并自行承担风险");
  }
  if (requested === "bwrap") {
    if (process.platform !== "linux") {
      throw new Error(`--sandbox bwrap 只支持 Linux（当前平台 ${process.platform} 没有 bwrap）；请改回 --sandbox auto 或 --sandbox local`);
    }
    if (!bwrapAvailable) {
      throw new Error(`--sandbox bwrap 要求本机安装 bubblewrap，但 PATH 里找不到 bwrap。${BWRAP_INSTALL_HINT}`);
    }
    return { backend: "bwrap", requested, mode, level: "bwrap", allowNet, bwrapAvailable };
  }
  // P0-6：macOS Seatbelt（sandbox-exec）。与 bwrap 同款语义，只是实现换 SBPL。
  if (requested === "seatbelt") {
    if (process.platform !== "darwin") {
      throw new Error(`--sandbox seatbelt 只支持 macOS（当前平台 ${process.platform}）；请改回 --sandbox auto 或 --sandbox local`);
    }
    if (!seatbeltAvailable()) {
      throw new Error("--sandbox seatbelt 要求 /usr/bin/sandbox-exec，但本机找不到它；请改回 --sandbox auto 或 --sandbox local");
    }
    if (mode === "danger-full-access") {
      throw new Error("danger-full-access 与沙箱互斥：该模式要求无限制执行，不能进 Seatbelt；如需无限制请用 --sandbox local 并自行承担风险");
    }
    return { backend: "seatbelt", requested, mode, level: "seatbelt", allowNet, bwrapAvailable, seatbeltAvailable: true };
  }
  if (requested === "local") {
    return { backend: "local", requested, mode, level: "tool-level", allowNet, bwrapAvailable };
  }
  // auto：danger-full-access 显式要无限制，不强制进沙箱，落到工具级。
  if (mode === "danger-full-access") {
    return { backend: "local", requested, mode, level: "tool-level", allowNet, bwrapAvailable };
  }
  if (process.platform === "linux" && bwrapAvailable) {
    return { backend: "bwrap", requested, mode, level: "bwrap", allowNet, bwrapAvailable };
  }
  // P0-6：macOS 上 auto 优先用 Seatbelt（系统自带，不需要额外安装）。
  if (process.platform === "darwin" && seatbeltAvailable()) {
    return { backend: "seatbelt", requested, mode, level: "seatbelt", allowNet, bwrapAvailable, seatbeltAvailable: true };
  }
  return { backend: "local", requested, mode, level: "tool-level", allowNet, bwrapAvailable };
}

/** auto 回落到工具级时，在 doctor 与首次 shell 执行时给一次的提示文案。 */
export function toolLevelFallbackNotice(status: ResolvedSandbox | SandboxStatus): string {
  return `沙箱提示：当前是工具级隔离，不是 OS 沙箱（后端 ${status.backend}，模式 ${status.mode}；本机无 bwrap）。` +
    `工作目录内读写与审批、shell 黑名单仍生效，但命令在宿主机上跑，无内核级拦截；` +
    `出工作区写与联网仍由工具级规则拦。想用 OS 级沙箱请安装 bwrap：${BWRAP_INSTALL_HINT}`;
}

/** 给 doctor / CLI 用的状态快照：解析失败（显式 bwrap 缺失、e2b）也不抛错，level 记 none 并把原因写进 detail。 */
export function getSandboxStatus(
  config?: Record<string, unknown> | null,
  flag?: string | null,
): SandboxStatus {
  const bwrapAvailable = detectBwrap();
  let mode: SandboxMode = "workspace-write";
  try { mode = resolveSandboxMode(config); } catch { /* 模式非法时 doctor 仍要出状态，detail 里说明 */ }
  try {
    const resolved = resolveSandboxBackend(config, flag);
    const detail = resolved.level === "bwrap"
      ? `后端 ${resolved.requested} → bwrap（OS 级沙箱，bubblewrap 可用），模式 ${resolved.mode}，网络 ${resolved.allowNet ? "已放开" : "默认断开"}；出工作区写与联网会被挡住`
      : `${toolLevelFallbackNotice(resolved)}`;
    return { backend: resolved.backend, mode: resolved.mode, bwrapAvailable, level: resolved.level, detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      backend: (flag ?? (config?.sandbox as string | undefined) ?? "auto"),
      mode, bwrapAvailable, level: "none",
      detail: `沙箱配置未生效：${message}`,
    };
  }
}

// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——bwrap 命令行拼接。
// 工作目录可写（--bind），系统目录只读（--ro-bind，只挂真实存在的目录，
// 不存在的跳过，不让 bwrap 因缺目录启动失败），默认断网（--unshare-net，
// allowNet 时不加），--die-with-parent 保证父进程退出时沙箱一起死。
// read-only 模式工作目录也改 --ro-bind；danger-full-access 拒绝进 bwrap，直接抛错。
export function buildBwrapArgs(
  command: string,
  opts: { workdir: string; allowNet: boolean; mode: SandboxMode },
): string[] {
  if (opts.mode === "danger-full-access") {
    throw new Error("danger-full-access 与沙箱互斥：该模式要求无限制执行，不能进 bwrap；如需无限制请用 --sandbox local 并自行承担风险");
  }
  const args: string[] = ["bwrap"];
  if (!opts.allowNet) args.push("--unshare-net");
  args.push("--die-with-parent");
  // 只读挂载系统目录：只挂真实存在的，不存在的跳过。
  for (const dir of ["/usr", "/lib", "/lib64", "/bin", "/etc"]) {
    if (existsSync(dir)) args.push("--ro-bind", dir, dir);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  if (opts.mode === "read-only") args.push("--ro-bind", opts.workdir, opts.workdir);
  else args.push("--bind", opts.workdir, opts.workdir);
  args.push("--chdir", opts.workdir, "--", "/bin/sh", "-c", command);
  return args;
}

export interface RunSandboxedOptions {
  workdir: string;
  allowNet: boolean;
  mode: SandboxMode;
  /** 超时秒数，默认 60（与 shell 工具默认一致）。 */
  timeout?: number;
  /** 流式回显：每收到一块输出就回调（stream 为 stdout/stderr）。 */
  onStream?: (stream: "stdout" | "stderr", text: string) => void;
}

export interface RunSandboxedResult {
  code: number;
  stdout: string;
  stderr: string;
}

// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——在 bwrap 内实际执行命令。
// 无 bwrap 时抛 SandboxUnavailableError（调用方据此降级或 fail-closed，绝不静默裸奔）。
// spawn 写法复用 src/tools.ts 的 shell 执行：/bin/sh -c 跑命令、整进程组杀、超时处理。
export async function runSandboxed(
  command: string,
  opts: RunSandboxedOptions,
): Promise<RunSandboxedResult> {
  if (!detectBwrap()) {
    throw new SandboxUnavailableError(`bwrap 不可用，无法进入 OS 沙箱。${BWRAP_INSTALL_HINT}`);
  }
  const args = buildBwrapArgs(command, opts);
  const timeoutMs = (opts.timeout ?? 60) * 1000;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("bwrap", args.slice(1), {
      cwd: opts.workdir,
      detached: process.platform !== "win32",
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const finish = (value: RunSandboxedResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const killTree = (): void => {
      if (child.pid !== undefined && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* 回退到单进程 */ }
      }
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      setTimeout(() => {
        finish({ code: -1, stdout, stderr: stderr + `\n错误：沙箱内命令超时（${opts.timeout ?? 60} 秒）` });
      }, 1000);
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString("utf-8");
      stdout += text;
      try { opts.onStream?.("stdout", text); } catch { /* 回显失败不影响执行 */ }
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf-8");
      stderr += text;
      try { opts.onStream?.("stderr", text); } catch { /* 回显失败不影响执行 */ }
    });
    child.on("close", (code) => {
      if (timedOut) { finish({ code: -1, stdout, stderr: stderr + `\n错误：沙箱内命令超时（${opts.timeout ?? 60} 秒）` }); return; }
      finish({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      rejectPromise(new SandboxUnavailableError(`bwrap 启动失败：${err.message}。${BWRAP_INSTALL_HINT}`));
    });
  });
}
