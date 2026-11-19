// src/windowsSandbox.ts — P0-6：Windows Job Object 沙箱。
//
// 选型（Job Object vs AppContainer，取舍见 docs/sandbox.md）：
//   Job Object 能落地——纯 PowerShell + Add-Type P/Invoke 就能建作业、设限制、
//   把子进程接进去，不依赖原生模块；AppContainer 要建容器档案、配 capability
//   SID、走 STARTUPINFOEX，且默认拿不到用户文件（agent 要读写工作区），
//   不适合做默认后端。
// Job Object 只管进程生命周期与资源（随作业死、进程数上限、可选作业总内存上限），
// 不管文件/网络隔离——文件与网络仍由工具级规则（工作区 containment + shell
// 黑名单）兜底，文档里不夸大这一点。
//
// 本模块的划分与 seatbelt.ts 同款：脚本生成与探测是纯函数/只读（任何平台可单测），
// 真正的执行只在 runWindowsSandboxed 里 spawn PowerShell。
//
// 已知边界（写清楚，别让人以为它能替代容器）：
//   - 子进程先启动、再接进作业，中间有毫秒级窗口：启动瞬间 fork 出的子进程
//     理论上可能逃出作业；作业关柄时只杀作业内的进程
//   - 输出不是流式：子进程输出先落临时文件，命令结束时一次性返回
//     （onStream 不适用；tools.ts 的 jobobject 分支不传 onStream）
//   - 命令与工作目录走 Base64 进脚本，不存在引号转义问题；
//     CreateProcess 命令行约 32KB 上限，超长命令会启动失败并报错
//   - 未在真机 Windows 上跑过：本机是 Linux，靠 CI 的 Windows 任务验证
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type JobObjectMode = "read-only" | "workspace-write" | "danger-full-access";

export interface JobObjectOptions {
  mode: JobObjectMode;
  /** 工作目录（绝对路径）。命令以此为 cwd 跑。 */
  workdir: string;
  /** 同时存活进程上限（默认 64；0 表示不设）。 */
  maxProcesses?: number;
  /** 作业总内存上限 MB（默认不设；设了才生效）。 */
  maxMemoryMB?: number;
}

export interface WindowsSandboxRunOptions {
  workdir: string;
  mode: JobObjectMode;
  /** 超时秒数，默认 60（与 shell 工具默认一致）。 */
  timeout?: number;
  maxProcesses?: number;
  maxMemoryMB?: number;
}

export interface WindowsSandboxRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class WindowsSandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsSandboxUnavailableError";
  }
}

/** 在 PATH 里找 PowerShell：pwsh 优先，没有再找 powershell。非 win32 恒为 null。 */
export function findPowerShell(pathEnv?: string, platform: string = process.platform): string | null {
  if (platform !== "win32") return null;
  const pathValue = pathEnv ?? process.env.PATH ?? "";
  for (const name of ["pwsh.exe", "powershell.exe"]) {
    for (const dir of pathValue.split(/[;:]/)) {
      if (!dir) continue;
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate)) return name;
      } catch { /* 不存在或不可读就继续找下一个 PATH 目录 */ }
    }
  }
  return null;
}

/** Windows 上 PowerShell 是否可用（Job Object 后端的前提）。 */
export function windowsSandboxAvailable(pathEnv?: string): boolean {
  return findPowerShell(pathEnv) !== null;
}

/**
 * 生成 PowerShell 脚本（纯函数，可在任何平台单测）。
 *
 * 做法：Add-Type 内联 C# P/Invoke 调 kernel32 建 Job Object；
 * LimitFlags 固定带 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE（0x2000，作业关柄即全杀，
 * 孤儿进程不留）；maxProcesses > 0 时再加 JOB_OBJECT_LIMIT_ACTIVE_PROCESS（0x8）；
 * maxMemoryMB > 0 时再加 JOB_OBJECT_LIMIT_JOB_MEMORY（0x200，作业总内存上限）。
 * 子进程是 cmd.exe /c (<命令>)，输出重定向到临时文件（防管道死锁），
 * 等退出后一次性读回、按原退出码退出；finally 里删临时文件并关作业句柄。
 */
