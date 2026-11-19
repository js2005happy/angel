// src/evidenceAudit.ts — P1-2：证据链自洽审计（`nyra evidence verify <run-id>`）。
//
// 目标：拿到一份落盘的 run 记录，不用信任模型的话，也能判断"这次运行到底算不算完成"。
// 做法是**只读校验落盘证据的自洽性**，不重跑任何命令——重跑是另一件事（--replay），
// 而且重跑结果可能因环境变化而不同，不能用来否定当时的结论。
//
// 审计的核心是抓这几类"自相矛盾"：
//   1. 自称 verified，但没有通过记录（无 verify_cmd / exit_code≠0 / passed≠true）
//   2. 自称 verify_failed，但记录里 exit_code=0
//   3. 状态不在已知集合里（文件损坏或被手改）
//   4. 测试文件被改动 + 验证通过（怀疑"改测试凑绿灯"）
//   5. 时间戳倒挂（created_at > updated_at）
import { testsModified } from "./runs.ts";

export type AuditLevel = "ok" | "warn" | "fail";

export interface AuditFinding {
  level: AuditLevel;
  code: string;
  message: string;
}

export interface AuditResult {
  findings: AuditFinding[];
  /** 没有任何 fail 即视为通过（warn 不阻塞）。 */
  ok: boolean;
  /** 一句话结论，供 CLI 直接打印。 */
  verdict: string;
}

const KNOWN_STATUSES = new Set([
  "queued", "running", "awaiting_approval", "interrupted", "failed",
  "incomplete", "completed_unverified", "verified", "verify_failed",
]);

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 审计一份 run 状态。纯函数，不读文件、不跑命令——输入就是 `RunStore.load()` 的结果。
 */
export function auditRunState(rawState: unknown): AuditResult {
  const state = asRecord(rawState);
  const findings: AuditFinding[] = [];
  const add = (level: AuditLevel, code: string, message: string) => findings.push({ level, code, message });

  const status = typeof state.status === "string" ? state.status : "";
  const verifyCmd = typeof state.verify_cmd === "string" && state.verify_cmd.trim() ? state.verify_cmd.trim() : null;
  const verifyResult = asRecord(state.verify_result);
  const exitCode = num(verifyResult.exit_code);
  const passed = verifyResult.passed === true;
  const changed = Array.isArray(state.changed_files) ? state.changed_files.filter((p): p is string => typeof p === "string") : [];

  // 1) 状态合法性
  if (!status) add("fail", "status_missing", "运行记录里没有 status，文件可能损坏");
  else if (!KNOWN_STATUSES.has(status)) add("fail", "status_unknown", `未知状态 "${status}"，记录可能被手改`);

  // 2) 自称 verified 的三件套
  if (status === "verified") {
    if (!verifyCmd) add("fail", "verified_without_cmd", "状态是 verified，但没有记录验证命令");
    if (exitCode !== 0) add("fail", "verified_without_pass", `状态是 verified，但验证退出码是 ${exitCode === null ? "（缺失）" : exitCode}`);
    if (!passed) add("fail", "verified_without_flag", "状态是 verified，但 verify_result.passed 不是 true");
  }

  // 3) verify_failed 必须真的失败过
  if (status === "verify_failed") {
    if (!verifyCmd) add("warn", "failed_without_cmd", "状态是 verify_failed，但没有记录验证命令（可能来自人工中止）");
    else if (exitCode === 0) add("fail", "failed_but_pass", "状态是 verify_failed，但记录里退出码是 0——两份证据互相矛盾");
  }

  // 4) 未验证状态不该带通过记录（带了说明状态与证据不一致）
  if ((status === "completed_unverified" || status === "incomplete") && exitCode === 0 && passed) {
    add("warn", "unverified_but_pass", `状态是 ${status}，但验证记录显示通过——状态可能没更新`);
  }

  // 5) 改测试凑绿灯
  const modifiedTests = testsModified(changed);
  if (modifiedTests.length && (status === "verified" || passed)) {
    add("warn", "tests_modified", `验证通过，但测试文件被改动：${modifiedTests.join("、")}（需人工确认不是改测试凑绿灯）`);
  }

  // 6) 时间戳倒挂
  const created = num(state.created_at) ?? (typeof state.created_at === "string" ? Date.parse(state.created_at) : null);
  const updated = num(state.updated_at) ?? (typeof state.updated_at === "string" ? Date.parse(state.updated_at) : null);
  if (created !== null && updated !== null && Number.isFinite(created) && Number.isFinite(updated) && updated < created) {
    add("warn", "time_inverted", "updated_at 早于 created_at，时间戳异常");
  }

  const fails = findings.filter((f) => f.level === "fail").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  if (!findings.length) add("ok", "consistent", "证据自洽：状态、验证命令、退出码、通过标记互相一致");

  const verdict = fails > 0
    ? `不通过：${fails} 处矛盾${warns ? `、${warns} 处提醒` : ""}`
    : warns > 0
      ? `通过（有 ${warns} 处提醒需人工确认）`
      : "通过：证据自洽";

  return { findings, ok: fails === 0, verdict };
}

/** CLI 用：把审计结果格式化成文本。 */
export function formatAudit(result: AuditResult, runId: string): string {
  const icon = (l: AuditLevel) => (l === "ok" ? "✅" : l === "warn" ? "⚠️ " : "❌");
  const lines = [`运行 ${runId} 证据审计：${result.verdict}`, ""];
  for (const f of result.findings) lines.push(`${icon(f.level)} [${f.code}] ${f.message}`);
  return lines.join("\n");
}
