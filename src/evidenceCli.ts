// src/evidenceCli.ts — P1-2：`nyra evidence verify <run-id>`。
//
//   nyra evidence verify <run-id>    审计落盘证据是否自洽（不重跑命令）
//   nyra evidence verify --last      审计最近一次运行
//   nyra evidence list               列出最近运行及其状态
//
// 退出码：0 = 自洽（可能有 warn）；1 = 发现矛盾；2 = 用法错误 / 找不到运行。
import { RunStore } from "./runs.ts";
import { auditRunState, formatAudit } from "./evidenceAudit.ts";

export function handleEvidence(argv: string[], home: string): number {
  const store = new RunStore(`${home}/runs`);
  const [sub, ...rest] = argv;

  if (sub === undefined || sub === "list") {
    const runs = store.list();
    if (!runs.length) {
      process.stdout.write("还没有运行记录。\n");
      return 0;
    }
    process.stdout.write("最近的运行（新 → 旧）：\n");
    for (const r of runs.slice(0, 20)) {
      const verified = r.status === "verified" ? "✅" : r.status === "verify_failed" ? "❌" : "○";
      process.stdout.write(`  ${verified} ${r.run_id}  ${r.status}  ${r.created_at}\n`);
    }
    return 0;
  }

  if (sub !== "verify") {
    process.stderr.write("用法：nyra evidence verify <run-id> | nyra evidence verify --last | nyra evidence list\n");
    return 2;
  }

  let runId = rest[0];
  if (!runId) {
    process.stderr.write("用法：nyra evidence verify <run-id>（或 --last）\n");
    return 2;
  }
  if (runId === "--last") {
    const runs = store.list();
    if (!runs.length) {
      process.stderr.write("还没有运行记录可审计。\n");
      return 2;
    }
    runId = runs[0].run_id;
  }

  let state: unknown;
  try {
    state = store.load(runId);
  } catch {
    process.stderr.write(`找不到运行记录：${runId}\n`);
    return 2;
  }

  const result = auditRunState(state);
  process.stdout.write(formatAudit(result, runId) + "\n");
  return result.ok ? 0 : 1;
}
