// src/handoverCli.ts — `nyra handover`：交接契约的程序化验收命令行入口。
//
// create 立契约（待验收）；check 跑程序验收（确定性，不调模型）：全过
// 接受、不过打回、轮次用完停下等人；resolve / close 是人的定夺（须
// --yes）。验收结果记进契约账本（attempt）与审计（~/.nyra/
// handover-contract-audit.jsonl）；有 --run 时结论还进该运行的事件
// （handover_contract_accepted / sent_back / stopped）。
import { existsSync, readFileSync } from "node:fs";
import { resolveHome } from "./config.ts";
import {
  HandoverContractError,
  HANDOVER_CONTRACT_STATUS_LABELS,
  HANDOVER_VERDICT_LABELS,
  DEFAULT_MAX_ROUNDS,
  MAX_ROUNDS_LIMIT,
  createHandoverContract,
  getHandoverContract,
  listHandoverContracts,
  checkHandoverContract,
  resolveHandoverContract,
  closeHandoverContract,
  formatHandoverContract,
  type HandoverDeliverable,
  type HandoverCheck,
} from "./handoverContract.ts";
import { listCheckers } from "./checkers.ts";

const HANDOVER_USAGE = [
  "用法：nyra handover <contract|checkers> [参数]",
  "",
  "  contract create --from <成员> --to <统筹> --task \"一句话\" --deliverable <id>:<相对路径>[:<描述>]... --check <id>:<checker>[:<标签>]... [--max-rounds N]",
  "      立一份交接契约（待验收）：交付物清单 + 验收项 + 修正轮次上限（默认 1，最多 5；0 = 交一次就定夺）",
  "  contract list [--status <状态>] [--from <成员>] [--to <统筹>] [--json]",
  "      列出交接契约（默认全列）",
  "  contract show <id>",
  "      看一份契约（交付物、验收项、轮次、最近一次验收逐项结果）",
  "  contract check <id> --workdir <目录> [--output-file <路径>] [--trajectory <工具1,工具2>] [--run <运行 ID>]",
  "      程序验收一次（确定性，不调模型）：交付物逐件核对 + 验收项逐项跑 checker；",
  "      全过接受（退出 0）、不过打回（退出 1）、轮次用完停下等人（退出 1）",
  "  contract resolve <id> --yes",
  "      人工定夺：停下等人的契约由人看过后认下（终态）",
  "  contract close <id> --yes",
  "      放弃一份契约（待验收 / 已打回 / 已停下等人的都能放弃）",
  "  checkers",
  "      列出能用的 checker（验收项只能挂这些，立契约时就校验）",
  "",
  "  验收是程序说了算：文件在不在、验收项过没过，逐项核对，不调模型；",
  "  打回与停下同时记一次信任阶梯违规（只对已登记的主体生效），通过记一次成功。",
  "  详见 docs/handover-contract.md。",
].join("\n");

function flagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function flagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  }
  return out;
}

function fail(message: string): number {
  process.stderr.write(`错误：${message}\n`);
  return 1;
}

function parseDeliverableFlag(raw: string): HandoverDeliverable {
  const parts = raw.split(":");
  if (parts.length < 2 || !parts[0]!.trim() || !parts[1]!.trim()) {
    throw new HandoverContractError(`--deliverable 格式不对：${raw}（应为 <id>:<相对路径>[:<描述>]）`);
  }
  return {
    id: parts[0]!.trim(),
    path: parts[1]!.trim(),
    description: parts.slice(2).join(":").trim() || parts[1]!.trim(),
  };
}

function parseCheckFlag(raw: string): HandoverCheck {
  const first = raw.indexOf(":");
  if (first < 0) throw new HandoverContractError(`--check 格式不对：${raw}（应为 <id>:<checker>[:<标签>]）`);
  const id = raw.slice(0, first).trim();
  const rest = raw.slice(first + 1);
  // 参数化 checker（file-exists / output-contains / trajectory-contains /
  // no-tool）的参数只占一段（相对路径、子串、工具名里都没有冒号），标签
  // 在参数之后；内置 checker 没有参数，标签直接跟在后面。
  const parts = rest.split(":");
  const kind = parts[0]!.trim();
  let checker = kind;
  let labelParts: string[];
  if (["file-exists", "output-contains", "trajectory-contains", "no-tool"].includes(kind)) {
    if (parts.length < 2 || !parts[1]!.trim()) throw new HandoverContractError(`--check 的 ${kind} 要带参数：${raw}（如 file-exists:report.md）`);
    checker = `${kind}:${parts[1]!.trim()}`;
    labelParts = parts.slice(2);
  } else {
    labelParts = parts.slice(1);
  }
  const label = labelParts.join(":").trim();
  if (!id || !checker) throw new HandoverContractError(`--check 格式不对：${raw}（应为 <id>:<checker>[:<标签>]）`);
  return { id, label: label || checker, checker };
}