export function buildJobObjectScript(command: string, opts: JobObjectOptions): string {
  if (opts.mode === "danger-full-access") {
    throw new Error("danger-full-access 与沙箱互斥：该模式要求无限制执行，不能进 Job Object；如需无限制请用 --sandbox local 并自行承担风险");
  }
  const maxProcs = Math.max(0, Math.floor(opts.maxProcesses ?? 64));
  const maxMemBytes = Math.max(0, Math.floor(opts.maxMemoryMB ?? 0)) * 1024 * 1024;
  // 命令与工作目录走 Base64 进脚本：任意引号、$、反引号都不会破坏脚本结构。
  const cmdB64 = Buffer.from(command, "utf-8").toString("base64");
  const wdB64 = Buffer.from(opts.workdir, "utf-8").toString("base64");
  const lines: string[] = [
    "$ErrorActionPreference = \"Stop\"",
    `$cmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${cmdB64}"))`,
    `$workdir = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${wdB64}"))`,
    "Add-Type -TypeDefinition @\"",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class NyraJobObject {",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
    "  public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
    "  public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
    "  public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);",
    "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
    "  public static extern bool CloseHandle(IntPtr hObject);",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct BasicLimits {",
    "    public long PerProcessUserTimeLimit;",
    "    public long JobMemoryLimit;",
    "    public uint LimitFlags;",
    "    public UIntPtr MinimumWorkingSetSize;",
    "    public UIntPtr MaximumWorkingSetSize;",
    "    public uint ActiveProcessLimit;",
    "    public UIntPtr Affinity;",
    "    public uint PriorityClass;",
    "    public uint SchedulingClass;",
    "  }",
    "}",
    "\"@",
    "$job = [NyraJobObject]::CreateJobObject([IntPtr]::Zero, $null)",
    "if ($job -eq [IntPtr]::Zero) { throw \"CreateJobObject 失败\" }",
    "$limits = [NyraJobObject+BasicLimits]::new()",
    "$limits.LimitFlags = 0x2000",
    ...(maxProcs > 0
      ? ["$limits.LimitFlags = $limits.LimitFlags -bor 0x8", `$limits.ActiveProcessLimit = ${maxProcs}`]
      : []),
    ...(maxMemBytes > 0
      ? ["$limits.LimitFlags = $limits.LimitFlags -bor 0x200", `$limits.JobMemoryLimit = ${maxMemBytes}`]
      : []),
    "$size = [System.Runtime.InteropServices.Marshal]::SizeOf($limits)",
    "$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)",
    "try {",
    "  [System.Runtime.InteropServices.Marshal]::StructureToPtr($limits, $ptr, $false)",
    "  $ok = [NyraJobObject]::SetInformationJobObject($job, 2, $ptr, [uint32]$size)",
    "  if (-not $ok) { throw \"SetInformationJobObject 失败\" }",
    "} finally {",
    "  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)",
    "}",
    "$outFile = [System.IO.Path]::GetTempFileName()",
    "$errFile = [System.IO.Path]::GetTempFileName()",
    "$code = 0",
    "try {",
    "  $psi = New-Object System.Diagnostics.ProcessStartInfo",
    "  $psi.FileName = \"cmd.exe\"",
    "  $psi.Arguments = '/c (' + $cmd + ') > \"' + $outFile + '\" 2> \"' + $errFile + '\"'",
    "  $psi.WorkingDirectory = $workdir",
    "  $psi.UseShellExecute = $false",
    "  $psi.RedirectStandardOutput = $false",
    "  $psi.RedirectStandardError = $false",
    "  $psi.CreateNoWindow = $true",
    "  $p = New-Object System.Diagnostics.Process",
    "  $p.StartInfo = $psi",
    "  [void]$p.Start()",
    "  $assigned = [NyraJobObject]::AssignProcessToJobObject($job, $p.Handle)",
    "  if (-not $assigned) { try { $p.Kill() } catch {} ; throw \"AssignProcessToJobObject 失败\" }",
    "  $p.WaitForExit()",
    "  $code = $p.ExitCode",
    "  if (Test-Path $outFile) { [Console]::Out.Write([System.IO.File]::ReadAllText($outFile)) }",
    "  if (Test-Path $errFile) { [Console]::Error.Write([System.IO.File]::ReadAllText($errFile)) }",
    "} finally {",
    "  Remove-Item $outFile -ErrorAction SilentlyContinue",
    "  Remove-Item $errFile -ErrorAction SilentlyContinue",
    "  [void][NyraJobObject]::CloseHandle($job)",
    "}",
    "exit $code",
  ];
  return lines.join("\n");
}

/** 给 doctor 用的一行摘要。 */
export function describeJobObject(opts: JobObjectOptions): string {
  const mem = (opts.maxMemoryMB ?? 0) > 0 ? `，作业总内存上限 ${opts.maxMemoryMB}MB` : "";
  return `Job Object（PowerShell + kernel32），模式 ${opts.mode}，同时存活进程上限 ${opts.maxProcesses ?? 64}${mem}；不管文件与网络隔离，仍由工具级规则兜底`;
}

// ---- 执行：powershell -Command <脚本> ----
// 返回值形状与 sandbox.ts 的 RunSandboxedResult 一致，便于 tools.ts 复用同一个
// formatSandboxResult。失败（PowerShell 不在、spawn 失败）必须抛错——绝不静默裸奔。
export async function runWindowsSandboxed(
  command: string,
  opts: WindowsSandboxRunOptions,
): Promise<WindowsSandboxRunResult> {
  const ps = findPowerShell();
  if (!ps) {
    throw new WindowsSandboxUnavailableError(
      "Windows 上找不到 PowerShell（powershell.exe 或 pwsh.exe），无法使用 Job Object 沙箱；请改回 --sandbox auto 或 --sandbox local",
    );
  }
  const script = buildJobObjectScript(command, {
    mode: opts.mode, workdir: opts.workdir,
    maxProcesses: opts.maxProcesses, maxMemoryMB: opts.maxMemoryMB,
  });
  const timeoutMs = (opts.timeout ?? 60) * 1000;
  return new Promise<WindowsSandboxRunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      cwd: opts.workdir,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const finish = (value: WindowsSandboxRunResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* 已经退出 */ }
      setTimeout(() => {
        finish({ code: -1, stdout, stderr: stderr + `\n错误：沙箱内命令超时（${opts.timeout ?? 60} 秒）` });
      }, 1000);
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
    child.on("close", (code) => {
      if (timedOut) { finish({ code: -1, stdout, stderr: stderr + `\n错误：沙箱内命令超时（${opts.timeout ?? 60} 秒）` }); return; }
      finish({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      rejectPromise(new WindowsSandboxUnavailableError(`PowerShell 启动失败：${err.message}`));
    });
  });
}
