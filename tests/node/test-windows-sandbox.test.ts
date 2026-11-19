// tests/node/test-windows-sandbox.test.ts — P0-6：Windows Job Object 沙箱。
// 脚本生成与探测是纯函数，任何平台可单测；真执行只在 Windows 上跑（CI 的
// windows-latest 任务覆盖），Linux/macOS 上跳过（与 test-sandbox.test.ts 同款写法）。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildJobObjectScript, findPowerShell, windowsSandboxAvailable,
  runWindowsSandboxed, describeJobObject,
} from "../../src/windowsSandbox.ts";
import {
  resolveSandboxBackend, getSandboxStatus, describeSandboxLevel, sandboxLevelText,
  SANDBOX_BACKENDS, toolLevelFallbackNotice,
} from "../../src/sandbox.ts";

test("WindowsSandbox.script_contains_job_object_setup", () => {
  const script = buildJobObjectScript("echo hello", { mode: "workspace-write", workdir: "C:\\work" });
  expect(script).toContain("CreateJobObject");
  expect(script).toContain("SetInformationJobObject");
  expect(script).toContain("AssignProcessToJobObject");
  expect(script).toContain("CloseHandle");
  // KILL_ON_JOB_CLOSE（0x2000）：作业关柄即全杀，孤儿进程不留。
  expect(script).toContain("0x2000");
  // 默认进程数上限 64（ACTIVE_PROCESS 0x8）。
  expect(script).toContain("0x8");
  expect(script).toContain("ActiveProcessLimit = 64");
  // 子进程走 cmd.exe，输出落临时文件（防管道死锁），结束时一次性返回。
  expect(script).toContain("cmd.exe");
  expect(script).toContain("GetTempFileName");
  expect(script).toContain("exit $code");
});

test("WindowsSandbox.script_command_base64_no_quoting_hole", () => {
  // 命令里带 $、单引号、双引号、反引号：走 Base64 进脚本，不存在引号转义问题。
  const cmd = `echo $HOME 'it''s' "a\\"b" \`tick\``;
  const script = buildJobObjectScript(cmd, { mode: "workspace-write", workdir: "C:\\work" });
  const b64 = Buffer.from(cmd, "utf-8").toString("base64");
  expect(script).toContain(b64);
  // 脚本里除了 Base64 负载，不应出现命令原文（说明没有拼进可执行位置）。
  expect(script).not.toContain("$HOME 'it");
  // 工作目录同样走 Base64。
  expect(script).toContain(Buffer.from("C:\\work", "utf-8").toString("base64"));
});

test("WindowsSandbox.script_memory_limit_opt_in", () => {
  const withMem = buildJobObjectScript("echo hi", { mode: "workspace-write", workdir: "C:\\w", maxMemoryMB: 512 });
  expect(withMem).toContain("$limits.LimitFlags = $limits.LimitFlags -bor 0x200");
  expect(withMem).toContain(`JobMemoryLimit = ${512 * 1024 * 1024}`);
  const withoutMem = buildJobObjectScript("echo hi", { mode: "workspace-write", workdir: "C:\\w" });
  expect(withoutMem).not.toContain("-bor 0x200");
  expect(withoutMem).not.toContain("JobMemoryLimit =");
});

test("WindowsSandbox.script_danger_rejected", () => {
  expect(() => buildJobObjectScript("echo hi", { mode: "danger-full-access", workdir: "C:\\w" }))
    .toThrow("danger-full-access 与沙箱互斥");
});

test("WindowsSandbox.find_powershell", () => {
  // 非 win32 恒为 null（本机是 Linux）。
  expect(findPowerShell()).toBeNull();
  expect(windowsSandboxAvailable()).toBe(false);
  // 假 PATH：只有平台参数传 win32 时才认。
  const dir = mkdtempSync(join(tmpdir(), "nyra-ps-"));
  writeFileSync(join(dir, "pwsh.exe"), "");
  expect(findPowerShell(dir, "win32")).toBe("pwsh.exe");
  expect(findPowerShell(dir, "linux")).toBeNull();
  const dir2 = mkdtempSync(join(tmpdir(), "nyra-ps2-"));
  writeFileSync(join(dir2, "powershell.exe"), "");
  expect(findPowerShell(dir2, "win32")).toBe("powershell.exe");
  expect(findPowerShell(join(tmpdir(), "nyra-no-such-dir-xyz"), "win32")).toBeNull();
});

