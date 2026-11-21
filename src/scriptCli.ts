// src/scriptCli.ts — `nyra script`：脚本内容判定 + 摘要预授权的命令行入口。
//
// check 只做判定（读文件、不执行、不改任何东西）；preauth grant/revoke
// 是授权动作，须 --yes。判定结果本身不落盘，只打印；预授权的授/撤/用
// 记进脚本审计（~/.nyra/script-preauth-audit.jsonl），使用时还进运行
// 证据链（script_preauth_used 事件）。
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { resolveHome } from "./config.ts";
import {
  judgeScript,
  scriptDigest,
  scriptScopeId,
  SCRIPT_LANGUAGES,
  type ScriptLanguage,
} from "./scriptPurity.ts";
import {
  listPreauth,
  revokePreauth,
  workflowRoutineId,
} from "./scriptPreauth.ts";
import { grantWorkflowScriptPreauth, listWorkflows } from "./workflow.ts";

const SCRIPT_USAGE = [
  "用法：nyra script <check|preauth> [参数]",
  "",
  "  check <文件> [--language python|javascript|lua|php]",
  "      判定一个脚本纯不纯（白名单静态分析）：纯返回 0，不纯返回 1；",
  "      语言不写时按扩展名认（.py/.js/.mjs/.cjs/.lua/.php），认不出须写 --language",
  "  preauth list [--workflow <名字>]",
  "      列出脚本预授权（哪个例行、哪一步、哪门语言、哪个摘要、什么时候授的）",
  "  preauth grant --workflow <名字> --yes",
  "      给已激活的工作流补钉纯脚本摘要（激活时已自动钉过一次；老工作流用这个补）",
  "  preauth revoke --workflow <名字> [--digest <摘要>] --yes",
  "      撤销一例行的全部预授权，或只撤某一条摘要",
  "",
  "  摘要预授权只在例行里有效：摘要对上号才走快路径，内容一改授权自动失效；",
  "  聊天里永远不走快路径。详见 docs/script-purity.md。",
].join("\n");

const EXT_LANGUAGE: Record<string, ScriptLanguage> = {
  ".py": "python",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".lua": "lua",
  ".php": "php",
};

function flagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function fail(message: string): number {
  process.stderr.write(`错误：${message}\n`);
  return 1;
}

function doCheck(argv: string[]): number {
  const file = argv[0];
  if (!file) {
    process.stderr.write("错误：check 后面须跟脚本文件\n" + SCRIPT_USAGE + "\n");
    return 2;
  }
  const langRaw = flagValue(argv, "--language");
  let language: ScriptLanguage | undefined;
  if (langRaw !== undefined) {
    if (!(SCRIPT_LANGUAGES as readonly string[]).includes(langRaw)) {
      return fail(`--language 只认 python|javascript|lua|php（给了 ${langRaw}）`);
    }
    language = langRaw as ScriptLanguage;
  } else {
    language = EXT_LANGUAGE[extname(file).toLowerCase()];
    if (!language) {
      return fail(`按扩展名认不出语言：${file}（用 --language 指明）`);
    }
  }
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) {
    return fail(`文件不存在或不安全：${file}`);
  }
  let code: string;
  try {
    code = readFileSync(file, "utf-8");
  } catch (err) {
    return fail(`读文件失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const verdict = judgeScript(language, code);
  const digest = scriptDigest(code);
  if (verdict.pure) {
    process.stdout.write(`纯脚本（${language}）：${verdict.reason}\n摘要：${digest}\n范围：${scriptScopeId(digest)}\n`);
    return 0;
  }
  process.stdout.write(`不纯（${language}）：${verdict.reason}\n摘要：${digest}\n`);
  return 1;
}

function doPreauthList(home: string, argv: string[]): number {
  const workflow = flagValue(argv, "--workflow");
  const routine = workflow === undefined ? undefined : workflowRoutineId(workflow);
  const entries = listPreauth(home, routine);
  if (!entries.length) {
    process.stdout.write(workflow ? `工作流 ${workflow} 还没有脚本预授权。\n` : "还没有脚本预授权。\n");
    return 0;
  }
  for (const e of entries) {
    process.stdout.write(`${e.routine}  步骤 ${e.stepId}  ${e.language}  摘要 ${e.digest.slice(0, 12)}…  ${e.grantedAt || "未知时间"}\n`);
  }
  return 0;
}

function doPreauthGrant(home: string, argv: string[]): number {
  const workflow = flagValue(argv, "--workflow");
  if (!workflow) {
    process.stderr.write("错误：grant 须写 --workflow <名字>\n" + SCRIPT_USAGE + "\n");
    return 2;
  }
  if (!argv.includes("--yes")) {
    process.stderr.write("错误：grant 是授权动作，须加 --yes 确认\n");
    return 2;
  }
  const entry = listWorkflows(home).find((w) => w.name === workflow);
  if (!entry) return fail(`没有这个工作流：${workflow}（先 nyra workflow import <文件> 导入）`);
  if (entry.status !== "active") {
    return fail(`工作流 ${workflow} 还没激活（当前 ${entry.status}），先 trial + activate（激活时自动钉摘要）`);
  }
  const result = grantWorkflowScriptPreauth(home, workflow, process.cwd());
  process.stdout.write(`已钉 ${result.pinned.length} 个纯脚本摘要（工作流 ${workflow}）。\n`);
  for (const p of result.pinned) {
    process.stdout.write(`  步骤 ${p.stepId}（${p.language}）：摘要 ${p.digest.slice(0, 12)}…\n`);
  }
  if (result.skipped.length) {
    process.stdout.write(`跳过 ${result.skipped.length} 个（不钉，不拦工作流）：\n`);
    for (const s of result.skipped) {
      process.stdout.write(`  步骤 ${s.stepId}：${s.reason}\n`);
    }
  }
  return 0;
}

function doPreauthRevoke(home: string, argv: string[]): number {
  const workflow = flagValue(argv, "--workflow");
  if (!workflow) {
    process.stderr.write("错误：revoke 须写 --workflow <名字>\n" + SCRIPT_USAGE + "\n");
    return 2;
  }
  if (!argv.includes("--yes")) {
    process.stderr.write("错误：revoke 是授权动作，须加 --yes 确认\n");
    return 2;
  }
  const digest = flagValue(argv, "--digest");
  const n = revokePreauth(home, workflowRoutineId(workflow), digest);
  if (n === 0) {
    process.stdout.write(`工作流 ${workflow} 没有可撤销的预授权。\n`);
    return 0;
  }
  process.stdout.write(`已撤销 ${n} 条预授权（工作流 ${workflow}${digest ? `，摘要 ${digest.slice(0, 12)}…` : ""}）。\n`);
  return 0;
}

export async function handleScript(argv: string[], home: string): Promise<number> {
  const action = argv[0];
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(SCRIPT_USAGE + "\n");
    return 2;
  }
  const resolvedHome = home || resolveHome();
  try {
    if (action === "check") return doCheck(argv.slice(1));
    if (action === "preauth") {
      const sub = argv[1];
      if (sub === "list") return doPreauthList(resolvedHome, argv.slice(2));
      if (sub === "grant") return doPreauthGrant(resolvedHome, argv.slice(2));
      if (sub === "revoke") return doPreauthRevoke(resolvedHome, argv.slice(2));
      process.stderr.write(`错误：preauth 后面只认 list|grant|revoke（给了 ${sub ?? "空"}）\n${SCRIPT_USAGE}\n`);
      return 2;
    }
    process.stderr.write(`错误：未知动作 ${action}\n${SCRIPT_USAGE}\n`);
    return 2;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