export async function handleHandover(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  const resolvedHome = home || resolveHome();
  if (!action || action === "-h" || action === "--help" || action === "help") {
    process.stdout.write(HANDOVER_USAGE + "\n");
    return 0;
  }
  if (action === "checkers") {
    for (const c of listCheckers()) {
      process.stdout.write(`${c.id}——${c.label}：${c.what}\n`);
    }
    return 0;
  }
  if (action !== "contract") {
    process.stderr.write("用法：nyra handover <contract|checkers>\n");
    return 2;
  }
  const sub = argv[1];
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(HANDOVER_USAGE + "\n");
    return 0;
  }
  try {
    if (sub === "list") {
      const status = flagValue(argv, "--status");
      if (status && !(status in HANDOVER_CONTRACT_STATUS_LABELS)) {
        return fail(`--status 不认：${status}（应为 ${Object.keys(HANDOVER_CONTRACT_STATUS_LABELS).join(" / ")}）`);
      }
      const contracts = listHandoverContracts(resolvedHome, {
        status: status as keyof typeof HANDOVER_CONTRACT_STATUS_LABELS | undefined,
        from: flagValue(argv, "--from"),
        to: flagValue(argv, "--to"),
      });
      if (argv.includes("--json")) {
        process.stdout.write(JSON.stringify(contracts, null, 2) + "\n");
        return 0;
      }
      if (!contracts.length) {
        process.stdout.write("没有交接契约（先 nyra handover contract create 立一份）。\n");
        return 0;
      }
      for (const c of contracts) {
        process.stdout.write(`${c.id} [${HANDOVER_CONTRACT_STATUS_LABELS[c.status]}] ${c.from} → ${c.to}：${c.task.slice(0, 80)}（交付物 ${c.deliverables.length} 件，验收 ${c.checks.length} 项，轮次 ${c.roundsUsed}/${c.maxRounds}）\n`);
      }
      return 0;
    }
    if (sub === "create") {
      const from = flagValue(argv, "--from") ?? "";
      const to = flagValue(argv, "--to") ?? "";
      const task = flagValue(argv, "--task") ?? "";
      const deliverables = flagValues(argv, "--deliverable").map(parseDeliverableFlag);
      const checks = flagValues(argv, "--check").map(parseCheckFlag);
      const maxRoundsRaw = flagValue(argv, "--max-rounds");
      let maxRounds: number | undefined;
      if (maxRoundsRaw !== undefined) {
        maxRounds = parseInt(maxRoundsRaw, 10);
        if (!Number.isInteger(maxRounds) || maxRounds < 0 || maxRounds > MAX_ROUNDS_LIMIT) {
          return fail(`--max-rounds 是 0–${MAX_ROUNDS_LIMIT} 的整数（默认 ${DEFAULT_MAX_ROUNDS}）`);
        }
      }
      const contract = createHandoverContract(resolvedHome, { from, to, task, deliverables, checks, maxRounds });
      process.stdout.write(`交接契约已立：${contract.id}（待验收，修正轮次上限 ${contract.maxRounds} 轮）。成员交活后用 nyra handover contract check ${contract.id} --workdir <目录> 程序验收。\n`);
      return 0;
    }
    if (sub === "show") {
      const id = argv[2] ?? "";
      const contract = id ? getHandoverContract(resolvedHome, id) : null;
      if (!contract) {
        process.stderr.write("错误：用法：nyra handover contract show <契约 id>\n");
        return 2;
      }
      process.stdout.write(formatHandoverContract(contract) + "\n");
      return 0;
    }
    if (sub === "check") {
      const id = argv[2] ?? "";
      const workdir = flagValue(argv, "--workdir") ?? "";
      if (!id || !workdir) {
        process.stderr.write("错误：用法：nyra handover contract check <契约 id> --workdir <目录> [--output-file <路径>] [--trajectory <工具1,工具2>] [--run <运行 ID>]\n");
        return 2;
      }
      const outputFile = flagValue(argv, "--output-file");
      let outputText = "";
      if (outputFile) {
        try {
          outputText = readFileSync(outputFile, "utf-8");
        } catch {
          process.stderr.write(`读不到输出文件：${outputFile}\n`);
          return 1;
        }
      }
      const trajectoryRaw = flagValue(argv, "--trajectory");
      const trajectory = trajectoryRaw ? trajectoryRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const runId = flagValue(argv, "--run") ?? null;
      const result = checkHandoverContract(resolvedHome, id, { workdir, outputText, trajectory }, { runId });
      const lines = [
        `验收结论：${HANDOVER_VERDICT_LABELS[result.verdict]}（第 ${result.attempt.round} 轮，${result.attempt.passedCount}/${result.attempt.total} 项通过）`,
        ...result.attempt.items.map((i) => `  - ${i.passed ? "通过" : "未过"} ${i.label}——${i.detail}`),
        result.text,
      ];
      if (!result.trustRecorded) lines.push("（交活方还没登记在信任阶梯里，这次没记信任证据；先 nyra trust register 登记，默认只读起步）");
      process.stdout.write(lines.join("\n") + "\n");
      return result.verdict === "accepted" ? 0 : 1;
    }
    if (sub === "resolve") {
      const id = argv[2] ?? "";
      if (!id || !argv.includes("--yes")) {
        process.stderr.write("错误：用法：nyra handover contract resolve <契约 id> --yes\n");
        return 2;
      }
      const contract = resolveHandoverContract(resolvedHome, id, "cli");
      process.stdout.write(`交接契约 ${contract.id} 已由人工定夺认下（${contract.from} → ${contract.to}：${contract.task.slice(0, 60)}）。\n`);
      return 0;
    }
    if (sub === "close") {
      const id = argv[2] ?? "";
      if (!id || !argv.includes("--yes")) {
        process.stderr.write("错误：用法：nyra handover contract close <契约 id> --yes\n");
        return 2;
      }
      const contract = closeHandoverContract(resolvedHome, id, "cli");
      process.stdout.write(`交接契约 ${contract.id} 已放弃。\n`);
      return 0;
    }
    process.stderr.write("用法：nyra handover contract <create|list|show|check|resolve|close>\n");
    return 2;
  } catch (err: unknown) {
    if (err instanceof HandoverContractError) return fail(err.message);
    throw err;
  }
}