test("WindowsSandbox.describe", () => {
  const text = describeJobObject({ mode: "workspace-write", workdir: "C:\\w" });
  expect(text).toContain("Job Object");
  expect(text).toContain("不管文件与网络");
  const mem = describeJobObject({ mode: "workspace-write", workdir: "C:\\w", maxMemoryMB: 256 });
  expect(mem).toContain("256MB");
});

test("WindowsSandbox.resolve_requires_windows", () => {
  expect(SANDBOX_BACKENDS).toContain("jobobject");
  if (process.platform !== "win32") {
    // “只支持 Windows”这个断言只在非 win32 上成立：win32 上平台检查通过，
    // 接下来是 PowerShell 可用性检查，抛的是“要求本机有 PowerShell”
    // （CI #88：原断言在 win32 上直接按后者报错）。
    expect(() => resolveSandboxBackend({}, "jobobject")).toThrow("--sandbox jobobject 只支持 Windows");
    // 非 Windows 上 getSandboxStatus 不抛错：level 记 none，原因写进 detail。
    const st = getSandboxStatus({}, "jobobject");
    expect(st.level).toBe("none");
    expect(st.detail).toContain("只支持 Windows");
    return;
  }
  // win32 上：PowerShell 一定存在（windows-latest 自带），应正常解析成功。
  const resolved = resolveSandboxBackend({}, "jobobject");
  expect(resolved.backend).toBe("jobobject");
  expect(resolved.level).toBe("jobobject");
});

test("WindowsSandbox.level_text_and_detail", () => {
  expect(sandboxLevelText("jobobject")).toBe("进程级沙箱（Job Object，不管文件与网络）");
  expect(sandboxLevelText("seatbelt")).toBe("OS 沙箱（Seatbelt）");
  expect(sandboxLevelText("bwrap")).toBe("OS 沙箱（bwrap）");
  expect(sandboxLevelText("tool-level")).toBe("工具级（非 OS 沙箱）");
  expect(sandboxLevelText("none")).toBe("未生效");
  // 各后端一句话状态（纯函数，macOS/Windows 才可达的分支也能单测）。
  const job = describeSandboxLevel({
    backend: "jobobject", requested: "jobobject", mode: "workspace-write",
    level: "jobobject", allowNet: false, bwrapAvailable: false, jobObjectAvailable: true,
  });
  expect(job).toContain("Job Object");
  expect(job).toContain("文件与网络隔离仍由工具级规则兜底");
  const sb = describeSandboxLevel({
    backend: "seatbelt", requested: "seatbelt", mode: "workspace-write",
    level: "seatbelt", allowNet: false, bwrapAvailable: false, seatbeltAvailable: true,
  });
  expect(sb).toContain("Seatbelt");
  expect(sb).not.toContain("工具级隔离");
  // 工具级回落提示：Windows 上不提 bwrap，提 Job Object。
  const notice = toolLevelFallbackNotice({
    backend: "local", mode: "workspace-write", bwrapAvailable: false, level: "tool-level", detail: "",
  });
  expect(notice).toContain("工具级隔离");
  if (process.platform === "win32") expect(notice).toContain("jobobject");
  else expect(notice).toContain("bwrap");
});

test("WindowsSandbox.run_echo_on_windows", async () => {
  if (process.platform !== "win32") { console.log("跳过：Job Object 只在 Windows"); return; }
  const workdir = mkdtempSync(join(tmpdir(), "nyra-job-"));
  const ok = await runWindowsSandboxed("echo hello-job", { workdir, mode: "workspace-write", timeout: 30 });
  expect(ok.code).toBe(0);
  expect(ok.stdout).toContain("hello-job");
  const fail = await runWindowsSandboxed("exit 3", { workdir, mode: "workspace-write", timeout: 30 });
  expect(fail.code).toBe(3);
});

test("WindowsSandbox.run_missing_powershell_throws", async () => {
  if (process.platform === "win32") { console.log("跳过：Windows 上 PowerShell 一定存在"); return; }
  await expect(runWindowsSandboxed("echo hi", { workdir: tmpdir(), mode: "workspace-write" }))
    .rejects.toThrow("找不到 PowerShell");
});
