// src/cli.ts — Nyra Node 版命令行入口（第 2 阶段）。
// 命令与 flag 与 Python 版 nyra/cli.py 一一对应：一次性任务 / REPL /
// schedule 子命令 / task 子命令 / --plan / --execute-plan / --resume /
// --resume-run / --verify / --list-providers / --list-skills / --json / --mode。
// 终端交互按方案 2.6 末尾：审核选择器默认是、REPL 状态行、命令实时流式输出。
// permissions / eigenflux 在第 4 阶段已原生化（src/poppy.ts、src/eigenflux.ts、
// src/eigenfluxPolicy.ts）；worker 桥与 Python 运行时已移除。
// ui（gateway）与 MCP 客户端在第 3 阶段已原生化。
import { createInterface } from "node:readline";
import { encode as qrEncode, toTerminal as qrToTerminal } from "./qrcode.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, realpathSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadConfig, resolveHome, resolveProvider, resolveProfile, resolveFallbackChain, resolveSwitchAllowlist,
  listProfiles, validateMode, resolveSandbox, PROVIDERS, VERSION, envVar, getProviderPresets, saveConfig,
} from "./config.ts";
import { Provider, FallbackProvider, buildProviderChain, ProviderError, switchTriggerFor, type RetryRecord, type SwitchRecord } from "./providers.ts";
import { Agent, AgentError, type ContextUsage } from "./agent.ts";
import { RunStore, RunRecorder, prepareResume, loadCompletedWriteKeys, resolveVerifyOrigin, acceptVerifyCommand, resolveVerifySettings, downgradeCompletionClaim, formatRunReport, verifyEvidenceChain, formatEvidenceReport, computeRunStats } from "./runs.ts";
import { resolvePricing, resolveMonthlyLimit } from "./cost.ts";
import { handleCost } from "./costCli.ts";
import { handleStats, formatMonthLine } from "./statsCli.ts";
import { handleModels } from "./modelsCli.ts";
import { loadModelCache, manualWindowFromConfig, resolveContextWindow } from "./modelCatalog.ts";
import { classifyFailure, formatFailureLine } from "./failures.ts";
import { parseRules } from "./permissionRules.ts";
import { checkRedlines, formatRedlines } from "./redlines.ts";
import { handleConfig } from "./configCli.ts";
import { explainAll, explainOne, formatExplain } from "./configExplain.ts";
import { summarizeSavings as summarizeCostSavings, formatSavings, formatRedlinesWithSavings } from "./savingsSummary.ts";
import { summarizeModelSavings, formatModelSavings } from "./modelSavings.ts";
import { buildVerdict, formatVerdict } from "./verdict.ts";
import type { RedlineResult } from "./redlines.ts";
import { measureToolBudget, filterSchemas, summarizeSavings, formatToolBudget } from "./toolBudget.ts";
import { resolveFeatures, featureOn, formatFeatures } from "./features.ts";
import { resolveExtraDirs } from "./extraDirs.ts";
import { resolveEnforced, applyEnforced, formatEnforced } from "./enforcedConfig.ts";
import { buildRecallNote, selectRecalledRuns } from "./runRecall.ts";
import { resolveAuxRouting } from "./modelRouting.ts";
import { resolveReasoningOptions, toRequestBody } from "./reasoning.ts";
import { loadSession, listSessions, saveSession, newSessionId } from "./memory.ts";
import { loadSkills, canonicalSkillDirs } from "./skills.ts";
import {
  renderHeader, renderTrustPrompt, renderInputFrame, inputRows, supportsBoxDrawing, renderTips, renderEcho,
  renderReply, renderOk, renderError, gitBranch, stripAnsi,
} from "./banner.ts";
import { detectColorLevel, type ColorLevel } from "./theme.ts";
import {
  PetController, PET_WIDTH, petVisible, petEnabledFromConfig, parsePetCommand, renderPet, renderBubble, petFace,
} from "./pet.ts";
import { Spinner } from "./spinner.ts";
import { formatUsage, windowSourceLabel, type UsageSnapshot } from "./usage.ts";
import { UsageLedger, formatHeatmap, monthKeyString } from "./usageLedger.ts";
import { McpCostTracker } from "./mcpCost.ts";
import { formatReplStatus, ToolPrinter, useColor, textWidth } from "./consoleUi.ts";
import { dashboardCostSegment } from "./dashboard.ts";
import { askApproval, approvalHooks } from "./approvalUi.ts";
import { JsonLines, invalidArguments, EXIT_SUCCESS, EXIT_RUNTIME, EXIT_ARGUMENT, EXIT_INCOMPLETE, EXIT_VERIFY, EXIT_INTERRUPTED, EXIT_COST } from "./jsonMode.ts";
import { buildPlan, renderPlan, savePlan, readApprovedPlan, approvedExecutionTask, PlanError } from "./planMode.ts";
import { handleTask } from "./tasks.ts";
import { handleReview } from "./reviewQueue.ts";
import { loadSchedule, saveSchedule, addScheduleTask, removeScheduleTask, listScheduleTasks, runDaemon, ScheduleError, type ScheduleTask } from "./scheduler.ts";
import { knowledgeMain } from "./knowledge.ts";
import { PermissionLedger, PermissionConflict } from "./poppy.ts";
import { doctor as eigenfluxDoctor, onboardingSteps as eigenfluxOnboarding, doctorExitCode as eigenfluxDoctorExitCode } from "./eigenflux.ts";
import { NetworkPolicy } from "./eigenfluxPolicy.ts";
import { printDoctorResult, runDoctor } from "./doctor.ts";
import { t, getLang, setLang, detectLang, extractLangFlag, normalizeLang, type MsgKey } from "./i18n.ts";
// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——main 入口做 fail-closed 校验，
// buildAgent 把解析出的沙箱配置透传给 Agent（再进 ToolContext）。
import { resolveSandboxBackend, getSandboxStatus } from "./sandbox.ts";
import { runExampleTask } from "./exampleTask.ts";
import { printNoKeyAndExitCode } from "./noKey.ts";
import { defaultExampleFile, runWizard } from "./wizard.ts";
import { ensureNyraHome } from "./migration.ts";
import { ApprovalRequired, TOOL_SCHEMAS } from "./tools.ts";
import { Vault, vaultUsage, VaultError } from "./vault.ts";
import { runCreator, verifyStagedPlugin, installStagedPlugin, describePlannedChanges, CreatorError } from "./creator.ts";
import { listHookEntries, runHooks, HOOK_EVENTS } from "./hooks.ts";
import { runStatusChecks, formatStatusReport } from "./status.ts";
import { Gateway } from "./gateway.ts";
import { GatewayClient } from "./gatewayClient.ts";
import { ConversationStore } from "./conversations.ts";
import { rewindTo, rewindEdit, rewindFork, storeHistoryToAgentMessages } from "./rewind.ts";
import { ShadowSnapshotStore, buildRestoreNote, type RestoreMode, type RestoreResult, type SnapshotRecord } from "./shadowSnapshots.ts";
import { loadMcpServers } from "./mcp.ts";
import { listPresets } from "./mcpPresets.ts";
import {
  PluginError, installPlugin, uninstallPlugin, listPlugins, verifyPlugin,
  setPluginStatus, setPluginPinned, pluginSkillDirs, auditPlugins, searchRegistry,
  STALE_AFTER_DAYS,
} from "./plugins.ts";

export const USAGE = `Nyra ${VERSION}（Node 运行时）

用法：
  nyra "任务" [--provider 名字] [--mode readonly|auto|full|creator]   一次性执行任务
  --max-cost <美元> --monthly-max-cost <美元>   单次 / 月度支出上限（超限即停；月度默认不设上限）
  nyra                                                        进入交互模式（REPL）
  nyra --help                    显示帮助（不用 Key、不联网）
  nyra --version                 显示版本
  nyra --list-providers          列出所有可用 provider（内置预设 + 自定义）
  nyra --list-models [--provider 名字]   列出该来源的已知模型
  nyra --list-profiles           列出已配置的 provider 档案
  nyra --list-skills             列出已加载的技能
  nyra --list-sessions           列出历史会话
  nyra --list-mcp                列出已配置的 MCP 服务器与预置（第 3 阶段原生）
  nyra ui [--host 127.0.0.1] [--port 8765] [--pair] [--open]   启动 gateway 网页界面
  nyra ui --print-url-json --exit-on-stdin-close   桌面外壳模式：stdout 首行一行 JSON，stdin 关闭即退出
  nyra gw <sessions|send|view|approve|rewind|info|schedule>   连正在跑的 gateway 当客户端
  nyra --compact <会话 ID>       压缩指定会话后退出
  REPL：/context 查看上下文占用；/compact focus <关键词> 按重点压缩会话（详见 docs/context.md）
  nyra --resume <会话 ID>        继续指定会话
  nyra --resume-run <运行 ID>    从运行记录断点续跑
  nyra evidence verify <运行 ID>   独立复核运行的证据链（工具调用 → 产物 → 校验结果，详见 docs/evidence.md）
  nyra restore [检查点] [--mode both|files|session]   从影子快照恢复文件与会话（不带参数列出检查点，详见 docs/shadow-snapshots.md）
  nyra stats [--heatmap]         本月用量与每日用量热力图（详见 docs/cost.md）
  nyra cost --show               定价、单次上限与月度上限（本月已花）
  nyra --plan "任务"             只读分析，生成工作目录中的 plan.md，不执行
  nyra --execute-plan --approve-plan <SHA256>   执行经校验值批准的 plan.md
  nyra --verify "<命令>"         任务完成后运行验证命令（退出码 0 才算验证通过）
  nyra --json "任务"             单次非交互任务，输出 JSON Lines
  nyra schedule <list|add|remove|run|daemon>   管理定时任务
  nyra task <add|list|show|cancel|worker|approve>   管理后台任务队列
  nyra review <list|show|approve|reject|apply|verify|enqueue>   审阅队列：并行线程与定时任务结果逐项批（详见 docs/review-queue.md）
  nyra kb <create|list|add|search|ask|remove>  本地知识库
  nyra plugin <list|search|install|uninstall|enable|disable|verify|audit|pin|unpin>  插件市场（最小版：技能包，只装带来源、可审计的插件）
  nyra hooks list                列出已安装的钩子（~/.nyra/hooks/<事件>.d/ 下的脚本，详见 docs/hooks.md）
  nyra status                    诊断清单：损坏的配置、不可用沙箱、被忽略的权限设置、永不匹配的 hook matcher（只读，详见 docs/status.md）
  nyra creator "<一句话需求>" [--yes]   创造模式：一句话搓出插件（先验证、经确认才安装）
  nyra memory <export|export-prompt|import|local|import-zip|search|forget>  记忆交换与检索/删除
  nyra style <learn|show|list|delete|export|import>  分应用文风学习（详见 docs/style.md）
  nyra doctor [--provider 名字]  中文自检：运行时、配置文件、配置目录、Key、网络、磁盘、写权限、密码箱权限
  nyra models [list|show <模型名>|refresh]   查模型上下文窗口、刷新模型数据（见 docs/model-catalog.md）
  nyra setup                     首次启动向导
  nyra --example [文件]          本地示例任务（不调模型、不花钱）
  nyra ui                        网页界面（本地网页，含模式切换与创造模式）
  nyra permissions ...           Poppy 站点授权意向（本地账本，只记录不授权）
  nyra eigenflux ...             EigenFlux 接入检测与本地网络限制（第 4 阶段已原生化）

模型兜底默认关闭（只用户开启、只切允许列表内服务商）。
界面语言：--lang zh|en（或 NYRA_LANG、config.json 的 language、系统语言；REPL 里 /lang 切换）。`;

export const USAGE_EN = `Nyra ${VERSION} (Node runtime)

Usage:
  nyra "task" [--provider name] [--mode readonly|auto|full|creator]   run one task
  --max-cost <USD> --monthly-max-cost <USD>   per-run / monthly spend caps (hard stop when exceeded; monthly cap unset by default)
  nyra                                                        interactive mode (REPL)
  nyra --help                    show help (no key, no network)
  nyra --version                 show version
  nyra --lang zh|en              UI language (also NYRA_LANG, config "language", system locale; /lang in the REPL)
  nyra --list-providers          list providers (built-in presets + custom)
  nyra --list-models [--provider name]   list known models for a provider
  nyra --list-profiles           list configured provider profiles
  nyra --list-skills             list loaded skills
  nyra --list-sessions           list past sessions
  nyra --list-mcp                list configured MCP servers and presets
  nyra ui [--host 127.0.0.1] [--port 8765] [--pair] [--open]   start the gateway web UI
  nyra ui --print-url-json --exit-on-stdin-close   desktop shell mode: one JSON line on stdout, exits when stdin closes
  nyra gw <sessions|send|view|approve|rewind|info|schedule>   talk to a running gateway as a client
  nyra --compact <session id>    compact a session and exit
  REPL: /context shows context usage; /compact focus <keyword> compacts around a topic (see docs/context.md)
  nyra --resume <session id>     continue a session
  nyra --resume-run <run id>     resume a run from its record
  nyra evidence verify <run id>  independently re-check a run's evidence chain (see docs/evidence.md)
  nyra restore [checkpoint] [--mode both|files|session]   restore files and session from a shadow snapshot (no argument lists checkpoints, see docs/shadow-snapshots.md)
  nyra stats [--heatmap]         this month's usage and the daily usage heatmap (see docs/cost.md)
  nyra cost --show               pricing, per-run cap and monthly cap (spent this month)
  nyra verdict [task]            one conclusion: is this run worth it (redlines + savings + recall + history)
  nyra --plan "task"             read-only analysis; writes plan.md in the workdir, runs nothing
  nyra --execute-plan --approve-plan <SHA256>   run a plan.md approved by its checksum
  nyra --verify "<command>"      run a verify command after the task (exit code 0 = verified)
  nyra --json "task"             one non-interactive task, JSON Lines output
  nyra schedule <list|add|remove|run|daemon>   manage scheduled tasks
  nyra task <add|list|show|cancel|worker|approve>   manage the background task queue
  nyra review <list|show|approve|reject|apply|verify|enqueue>   review queue: approve parallel threads and scheduled-task results one by one (see docs/review-queue.md)
  nyra kb <create|list|add|search|ask|remove>  local knowledge base
  nyra plugin <list|search|install|uninstall|enable|disable|verify|audit|pin|unpin>  plugin market (skill packs with source, auditable)
  nyra hooks list                list installed hooks (~/.nyra/hooks/<event>.d/, see docs/hooks.md)
  nyra status                    diagnose broken configs, unavailable sandbox, ignored permission rules, never-matching hook matchers (read-only, see docs/status.md)
  nyra creator "<one-line idea>" [--yes]   creator mode: build a plugin from one sentence (verified, installed only after you confirm)
  nyra memory <export|export-prompt|import|local|import-zip|search|forget>  memory exchange, search and forget
  nyra style <learn|show|list|delete|export|import>  per-channel writing style profiles (see docs/style.md)
  nyra doctor [--provider name]  self-check: runtime, config, home dir, key, network, disk, write access, vault permissions
  nyra models [list|show <model>|refresh]   look up model context windows, refresh model data (see docs/model-catalog.md)
  nyra setup                     first-run wizard
  nyra --example [file]          local example task (no model calls, no cost)
  nyra permissions ...           Poppy site permission intents (local ledger; records, never grants)
  nyra eigenflux ...             EigenFlux checks and local network limits

Model fallback is off by default (only when you turn it on, only to allowed providers).`;

/** 当前界面语言的 --help 文本。 */
export function usageText(): string { return getLang() === "en" ? USAGE_EN : USAGE; }

/**
 * CLI 入口的语言初始化：--lang > NYRA_LANG > config.language > 系统语言 > en。
 * 返回去掉 --lang 后的 argv；--lang 值非法时 error 有值。
 */
export function initLang(argv: string[], config: Record<string, unknown> | null): { argv: string[]; error?: string } {
  const flag = extractLangFlag(argv);
  if (flag.value !== undefined && flag.lang === null) {
    setLang(detectLang({ config }));
    return { argv: flag.rest, error: t("lang.badFlag", { value: flag.value }) };
  }
  setLang(detectLang({ flag: flag.lang, config }));
  return { argv: flag.rest };
}

export interface CliArgs {
  help: boolean; version: boolean;
  listProviders: boolean; listModels: boolean; listProfiles: boolean;
  listSkills: boolean; listSessions: boolean; listMcp: boolean;
  compact: string | null; resume: string | null; resumeRun: string | null;
  planMode: boolean; executePlan: boolean; approvePlan: string | null;
  verify: string | null; verifyTimeout: number | null; verifyRetries: number | null;
  /** P2-2：本次运行的成本上限（美元）；null = 不设上限。 */
  maxCost: number | null;
  /** 缺口 29：本次运行的月度支出上限（美元）；null = 按配置（默认不设上限）。 */
  monthlyMaxCost: number | null;
  /** 本次运行禁用的工具（可重复 --disable-tool）。 */
  disableTools: string[];
  /** 功能开关的 CLI 覆盖（--enable-feature / --disable-feature，可重复）。 */
  enableFeatures: string[];
  disableFeatures: string[];
  /** --add-dir：额外可写根（可重复）。 */
  addDirs: string[];
  trustAgentsVerify: boolean;
  jsonMode: boolean; autoCompact: boolean; autoCompactThreshold: number | null;
  poppy: boolean; fallback: boolean; noFallback: boolean;
  discoverPoppy: string | null; inspectPoppyIdentity: string | null;
  provider?: string; model?: string; profile?: string;
  mode?: string; maxTurns: number | null; contextWindow: number | null;
  /** 缺口 4：本次运行的代笔渠道（--channel gmail）；null = 不注入文风画像。 */
  channel?: string | null;
  workdir: string; trust: boolean;
  sandbox?: string | null; sandboxId?: string | null; sandboxTemplate?: string | null; sandboxTimeout: number | null;
  doctor: boolean; setup: boolean; example: boolean; exampleFile?: string;
  /** 界面语言 --lang zh|en（main 入口已先取出并生效；这里只为 parseArgs 单独调用时不报未知选项）。 */
  lang?: string;
  task?: string; unknown?: string;
  subcommand?: string; subArgs?: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false, version: false,
    listProviders: false, listModels: false, listProfiles: false,
    listSkills: false, listSessions: false, listMcp: false,
    compact: null, resume: null, resumeRun: null,
    planMode: false, executePlan: false, approvePlan: null,
    verify: null, verifyTimeout: null, verifyRetries: null, maxCost: null, monthlyMaxCost: null, disableTools: [], enableFeatures: [], disableFeatures: [], addDirs: [],
    trustAgentsVerify: false, jsonMode: false, autoCompact: false,
    autoCompactThreshold: null, poppy: false, fallback: false, noFallback: false,
    discoverPoppy: null, inspectPoppyIdentity: null,
    maxTurns: null, contextWindow: null, channel: null,
    workdir: ".", trust: false, sandboxTimeout: null,
    doctor: false, setup: false, example: false,
  };
  const positional: string[] = [];
  const valueFlags = new Set([
    "--provider", "--model", "--profile", "--mode", "--max-turns", "--context-window",
    "--compact", "--resume", "--resume-run", "--verify", "--verify-timeout", "--verify-retries", "--monthly-max-cost",
    "--auto-compact-threshold", "--discover-poppy", "--inspect-poppy-identity",
    "--approve-plan", "--workdir", "--sandbox", "--sandbox-id", "--sandbox-template", "--sandbox-timeout",
    "--lang", "--channel",
  ]);
  const subcommands = new Set(["verdict", "savings", "recall", "features", "tools", "config", "redlines", "evidence", "restore", "cost", "models", "schedule", "task", "review", "ui", "gw", "permissions", "eigenflux", "kb", "plugin", "creator", "memory", "style", "doctor", "setup", "vault", "hooks", "stats", "status"]);
  // 子命令 early-return 之前先扫一遍 --provider/--model：setup/--example/doctor
  // 从 args.provider 取值，否则子命令后的 flag 永远填不进来（setup --provider nope
  // 会按配置文件里的 provider 跑）。schedule/task 等仍从 subArgs 取自己的参数，不受影响。
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider" && argv[i + 1] !== undefined) args.provider = argv[i + 1];
    else if (a === "--model" && argv[i + 1] !== undefined) args.model = argv[i + 1];
    else if (a.startsWith("--provider=")) args.provider = a.slice("--provider=".length);
    else if (a.startsWith("--model=")) args.model = a.slice("--model=".length);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (i === 0 && subcommands.has(a)) {
      args.subcommand = a;
      args.subArgs = argv.slice(1);
      return args;
    }
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-V") args.version = true;
    else if (a === "--list-providers") args.listProviders = true;
    else if (a === "--list-models") args.listModels = true;
    else if (a === "--list-profiles") args.listProfiles = true;
    else if (a === "--list-skills") args.listSkills = true;
    else if (a === "--list-sessions") args.listSessions = true;
    else if (a === "--list-mcp") args.listMcp = true;
    else if (a === "--plan") args.planMode = true;
    else if (a === "--execute-plan") args.executePlan = true;
    else if (a === "--trust-agents-verify") args.trustAgentsVerify = true;
    else if (a === "--json") args.jsonMode = true;
    else if (a === "--auto-compact") args.autoCompact = true;
    else if (a === "--poppy") args.poppy = true;
    else if (a === "--fallback") args.fallback = true;
    else if (a === "--no-fallback") args.noFallback = true;
    else if (a === "--trust") args.trust = true;
    else if (a === "--example") args.example = true;
    else if (valueFlags.has(a)) {
      const value = argv[++i];
      if (value === undefined) { args.unknown = a; break; }
      switch (a) {
        case "--provider": args.provider = value; break;
        case "--model": args.model = value; break;
        case "--profile": args.profile = value; break;
        case "--mode": args.mode = value; break;
        case "--max-turns": args.maxTurns = parseInt(value, 10); break;
        case "--context-window": args.contextWindow = parseInt(value, 10); break;
        case "--compact": args.compact = value; break;
        case "--resume": args.resume = value; break;
        case "--resume-run": args.resumeRun = value; break;
        case "--verify": args.verify = value; break;
        case "--max-cost": args.maxCost = parseFloat(value); break;
        case "--monthly-max-cost": args.monthlyMaxCost = parseFloat(value); break;
        case "--disable-tool": args.disableTools.push(value); break;
        case "--enable-feature": args.enableFeatures.push(value); break;
        case "--add-dir": args.addDirs.push(value); break;
        case "--disable-feature": args.disableFeatures.push(value); break;
        case "--verify-timeout": args.verifyTimeout = parseInt(value, 10); break;
        case "--verify-retries": args.verifyRetries = parseInt(value, 10); break;
        case "--auto-compact-threshold": args.autoCompactThreshold = parseFloat(value); break;
        case "--discover-poppy": args.discoverPoppy = value; break;
        case "--inspect-poppy-identity": args.inspectPoppyIdentity = value; break;
        case "--approve-plan": args.approvePlan = value; break;
        case "--workdir": args.workdir = value; break;
        case "--sandbox": args.sandbox = value; break;
        case "--sandbox-id": args.sandboxId = value; break;
        case "--sandbox-template": args.sandboxTemplate = value; break;
        case "--sandbox-timeout": args.sandboxTimeout = parseInt(value, 10); break;
        case "--lang": args.lang = value; break;
        case "--channel": args.channel = value; break;
      }
    } else if (a.startsWith("--") && a.includes("=")) {
      const [flag, value] = a.split("=", 2);
      if (valueFlags.has(flag)) {
        const fake = parseArgs([flag, value]);
        Object.assign(args, fake);
      } else { args.unknown = a; break; }
    } else if (a.startsWith("-")) { args.unknown = a; break; }
    else positional.push(a);
  }
  if (args.example && positional[0]) args.exampleFile = positional[0];
  else if (positional[0]) args.task = positional[0];
  if (positional.length > 1 && !args.example) args.unknown = positional[1];
  return args;
}

function printSetupHelp(providerName: string): void {
  process.stdout.write(t("setup.noCreds", { provider: providerName }) + "\n");
}

function fallbackEnabled(args: CliArgs): boolean | null {
  if (args.noFallback) return false;
  if (args.fallback) return true;
  return null;
}

function fallbackNotice(record: { from: string; to: string; error: string; kind?: SwitchRecord["kind"]; trigger?: SwitchRecord["trigger"] }): void {
  let reason = record.error;
  if (reason.length > 120) reason = reason.slice(0, 117) + "…";
  // 缺口 5：提示写明触发原因（用量触顶 / 限流 / 服务端错误…），不让用户
  // 从报错原文里猜“为什么换了模型”。
  const trigger = record.trigger ?? (record.kind ? switchTriggerFor(record.kind) : "other");
  const label = t(`fallback.trigger.${trigger}` as MsgKey);
  process.stderr.write(t("fallback.notice", { from: record.from, reason, to: record.to, trigger: label }) + "\n");
}

const TRUSTED_FILE = "trusted_workspaces.json";

function trustedPath(home: string): string { return join(home, TRUSTED_FILE); }

/** 与 Python trust.normalize 同口径：绝对路径 + 解析符号链接，Windows 下小写。 */
function normalizeTrustPath(p: string): string {
  let abs = resolve(p);
  try { abs = realpathSync(abs); } catch { /* 路径不存在时用 resolve 结果 */ }
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * 读信任列表，双格式兼容：Node 数组格式 ["<路径>", ...] 与 Python 字典格式
 * {"version": 1, "folders": {"<路径>": {"trusted_at": ...}}}。损坏文件按全不信任。
 */
function readTrustedList(home: string): string[] {
  let data: unknown;
  try { data = JSON.parse(readFileSync(trustedPath(home), "utf-8")); } catch { return []; }
  let raw: unknown[] = [];
  if (Array.isArray(data)) raw = data;
  else if (data && typeof data === "object") {
    const folders = (data as Record<string, unknown>).folders;
    if (folders && typeof folders === "object" && !Array.isArray(folders)) raw = Object.keys(folders);
  }
  return raw.filter((x): x is string => typeof x === "string").map((x) => normalizeTrustPath(x));
}

export function isTrusted(workdir: string, home: string): boolean {
  return readTrustedList(home).includes(normalizeTrustPath(workdir));
}

export function addTrusted(workdir: string, home: string): void {
  const path = trustedPath(home);
  const list = readTrustedList(home);
  const key = normalizeTrustPath(workdir);
  if (!list.includes(key)) list.push(key);
  mkdirSync(home, { recursive: true });
  try { chmodSync(home, 0o700); } catch { /* 忽略（如文件系统不支持） */ }
  // 原子写 + 0600（与 Python add_trusted 同口径；旧 Python 字典格式首次写入时转为数组格式）。
  const tmp = join(home, `.trust-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", "utf-8");
    try { chmodSync(tmp, 0o600); } catch { /* 忽略 */ }
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 清理失败不掩盖原错 */ }
    throw err;
  }
}

async function ensureWorkspaceTrusted(workdir: string, args: CliArgs, config: Record<string, unknown>, home: string): Promise<number | null> {
  if (args.trust) {
    try { addTrusted(workdir, home); } catch (err: unknown) {
      process.stderr.write(t("trust.warn", { err: err instanceof Error ? err.message : String(err) }) + "\n");
    }
    return null;
  }
  if (config.skip_workspace_trust) return null;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return null;
  if (isTrusted(workdir, home)) return null;
  const trust = renderTrustPrompt(resolve(workdir), {
    width: process.stdout.columns || 80, color: useColor(process.stdout),
    level: useColor(process.stdout) ? detectColorLevel(process.env, true) : 0, unicode: supportsBoxDrawing(),
  });
  process.stdout.write(trust.lines.join("\n") + "\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolvePromise) => {
    rl.question(trust.question, (a) => { rl.close(); resolvePromise(a); });
  });
  if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
    process.stdout.write(t("trust.denied") + "\n");
    return 1;
  }
  try { addTrusted(workdir, home); } catch (err: unknown) {
    process.stderr.write(t("trust.warnContinue", { err: err instanceof Error ? err.message : String(err) }) + "\n");
  }
  return null;
}

interface BuiltAgent {
  agent: Agent;
  providerName: string;
  config: Record<string, unknown>;
  home: string;
  /** 缺口 20/29：用量账本与本次运行已落盘的 LLM 花费 holder（月度口径要扣掉它，避免重复计）。 */
  monthly: { ledger: UsageLedger; flushed: { flushedUsd: number } };
  /**
   * 缺口 5：兜底切换回调（stderr 提示 + 经 Agent 发 model_switch 事件进
   * 证据链）。REPL `/model` 建新链时复用同一回调，之后自动切换照样留痕。
   */
  onModelSwitch: (record: SwitchRecord) => void;
}

async function buildAgent(args: CliArgs, opts?: { interactive: boolean; skillsDirs?: string[]; onRetry?: (record: RetryRecord) => void }): Promise<BuiltAgent> {
  const home = resolveHome();
  const config = loadConfig(home);
  const profile = resolveProfile(args.profile ?? null, config);
  const primaryCfg = resolveProvider({
    home, config,
    providerName: args.provider ?? profile.provider,
    model: args.model ?? profile.model ?? undefined,
  });
  const chain = resolveFallbackChain(config, primaryCfg.name, fallbackEnabled(args) ?? undefined);
  // 缺口 5：兜底切换的事件落点——provider 在 Agent 之前建成，先用 holder
  // 占位；Agent 建好后挂上去，之后每次自动切换都经 agent.emit 发
  // model_switch 事件，RunRecorder 写进 events.jsonl（与 REPL /model
  // 的手动切换同一事件、同一口径：何时换、从谁换到谁、为什么换、花了多少）。
  const switchAgent: { current: Agent | null } = { current: null };
  const onModelSwitch = (r: SwitchRecord): void => {
    fallbackNotice(r);
    const a = switchAgent.current;
    if (!a) return;
    const spent = a.lastCost?.status === "priced" ? a.lastCost.spentUsd : null;
    a.emit("model_switch", {
      from: r.from, to: r.to, reason: r.error,
      kind: r.kind, status: r.status,
      trigger: r.trigger ?? switchTriggerFor(r.kind),
      spent_usd: spent,
    });
  };
  const provider = buildProviderChain(
    primaryCfg, chain,
    onModelSwitch,
    {
      resolver: (name: string) => resolveProvider({ home, config, providerName: name }),
      // 缺口 20：同一 provider 重试前的回调（CLI 用来显示 429 冷却倒计时）。
      onRetry: opts?.onRetry ?? null,
    },
  );
  if (!provider.hasCredentials()) {
    printSetupHelp(primaryCfg.name);
    throw new AgentError("__NO_CREDENTIALS__");
  }
  const mode = validateMode(args.mode ?? profile.mode ?? (config.mode as string) ?? "auto");
  const maxTurns = args.maxTurns ?? (typeof config.max_turns === "number" ? config.max_turns : 20);
  if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error(t("err.maxTurns"));
  }
  // 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——后端/模式/网络开关
  // 按 CLI flag > 环境变量 > config.json 解析（resolveSandbox）；显式 bwrap
  // 缺失、e2b 等 fail-closed 情况在这里抛错，命令不跑。
  const sandboxSettings = resolveSandbox(config, args.sandbox ?? null);
  // 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——这里再做一次 fail-closed
  // 解析：显式 bwrap 缺失、e2b 等直接抛错（main 入口已先拦一道，这里是纵深，
  // 覆盖 --compact 这类先调 buildAgent 的路径；auto 回落不报错）。
  resolveSandboxBackend(config, args.sandbox ?? null);
  // 推理档位 / 冗长度：未配置时 toRequestBody 返回空对象，provider payload 不变。
  const reasoningOpts = resolveReasoningOptions(config);
  (provider as { extraBody?: Record<string, unknown> }).extraBody = toRequestBody(reasoningOpts);
  // 模型上下文窗口自动识别：--context-window > 手动配置 > 刷新缓存 > 内置表
  // > 同系列推断；未知模型不猜数字（resolver 给原因）。同时修掉旧的不一致：
  // CLI 读的是 config.context_window，网关读的是 context_window_tokens，
  // 现在统一走 manualWindowFromConfig（context_window_tokens 优先，旧键兼容）。
  const manualWindow = manualWindowFromConfig(config);
  const windowResolved = resolveContextWindow({
    model: provider.model, provider: primaryCfg.name,
    cli: args.contextWindow, manual: manualWindow.value, manualKey: manualWindow.key,
    cache: loadModelCache(home),
  });
  // 缺口 29：月度硬顶的“本月已花（不含本次运行）”——账本里的本月 LLM 花费
  // + 本月 MCP 花费，减去本次运行已经落盘的部分（账本里有、但本次运行的
  // 进行中花费还没算进去，扣掉才不重复计）。账本读失败返回 null：算不出
  // 就不封顶，不假装。月度上限本身：CLI 显式值 > 配置，默认不设上限。
  const monthlyLedger = new UsageLedger(home);
  const monthlyFlushed = { flushedUsd: 0 };
  const monthlyLimit = resolveMonthlyLimit(config, args.monthlyMaxCost ?? null);
  const monthlySpentBeforeUsd = monthlyLimit === null ? null : (): { spentUsd: number; incomplete: boolean } | null => {
    try {
      const llm = monthlyLedger.monthTotal(monthKeyString());
      const mcp = new McpCostTracker(home).monthTotalUsd(monthKeyString());
      return { spentUsd: llm.spentUsd + mcp - monthlyFlushed.flushedUsd, incomplete: llm.incomplete };
    } catch {
      return null;
    }
  };
  const agent = new Agent(provider, {
    workdir: resolve(args.workdir),
    mode,
    maxTurns,
    interactive: opts?.interactive ?? true,
    skillsDirs: opts?.skillsDirs,
      // 单技能启停（对齐 Codex `[[skills.config]] enabled=false`）：config.skills.disabled
      skillsDisabled: (() => {
        const sk = (config as Record<string, unknown>).skills;
        if (!sk || typeof sk !== "object") return [];
        const d = (sk as Record<string, unknown>).disabled;
        return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : [];
      })(),
    contextWindowTokens: windowResolved.window,
    contextWindowSource: windowResolved.source,
    contextWindowModel: windowResolved.model,
    autoCompactEnabled: args.autoCompact,
    // 缺口 4：分应用文风学习——--channel 指定本次运行的代笔渠道，按画像注入提示词。
    channel: args.channel ?? null,
    autoCompactThreshold: args.autoCompactThreshold ?? undefined,
    poppyEnabled: args.poppy,
    home,
    // P2-2：成本硬顶。单价从 config.pricing 按模型名解析；未配置时金额未知（不编造）。
    // 管理员锁定（config.enforced）优先于 CLI 与 config：被锁的键改不动。
    maxCostUsd: (() => {
      const enf = resolveEnforced(config).values;
      if (typeof enf.max_cost_usd === "number") return enf.max_cost_usd;
      return args.maxCost ?? (typeof config.max_cost_usd === "number" ? config.max_cost_usd : null);
    })(),
    pricing: resolvePricing(config.pricing, provider.model),
    // 缺口 29：月度支出硬顶（与 --max-cost 同级硬停；默认不设上限，见 docs/cost.md）。
    monthlyCostLimitUsd: monthlyLimit,
    monthlySpentBeforeUsd,
    // 辅助任务走便宜模型（对齐 Alma 的 Tool Model）：压缩与子任务默认模型。
    auxModels: (() => { const r = resolveAuxRouting(config, provider.model); return { compact: r.compact, delegate: r.delegate }; })(),
    // 缺口 5：对话中途手动换模型的允许列表（primary + fallback_providers，
    // 与兜底链同一份名单；不受 fallback_enabled 开关影响，见 config.ts）。
    modelSwitchAllowlist: resolveSwitchAllowlist(config, primaryCfg.name),
    // 工具集裁剪（config.disabled_tools + --disable-tool）：每轮少发 schema = 每轮省钱。
    disabledTools: [...(Array.isArray(config.disabled_tools) ? config.disabled_tools.filter((t): t is string => typeof t === "string") : []), ...args.disableTools],
    // 工具检索（延迟加载）：config.tool_search.enabled 打开后只发核心工具 + 已揭示的。
    // 跨会话回忆（features.run_recall 默认开）：上次同类任务的结论注入系统提示。
    recallNote: (() => {
      const feats = resolveFeatures(config, { enable: args.enableFeatures, disable: args.disableFeatures });
      if (!featureOn(feats, "run_recall")) return null;
      try {
        const store = new RunStore(join(home, "runs"));
        return buildRecallNote(store.list(), args.task ?? "", { workdir: resolve(args.workdir), limit: 3 });
      } catch {
        return null; // 历史读不了不该挡住本次运行
      }
    })(),    // --add-dir / config.extra_writable_dirs：显式放开工作目录之外的可写根。
    extraDirs: (() => {
      const cfgDirs = Array.isArray(config.extra_writable_dirs)
        ? config.extra_writable_dirs.filter((x): x is string => typeof x === "string")
        : [];
      const { ok, rejected } = resolveExtraDirs([...cfgDirs, ...args.addDirs], { workdir: resolve(args.workdir) });
      for (const r of rejected) process.stderr.write(`忽略 --add-dir ${r.input}：${r.reason}\n`);
      return ok;
    })(),
    toolSearch: (() => {
      const ts = config.tool_search;
      if (!ts || typeof ts !== "object") return { enabled: false };
      const o = ts as Record<string, unknown>;
      return {
        // 两条路都算数：显式 config.tool_search.enabled，或 features.tool_search 开关。
        enabled: o.enabled === true || featureOn(resolveFeatures(config, { enable: args.enableFeatures, disable: args.disableFeatures }), "tool_search"),
        topK: typeof o.top_k === "number" ? o.top_k : undefined,
        always: Array.isArray(o.always) ? o.always.filter((x): x is string => typeof x === "string") : undefined,
      };
    })(),
    sandbox: {
      backend: sandboxSettings.backend,
      mode: sandboxSettings.mode as "read-only" | "workspace-write" | "danger-full-access",
      allowNet: sandboxSettings.allowNet,
    },
  });
  switchAgent.current = agent;
  return { agent, providerName: primaryCfg.name, config, home, monthly: { ledger: monthlyLedger, flushed: monthlyFlushed }, onModelSwitch };
}

// ---- 缺口 20：用量账本 flush ----
// 把一次运行的累计用量增量写进账本（热力图与月度硬顶的事实源）。
// own 事件（usage/cost_update）：按上次 flush 的快照算增量；
// delegate_usage：子任务独立累计，全量当增量记。账本写失败绝不破坏运行。
function makeUsageFlusher(built: BuiltAgent): {
  flush: (agent: Agent, kind: string, data: Record<string, unknown>) => void;
  flushNow: (agent: Agent) => void;
} {
  const ledger = built.monthly.ledger;
  let lastSnap: UsageSnapshot | null = null;
  let lastSpent: number | null = null;
  const recordOwn = (agent: Agent): void => {
    const snap = agent.usage.snapshot();
    const spent = agent.lastCost?.status === "priced" ? agent.lastCost.spentUsd : null;
    const rec = ledger.recordDelta(snap, lastSnap, spent, lastSpent, agent.provider.model);
    // 只有主 agent 自己的已落盘花费才进 flushedUsd：月度口径 = 账本 - flushedUsd
    // + 本次运行进行中花费；子任务的花费已在账本里、但不在主 agent 快照里，
    // 不能扣，扣了就会漏计子任务。
    if (rec && rec.spent_usd !== null) built.monthly.flushed.flushedUsd += rec.spent_usd;
    lastSnap = snap;
    lastSpent = spent;
  };
  return {
    flush: (agent, kind, data) => {
      try {
        if (kind === "delegate_usage") {
          const snap = data.snapshot as unknown as UsageSnapshot | undefined;
          if (snap && typeof snap === "object") {
            const spent = typeof data.spent_usd === "number" ? data.spent_usd : null;
            ledger.recordDelta(snap, null, spent, null, typeof data.model === "string" ? data.model : null);
          }
        } else if (kind === "usage" || kind === "cost_update") {
          recordOwn(agent);
        }
      } catch { /* 账本写失败不破坏运行 */ }
    },
    flushNow: (agent) => {
      try { recordOwn(agent); } catch { /* ignore */ }
    },
  };
}

function verifySetup(args: CliArgs, config: Record<string, unknown>, workdir: string): { command: string | null; skipReason: string | null } {
  const [command, source] = resolveVerifyOrigin(args.verify, config, workdir);
  if (!command) return { command: null, skipReason: null };
  const [accepted, reason] = acceptVerifyCommand(command, source, {
    trustAgents: args.trustAgentsVerify,
    interactive: process.stdin.isTTY,
  });
  return { command: accepted, skipReason: reason };
}

// ---- 子命令：ui（第 3 阶段：单 gateway） ----
async function handleUi(argv: string[], workdir: string, home: string): Promise<number> {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  const host = get("--host") ?? "127.0.0.1";
  const portRaw = get("--port");
  const port = portRaw !== undefined ? parseInt(portRaw, 10) : 8765;
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    process.stderr.write("错误：--port 必须是 0–65535 的整数\n");
    return 2;
  }
  const printJson = has("--print-url-json");
  const exitOnStdinClose = has("--exit-on-stdin-close");
  const pair = has("--pair");
  const config = loadConfig(home);
  const gateway = new Gateway({
    home, workdir,
    host: pair && host === "127.0.0.1" ? "0.0.0.0" : host,
    port,
    mode: get("--mode") ?? undefined,
    providerName: get("--provider") ?? null,
    model: get("--model") ?? null,
    profile: get("--profile") ?? null,
    verbose: has("--verbose"),
    config,
  });
  let info: { host: string; port: number; url: string };
  try {
    info = await gateway.start();
  } catch (err) {
    process.stderr.write(`错误：无法监听 ${host}:${port}：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  gateway.startScheduler(60);
  const url = info.url;
  if (printJson) {
    // 桌面外壳契约：stdout 第一行是一行 JSON（nyra/version/url/host/port/token），
    // 人读的提示一律改到 stderr；stdin 关闭即退出（退出码 0）。
    process.stdout.write(JSON.stringify(gateway.urlJson()) + "\n");
    process.stderr.write(`Nyra ${VERSION} 网页界面已启动：${url}\n`);
    process.stderr.write("这个链接里含有本次启动的访问 token，请不要分享。\n");
  } else {
    process.stdout.write(`Nyra ${VERSION} 网页界面已启动：${url}\n`);
    process.stdout.write("这个链接里含有本次启动的访问 token，请不要分享。按 Ctrl+C 停止。\n");
  }
  if (pair) {
    try {
      const pairing = gateway.startPairing();
      const line = `手机配对码 ${pairing.code}（${Math.floor(Number(pairing.expires_in) / 60)} 分钟内有效，一次性，输错 5 次作废）；用手机扫下面的二维码，或打开 ${pairing.url} 并输入配对码。`;
      const out = printJson ? process.stderr : process.stdout;
      let qr = "";
      try {
        // 终端里画二维码（本机生成，不调第三方）；非 TTY / NO_COLOR 时不带 ANSI 颜色。
        const ansi = Boolean(out.isTTY) && !process.env.NO_COLOR;
        qr = qrToTerminal(qrEncode(String(pairing.url), "M"), { ansi }) + "\n";
      } catch { qr = ""; }
      out.write(qr + line + "\n");
      out.write("只在可信的局域网里配对；已配对的设备可在网页“设置 → 手机”里撤销。\n");
    } catch (err) {
      process.stderr.write(`无法生成配对码：${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (has("--open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
      const child = spawn(opener, args, { detached: true, stdio: "ignore" });
      child.unref();
    } catch { /* 打不开浏览器不阻塞服务 */ }
  }
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await gateway.stop();
  };
  const done = new Promise<number>((resolvePromise) => {
    process.once("SIGINT", () => { void stop().then(() => resolvePromise(0)); });
    process.once("SIGTERM", () => { void stop().then(() => resolvePromise(0)); });
    if (exitOnStdinClose) {
      process.stdin.resume();
      process.stdin.once("end", () => { void stop().then(() => resolvePromise(0)); });
      process.stdin.once("close", () => { void stop().then(() => resolvePromise(0)); });
    }
  });
  return done;
}

// ---- 子命令：gw（连正在跑的 gateway 当客户端） ----
async function handleGw(argv: string[]): Promise<number> {
  const flags = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const rest = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--url" && argv[i - 1] !== "--token");
  const action = rest[0];
  const client = new GatewayClient({ url: flags("--url"), token: flags("--token") });
  if (!client.token) {
    process.stderr.write("错误：gw 需要 gateway token（--token 或 NYRA_GATEWAY_TOKEN；启动 nyra ui 时终端会打印含 token 的链接）\n");
    return 2;
  }
  try {
    if (action === "sessions") {
      const data = await client.sessions() as { sessions: { id: string; count: number; preview: string }[] };
      if (!data.sessions.length) process.stdout.write("暂无历史会话\n");
      else for (const s of data.sessions) process.stdout.write(`- ${s.id}（${s.count} 条消息）${s.preview}\n`);
      return 0;
    }
    if (action === "send") {
      const id = rest[1];
      const text = rest.slice(2).join(" ");
      if (!id || !text) { process.stderr.write("用法：nyra gw send <会话 id> <消息>\n"); return 2; }
      const out = await client.send(id, text) as { status: string; error: string };
      process.stdout.write(`已发送到 ${id}，状态：${out.status}${out.error ? `（${out.error}）` : ""}\n`);
      return 0;
    }
    if (action === "view") {
      const id = rest[1];
      if (!id) { process.stderr.write("用法：nyra gw view <会话 id>\n"); return 2; }
      const view = await client.sessionView(id) as { status: string; messages: { role: string; content: unknown }[] };
      process.stdout.write(`状态：${view.status}\n`);
      for (const m of view.messages) process.stdout.write(`[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}\n`);
      return 0;
    }
    if (action === "approve") {
      const id = rest[1];
      if (!id) { process.stderr.write("用法：nyra gw approve <审批 id> [--always]\n"); return 2; }
      await client.decide(id, true, argv.includes("--always"));
      process.stdout.write(`已批准 ${id}\n`);
      return 0;
    }
    if (action === "rewind") {
      const id = rest[1];
      const messageId = Number(rest[2]);
      const op = rest[3] as "truncate" | "edit" | "fork";
      const text = rest.slice(4).join(" ") || null;
      if (!id || !Number.isInteger(messageId) || !["truncate", "edit", "fork"].includes(op)) {
        process.stderr.write("用法：nyra gw rewind <会话 id> <消息 id> <truncate|edit|fork> [新文本]\n");
        return 2;
      }
      const out = await client.rewind(id, messageId, op, text) as { kept: number; deleted: number; new_session_id: string | null };
      process.stdout.write(`回退完成：保留 ${out.kept} 条，删除 ${out.deleted} 条${out.new_session_id ? `，新会话 ${out.new_session_id}` : ""}\n`);
      return 0;
    }
    if (action === "info") {
      const info = await client.info() as { version: string; mode: string; provider: string; model: string };
      process.stdout.write(`Nyra ${info.version} · 模式 ${info.mode} · ${info.provider} / ${info.model}\n`);
      return 0;
    }
    if (action === "schedule") {
      const data = await client.schedule() as { tasks: { name: string; enabled?: boolean }[] };
      if (!data.tasks.length) process.stdout.write("暂无定时任务\n");
      else for (const t of data.tasks) process.stdout.write(`- ${t.name}${t.enabled === false ? "（已停用）" : ""}\n`);
      return 0;
    }
    process.stderr.write("用法：nyra gw <sessions|send|view|approve|rewind|info|schedule>\n");
    return 2;
  } catch (err) {
    process.stderr.write(`gateway 调用失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：schedule ----
async function handleSchedule(argv: string[], workdir: string): Promise<number> {
  const action = argv[0];
  const home = resolveHome();
  if (!action) {
    process.stdout.write("用法：nyra schedule <list|add|remove|run|daemon> [选项]\n");
    return 2;
  }
  try {
    const data = loadSchedule();
    if (action === "list") {
      for (const t of listScheduleTasks(data)) {
        process.stdout.write(`${t.name}\t${t.enabled === false ? "禁用" : "启用"}\t${t.every_seconds ? `每 ${t.every_seconds} 秒` : t.at}\t${t.last_status ?? ""}\n`);
      }
      return 0;
    }
    if (action === "add") {
      const get = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
      };
      const name = get("--name");
      const prompt = get("--prompt");
      if (!name || !prompt) { process.stderr.write("错误：schedule add 需要 --name 与 --prompt\n"); return 2; }
      const every = get("--every") ? parseInt(get("--every")!, 10) : null;
      const at = get("--at") ?? null;
      const mode = get("--mode") ?? "auto";
      addScheduleTask(data, { name, prompt, every_seconds: every, at, mode, enabled: !argv.includes("--disable") });
      saveSchedule(data);
      process.stdout.write(`已添加定时任务：${name}\n`);
      return 0;
    }
    if (action === "remove") {
      const get = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
      };
      const name = get("--name") ?? argv[1];
      if (!name) { process.stderr.write("错误：schedule remove 需要 --name\n"); return 2; }
      if (!removeScheduleTask(data, name)) { process.stderr.write(`错误：没有名为 ${name} 的定时任务\n`); return 2; }
      saveSchedule(data);
      process.stdout.write(`已删除定时任务：${name}\n`);
      return 0;
    }
    if (action === "run" || action === "daemon") {
      const intervalIdx = argv.indexOf("--interval");
      const interval = intervalIdx >= 0 ? parseFloat(argv[intervalIdx + 1]) : 60.0;
      const roundsIdx = argv.indexOf("--rounds");
      const rounds = roundsIdx >= 0 ? parseInt(argv[roundsIdx + 1], 10) : null;
      const factory = async (task: ScheduleTask): Promise<string> => {
        const { agent } = await buildAgent({ ...parseArgs([]), workdir: task.workdir ?? workdir, mode: task.mode }, { interactive: false });
        return agent.run(task.prompt);
      };
      const done = await runDaemon(factory, { interval, path: undefined, stopAfter: action === "run" ? 1 : rounds });
      void done;
      return 0;
    }
    process.stderr.write(`错误：未知子命令 schedule ${action}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 子命令：memory ----
const PLUGIN_USAGE = `用法：
  nyra plugin list                    列出已安装插件
  nyra plugin search [关键词]         在登记表里找插件
  nyra plugin install <本地目录|git URL>  安装插件（只装显式指定的来源）
  nyra plugin uninstall <名字>        卸载插件（用户改过的文件保留并报告）
  nyra plugin enable <名字>           启用插件
  nyra plugin disable <名字>          停用插件
  nyra plugin verify [名字]           按锁定文件验哈希（不给名字则验全部）
  nyra plugin audit                   生命周期 + 全部验哈希
  nyra plugin pin <名字>              固定插件（不豁免 stale，只是不自动归档）
  nyra plugin unpin <名字>            取消固定`;

async function handlePlugin(argv: string[], home: string): Promise<number> {
  const [cmd, arg] = argv;
  try {
    if (cmd === "list" || cmd === undefined) {
      const plugins = listPlugins(home);
      if (!plugins.length) { process.stdout.write("未安装插件\n"); return 0; }
      for (const p of plugins) {
        process.stdout.write(`- ${p.name} ${p.version}（${p.status}${p.pinned ? "，pinned" : ""}，来源：${p.source}）\n`);
      }
      return 0;
    }
    if (cmd === "search") {
      const found = searchRegistry(home, arg);
      if (!found.length) { process.stdout.write("登记表里没有匹配的插件\n"); return 0; }
      for (const e of found) {
        process.stdout.write(`- ${e.name} ${e.version}${e.description ? `：${e.description}` : ""}（来源：${e.source}）\n`);
      }
      return 0;
    }
    if (cmd === "install") {
      if (!arg) { process.stderr.write("缺少来源：nyra plugin install <本地目录|git URL>\n"); return 2; }
      const res = installPlugin(home, arg);
      process.stdout.write(`已安装 ${res.name} ${res.version}${res.upgraded ? "（升级）" : ""}\n`);
      if (res.keptModified.length) {
        process.stdout.write(`以下文件你改过，已保留未覆盖：${res.keptModified.join("、")}\n`);
      }
      return 0;
    }
    if (cmd === "uninstall") {
      if (!arg) { process.stderr.write("缺少插件名：nyra plugin uninstall <名字>\n"); return 2; }
      const res = uninstallPlugin(home, arg);
      process.stdout.write(`已卸载 ${res.name}（删除 ${res.removed.length} 个文件）\n`);
      if (res.keptModified.length) {
        process.stdout.write(`以下文件你改过，已保留：${res.keptModified.join("、")}\n`);
      }
      return 0;
    }
    if (cmd === "enable" || cmd === "disable") {
      if (!arg) { process.stderr.write(`缺少插件名：nyra plugin ${cmd} <名字>\n`); return 2; }
      const rec = setPluginStatus(home, arg, cmd === "enable" ? "active" : "disabled");
      process.stdout.write(`已${cmd === "enable" ? "启用" : "停用"} ${rec.name}\n`);
      return 0;
    }
    if (cmd === "pin" || cmd === "unpin") {
      if (!arg) { process.stderr.write(`缺少插件名：nyra plugin ${cmd} <名字>\n`); return 2; }
      const rec = setPluginPinned(home, arg, cmd === "pin");
      process.stdout.write(`已${cmd === "pin" ? "固定" : "取消固定"} ${rec.name}\n`);
      return 0;
    }
    if (cmd === "verify") {
      const targets = arg ? [arg] : listPlugins(home).map((p) => p.name);
      if (!targets.length) { process.stdout.write("未安装插件\n"); return 0; }
      let allOk = true;
      for (const name of targets) {
        const v = verifyPlugin(home, name);
        if (!v.ok) allOk = false;
        const bad = v.files.filter((f) => f.state === "modified" || f.state === "missing");
        const held = v.files.filter((f) => f.state === "held");
        process.stdout.write(`${name}：${v.ok ? "通过" : "有问题"}${bad.length ? `（${bad.map((f) => `${f.rel}:${f.state === "modified" ? "被改过" : "缺失"}`).join("、")}）` : ""}${held.length ? `（保留用户改过的文件 ${held.length} 个）` : ""}\n`);
      }
      return allOk ? 0 : 1;
    }
    if (cmd === "audit") {
      const { staleNow, verified } = auditPlugins(home);
      if (staleNow.length) process.stdout.write(`已降级为 stale（超过 ${STALE_AFTER_DAYS} 天没用过）：${staleNow.join("、")}\n`);
      else process.stdout.write("没有新降级的插件\n");
      for (const v of verified) {
        process.stdout.write(`${v.name}：${v.ok ? "通过" : "有问题"}\n`);
      }
      return verified.every((v) => v.ok) ? 0 : 1;
    }
    process.stderr.write(`未知插件子命令：${cmd ?? ""}\n${PLUGIN_USAGE}\n`);
    return 2;
  } catch (err: unknown) {
    if (err instanceof PluginError) {
      process.stderr.write(`插件操作失败：${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function handleCreator(argv: string[], home: string, workdir: string): Promise<number> {
  const CREATOR_USAGE = "用法：\n"
    + "  nyra creator \"<一句话需求>\" [--yes]   对齐 spec → 生成插件 → 验证 → 确认后安装\n"
    + "  nyra creator verify <staging 目录>     只验证 staging 插件（不安装）\n"
    + "  nyra creator install <staging 目录> [--yes]  验证后安装 staging 插件\n"
    + "例子：nyra creator \"做个番茄钟\" --yes；nyra creator \"扫描 TODO\" --yes";
  try {
    const cmd = argv[0];
    if (cmd === "verify") {
      const dir = argv[1];
      if (!dir) { process.stderr.write("缺少 staging 目录：nyra creator verify <目录>\n"); return 2; }
      const report = verifyStagedPlugin(resolve(dir));
      if (report.ok) {
        process.stdout.write(`验证通过：${report.manifest?.name ?? "未知插件"} v${report.manifest?.version ?? "?"}\n`);
        process.stdout.write(describePlannedChanges(report) + "\n");
        return 0;
      }
      process.stderr.write(`验证未通过：\n${report.errors.map((e) => `- ${e}`).join("\n")}\n`);
      return 1;
    }
    if (cmd === "install") {
      const dir = argv[1];
      if (!dir) { process.stderr.write("缺少 staging 目录：nyra creator install <目录> [--yes]\n"); return 2; }
      const yes = argv.includes("--yes");
      const report = verifyStagedPlugin(resolve(dir));
      if (!report.ok) {
        process.stderr.write(`验证未通过，拒绝安装：\n${report.errors.map((e) => `- ${e}`).join("\n")}\n`);
        return 1;
      }
      if (!yes) {
        process.stdout.write(describePlannedChanges(report) + "\n");
        const choice = await askApproval("确认安装这个插件吗？");
        if (choice !== "yes") {
          process.stdout.write("已取消，未安装任何东西。\n");
          return 0;
        }
      }
      const { install } = installStagedPlugin(home, resolve(dir));
      process.stdout.write(`已安装 ${install.name} ${install.version}\n`);
      process.stdout.write(`停用：nyra plugin disable ${install.name}；卸载：nyra plugin uninstall ${install.name}\n`);
      return 0;
    }
    // 默认：nyra creator "<一句话>" [--yes]
    const request = argv.filter((a) => a !== "--yes").join(" ").trim();
    if (!request || cmd === "--help" || cmd === "-h") {
      process.stdout.write(CREATOR_USAGE + "\n");
      return cmd === "--help" || cmd === "-h" ? 0 : 2;
    }
    const yes = argv.includes("--yes");
    const result = await runCreator(request, { home, workdir, autoApprove: yes });
    process.stdout.write(`spec 已存档：${result.specPath}\n`);
    process.stdout.write(result.changes + "\n");
    if (result.status === "awaiting-approval") {
      const choice = await askApproval("确认安装这个插件吗？");
      if (choice !== "yes") {
        process.stdout.write("已取消，未安装任何东西。\n");
        return 0;
      }
      const { install } = installStagedPlugin(home, result.stagingDir);
      process.stdout.write(`已安装 ${install.name} ${install.version}\n`);
      process.stdout.write(`停用：nyra plugin disable ${install.name}；卸载：nyra plugin uninstall ${install.name}\n`);
      return 0;
    }
    process.stdout.write(`已安装 ${result.install?.name} ${result.install?.version}\n`);
    process.stdout.write(`停用：nyra plugin disable ${result.install?.name}；卸载：nyra plugin uninstall ${result.install?.name}\n`);
    return 0;
  } catch (err: unknown) {
    if (err instanceof CreatorError || err instanceof PluginError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function handleMemory(argv: string[], home: string): Promise<number> {
  const { exportSnapshot, importSnapshot, importChatZip, readLocalCodex, readLocalClaude, readLocalDir, EXPORT_PROMPT } = await import("./memoryExchange.ts");
  const cmd = argv[0];
  // 缺口 1：nyra memory search <关键词> [--limit N] [--session <会话 id>]
  if (cmd === "search") {
    const { searchMemoryEntries, formatMemorySearchResults } = await import("./memory.ts");
    const rest = argv.slice(1);
    const limitIdx = rest.indexOf("--limit");
    const limit = limitIdx >= 0 ? parseInt(rest[limitIdx + 1], 10) : 5;
    const sessIdx = rest.indexOf("--session");
    const sessionId = sessIdx >= 0 ? rest[sessIdx + 1] : undefined;
    const query = rest.filter((a, i) => a !== "--limit" && a !== "--session" && !(limitIdx >= 0 && i === limitIdx + 1) && !(sessIdx >= 0 && i === sessIdx + 1)).join(" ");
    if (!query.trim()) { process.stderr.write("用法：nyra memory search <关键词> [--limit N] [--session <会话 id>]\n"); return 2; }
    const results = searchMemoryEntries(join(home, "MEMORY.md"), query, { limit: Number.isFinite(limit) ? limit : 5, session_id: sessionId, home });
    if (!results.length) { process.stdout.write("没有找到相关记忆。\n"); return 0; }
    process.stdout.write(formatMemorySearchResults(results) + "\n");
    return 0;
  }
  // 缺口 2：nyra memory forget <id...> [--session <会话 id>] [--yes]
  // 缺省先列出要删的条目再问一次；--yes 跳过确认（脚本里用）。
  if (cmd === "forget" || cmd === "delete") {
    const { previewMemoryDelete, deleteMemoryEntries, memoryOwnerForPath } = await import("./memory.ts");
    const { EvidenceStore } = await import("./evidence.ts");
    const rest = argv.slice(1);
    const yes = rest.includes("--yes");
    const sessIdx = rest.indexOf("--session");
    const sessionId = sessIdx >= 0 ? rest[sessIdx + 1] : undefined;
    const ids = rest.filter((a, i) => a !== "--yes" && a !== "--session" && !(sessIdx >= 0 && i === sessIdx + 1));
    const memoryPath = join(home, "MEMORY.md");
    if (!ids.length && !sessionId) { process.stderr.write("用法：nyra memory forget <记忆 id...> [--session <会话 id>] [--yes]\n"); return 2; }
    let preview;
    try {
      preview = previewMemoryDelete(memoryPath, { ids: ids.length ? ids : undefined, session_id: sessionId, home });
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    if (preview.notFound.length) process.stdout.write(`未找到：${preview.notFound.join("、")}\n`);
    if (!preview.targets.length) { process.stdout.write("没有可删除的记忆。\n"); return 0; }
    process.stdout.write(`将删除 ${preview.targets.length} 条记忆（删后剩 ${preview.remaining} 条）：\n`);
    for (const e of preview.targets) process.stdout.write(`- [${e.id}] ${e.text}\n`);
    if (!yes) {
      const choice = await askApproval("确认删除这些记忆吗？");
      if (choice !== "yes") { process.stdout.write("已取消，未删除任何东西。\n"); return 0; }
    }
    let result;
    try {
      result = deleteMemoryEntries(memoryPath, { ids: ids.length ? ids : undefined, session_id: sessionId, home });
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    try {
      const owner = memoryOwnerForPath(memoryPath, home);
      new EvidenceStore(join(home, "evidence"), "memory").save(
        "memory_delete",
        `memory://${owner}`,
        [
          "nyra memory forget（终端）",
          `记忆文件：${memoryPath}（${owner}）`,
          "批准：用户（终端确认）",
          `删了 ${result.deleted.length} 条，删后剩 ${result.remaining} 条：`,
          ...result.deleted.map((e) => `- [${e.id}] ${e.text}（来源会话：${e.source_session ?? "未记录"}；${e.created_at || "时间未记录"}）`),
        ].join("\n"),
      );
    } catch { /* 证据落盘失败不破坏删除结果 */ }
    process.stdout.write(`已删除 ${result.deleted.length} 条记忆，剩余 ${result.remaining} 条。\n`);
    return 0;
  }
  if (cmd === "export") {
    // exportSnapshot 要的是记忆文件路径，不是 Nyra 家目录。
    process.stdout.write(exportSnapshot(join(home, "MEMORY.md")) + "\n");
    return 0;
  }
  if (cmd === "export-prompt") {
    process.stdout.write(EXPORT_PROMPT);
    return 0;
  }
  if (cmd === "import") {
    const { readFileSync } = await import("node:fs");
    const text = argv[1] ? readFileSync(argv[1], "utf-8") : await new Promise<string>((res) => {
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (c: string) => { data += c; });
      process.stdin.on("end", () => res(data));
    });
    const result = importSnapshot(text, join(home, "MEMORY.md"));
    process.stdout.write(`已导入 ${result.added} 条，跳过 ${result.skipped} 条（已存在），删掉 ${result.removed} 行含凭据的内容。\n`);
    return 0;
  }
  if (cmd === "local") {
    const kind = argv[1];
    try {
      let text: string;
      // 本地记忆读的是用户家目录（~/.codex、~/.claude），不是 Nyra 家目录。
      if (kind === "codex") text = readLocalCodex();
      else if (kind === "claude") text = readLocalClaude();
      else if (kind === "dir") text = readLocalDir(argv[2] ?? "");
      else { process.stderr.write("用法：nyra memory local <codex|claude|dir> [路径]\n"); return 2; }
      process.stdout.write(text + "\n");
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (cmd === "import-zip") {
    try {
      const result = importChatZip(argv[1], home);
      process.stdout.write(`已导入 ${result.conversations} 条对话，原文存档：${result.archived}${result.removed ? `（已删掉 ${result.removed} 行含凭据的内容）` : ""}\n`);
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (cmd === "peer") {
    process.stdout.write("配对读记忆在 Node 版第 3 阶段，暂走 Python 版：python3 -m nyra.memory_exchange peer <配对码> [主机 端口]\n");
    return 2;
  }
  process.stdout.write("用法：nyra memory <export|export-prompt|import|local|import-zip|peer|search|forget>\n");
  return 2;
}

// ---- 子命令：style（缺口 4：分应用文风学习） ----
async function handleStyle(argv: string[], home: string): Promise<number> {
  const STYLE_USAGE = "用法：\n"
    + "  nyra style learn <渠道> <样本文件|-> [--yes]   从已发送消息样本提炼文风画像（先展示、确认后才保存；样本原文不保存）\n"
    + "  nyra style show [渠道]                        查看画像（不给渠道列出全部）\n"
    + "  nyra style list                               列出已有画像的渠道\n"
    + "  nyra style delete <渠道> [--yes]              删除画像\n"
    + "  nyra style export                             导出全部画像（Markdown，可随记忆快照走）\n"
    + "  nyra style import [文件]                      导入画像（只追加不覆盖；不给文件读 stdin）\n"
    + "渠道：gmail、outlook、slack、imessage、whatsapp 等小写名；详见 docs/style.md";
  const {
    learnStyleProfile, parseSamples, saveStyleProfile, loadStyleProfile,
    listStyleProfiles, deleteStyleProfile, formatStyleProfile, StyleError,
  } = await import("./style.ts");
  const { EvidenceStore } = await import("./evidence.ts");
  const cmd = argv[0];
  const readInput = async (src: string): Promise<string> => {
    if (src === "-") {
      return new Promise<string>((res) => {
        let data = "";
        process.stdin.setEncoding("utf-8");
        process.stdin.on("data", (c: string) => { data += c; });
        process.stdin.on("end", () => res(data));
      });
    }
    const { readFileSync } = await import("node:fs");
    return readFileSync(src, "utf-8");
  };
  try {
    // nyra style learn <渠道> <样本文件|-> [--yes]
    // 缺省先展示提炼出的画像再问一次；--yes 跳过确认（脚本里用，仍是用户显式调用）。
    if (cmd === "learn") {
      const channel = argv[1];
      const src = argv[2];
      const yes = argv.includes("--yes");
      if (!channel || !src || src === "--yes") {
        process.stderr.write("用法：nyra style learn <渠道> <样本文件|-> [--yes]\n");
        return 2;
      }
      let text: string;
      try {
        text = await readInput(src);
      } catch {
        process.stderr.write(`读不到样本文件：${src}\n`);
        return 1;
      }
      let profile;
      try {
        profile = learnStyleProfile(channel, parseSamples(text));
      } catch (err: unknown) {
        process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      process.stdout.write("提炼出的文风画像（样本原文不会保存）：\n" + formatStyleProfile(profile) + "\n");
      if (!yes) {
        const choice = await askApproval("确认保存这套文风画像吗？");
        if (choice !== "yes") { process.stdout.write("已取消，未保存任何东西。\n"); return 0; }
      }
      const path = saveStyleProfile(home, profile);
      try {
        new EvidenceStore(join(home, "evidence"), "style").save(
          "style_learn",
          `style://${profile.channel}`,
          [
            "nyra style learn（终端）",
            `渠道：${profile.channel}`,
            `批准：用户（${yes ? "--yes 显式调用" : "终端确认"}）`,
            `样本：${profile.sample_count} 条用户已发送消息（原文未保存，只存了提炼出的习惯）`,
            "学到的画像：",
            formatStyleProfile(profile),
          ].join("\n"),
        );
      } catch { /* 证据落盘失败不破坏保存结果 */ }
      process.stdout.write(`已保存 ${profile.channel} 的文风画像（${profile.sample_count} 条样本提炼）：${path}\n`);
      process.stdout.write(`代笔时用它：nyra --channel ${profile.channel} "<任务>"\n`);
      return 0;
    }
    // nyra style show [渠道]
    if (cmd === "show") {
      const channel = argv[1];
      if (channel) {
        let profile;
        try {
          profile = loadStyleProfile(home, channel);
        } catch (err: unknown) {
          process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
          return 1;
        }
        if (!profile) { process.stdout.write(`没有 ${channel} 的文风画像，先用 nyra style learn ${channel} <样本文件> 学一套。\n`); return 0; }
        process.stdout.write(formatStyleProfile(profile) + "\n");
        return 0;
      }
      const channels = listStyleProfiles(home);
      if (!channels.length) { process.stdout.write("还没有文风画像，先用 nyra style learn <渠道> <样本文件> 学一套。\n"); return 0; }
      for (const c of channels) {
        const profile = loadStyleProfile(home, c);
        if (profile) process.stdout.write(formatStyleProfile(profile) + "\n\n");
      }
      return 0;
    }
    // nyra style list
    if (cmd === "list") {
      const channels = listStyleProfiles(home);
      if (!channels.length) { process.stdout.write("还没有文风画像。\n"); return 0; }
      for (const c of channels) process.stdout.write(`- ${c}\n`);
      return 0;
    }
    // nyra style delete <渠道> [--yes]
    if (cmd === "delete") {
      const channel = argv[1];
      const yes = argv.includes("--yes");
      if (!channel) { process.stderr.write("用法：nyra style delete <渠道> [--yes]\n"); return 2; }
      let profile;
      try {
        profile = loadStyleProfile(home, channel);
      } catch (err: unknown) {
        process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      if (!profile) { process.stdout.write(`没有 ${channel} 的文风画像，无需删除。\n`); return 0; }
      process.stdout.write("将删除以下文风画像：\n" + formatStyleProfile(profile) + "\n");
      if (!yes) {
        const choice = await askApproval("确认删除这套文风画像吗？");
        if (choice !== "yes") { process.stdout.write("已取消，未删除任何东西。\n"); return 0; }
      }
      deleteStyleProfile(home, channel);
      try {
        new EvidenceStore(join(home, "evidence"), "style").save(
          "style_delete",
          `style://${channel}`,
          [
            "nyra style delete（终端）",
            `渠道：${channel}`,
            `批准：用户（${yes ? "--yes 显式调用" : "终端确认"}）`,
            "删掉的画像：",
            formatStyleProfile(profile),
          ].join("\n"),
        );
      } catch { /* 证据落盘失败不破坏删除结果 */ }
      process.stdout.write(`已删除 ${channel} 的文风画像。\n`);
      return 0;
    }
    // nyra style export
    if (cmd === "export") {
      const { exportStylesSnapshot } = await import("./memoryExchange.ts");
      const text = exportStylesSnapshot(home);
      if (!text) { process.stdout.write("还没有文风画像。\n"); return 0; }
      process.stdout.write(text);
      return 0;
    }
    // nyra style import [文件]
    if (cmd === "import") {
      const { importStylesSnapshot } = await import("./memoryExchange.ts");
      const src = argv[1];
      let text: string;
      try {
        text = src ? await readInput(src) : await readInput("-");
      } catch {
        process.stderr.write(`读不到导入文件：${src}\n`);
        return 1;
      }
      const result = importStylesSnapshot(home, text);
      process.stdout.write(`已导入 ${result.added} 套文风画像，跳过 ${result.skipped} 套${result.removed ? `（已删掉 ${result.removed} 行含凭据的内容）` : ""}。\n`);
      return 0;
    }
    process.stdout.write(STYLE_USAGE + "\n");
    return cmd === undefined || cmd === "--help" || cmd === "-h" ? 0 : 2;
  } catch (err: unknown) {
    if (err instanceof StyleError) {
      process.stderr.write(`错误：${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

// ---- 子命令：hooks（调研报告第 1 项：Hooks 确定性钩子层，学 Claude Code） ----
// 缺口 19：除 shell 脚本外也列出 config 里的 prompt/agent 条目（含 matcher）。
async function handleHooks(argv: string[], home: string): Promise<number> {
  const HOOKS_USAGE = "用法：\n  nyra hooks list   列出已安装的钩子";
  const cmd = argv[0];
  if (cmd !== undefined && cmd !== "list") {
    process.stderr.write(`未知钩子子命令：${cmd}\n${HOOKS_USAGE}\n`);
    return 2;
  }
  const entries = listHookEntries(home);
  if (!entries.length) {
    process.stdout.write("未安装任何钩子。\n");
    process.stdout.write(`放脚本的位置：${join(home, "hooks", "<事件>.d")}/，例如 ${join(home, "hooks", "PreToolUse.d", "lint.sh")}\n`);
    process.stdout.write("事件：PreToolUse、PostToolUse、SessionStart、SessionEnd、PermissionRequest、SubagentStart、SubagentStop、Stop、PreCompact、PostCompact；用法与例子见 docs/hooks.md。\n");
    return 0;
  }
  for (const event of HOOK_EVENTS) {
    const items = entries.filter((h) => h.event === event);
    if (!items.length) continue;
    process.stdout.write(`${event}：\n`);
    for (const h of items) {
      const matcher = h.tools ? `（仅 ${h.tools.join("、")}）` : "";
      if (h.kind === "command") process.stdout.write(`- [command] ${h.path ?? h.label}${matcher}\n`);
      else if (h.kind === "prompt") process.stdout.write(`- [prompt] ${h.label}${h.model ? `（模型 ${h.model}）` : ""}${matcher}\n`);
      else if (h.kind === "agent") process.stdout.write(`- [agent] ${h.label}${h.model ? `（模型 ${h.model}）` : ""}${matcher}\n`);
      else process.stdout.write(`- [无效] ${h.label}：${h.invalidReason ?? "格式错误"}（用 /status 查看）\n`);
    }
  }
  return 0;
}

// ---- 子命令：status（缺口 19：/status 诊断清单，学 Claude Code 2.1.327） ----
// 只读：只检查、不改任何状态；有错误配置时返回 1（供脚本把关），警告不影响返回码。
async function handleStatus(home: string, workdir: string): Promise<number> {
  const report = runStatusChecks({ home, workdir });
  process.stdout.write(formatStatusReport(report) + "\n");
  return report.errors > 0 ? 1 : 0;
}

// ---- 子命令：evidence（P1-2：证据链独立复核） ----
async function handleEvidence(argv: string[], home: string): Promise<number> {
  const [cmd, runId, ...rest] = argv;
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    process.stdout.write(
      "用法：nyra evidence verify <运行 ID>\n" +
      "独立复核指定运行的证据链（工具调用 → 产物 → 校验结果），不信任状态字段本身，\n" +
      "逐项重算：验证结果、调用闭合、产物存在、产物哈希。\n" +
      "通过返回 0；链不完整返回 4（与 --verify 未通过同码）；用法错误返回 2。\n",
    );
    return EXIT_SUCCESS;
  }
  if (cmd !== "verify" || !runId || rest.length) {
    process.stderr.write("用法：nyra evidence verify <运行 ID>\n");
    return EXIT_ARGUMENT;
  }
  const store = new RunStore(join(home, "runs"));
  try {
    const result = verifyEvidenceChain(store, runId);
    const state = store.load(runId);
    process.stdout.write(formatEvidenceReport(result, computeRunStats(store, runId, state)) + "\n");
    return result.passed ? EXIT_SUCCESS : EXIT_VERIFY;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_RUNTIME;
  }
}

// ---- 子命令：restore（缺口 9，影子快照 + 文件与会话联合回滚） ----
// 回滚本身记进证据链：优先追加到该会话最新的运行记录；该会话尚无运行时
// 新建一条 restore 运行记录（状态 completed），保证 `nyra evidence` 能看到。
function recordRestoreEvidence(home: string, workdir: string, sessionId: string, fields: Record<string, unknown>): void {
  try {
    const runStore = new RunStore(join(home, "runs"));
    const runs = runStore.list().filter((r) => r.session_id === sessionId);
    if (runs.length) {
      runStore.appendEvent(runs[0].run_id, "restore", fields);
    } else {
      const state = runStore.create(`restore ${String(fields.snapshot_id ?? "")}`, sessionId, workdir, "auto", 20, "running");
      runStore.appendEvent(state.run_id, "restore", fields);
      runStore.setStatus(state.run_id, "completed");
    }
  } catch { /* 证据链写失败不影响已完成的恢复 */ }
}

function formatSnapshotLine(idx: number, rec: SnapshotRecord): string {
  const when = rec.created_at.slice(0, 19).replace("T", " ");
  const target = rec.tool_call.target ?? "（只拍会话）";
  const backend = rec.backend === "git" ? "git" : "文件";
  return `  ${idx}. ${rec.id}  ${when}  ${rec.tool_call.tool} ${target}  [${backend}]  会话 ${rec.message_count} 条`;
}

function printRestoreResult(result: RestoreResult): void {
  const files = result.files_restored.length + result.files_deleted.length;
  if (result.messages_deleted !== null) {
    process.stdout.write(t("repl.restored", {
      id: result.snapshot_id, mode: result.mode, files,
      deleted: result.messages_deleted, kept: result.messages_kept ?? 0,
    }) + "\n");
  } else {
    process.stdout.write(t("repl.restoredFilesOnly", { id: result.snapshot_id, files }) + "\n");
  }
  process.stdout.write(t("repl.restorePending", {
    tool: result.tool_call.tool, target: result.tool_call.target ?? "",
  }) + "\n");
}

function parseRestoreMode(args: string[]): RestoreMode | null {
  let mode: RestoreMode = "both";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") {
      const v = args[i + 1];
      if (v !== "both" && v !== "files" && v !== "session") return null;
      mode = v;
      i++;
    } else {
      return null;
    }
  }
  return mode;
}

async function handleRestore(argv: string[], home: string, workdir: string): Promise<number> {
  const store = new ShadowSnapshotStore(home, workdir);
  const [ref, ...rest] = argv;
  if (ref === undefined) {
    const records = store.list();
    if (!records.length) {
      process.stdout.write(t("repl.restoreNone") + "\n");
      return EXIT_SUCCESS;
    }
    process.stdout.write(t("repl.restoreList", { n: records.length }) + "\n");
    for (let i = 0; i < records.length; i++) process.stdout.write(formatSnapshotLine(i + 1, records[i]) + "\n");
    process.stdout.write(t("repl.restoreUsage") + "\n");
    return EXIT_SUCCESS;
  }
  if (ref === "--help" || ref === "-h") {
    process.stdout.write(
      "用法：nyra restore [检查点序号或 id] [--mode both|files|session]\n" +
      "不带参数列出影子快照；带检查点恢复文件与会话（默认 both：两者一起）。\n" +
      "恢复后原工具调用会重新提出，供重跑、修改后重跑，或忽略。\n",
    );
    return EXIT_SUCCESS;
  }
  const mode = parseRestoreMode(rest);
  if (mode === null) {
    process.stderr.write("用法：nyra restore [检查点序号或 id] [--mode both|files|session]\n");
    return EXIT_ARGUMENT;
  }
  try {
    const record = store.resolve(ref);
    const conv = new ConversationStore(home);
    try {
      const result = store.restore(ref, mode, {
        conversationStore: conv,
        triggeredBy: "cli",
        recordEvidence: (fields) => recordRestoreEvidence(home, workdir, record.session_id, fields),
      });
      // 无 live agent 时，会话文件也要回到快照时刻（否则 --resume 会读回已删的消息）。
      if (result.live_messages !== null) {
        saveSession(result.session_id, [...result.live_messages, { role: "user", content: buildRestoreNote(result) }], home);
      }
      printRestoreResult(result);
    } finally {
      conv.close();
    }
    return EXIT_SUCCESS;
  } catch (err: unknown) {
    process.stderr.write(t("repl.restoreFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
    return EXIT_RUNTIME;
  }
}

// ---- 子命令：vault（密码箱 CLI，与 python3 -m nyra.vault 同行为） ----
// 密钥只从环境变量 NYRA_VAULT_PASSWORD 或交互输入读，绝不从 argv 读
// （argv 会进进程表和 shell 历史）。
export interface VaultInput {
  passwords?: string[];
  secrets?: string[];
}

export async function handleVault(argv: string[], home: string, input?: VaultInput): Promise<number> {
  const path = join(home, "vault.json");
  const vault = new Vault(path);
  const pwQueue = [...(input?.passwords ?? [])];
  const secretQueue = [...(input?.secrets ?? [])];
  const ask = async (prompt: string): Promise<string> => {
    if (pwQueue.length) return pwQueue.shift()!;
    if (process.env.NYRA_VAULT_PASSWORD) return process.env.NYRA_VAULT_PASSWORD;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolvePromise) => {
      rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
    });
    return answer;
  };
  const askSecret = async (prompt: string): Promise<string> => {
    if (secretQueue.length) return secretQueue.shift()!;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolvePromise) => {
      rl.question(prompt, (a) => { rl.close(); resolvePromise(a); });
    });
    return answer;
  };
  const unlock = async (): Promise<boolean> => {
    if (!vault.exists()) {
      process.stderr.write("密码箱不存在，先运行：nyra vault init\n");
      return false;
    }
    if (!vault.unlock(await ask("主密码："))) {
      // 锁死时说清楚要等多久，而不是让用户以为密码错了（审查报告第 2 项）。
      const remaining = vault.lockoutRemainingMs();
      if (remaining > 0) {
        process.stderr.write(`尝试次数过多，请 ${Math.ceil(remaining / 1000)} 秒后再试\n`);
      } else {
        process.stderr.write("主密码错误或密码箱已损坏\n");
      }
      return false;
    }
    return true;
  };
  const cmd = argv[0];
  const rest = argv.slice(1);
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(vaultUsage());
      return 0;
    }
    if (cmd === "init") {
      if (rest.length) { process.stderr.write("init 不接受额外参数\n"); return 2; }
      if (vault.exists()) { process.stderr.write(`密码箱已存在：${path}\n`); return 1; }
      const first = await ask("主密码：");
      const second = await ask("再输一次主密码：");
      if (first !== second) { process.stderr.write("两次输入的主密码不一致\n"); return 1; }
      vault.init(first);
      process.stdout.write(`密码箱已创建：${path}\n`);
      return 0;
    }
    if (cmd === "add") {
      if (rest.length !== 1) {
        process.stderr.write("用法：nyra vault add NAME\n密钥用交互输入，绝不要写在命令行里（会进进程表和 shell 历史）。\n");
        return 2;
      }
      const name = rest[0];
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
        process.stderr.write(`名字不合法：${name}（只允许字母、数字、_ . -）\n`);
        return 1;
      }
      if (!(await unlock())) return 1;
      const secret = await askSecret("密钥：");
      if (!secret) { process.stderr.write("密钥不能为空\n"); return 1; }
      vault.add(name, secret);
      process.stdout.write(`已保存：${name}\n`);
      return 0;
    }
    if (cmd === "get") {
      if (rest.length !== 1) { process.stderr.write("用法：nyra vault get NAME\n"); return 2; }
      if (!(await unlock())) return 1;
      const value = vault.get(rest[0]);
      if (value === null) { process.stderr.write(`没有这条：${rest[0]}\n`); return 1; }
      process.stdout.write(value + "\n");
      return 0;
    }
    if (cmd === "list") {
      if (rest.length) { process.stderr.write("list 不接受额外参数\n"); return 2; }
      if (!vault.exists()) { process.stderr.write("密码箱不存在，先运行：nyra vault init\n"); return 1; }
      const names = vault.listNames();
      if (!names.length) process.stdout.write("（密码箱为空）\n");
      else for (const n of names) process.stdout.write(n + "\n");
      return 0;
    }
    if (cmd === "remove") {
      if (rest.length !== 1) { process.stderr.write("用法：nyra vault remove NAME\n"); return 2; }
      if (!(await unlock())) return 1;
      vault.remove(rest[0]);
      process.stdout.write(`已删除：${rest[0]}\n`);
      return 0;
    }
    if (cmd === "change-password") {
      if (rest.length) { process.stderr.write("change-password 不接受额外参数\n"); return 2; }
      if (!vault.exists()) { process.stderr.write("密码箱不存在，先运行：nyra vault init\n"); return 1; }
      const oldPw = await ask("旧主密码：");
      if (!vault.unlock(oldPw)) { process.stderr.write("旧主密码错误或密码箱已损坏\n"); return 1; }
      const next = await ask("新主密码：");
      const again = await ask("再输一次新主密码：");
      if (next !== again) { process.stderr.write("两次输入的新主密码不一致\n"); return 1; }
      vault.changePassword(oldPw, next);
      process.stdout.write("主密码已更换\n");
      return 0;
    }
    process.stderr.write(`未知命令：${cmd}\n${vaultUsage()}`);
    return 2;
  } catch (err: unknown) {
    if (err instanceof VaultError) {
      process.stderr.write(`错误：${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

// ---- JSON 模式 ----
/**
 * 一次性任务的会话钩子外包：SessionStart 在任务开始前触发，SessionEnd 在
 * 任务结束（成功、失败或异常退出）后于 finally 里触发——与 REPL（runRepl）
 * /网关（newSession/stop/closeSession）行为一致：一次任务一个会话，
 * 开始与结束各触发一次。会话钩子是只通知事件（超时、退出码非零都只警告、
 * 不阻塞、不改退出码）；钩子只写 stderr、不碰 stdout，--json 模式的结构化输出不受影响。
 * 注意：包在 main() 分发层，参数错误等极早退出也会触发一次开始/结束——
 * 与 REPL“启动即触发 SessionStart”的口径一致。
 */
async function withOneShotSession(args: CliArgs, fn: () => Promise<number>): Promise<number> {
  const home = resolveHome();
  const workdir = resolve(args.workdir);
  try { await runHooks("SessionStart", { home, workdir }); } catch { /* 只通知事件：钩子故障不破坏任务 */ }
  try {
    return await fn();
  } finally {
    try { await runHooks("SessionEnd", { home, workdir }); } catch { /* 同上 */ }
  }
}

async function runJson(args: CliArgs): Promise<number> {
  const lines = new JsonLines();
  try {
    if (args.planMode || args.executePlan || args.approvePlan) {
      return invalidArguments(process.stdout, "--json 与 --plan/--execute-plan 不能组合使用");
    }
    if (!args.task) return invalidArguments(process.stdout, "--json 需要任务文本");
    const built = await buildAgent(args, {
      interactive: false,
      // 缺口 20：429 冷却以 JSON 事件报出（delay_ms 是本次计划等待的毫秒数）。
      onRetry: (r) => lines.emit("rate_limit_cooldown", { provider: r.provider, attempt: r.attempt, delay_ms: r.delayMs, kind: r.kind }),
    });
    const { agent, config, home } = built;
    const workdir = resolve(args.workdir);
    const { command, skipReason } = verifySetup(args, config, workdir);
    const [timeout, retries] = resolveVerifySettings(args.verifyTimeout, args.verifyRetries, config);
    const store = new RunStore(join(home, "runs"));
    // 缺口 20 的前置修复：onEvent 必须先挂再建 recorder——recorder 捕获当时的
    // onEvent 当 previous 并转发；事后覆盖会把 recorder 的 wrapper 摘掉，
    // 事件就再也进不了 events.jsonl，统计头只能写“未知”。
    const flusher = makeUsageFlusher(built);
    agent.onEvent = (kind, data) => { flusher.flush(agent, kind, data); lines.agentEvent(kind, data); };
    const recorder = new RunRecorder(store, agent, args.task, {
      verifyCmd: command, verifySkipReason: skipReason, verifyTimeout: timeout, verifyRetries: retries,
    });
    const result = await recorder.run(args.task);
    flusher.flushNow(agent);
    const final = store.load(recorder.runId);
    lines.emit("run_completed", { run_id: recorder.runId, status: final.status });
    // P1-1：未验证通过的运行，不得在输出里宣称"已完成"。
    const note = final.status === "verify_failed"
      ? "验证命令未通过"
      : "未配置或未执行验证命令";
    const downgraded = downgradeCompletionClaim(result, final.status, note);
    if (downgraded.downgraded) {
      lines.emit("completion_downgraded", { status: final.status, claim: downgraded.claim ?? "" });
    }
    lines.emit("final", { content: downgraded.text });
    if (final.status === "verified" || final.status === "completed_unverified") return EXIT_SUCCESS;
    if (final.status === "verify_failed") return EXIT_VERIFY;
    if (final.status === "incomplete") return EXIT_INCOMPLETE;
    return EXIT_RUNTIME;
  } catch (err: unknown) {
    if (err instanceof ApprovalRequired) {
      return lines.failed("approval_required", "审批被拒绝或超时", EXIT_RUNTIME, { class: "tool_error", retryable: false, errorName: "ApprovalRequired" });
    }
    if (err instanceof AgentError && (err as Error).message === "__NO_CREDENTIALS__") {
      return lines.failed("no_credentials", "未找到可用的 API 凭据", EXIT_RUNTIME, { class: "model_error", retryable: false, errorName: "AgentError" });
    }
    // P1-3：失败分类——CI 据此决定重试还是报 bug，不必解析自然语言。
    const info = classifyFailure(err);
    return lines.failed(info.class, info.message, EXIT_RUNTIME, {
      class: info.class,
      retryable: info.retryable,
      errorName: info.errorName,
    });
  }
}

// ---- 一次性任务 ----
async function runOneShot(args: CliArgs): Promise<number> {
  const home = resolveHome();
  const config = loadConfig(home);
  const workdir = resolve(args.workdir);
  if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
    process.stderr.write(`错误：工作目录不存在：${workdir}\n`);
    return 1;
  }
  const trustExit = await ensureWorkspaceTrusted(workdir, args, config, home);
  if (trustExit !== null) return trustExit;
  // --resume-run
  if (args.resumeRun) {
    try {
      const store = new RunStore(join(home, "runs"));
      const [state, messages, count] = prepareResume(store, args.resumeRun, { workdir, home });
      // P1-4：中断前已成功的写操作幂等键——续跑时同键调用跳过，不重复执行。
      const completedKeys = loadCompletedWriteKeys(store, args.resumeRun);
      const builtResume = await buildAgent({ ...args, mode: state.mode, maxTurns: state.max_turns }, {
        interactive: true,
        onRetry: (r) => process.stderr.write(t("spinner.cooldown", { provider: r.provider, attempt: r.attempt, seconds: Math.max(1, Math.ceil(r.delayMs / 1000)) }) + "\n"),
      });
      const { agent } = builtResume;
      const flusherResume = makeUsageFlusher(builtResume);
      agent.onEvent = (kind, data) => flusherResume.flush(agent, kind, data);
      agent.ctx.resumeCompletedWriteKeys = completedKeys;
      if (completedKeys.size) process.stderr.write(`续跑幂等：${completedKeys.size} 个已成功的写操作将被跳过（不重复执行）。\n`);
      agent.messages = messages;
      agent.sessionId = state.session_id;
      const [timeout, retries] = resolveVerifySettings(args.verifyTimeout, args.verifyRetries, config);
      const recorder = new RunRecorder(store, agent, state.task, {
        state, interruptedToolCalls: count, verifyTimeout: timeout, verifyRetries: retries,
      });
      const output = await recorder.run(state.task);
      flusherResume.flushNow(agent);
      process.stdout.write(output + "\n");
      const final = store.load(recorder.runId);
      return final.status === "verify_failed" ? EXIT_VERIFY : EXIT_SUCCESS;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  // --plan / --execute-plan
  if (args.planMode || args.executePlan || args.approvePlan) {
    const badCombo =
      (args.planMode && args.executePlan) ||
      (args.approvePlan && !args.executePlan) ||
      (args.planMode && (!args.task || args.approvePlan)) ||
      (args.executePlan && (args.task !== undefined || !args.approvePlan));
    if (badCombo) {
      process.stderr.write("错误：--plan 需要任务文本；--execute-plan 需要 --approve-plan SHA256，且不能混用其他会话命令\n");
      return 2;
    }
    if (args.planMode) {
      try {
        const { agent } = await buildAgent(args, { interactive: false });
        const details = await buildPlan(agent.provider, args.task!, workdir, TOOL_SCHEMAS);
        const digest = savePlan(workdir, renderPlan(args.task!, details));
        process.stdout.write(`已生成只读计划：${join(workdir, "plan.md")}\n`);
        process.stdout.write(`SHA-256：${digest}\n`);
        process.stdout.write(`审核内容后执行：nyra --workdir ${JSON.stringify(workdir)} --execute-plan --approve-plan ${digest}\n`);
        process.stdout.write("执行阶段默认 auto：写入/命令仍需逐项确认，除非明确选择 --mode full。\n");
        return 0;
      } catch (err: unknown) {
        process.stderr.write(`规划失败：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
    }
    if (args.executePlan) {
      if (args.mode === "readonly") {
        process.stderr.write("错误：readonly 不适合执行写入计划，请使用默认 auto 模式\n");
        return 2;
      }
      try {
        const approved = readApprovedPlan(workdir, args.approvePlan!);
        const task = approvedExecutionTask(approved);
        const builtPlan = await buildAgent(args, {
          interactive: true,
          onRetry: (r) => process.stderr.write(t("spinner.cooldown", { provider: r.provider, attempt: r.attempt, seconds: Math.max(1, Math.ceil(r.delayMs / 1000)) }) + "\n"),
        });
        const { agent } = builtPlan;
        const flusherPlan = makeUsageFlusher(builtPlan);
        agent.onEvent = (kind, data) => flusherPlan.flush(agent, kind, data);
        const store = new RunStore(join(home, "runs"));
        const recorder = new RunRecorder(store, agent, task, { verifyCmd: null });
        const output = await recorder.run(task);
        flusherPlan.flushNow(agent);
        process.stdout.write(output + "\n");
        return 0;
      } catch (err: unknown) {
        process.stderr.write(`计划审批失败：${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
    }
  }
  if (!args.task) return 0; // 无任务时由 main 分派 REPL。
  try {
    const built = await buildAgent(args, {
      interactive: true,
      onRetry: (r) => process.stderr.write(t("spinner.cooldown", { provider: r.provider, attempt: r.attempt, seconds: Math.max(1, Math.ceil(r.delayMs / 1000)) }) + "\n"),
    });
    const { agent } = built;
    const flusher = makeUsageFlusher(built);
    if (args.resume) {
      const messages = loadSession(args.resume, home);
      if (messages === null) {
        process.stderr.write(`错误：找不到会话 ${args.resume}\n`);
        return 1;
      }
      agent.messages = messages;
      agent.sessionId = args.resume;
    }
    const { command, skipReason } = verifySetup(args, config, workdir);
    if (skipReason) process.stderr.write(`注意：${skipReason}\n`);
    const [timeout, retries] = resolveVerifySettings(args.verifyTimeout, args.verifyRetries, config);
    const store = new RunStore(join(home, "runs"));
    const printer = new ToolPrinter();
    // 缺口 20 的前置修复：onEvent 先挂再建 recorder（同 runJson，见该处注释）。
    agent.onEvent = (kind, data) => { flusher.flush(agent, kind, data); printer.call(kind, data); };
    const recorder = new RunRecorder(store, agent, args.task, {
      verifyCmd: command, verifySkipReason: skipReason, verifyTimeout: timeout, verifyRetries: retries,
    });
    const result = await recorder.run(args.task);
    flusher.flushNow(agent);
    const final = store.load(recorder.runId);
    // P1-1：未验证通过的运行，不得在输出里宣称"已完成"。
    const downgraded = downgradeCompletionClaim(
      result,
      final.status,
      final.status === "verify_failed" ? "验证命令未通过" : "未配置或未执行验证命令",
    );
    process.stdout.write(downgraded.text + "\n");
    process.stderr.write(t("repl.usageTitle") + "\n" + formatUsage(agent.usage.snapshot()) + "\n");
    return final.status === "verify_failed" ? EXIT_VERIFY : EXIT_SUCCESS;
  } catch (err: unknown) {
    if (err instanceof AgentError && (err as Error).message === "__NO_CREDENTIALS__") return 1;
    // P2-2：成本硬顶触发——专用退出码，便于 CI/脚本区分"超预算"与"真出错"。
    if (err instanceof AgentError && /^成本上限已超/.test((err as Error).message)) {
      process.stderr.write(`成本上限已触发：${(err as Error).message}\n`);
      return EXIT_COST;
    }
    if (err instanceof ApprovalRequired) {
      process.stderr.write(`等待审批：${(err as ApprovalRequired).tool}\n`);
      return 1;
    }
    // P1-3：非 JSON 输出也带分类前缀，人一眼能看出该重试还是该改代码。
    process.stderr.write(`错误：${formatFailureLine(classifyFailure(err))}\n`);
    return 1;
  }
}

/** 列出自定义命令（项目 .nyra/commands 与 ~/.nyra/commands 下的 .md 文件）。 */
export function listCustomCommands(workdir: string, home: string): string[] {
  // 与 Python load_commands 同语义：命令名是去 .md 的 stem，按目录顺序去重（项目优先）。
  const dirs = [join(workdir, ".nyra", "commands"), join(home, "commands")];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith(".md"))) {
      const name = f.slice(0, -3);
      if (!seen.has(name)) { seen.add(name); found.push(name); }
    }
  }
  return found;
}

// 调研报告第 3 项：上下文补齐（学 Claude Code）——/compact 的 REPL 分发解析
// （纯函数，供测试直接覆盖 REPL 分发逻辑）：
//   "/compact" → { focus: "" }（行为与原来完全一致）；
//   "/compact focus <关键词>" → { focus: "<关键词>" }；
//   其他 /compact 开头的写法（缺关键词、未知参数）→ null，调用方打印用法。
export function parseCompactCommand(text: string): { focus: string } | null {
  if (text === "/compact") return { focus: "" };
  const m = /^\/compact focus\s+(.+)$/.exec(text);
  if (m) return { focus: m[1].trim() };
  if (text === "/compact focus" || text.startsWith("/compact ")) return null;
  return null;
}

// 调研报告第 3 项：上下文补齐（学 Claude Code）——/context 的优化建议触发规则：
// 总量为 0 时无需优化；占比最高的类别超过 50% 时给出针对性建议，否则报均衡。
export function contextSuggestion(u: ContextUsage): string {
  if (u.totalChars <= 0) return t("ctx.empty");
  const parts: [string, number, string][] = [
    ["system", u.system, t("ctx.sysTop")],
    ["skills", u.skills, t("ctx.skillsTop")],
    ["history", u.history, t("ctx.historyTop")],
    ["tools", u.toolResults, t("ctx.toolsTop")],
  ];
  let top = parts[0];
  for (const p of parts) if (p[1] > top[1]) top = p;
  if (top[1] / u.totalChars <= 0.5) return t("ctx.balanced");
  return top[2];
}

// 调研报告第 3 项：上下文补齐（学 Claude Code）——/context 的打印格式：四类
// 占比 + 总量 + 模型窗口 + 优化建议。token 数是实报还是估算必须写明：实报来自
// 模型用量快照，估算按 4 字符 ≈ 1 token，只在模型没报告用量时用。
export function formatContextUsage(u: ContextUsage): string {
  const pct = (n: number) => (u.totalChars > 0 ? `${Math.round((n / u.totalChars) * 100)}%` : "0%");
  const lines = [
    t("ctx.title"),
    t("ctx.system", { n: u.system, pct: pct(u.system) }),
    t("ctx.skills", { n: u.skills, pct: pct(u.skills) }),
    t("ctx.history", { n: u.history, pct: pct(u.history) }),
    t("ctx.tools", { n: u.toolResults, pct: pct(u.toolResults) }),
    t("ctx.total", { n: u.totalChars }),
  ];
  if (u.windowTokens === null || u.windowTokens === undefined) {
    lines.push(t("ctx.windowUnset"));
  } else {
    lines.push(t("ctx.window", { n: u.windowTokens.toLocaleString("en-US"), source: windowSourceLabel(u.windowSource) }));
  }
  if (u.usedTokens === null || u.usedTokens === undefined) {
    lines.push(t("ctx.usedUnknown"));
  } else if (u.estimated) {
    lines.push(t("ctx.usedEstimated", { n: u.usedTokens.toLocaleString("en-US") }));
  } else {
    lines.push(t("ctx.usedReported", { n: u.usedTokens.toLocaleString("en-US") }));
  }
  lines.push(t("ctx.suggest", { s: contextSuggestion(u) }));
  return lines.join("\n");
}

/** 解析 /lang 命令：返回目标语言；null = 用法错误（没给参数或不是 zh/en）。 */
export function parseLangCommand(text: string): "zh" | "en" | null {
  const arg = text.trim().split(/\s+/)[1];
  return arg === undefined ? null : normalizeLang(arg);
}

// ---- REPL ----
async function runRepl(args: CliArgs): Promise<number> {
  const home = resolveHome();
  const config = loadConfig(home);
  const workdir = resolve(args.workdir);
  const trustExit = await ensureWorkspaceTrusted(workdir, args, config, home);
  if (trustExit !== null) return trustExit;
  let built: BuiltAgent;
  // 缺口 20：429 冷却回调的落点——spinner 在 buildAgent 之后才创建，
  // 先用 holder 占位，spinner 建好后再把真正的显示函数挂上去。
  let retryNotify: ((r: RetryRecord) => void) | null = null;
  try {
    built = await buildAgent(args, { interactive: true, onRetry: (r) => retryNotify?.(r) });
  } catch (err: unknown) {
    if (err instanceof AgentError && (err as Error).message === "__NO_CREDENTIALS__") return 1;
    process.stderr.write(t("err.prefix", { err: err instanceof Error ? err.message : String(err) }) + "\n");
    return 1;
  }
  const { agent } = built;
  // 调研报告第 1 项：Hooks —— REPL 会话开始/结束触发 SessionStart/SessionEnd。
  // SessionStart 在会话建立后、首个提示前等一次（只通知事件：钩子故障/超时只
  // 警告、不阻止会话开始；无钩子时 runHooks 直接返回、零 spawn）。
  // SessionEnd 由下面的 try/finally 保证（/exit、EOF 与循环内异常都走 finally）；
  // Ctrl+C 走 onReplSigint：尽力触发一次 SessionEnd，3 秒宽限后退出（130），
  // 不等满 10 秒钩子超时；连按两次 Ctrl+C 时第二次走默认行为直接退出。
  let sessionEnded = false;
  const endSessionHooks = async (): Promise<void> => {
    if (sessionEnded) return;
    sessionEnded = true;
    try { await runHooks("SessionEnd", { home, workdir }); } catch { /* 钩子通知失败不破坏退出流程 */ }
  };
  const onReplSigint = (): void => {
    void (async () => {
      await Promise.race([endSessionHooks(), new Promise((r) => setTimeout(r, 3000))]);
      process.exit(130);
    })();
  };
  process.once("SIGINT", onReplSigint);
  try { await runHooks("SessionStart", { home, workdir }); } catch { /* 同上：只通知事件 */ }
  let providerDesc = `${agent.provider.name} / ${(agent.provider as { model?: string }).model ?? ""}`;
  // 终端外观 v2：TTY 且宽度够时是品牌化欢迎屏（渐变块字 + 信息卡 + Tips）、横线输入区、
  // 彩色状态栏、spinner 与右侧小伙伴；非 TTY / TERM=dumb / 太窄时退回纯文本状态行 + "> "
  // （管道与脚本不受影响）。颜色：truecolor → 256 → 16 → NO_COLOR 无色。
  const uiColor = useColor(process.stdout);
  const uiLevel: ColorLevel = uiColor ? detectColorLevel(process.env, true) : 0;
  const uiUnicode = supportsBoxDrawing();
  const ui = { color: uiColor, level: uiLevel, unicode: uiUnicode };
  const errColor = useColor(process.stderr);
  const errUi = { color: errColor, level: (errColor ? detectColorLevel(process.env, true) : 0) as ColorLevel, unicode: uiUnicode };
  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const termCols = (): number => process.stdout.columns || 80;
  const framed = (): boolean => isTty && process.env.TERM !== "dumb" && termCols() >= 20;
  const ok = (msg: string): string => (framed() ? renderOk(msg, ui) : msg);
  const fail = (msg: string): string => (framed() ? renderError(msg, errUi) : msg);
  const branch = gitBranch(workdir);
  let petOn = petEnabledFromConfig(built.config);
  const showPet = (): boolean => framed() && petVisible({ enabled: petOn, tty: isTty, cols: termCols(), unicode: uiUnicode });
  process.stdout.write(renderHeader(
    { version: VERSION, model: providerDesc, mode: agent.mode, cwd: workdir, branch },
    { width: termCols(), ...ui, compact: !framed() },
  ).join("\n") + "\n");
  process.stdout.write((framed()
    ? renderTips({ width: termCols(), ...ui, pet: showPet() })
    : t("tips.plain")) + "\n");
  const unread = (await import("./tasks.ts")).formatUnreadInbox(home);
  if (unread) process.stdout.write(unread + "\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (prompt: string): Promise<string | null> => new Promise((resolvePromise) => {
    rl.question(prompt, (answer) => resolvePromise(answer));
  });
  // 小伙伴：只在输入框可见时画在右侧固定列（保存/恢复光标，不动 readline 的光标）。
  let frameActive = false;
  let frameCols = 0;
  const pet = new PetController(() => { if (frameActive) process.stdout.write(petSeq()); });
  const petSeq = (): string => {
    if (!frameActive) return "";
    const cols = frameCols;
    const typed = (rl as unknown as { line?: string }).line ?? "";
    if (inputRows(typed, cols) > 1) return "";
    const col = cols - PET_WIDTH + 1; // 1 起算的列号
    const rows = renderPet(pet.state, { level: uiLevel });
    let seq = "\x1b7\x1b[2A\r\x1b[2K";
    if (pet.bubble) {
      const bubble = renderBubble(pet.bubble, uiLevel);
      const bw = textWidth(stripAnsi(bubble));
      if (bw + 4 < cols) seq += `\x1b[${Math.max(1, cols - bw - 2)}G` + bubble;
    }
    seq += "\x1b8";
    rows.forEach((row, i) => {
      const d = i - 1; // 行偏移：上横线 -1、输入行 0、下横线 +1、状态栏 +2
      if (d === 0 && 2 + textWidth(typed) >= col - 1) return; // 输入快碰到小伙伴时让位
      seq += "\x1b7" + (d < 0 ? `\x1b[${-d}A` : d > 0 ? `\x1b[${d}B` : "") + `\x1b[${col}G` + row + "\x1b8";
    });
    return seq;
  };
  // spinner：只在 TTY 上转；小伙伴开着时右侧带一张同步转眼珠的小脸。
  // 它用原始的 stdout.write；agent.run 期间别处（工具、审批）的输出先收起 spinner 再写，
  // 写完整行后再恢复，避免 spinner 和别的输出挤在同一行。
  const rawOut = process.stdout.write.bind(process.stdout) as (chunk: string) => boolean;
  const spinner = new Spinner({
    write: (t) => rawOut(t), tty: framed(), level: uiLevel, unicode: uiUnicode, width: termCols,
    face: (tick) => (showPet() ? petFace("thinking", tick, uiLevel) : null),
    faceCol: () => termCols() - PET_WIDTH + 2,
  });
  let spinning = false;
  let approvalOpen = false;
  const guardStream = (stream: NodeJS.WriteStream): (() => void) => {
    const original = stream.write;
    stream.write = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
      if (!spinning) return (original as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
      spinner.pause();
      const ok2 = (original as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : "";
      if (!approvalOpen && text.endsWith("\n")) spinner.resume();
      return ok2;
    } as typeof stream.write;
    return () => { stream.write = original; };
  };
  // Bun 的 console.log 不走 process.stdout.write，单独包一层（工具的审批摘要用它打印）。
  const guardConsole = (name: "log" | "error" | "warn"): (() => void) => {
    const original = console[name];
    console[name] = (...a: unknown[]) => {
      if (!spinning) return original.apply(console, a);
      spinner.pause();
      original.apply(console, a);
      if (!approvalOpen) spinner.resume();
    };
    return () => { console[name] = original; };
  };
  const printer = new ToolPrinter(undefined, undefined, { level: uiLevel, unicode: uiUnicode });
  printer.onBeforeWrite = () => spinner.pause();
  printer.onAfterWrite = () => { if (spinning) spinner.resume(); };
  const flusher = makeUsageFlusher(built);
  // 缺口 20：429 冷却倒计时——重试要等多久，直接显示在 spinner 行上、
  // 每秒减一；非 TTY 时只写一行。等待时间就是本次重试计划的 delayMs
  //（服务端 Retry-After 与客户端退避取最大值的那一位），不是现编的。
  let cooldownTimer: ReturnType<typeof setInterval> | null = null;
  let cooldownTimeout: ReturnType<typeof setTimeout> | null = null;
  const clearCooldown = (restoreLabel: boolean): void => {
    if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
    if (cooldownTimeout) { clearTimeout(cooldownTimeout); cooldownTimeout = null; }
    if (restoreLabel && spinning) spinner.setLabel(t("spinner.thinking"));
  };
  retryNotify = (r: RetryRecord): void => {
    clearCooldown(false);
    const seconds = Math.max(1, Math.ceil(r.delayMs / 1000));
    if (!framed()) {
      process.stderr.write(t("spinner.cooldown", { provider: r.provider, attempt: r.attempt, seconds }) + "\n");
      return;
    }
    let remaining = seconds;
    const label = () => t("spinner.cooldown", { provider: r.provider, attempt: r.attempt, seconds: remaining });
    spinner.setLabel(label());
    cooldownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) clearCooldown(true);
      else spinner.setLabel(label());
    }, 1000);
    (cooldownTimer as { unref?: () => void }).unref?.();
    cooldownTimeout = setTimeout(() => clearCooldown(true), r.delayMs + 500);
    (cooldownTimeout as { unref?: () => void }).unref?.();
  };
  agent.onEvent = (kind, data) => {
    flusher.flush(agent, kind, data);
    if (kind === "tool_start" || kind === "tool_result" || kind === "usage" || kind === "cost_update" || kind === "final") {
      clearCooldown(false);
    }
    if (kind === "tool_start") spinner.setLabel(t("spinner.running", { tool: String(data.name ?? t("spinner.tool")) }));
    else if (kind === "tool_result") spinner.setLabel(t("spinner.thinking"));
    printer.call(kind, data);
  };
  // 审批：提问前收起 spinner，小伙伴举手；回答后恢复。
  approvalHooks.before = () => {
    approvalOpen = true;
    spinner.pause();
    pet.setMood("approval");
    if (!showPet()) return;
    const cols = termCols();
    const rows = renderPet("approval", { level: uiLevel });
    const bubble = renderBubble(pet.bubble ?? t("pet.approval"), uiLevel);
    const bw = textWidth(stripAnsi(bubble));
    const lines = rows.map((r, i) => {
      const left = i === 1 && bw + PET_WIDTH + 3 < cols ? " ".repeat(cols - PET_WIDTH - bw - 2) + bubble + " " : " ".repeat(cols - PET_WIDTH - 1);
      return left + r;
    });
    process.stdout.write(lines.join("\n") + "\n");
  };
  approvalHooks.after = () => {
    approvalOpen = false;
    pet.setMood("thinking");
    if (spinning) spinner.resume();
  };
  let mode = agent.mode;
  // try/finally 只为保证 SessionEnd 一定触发：循环体不重缩进，diff 保持最小。
  try {
  for (;;) {
    const contextUsage = agent.usage.last_prompt_tokens !== null && agent.usage.configuredWindow
      ? agent.usage.last_prompt_tokens / agent.usage.configuredWindow
      : null;
    let line: string | null;
    if (framed()) {
      const cols = termCols();
      const petShown = showPet();
      // Node 版暂不支持 shift+tab 切换模式（用 /mode），所以不显示该提示。
      const frame = renderInputFrame(
        // P2-3：框式状态栏同样追加成本段（上一轮算出的 lastCost；没配单价/没跑过一轮时不显示）。
        { model: providerDesc, mode, contextUsage, modeSwitchKey: false, branch, cost: dashboardCostSegment(agent.lastCost) },
        { width: cols, ...ui, reserveRight: petShown ? PET_WIDTH : 0 },
      );
      // 先画上横线并在下面预留几行（避免之后滚屏），光标回到输入行；
      // readline 显示提示符后再把下横线和状态栏画到输入行下面。readline 在
      // 退格、移动光标时会清掉光标以下的内容，所以每次按键后补画一次（只在
      // 输入还是单行时画，多行时跳过，避免和折行的输入抢位置）。小伙伴随同一次写入补画。
      process.stdout.write("\n" + frame.above.join("\n") + "\n" + "\n".repeat(frame.below.length) + `\x1b[${frame.below.length}A\r`);
      frameActive = petShown;
      frameCols = cols;
      const drawBelow = (): void => {
        const typed = (rl as unknown as { line?: string }).line ?? "";
        if (inputRows(typed, cols) > 1) return;
        process.stdout.write("\x1b7" + frame.below.map((l) => `\x1b[1B\r\x1b[2K${l}`).join("") + "\x1b8" + petSeq());
      };
      const onKey = (_s: unknown, key?: { name?: string }): void => {
        if (key && (key.name === "return" || key.name === "enter")) return;
        drawBelow();
      };
      const pending = ask(frame.prompt);
      drawBelow();
      if (petShown) pet.start();
      process.stdin.on("keypress", onKey);
      try { line = await pending; } finally {
        process.stdin.off("keypress", onKey);
        frameActive = false;
        pet.stop();
      }
      if (line !== null) {
        // 提交后：回到上横线，清掉输入框（连同上方的气泡行），留下一行暗色回显。
        const up = inputRows(line, cols) + frame.above.length;
        process.stdout.write(`\x1b[${up + 1}A\r\x1b[2K\x1b[1B\r\x1b[J` + renderEcho(line, ui) + "\n");
      }
    } else {
      // P2-3：纯文本状态行同样追加成本段（与框式状态栏同一份 lastCost）。
      process.stdout.write(formatReplStatus(providerDesc, workdir, contextUsage, mode, dashboardCostSegment(agent.lastCost)) + "\n");
      line = await ask("> ");
    }
    if (line === null) { process.stdout.write("\n"); break; }
    const text = line.trim();
    if (!text) continue;
    if (text === "/exit" || text === "/quit") break;
    if (text === "/help") {
      process.stdout.write(t("repl.help") + "\n");
      continue;
    }
    if (text === "/clear") {
      agent.messages = [];
      saveSession(agent.sessionId, [], home);
      process.stdout.write(ok(t("repl.cleared")) + "\n");
      continue;
    }
    // 调研报告第 3 项：上下文补齐（学 Claude Code）——/context 可视化与
    // /compact focus（分发走 parseCompactCommand，见该函数注释）。
    if (text === "/context") {
      process.stdout.write(formatContextUsage(agent.contextUsage()) + "\n");
      continue;
    }
    // 缺口 20：/stats 看本次会话用量与本月累计；/stats heatmap 看每日热力图。
    if (text === "/stats" || text.startsWith("/stats ")) {
      const arg = text.slice("/stats".length).trim();
      if (arg === "" ) {
        process.stdout.write(t("repl.usageTitle") + "\n" + formatUsage(agent.usage.snapshot()) + "\n" + formatMonthLine(home) + "\n");
      } else if (arg === "heatmap" || arg.startsWith("heatmap ")) {
        const weeksRaw = parseInt(arg.split(/\s+/)[1] ?? "8", 10);
        const weeks = Number.isFinite(weeksRaw) && weeksRaw >= 1 && weeksRaw <= 52 ? weeksRaw : 8;
        flusher.flushNow(agent);
        const ledger = new UsageLedger(home);
        process.stdout.write(formatHeatmap(ledger.dailyTotals(weeks * 7), { weeks }) + "\n");
      } else {
        process.stderr.write("用法：/stats；/stats heatmap [周数]\n");
      }
      continue;
    }
    // 缺口 19：/status 诊断清单（只读：坏配置、不可用沙箱、被忽略的权限设置、永不匹配的 hook matcher）。
    if (text === "/status") {
      const report = runStatusChecks({ home, workdir });
      process.stdout.write(formatStatusReport(report) + "\n");
      continue;
    }
    if (text === "/compact" || text.startsWith("/compact ")) {
      const parsed = parseCompactCommand(text);
      if (parsed === null) {
        process.stderr.write(t("repl.compactUsage") + "\n");
        continue;
      }
      try {
        const info = await agent.compact(4, parsed.focus || undefined);
        process.stdout.write(t("repl.compacted", { focus: parsed.focus ? t("repl.compactFocus", { focus: parsed.focus }) : "", before: info.before, after: info.after, method: info.method }) + "\n");
      } catch (err: unknown) {
        process.stderr.write(t("repl.compactFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
      }
      continue;
    }
    if (text.startsWith("/mode ")) {
      const next = text.slice(6).trim();
      try {
        mode = validateMode(next);
        agent.setMode(mode);
        process.stdout.write(ok(t("repl.modeSwitched", { mode })) + "\n");
      } catch {
        process.stderr.write(fail(t("repl.modeInvalid")) + "\n");
      }
      continue;
    }
    // 缺口 5：对话中途换模型（/model）。只换 provider，不动会话与工具
    // 状态（Agent.switchModel 保证）；新链以目标为 primary，兜底开关
    // 与本次运行一致；窗口与单价按新模型重配。
    if (text === "/model" || text.startsWith("/model ")) {
      const spec = text.slice("/model".length).trim();
      if (!spec) {
        const allowlist = resolveSwitchAllowlist(config, agent.provider.name);
        const fallbackOn = agent.provider instanceof FallbackProvider;
        process.stdout.write(t("repl.modelCurrent", {
          model: `${agent.provider.name} / ${agent.provider.model}`,
          allowlist: allowlist.join("、"),
          fallback: fallbackOn ? t("repl.modelFallbackOn") : t("repl.modelFallbackOff"),
        }) + "\n");
        continue;
      }
      const sep = spec.indexOf(":");
      const targetName = (sep >= 0 ? spec.slice(0, sep) : spec).trim();
      const targetModel = sep >= 0 ? spec.slice(sep + 1).trim() || undefined : undefined;
      if (!targetName) {
        process.stderr.write(fail(t("repl.modelUsage")) + "\n");
        continue;
      }
      try {
        const targetCfg = resolveProvider({ home, config, providerName: targetName, model: targetModel });
        const chain = resolveFallbackChain(config, targetCfg.name, fallbackEnabled(args) ?? undefined);
        const next = buildProviderChain(targetCfg, chain, built.onModelSwitch, {
          resolver: (n: string) => resolveProvider({ home, config, providerName: n }),
          onRetry: (r) => retryNotify?.(r),
        });
        // 推理档位与当前运行一致（provider.extraBody）。
        (next as { extraBody?: Record<string, unknown> }).extraBody = toRequestBody(resolveReasoningOptions(config));
        const manualWindow = manualWindowFromConfig(config);
        const windowResolved = resolveContextWindow({
          model: next.model, provider: targetCfg.name,
          cli: args.contextWindow, manual: manualWindow.value, manualKey: manualWindow.key,
          cache: loadModelCache(home),
        });
        const switched = agent.switchModel(next, {
          reason: "用户在对话中途手动切换模型",
          contextWindowTokens: windowResolved.window,
          contextWindowSource: windowResolved.source,
          contextWindowModel: windowResolved.model,
          pricing: resolvePricing(config.pricing, next.model),
        });
        providerDesc = `${agent.provider.name} / ${agent.provider.model}`;
        process.stdout.write(ok(t("repl.modelSwitched", { from: switched.from, to: switched.to })) + "\n");
      } catch (err: unknown) {
        process.stderr.write(fail(t("repl.modelSwitchFailed", { err: err instanceof Error ? err.message : String(err) })) + "\n");
      }
      continue;
    }
    if (text === "/pet" || text.startsWith("/pet ")) {
      const next = parsePetCommand(text, petOn);
      if (next === null) {
        process.stderr.write(fail(t("pet.usage")) + "\n");
        continue;
      }
      petOn = next;
      try { saveConfig(home, { pet: petOn }); } catch { /* 写不了配置也照样切换本次会话 */ }
      let msg = petOn ? t("pet.on") : t("pet.off");
      if (petOn && !showPet()) msg += t("pet.hidden");
      process.stdout.write(ok(msg) + "\n");
      continue;
    }
    if (text === "/lang" || text.startsWith("/lang ")) {
      // 界面语言：立即切换并写回 config.json 的 language（下次启动沿用）。
      const next = parseLangCommand(text);
      if (next === null) {
        process.stderr.write(fail(t("lang.usage", { lang: getLang() })) + "\n");
        continue;
      }
      setLang(next);
      try { saveConfig(home, { language: next }); } catch { /* 写不了配置也照样切换本次会话 */ }
      process.stdout.write(ok(t("lang.switched")) + "\n");
      continue;
    }
    if (text === "/creator") {
      try {
        mode = validateMode("creator");
        agent.setMode(mode);
        process.stdout.write(t("repl.creatorOn") + "\n");
      } catch {
        process.stderr.write(t("repl.creatorFailed") + "\n");
      }
      continue;
    }
    if (text === "/commands") {
      const found = listCustomCommands(workdir, home);
      if (!found.length) process.stdout.write(t("repl.noCommands") + "\n");
      else for (const f of found) process.stdout.write(`- ${f}\n`);
      continue;
    }
    if (text.startsWith("/rewind-msg ") || text.startsWith("/rewind-edit ") || text.startsWith("/rewind-fork ")) {
      // 对话回退（第 3 阶段 /rewind）：基于 conversations 存档，与网页/手机同一份实现。
      const store = new ConversationStore(home);
      try {
        const parts = text.split(/\s+/);
        const messageId = Number(parts[1]);
        if (!Number.isInteger(messageId) || messageId <= 0) {
          process.stderr.write(t("repl.rewindMsgUsage") + "\n");
          continue;
        }
        let result: { action: string; kept: number; deleted: number; new_session_id: string | null };
        if (text.startsWith("/rewind-msg ")) {
          result = rewindTo(store, agent.sessionId, messageId);
        } else if (text.startsWith("/rewind-fork ")) {
          result = rewindFork(store, agent.sessionId, messageId);
        } else {
          const newText = text.slice(text.indexOf(parts[1]) + parts[1].length).trim();
          if (!newText) { process.stderr.write(t("repl.rewindEditUsage") + "\n"); continue; }
          result = rewindEdit(store, agent.sessionId, messageId, newText);
        }
        if (result.action !== "fork") {
          agent.messages = storeHistoryToAgentMessages(store.history(agent.sessionId, 100000));
          saveSession(agent.sessionId, agent.messages, home);
          process.stdout.write(t("repl.rewound", { id: messageId, kept: result.kept, deleted: result.deleted }) + "\n");
        } else {
          process.stdout.write(t("repl.forked", { sid: String(result.new_session_id), kept: result.kept }) + "\n");
        }
      } catch (err: unknown) {
        process.stdout.write(t("repl.rewindFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
      } finally {
        store.close();
      }
      continue;
    }
    if (text === "/restore" || text.startsWith("/restore ")) {
      // 缺口 9：影子快照联合回滚（文件 + 会话一起，或只文件 / 只会话）。
      if (!agent.shadowSnapshots) {
        process.stdout.write(t("repl.noShadow") + "\n");
        continue;
      }
      const parts = text.split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        const records = agent.shadowSnapshots.list();
        if (!records.length) {
          process.stdout.write(t("repl.restoreNone") + "\n");
          continue;
        }
        process.stdout.write(t("repl.restoreList", { n: records.length }) + "\n");
        for (let i = 0; i < records.length; i++) process.stdout.write(formatSnapshotLine(i + 1, records[i]) + "\n");
        continue;
      }
      let mode: RestoreMode = "both";
      if (parts.length >= 3) {
        if (parts[2] === "both" || parts[2] === "files" || parts[2] === "session") mode = parts[2];
        else { process.stderr.write(t("repl.restoreUsage") + "\n"); continue; }
      }
      if (parts.length > 3) {
        process.stderr.write(t("repl.restoreUsage") + "\n");
        continue;
      }
      try {
        const result = agent.restoreShadowSnapshot(parts[1], mode, "repl");
        recordRestoreEvidence(home, workdir, agent.sessionId, {
          snapshot_id: result.snapshot_id, triggered_by: "repl", mode,
          files: [...result.files_restored, ...result.files_deleted].join(","),
          ...(result.messages_deleted !== null
            ? { messages_deleted: result.messages_deleted, messages_kept: result.messages_kept }
            : {}),
        });
        printRestoreResult(result);
      } catch (err: unknown) {
        process.stdout.write(t("repl.restoreFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
      }
      continue;
    }
    if (text === "/undo" || text === "/rewind" || text.startsWith("/rewind ")) {
      if (!agent.checkpoints) {
        process.stdout.write(t("repl.noCheckpoints") + "\n");
        continue;
      }
      let count = 1;
      if (text.startsWith("/rewind ")) {
        const pieces = text.split(/\s+/);
        if (pieces.length !== 2 || !/^\d+$/.test(pieces[1])) {
          process.stderr.write(t("repl.rewindUsage") + "\n");
          continue;
        }
        count = parseInt(pieces[1], 10);
      }
      try {
        const result = agent.checkpoints.undo(count);
        // 模型的对话记录不能默认已撤销的改动还在：把回退记成一轮用户消息。
        agent.messages.push({
          role: "user",
          content: `[Nyra 撤销记录] 已恢复最近 ${result.turns} 轮中的 ${result.files} 个本地文件；此前工具执行结果可能已失效。后续操作请重新读取文件，不要假设此前改动仍存在。`,
        });
        saveSession(agent.sessionId, agent.messages, home);
        process.stdout.write(t("repl.undone", { turns: result.turns, files: result.files }) + "\n");
      } catch (err: unknown) {
        process.stdout.write(t("repl.undoFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
      }
      continue;
    }
    agent.ctx.approvedShellCommands?.clear();
    try {
      // 回退存档（第 3 阶段）：本轮问答记入 conversations，供 /rewind-* 用。
      const store = new ConversationStore(home);
      try { store.record(agent.sessionId, "user", text); } catch { /* ignore */ }
      pet.setMood("thinking");
      spinning = framed();
      spinner.start(t("spinner.thinking"));
      const unguard = spinning
        ? [guardStream(process.stdout), guardStream(process.stderr), guardConsole("log"), guardConsole("error"), guardConsole("warn")]
        : [];
      let result: string;
      try { result = await agent.run(text); } finally {
        spinning = false;
        approvalOpen = false;
        clearCooldown(false);
        spinner.stop();
        for (const u of unguard) u();
      }
      flusher.flushNow(agent);
      try { store.record(agent.sessionId, "assistant", result); } catch { /* ignore */ }
      store.close();
      process.stdout.write((framed() ? renderReply(result, ui) : result) + "\n");
      pet.setMood("happy");
    } catch (err: unknown) {
      if (err instanceof ApprovalRequired) {
        pet.setMood("approval");
        process.stdout.write(t("approval.pending", { tool: (err as ApprovalRequired).tool }) + "\n");
        continue;
      }
      pet.setMood("worried");
      process.stderr.write(fail(t("err.prefix", { err: err instanceof Error ? err.message : String(err) })) + "\n");
    }
    agent.ctx.approvedShellCommands?.clear();
  }
  } finally {
    clearCooldown(false);
    spinner.stop();
    pet.stop();
    approvalHooks.before = undefined;
    approvalHooks.after = undefined;
    rl.close();
    await endSessionHooks();
    process.removeListener("SIGINT", onReplSigint);
  }
  flusher.flushNow(agent);
  process.stderr.write(t("repl.usageTitle") + "\n" + formatUsage(agent.usage.snapshot()) + "\n" + formatMonthLine(home) + "\n");
  return 0;
}

const PERMISSIONS_USAGE = `用法：nyra permissions <list|check|grant|revoke|audit> [选项]
  list [--site <站点>]                    列出本地授权意向
  check --site <站点> --scope <scope> [--account <别名>]
  grant --site <站点> --scope <scope> [--account <别名>] --confirm [--expect-revision <版本>]
  revoke --site <站点> --scope <scope> [--account <别名>] [--expect-revision <版本>]
  audit [--site <站点>] [--limit N]
只存本地记录，不等于已登录、OAuth 授权或真实远端执行权限。
`;

const EIGENFLUX_USAGE = `用法：nyra eigenflux <doctor|onboarding|policy> [选项]
  doctor [--room <群> --bot <机器人>] [--check]   仅做本地准备与可选 CLI 诊断
  onboarding [--room <群> --bot <机器人>] [--check]  查看入网准备步骤（均需用户前台确认）
  policy <show|allow|deny|audit> ...            本地网络限制账本（只记录上限，不等于官方授权）
EigenFlux 本地适配：不负责安装、认证、外发或自动计划任务；网络权限还需独立的 ef-onboarding 前台授权。
`;

function subFlagValue(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

function subHasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

/** Poppy 站点授权意向账本（与 Python poppy_permissions_cli.py 同口径）。 */
function handlePermissions(argv: string[], home: string): number {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const site = subFlagValue(rest, "--site");
  const scope = subFlagValue(rest, "--scope");
  const account = subFlagValue(rest, "--account");
  const limitRaw = subFlagValue(rest, "--limit");
  const revision = subFlagValue(rest, "--expect-revision");
  const confirm = subHasFlag(rest, "--confirm");
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(PERMISSIONS_USAGE);
      return 0;
    }
    const ledger = new PermissionLedger(null, home);
    let result: unknown;
    if (cmd === "list") {
      result = ledger.list(site);
    } else if (cmd === "audit") {
      result = { events: ledger.audit(site, limitRaw === null ? 30 : Number(limitRaw)) };
    } else if (cmd === "check" || cmd === "grant" || cmd === "revoke") {
      if (!site || !scope) {
        process.stderr.write(`用法：nyra permissions ${cmd} --site <站点> --scope <scope> [--account <别名>]\n`);
        return 2;
      }
      if (cmd === "check") result = ledger.check(site, scope, account);
      else if (cmd === "grant") result = ledger.grant(site, scope, account, { confirmed: confirm, expectedRevision: revision });
      else result = ledger.revoke(site, scope, account, { expectedRevision: revision });
    } else {
      process.stderr.write(`未知 permissions 命令：${cmd}\n`);
      return 2;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (err: unknown) {
    process.stderr.write(`权限账本拒绝操作：${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof PermissionConflict ? 2 : 1;
  }
}

/** EigenFlux 接入（与 Python eigenflux_adapter.py main() 同口径）。 */
function handleEigenflux(argv: string[], home: string): number {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const room = subFlagValue(rest, "--room");
  const bot = subFlagValue(rest, "--bot");
  const check = subHasFlag(rest, "--check");
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(EIGENFLUX_USAGE);
      return 0;
    }
    if (cmd === "doctor") {
      const report = eigenfluxDoctor({ root: home, room, bot, check });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return eigenfluxDoctorExitCode(report.status);
    }
    if (cmd === "onboarding") {
      const report = eigenfluxOnboarding({ root: home, room, bot, check });
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    if (cmd === "policy") {
      const op = rest[0];
      const capability = subFlagValue(rest, "--capability");
      const limitRaw = subFlagValue(rest, "--limit");
      const revision = subFlagValue(rest, "--expect-revision");
      const confirm = subHasFlag(rest, "--confirm");
      const gate = new NetworkPolicy({ root: home });
      let result: unknown;
      if (op === "allow" || op === "deny") {
        if (!capability) {
          process.stderr.write("allow/deny 需要 --capability\n");
          return 2;
        }
        result = gate.change(op, capability, { room, bot, confirmed: confirm, expectedRevision: revision });
      } else if (op === "show") {
        if (capability !== null || confirm) {
          process.stderr.write("show 不接受 --capability 或 --confirm\n");
          return 2;
        }
        result = gate.show({ room, bot });
      } else if (op === "audit") {
        if (capability !== null || confirm) {
          process.stderr.write("audit 不接受 --capability 或 --confirm\n");
          return 2;
        }
        result = gate.audit({ room, bot, limit: limitRaw === null ? 30 : Number(limitRaw) });
      } else {
        process.stderr.write(`未知 policy 操作：${op ?? ""}（应为 show|allow|deny|audit）\n`);
        return 2;
      }
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }
    process.stderr.write(`未知 eigenflux 命令：${cmd}\n`);
    return 2;
  } catch (err: unknown) {
    process.stderr.write(`EigenFlux 适配拒绝操作：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ---- 主入口 ----
export async function main(argv: string[]): Promise<number> {
  // spec 07：首次运行做原子迁移（~/.angel → ~/.nyra），只读 ~/.nyra。
  ensureNyraHome();
  // 界面语言：--lang > NYRA_LANG > config.language > 系统语言 > en（首次启动不询问）。
  // 只读 config.json 的 language（不存在不创建，--help/--version 不留副作用）。
  let langCfg: Record<string, unknown> | null = null;
  try {
    const raw = JSON.parse(readFileSync(join(resolveHome(), "config.json"), "utf-8"));
    if (raw && typeof raw === "object") langCfg = { language: (raw as Record<string, unknown>).language };
  } catch { /* 没有或坏了就按环境探测 */ }
  const langInit = initLang(argv, langCfg);
  if (langInit.error) { process.stderr.write(t("err.prefix", { err: langInit.error }) + "\n"); return 2; }
  argv = langInit.argv;
  const args = parseArgs(argv);
  if (args.unknown) {
    process.stderr.write(`${t("err.unknownOption", { opt: args.unknown })}\n${usageText()}\n`);
    return 2;
  }
  if (args.help) { process.stdout.write(usageText() + "\n"); return 0; }
  if (args.version) { process.stdout.write(`nyra ${VERSION} (node runtime)\n`); return 0; }

  const home = resolveHome();

  // 子命令优先。
  if (args.subcommand === "cost") {
    const cfgCost = loadConfig(home);
    // 回忆感知：估算前先看有没有可复用的历史（与运行时的注入同源）
    let recalledCount: number | undefined;
    const sub = args.subArgs ?? [];
    const taskIdx = sub.findIndex((a) => a === "--estimate" || !a.startsWith("-"));
    const taskText = taskIdx >= 0 ? (sub[taskIdx] === "--estimate" ? sub[taskIdx + 1] ?? "" : sub[taskIdx]) : "";
    if (taskText) {
      try {
        const store = new RunStore(join(home, "runs"));
        recalledCount = selectRecalledRuns(store.list(), taskText, { workdir: resolve(args.workdir), limit: 3 }).length;
      } catch {
        recalledCount = undefined;
      }
    }
    return handleCost(sub, cfgCost, (cfgCost.model as string) ?? null, { recalledCount, home });
  }
  if (args.subcommand === "stats") return handleStats(args.subArgs ?? [], home);
  if (args.subcommand === "models") return handleModels(args.subArgs ?? [], home);
  if (args.subcommand === "schedule") return handleSchedule(args.subArgs ?? [], resolve(args.workdir));
  if (args.subcommand === "task") return handleTask(args.subArgs ?? [], resolve(args.workdir));
  if (args.subcommand === "review") return handleReview(args.subArgs ?? [], home);
  if (args.subcommand === "kb") return knowledgeMain(args.subArgs ?? []);
  if (args.subcommand === "plugin") return handlePlugin(args.subArgs ?? [], home);
  if (args.subcommand === "creator") return handleCreator(args.subArgs ?? [], home, resolve(args.workdir));
  if (args.subcommand === "memory") return handleMemory(args.subArgs ?? [], home);
  if (args.subcommand === "style") return handleStyle(args.subArgs ?? [], home);
  if (args.subcommand === "vault") return handleVault(args.subArgs ?? [], home);
  if (args.subcommand === "hooks") return handleHooks(args.subArgs ?? [], home);
  if (args.subcommand === "verdict") {
    // 一条结论：把红线 + 省钱 + 回忆 + 运行历史拼成"这次跑得值不值"。
    const cfgV = loadConfig(home);
    const feats = resolveFeatures(cfgV, { enable: args.enableFeatures, disable: args.disableFeatures });
    const taskText = (args.subArgs ?? []).join(" ").trim() || (args.task ?? "").trim();
    const turns = typeof cfgV.max_turns === "number" ? cfgV.max_turns : 20;

    // 红线
    let redlines: RedlineResult | null = null;
    try {
      redlines = checkRedlines({
        config: cfgV,
        sandbox: resolveSandbox(cfgV),
        permissions: null,
        hasCostLimit: typeof cfgV.max_cost_usd === "number",
        toolBudget: measureToolBudget(TOOL_SCHEMAS as never),
      } as never);
    } catch { redlines = null; }

    // 省钱 + 实测
    const savings = summarizeCostSavings({
      config: cfgV,
      schemas: TOOL_SCHEMAS as never,
      disabledTools: Array.isArray(cfgV.disabled_tools) ? (cfgV.disabled_tools as string[]) : [],
      recallCount: null,
      toolSearchEnabled: featureOn(feats, "tool_search"),
      turns,
    });
    let modelSavings = null;
    try {
      modelSavings = summarizeModelSavings(new UsageLedger(home).readAll(), {
        mainModel: (cfgV.model as string) ?? null,
        mainPricing: resolvePricing(cfgV.pricing, (cfgV.model as string) ?? null),
      });
    } catch { modelSavings = null; }

    // 回忆
    let recallAvailable: number | null = null;
    if (taskText) {
      try {
        recallAvailable = selectRecalledRuns(new RunStore(join(home, "runs")).list(), taskText, {
          workdir: resolve(args.workdir), limit: 3,
        }).length;
      } catch { recallAvailable = null; }
    }

    // 运行历史状态分布
    let runStatusCounts: Record<string, number> | null = null;
    try {
      const runs = new RunStore(join(home, "runs")).list();
      const counts: Record<string, number> = {};
      for (const r of runs) {
        const st = String((r as unknown as Record<string, unknown>).status ?? "");
        if (st) counts[st] = (counts[st] ?? 0) + 1;
      }
      runStatusCounts = Object.keys(counts).length ? counts : null;
    } catch { runStatusCounts = null; }

    const verdict = buildVerdict({ redlines, savings, modelSavings, recallAvailable, runStatusCounts, turns });
    process.stdout.write(formatVerdict(verdict) + "\n");
    return verdict.grade === "red" ? EXIT_RUNTIME : EXIT_SUCCESS;
  }
  if (args.subcommand === "status") return handleStatus(home, resolve(args.workdir));
  if (args.subcommand === "savings") {
    // 把散落的省钱机制汇成一张单页：一份运行到底开了哪些、能确定省多少。
    const cfgSav = loadConfig(home);
    const feats = resolveFeatures(cfgSav, { enable: args.enableFeatures, disable: args.disableFeatures });
    const disabled = [
      ...(Array.isArray(cfgSav.disabled_tools) ? cfgSav.disabled_tools.filter((t): t is string => typeof t === "string") : []),
      ...args.disableTools,
    ];
    let recallCount: number | null = null;
    try {
      const store = new RunStore(join(home, "runs"));
      const taskText = (args.subArgs ?? []).join(" ").trim() || (args.task ?? "").trim();
      if (taskText) recallCount = selectRecalledRuns(store.list(), taskText, { workdir: resolve(args.workdir), limit: 3 }).length;
    } catch { /* 历史读不了不影响汇总 */ }
    // 账本实测：辅助模型到底省了多少（反事实 = 主模型单价 × 同样 tokens）
    const ledgerRecords = (() => { try { return new UsageLedger(home).readAll(); } catch { return []; } })();
    const modelSavings = summarizeModelSavings(ledgerRecords, {
      mainModel: (cfgSav.model as string) ?? null,
      mainPricing: resolvePricing(cfgSav.pricing, (cfgSav.model as string) ?? null),
    });
    const summary = summarizeCostSavings({
      config: cfgSav,
      schemas: TOOL_SCHEMAS as unknown as { type?: string; function?: { name?: string; description?: string } }[],
      disabledTools: disabled,
      recallCount,
      toolSearchEnabled: featureOn(feats, "tool_search"),
      turns: typeof cfgSav.max_turns === "number" ? cfgSav.max_turns : 20,
      modelSavings,
    });
    process.stdout.write(formatSavings(summary) + "\n");
    // 逐模型明细：省了多少用真实账本反事实算，不写"算不出"。
    process.stdout.write("\n" + formatModelSavings(modelSavings) + "\n");
    return EXIT_SUCCESS;
  }  if (args.subcommand === "recall") {
    // 回忆是隐式注入的，出问题时只能猜。这条命令把"这次任务能复用哪些历史"摊开给人看。
    const cfgRecall = loadConfig(home);
    const taskArg = (args.subArgs ?? []).filter((a) => a !== "--cross-dir").join(" ").trim() || (args.task ?? "").trim();
    if (!taskArg) {
      process.stderr.write("用法：nyra recall \"<任务文本>\"\n");
      return EXIT_ARGUMENT;
    }
    const feats = resolveFeatures(cfgRecall, { enable: args.enableFeatures, disable: args.disableFeatures });
    const enabled = featureOn(feats, "run_recall");
    const store = new RunStore(join(home, "runs"));
    const runs = store.list();
    // 跨目录弱复用：任务文本里带 --cross-dir 时把别的项目的历史也算进来（降权 + 标注来源）
    const crossDir = (args.subArgs ?? []).some((a) => a === "--cross-dir");
    const picked = selectRecalledRuns(runs, taskArg, { workdir: resolve(args.workdir), limit: 5, maxAgeDays: 30, allowCrossDir: crossDir });
    process.stdout.write(`回忆开关：${enabled ? "已开启" : "已关闭"}（features.run_recall）\n`);
    process.stdout.write(`历史运行：共 ${runs.length} 条，本目录 ${runs.filter((r) => (r as unknown as Record<string, unknown>).workdir === resolve(args.workdir)).length} 条\n`);
    if (!picked.length) {
      process.stdout.write("（没有可复用的历史：可能没有同类任务、或都超过 30 天、或未通过验证）\n");
      return EXIT_SUCCESS;
    }
    process.stdout.write(`可复用 ${picked.length} 条：\n`);
    for (const r of picked) {
      process.stdout.write(`  ${r.run_id}  ${r.status}  ${r.ageDays} 天前  相似度 ${(r.score * 100).toFixed(0)}%  ${r.task.slice(0, 40)}\n`);
    }
    return EXIT_SUCCESS;
  }  if (args.subcommand === "features") {
    const res = resolveFeatures(loadConfig(home), { enable: args.enableFeatures, disable: args.disableFeatures });
    process.stdout.write(formatFeatures(res) + "\n");
    return EXIT_SUCCESS;
  }  if (args.subcommand === "tools") {
    // 工具集成本体检：每轮发多少 token、谁最贵、裁掉能省多少。
    const cfgTools = loadConfig(home);
    const disabled = [
      ...(Array.isArray(cfgTools.disabled_tools) ? cfgTools.disabled_tools.filter((t): t is string => typeof t === "string") : []),
      ...args.disableTools,
    ];
    const schemas = TOOL_SCHEMAS as unknown as { function?: { name?: string } }[];
    const { kept, dropped } = filterSchemas(schemas, disabled);
    const toolsManual = manualWindowFromConfig(cfgTools);
    const toolsWindow = resolveContextWindow({
      model: (cfgTools.model as string) ?? null, provider: (cfgTools.provider as string) ?? null,
      cli: args.contextWindow, manual: toolsManual.value, manualKey: toolsManual.key,
      cache: loadModelCache(home),
    }).window;
    const full = measureToolBudget(schemas, toolsWindow);
    const after = measureToolBudget(kept, toolsWindow);
    const saving = summarizeSavings(schemas, kept);
    process.stdout.write(formatToolBudget(full) + "\n");
    if (dropped.length) {
      process.stdout.write(`已裁剪：${dropped.join("、")} → 每轮 ${after.tokensPerTurn} token（省 ${saving.tokensPerTurnSaved}，${(saving.ratio * 100).toFixed(1)}%）\n`);
    } else {
      process.stdout.write("提示：用 --disable-tool <名字> 或 config.disabled_tools 裁剪用不到的工具，每轮都会省下这部分 token。\n");
    }
    return EXIT_SUCCESS;
  }  if (args.subcommand === "config") {
    const sub = (args.subArgs ?? [])[0];
    // nyra config explain [capability]：这个能力由哪个键控制、当前生效值、来源
    if (sub === "explain") {
      const cfgEx = loadConfig(home);
      const input = { config: cfgEx, cli: { enableFeatures: args.enableFeatures, disableFeatures: args.disableFeatures, maxCost: args.maxCost, addDirs: args.addDirs } };
      const wanted = (args.subArgs ?? [])[1];
      if (wanted) {
        const one = explainOne(input, wanted);
        if (!one) {
          process.stderr.write(`未知能力：${wanted}\n可用：${explainAll(input).map((c) => c.capability).join("、")}\n`);
          return EXIT_ARGUMENT;
        }
        process.stdout.write(formatExplain([one]) + "\n");
        return EXIT_SUCCESS;
      }
      process.stdout.write(formatExplain(explainAll(input)) + "\n");
      return EXIT_SUCCESS;
    }
    return handleConfig(args.subArgs ?? [], home);
  }
  if (args.subcommand === "redlines") {
    // 上线红线自检：把 docs/VISION-NEXT.md 第七节变成可执行命令。
    const cfgRed = loadConfig(home);
    const sandboxStatus = getSandboxStatus(cfgRed, args.sandbox ?? null);
    const perms = parseRules(cfgRed.permissions as { allow?: unknown; ask?: unknown; deny?: unknown } | null);
    const result = checkRedlines({
      config: cfgRed,
      sandbox: { level: sandboxStatus.level, backend: String(sandboxStatus.backend) },
      permissions: { allow: perms.allow, ask: perms.ask, deny: perms.deny },
      hasCostLimit: typeof cfgRed.max_cost_usd === "number",
      // 阈值与忽略项：config.redlines（不同项目合理值不同）
      thresholds: (() => {
        const rl = cfgRed.redlines;
        if (!rl || typeof rl !== "object") return null;
        const t = (rl as Record<string, unknown>).thresholds;
        return t && typeof t === "object" ? (t as Record<string, number>) : null;
      })(),
      ignore: (() => {
        const rl = cfgRed.redlines;
        if (!rl || typeof rl !== "object") return null;
        const ig = (rl as Record<string, unknown>).ignore;
        return Array.isArray(ig) ? ig.filter((x): x is string => typeof x === "string") : null;
      })(),
      // 跨会话回忆：开着但没有新鲜历史 = 看起来在省，其实一点没省。
      recall: (() => {
        const feats2 = resolveFeatures(cfgRed, { enable: args.enableFeatures, disable: args.disableFeatures });
        const all = new RunStore(join(home, "runs")).list();
        const cfgRl = (cfgRed.redlines && typeof cfgRed.redlines === "object" ? (cfgRed.redlines as Record<string, unknown>).thresholds : null) as Record<string, number> | null;
        const maxAgeDays = cfgRl && typeof cfgRl.recallMaxAgeDays === "number" ? cfgRl.recallMaxAgeDays : 30;
        const cutoff = Date.now() - maxAgeDays * 86_400_000;
        const fresh = all.filter((r) => {
          const ts = Date.parse(String((r as unknown as Record<string, unknown>).created_at ?? ""));
          return Number.isFinite(ts) && ts >= cutoff;
        }).length;
        return { enabled: featureOn(feats2, "run_recall"), total: all.length, fresh };
      })(),
      platform: process.platform,
      // 工具体积：原生工具每轮都发 schema，工具多就是每轮白烧 token。
      // （延迟加载只覆盖 MCP 工具且自动开启，这里不传开关——见 redlines.ts 检查 8。）
      toolBudget: (() => {
        const schemas = TOOL_SCHEMAS as unknown as { function?: { name?: string } }[];
        const disabled = Array.isArray(cfgRed.disabled_tools) ? cfgRed.disabled_tools.filter((t): t is string => typeof t === "string") : [];
        const kept = filterSchemas(schemas, disabled).kept;
        const m = measureToolBudget(kept, typeof cfgRed.context_window === "number" ? cfgRed.context_window : null);
        return { totalTools: m.totalTools, tokensPerTurn: m.tokensPerTurn, contextRatio: m.contextRatio };
      })(),
    });
    // 与省钱机制合并输出：红线管"该不该上生产"，savings 管"上了能省多少"。
    const savingsForRedlines = summarizeCostSavings({
      config: cfgRed,
      schemas: TOOL_SCHEMAS as unknown as { type?: string; function?: { name?: string; description?: string } }[],
      disabledTools: Array.isArray(cfgRed.disabled_tools) ? cfgRed.disabled_tools.filter((t): t is string => typeof t === "string") : [],
      recallCount: result.findings.some((f) => f.code === "recall-ready") ? 1 : 0,
      toolSearchEnabled: featureOn(resolveFeatures(cfgRed, { enable: args.enableFeatures, disable: args.disableFeatures }), "tool_search"),
      turns: typeof cfgRed.max_turns === "number" ? cfgRed.max_turns : 20,
    });
    process.stdout.write(formatRedlinesWithSavings(formatRedlines(result), savingsForRedlines) + "\n");
    return result.ok ? EXIT_SUCCESS : EXIT_RUNTIME;
  }
  if (args.subcommand === "evidence") return handleEvidence(args.subArgs ?? [], home);
  if (args.subcommand === "restore") return handleRestore(args.subArgs ?? [], home, resolve(args.workdir));
  if (args.subcommand === "ui") {
    return handleUi(args.subArgs ?? [], resolve(args.workdir), home);
  }
  if (args.subcommand === "gw") {
    return handleGw(args.subArgs ?? []);
  }
  if (args.subcommand === "permissions") return handlePermissions(args.subArgs ?? [], home);
  if (args.subcommand === "eigenflux") return handleEigenflux(args.subArgs ?? [], home);
  if (args.subcommand === "doctor") {
    const { checks, allOk } = await runDoctor({ home, providerName: args.provider });
    printDoctorResult({ checks, allOk });
    return allOk ? 0 : 1;
  }
  if (args.subcommand === "setup") {
    const config = loadConfig(home);
    let provider;
    try {
      provider = resolveProvider({ home, config, providerName: args.provider });
    } catch (err) {
      console.error(t("main.configBad", { err: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
    const result = await runWizard({ home, provider, config, exampleFile: defaultExampleFile(home) });
    return result.exampleOk ? 0 : 1;
  }
  if (args.example) {
    const config = loadConfig(home);
    let provider;
    try {
      provider = resolveProvider({ home, config, providerName: args.provider });
    } catch (err) {
      console.error(t("main.configBad", { err: err instanceof Error ? err.message : String(err) }));
      return 1;
    }
    const file = args.exampleFile || defaultExampleFile(home);
    if (!existsSync(file)) { process.stderr.write(t("main.exampleMissing", { file }) + "\n"); return 2; }
    try {
      const result = runExampleTask({ home, provider: provider.name, model: provider.model, file });
      return result.rows === 100 ? 0 : 1;
    } catch (err: unknown) {
      process.stderr.write(t("main.exampleFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
      return 1;
    }
  }

  // --resume-run 不能与任务文本、--resume、计划、压缩或列表命令组合使用。
  if (args.resumeRun && (args.task !== undefined || args.resume || args.planMode || args.executePlan || args.approvePlan || args.compact || args.listMcp || args.listProfiles || args.listSessions || args.listSkills || args.inspectPoppyIdentity !== null || args.discoverPoppy !== null)) {
    const message = t("main.resumeRunCombo");
    if (args.jsonMode) return invalidArguments(process.stdout, message);
    process.stderr.write(t("err.prefix", { err: message }) + "\n");
    return 2;
  }
  if (args.inspectPoppyIdentity !== null) {
    if (args.jsonMode) return invalidArguments(process.stdout, "--inspect-poppy-identity 不能与 --json 混用");
    process.stdout.write("Poppy 身份核验在 Node 版第 3 阶段，暂走 Python 版：python3 -m nyra --inspect-poppy-identity <站点>\n");
    return 2;
  }
  if (args.discoverPoppy !== null) {
    if (args.jsonMode) return invalidArguments(process.stdout, "--discover-poppy 不能与 --json 混用");
    process.stdout.write("Poppy 发现工具在 Node 版第 3 阶段，暂走 Python 版：python3 -m nyra --discover-poppy <站点>\n");
    return 2;
  }
  if (args.jsonMode) return withOneShotSession(args, () => runJson(args));

  // 列表类命令（不用 Key、不调模型）。
  if (args.listProviders) {
    const config = loadConfig(home);
    const current = (config.provider as string) || "deepseek";
    for (const name of Object.keys(getProviderPresets(config)).sort()) {
      const p = PROVIDERS[name] ?? getProviderPresets(config)[name];
      const mark = name === current ? t("list.current") : "";
      const auth = p.auth === "cli" ? t("list.cliAuth") : name === "ollama" ? t("list.localModel") : t("list.envKey", { key: String(p.envKey) });
      process.stdout.write(t("list.providerLine", { name, mark, model: p.defaultModel ?? t("list.needModel"), auth }) + "\n");
    }
    process.stdout.write(t("list.customHint") + "\n");
    return 0;
  }
  if (args.listModels) {
    const config = loadConfig(home);
    const name = args.provider || envVar("PROVIDER") || (config.provider as string) || "deepseek";
    const preset = getProviderPresets(config)[name];
    if (!preset) { process.stderr.write(`Unknown provider: ${name}\n`); return 2; }
    try {
      const resolved = resolveProvider({ home, config, providerName: name });
      const provider = new Provider(resolved);
      const models = await provider.listModels();
      if (!models.length) { process.stdout.write(t("list.noModels", { name }) + "\n"); return 0; }
      for (const m of models) process.stdout.write(`- ${m}\n`);
      return 0;
    } catch (err: unknown) {
      process.stderr.write(t("err.prefix", { err: err instanceof Error ? err.message : String(err) }) + "\n");
      return 1;
    }
  }
  if (args.listProfiles) {
    const config = loadConfig(home);
    const names = listProfiles(config);
    if (!names.length) process.stdout.write(t("list.noProfiles") + "\n");
    else for (const n of names) process.stdout.write(`- ${n}\n`);
    return 0;
  }
  if (args.listSkills) {
    const skills = loadSkills(canonicalSkillDirs(process.cwd(), home, pluginSkillDirs(home)));
    if (!skills.length) process.stdout.write(t("list.noSkills") + "\n");
    else for (const s of skills) process.stdout.write(`- ${s.name}：${s.description}\n`);
    return 0;
  }
  if (args.listSessions) {
    const sessions = listSessions(home);
    if (!sessions.length) process.stdout.write(t("list.noSessions") + "\n");
    else for (const s of sessions) process.stdout.write(t("list.sessionLine", { id: s.id, n: s.count, preview: s.preview }) + "\n");
    return 0;
  }
  if (args.listMcp) {
    const config = loadConfig(home);
    const servers = loadMcpServers(config);
    const names = Object.keys(servers);
    if (!config.mcp_enabled || !names.length) {
      process.stdout.write(t("list.mcpOff") + "\n");
      process.stdout.write(t("list.mcpPresets", { n: listPresets().length, names: listPresets().map((p) => p.name).join(getLang() === "en" ? ", " : "、") }) + "\n");
      return 0;
    }
    process.stdout.write(t("list.mcpTitle") + "\n");
    for (const name of names) {
      const s = servers[name];
      process.stdout.write(`- ${name}：${s.command} ${s.args.join(" ")}\n`);
    }
    process.stdout.write(t("list.mcpHint") + "\n");
    return 0;
  }
  if (args.compact) {
    try {
      const { agent } = await buildAgent({ ...args, task: undefined }, { interactive: false });
      agent.sessionId = args.compact;
      const messages = loadSession(args.compact, home);
      if (messages === null) { process.stderr.write(t("main.sessionMissing", { id: args.compact }) + "\n"); return 1; }
      agent.messages = messages;
      const info = await agent.compact();
      process.stdout.write(t("main.compacted", { id: args.compact, before: info.before, after: info.after, method: info.method }) + "\n");
      return 0;
    } catch (err: unknown) {
      process.stderr.write(t("repl.compactFailed", { err: err instanceof Error ? err.message : String(err) }) + "\n");
      return 1;
    }
  }

  // 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——沙箱选择 fail-closed 校验。
  // 显式 --sandbox bwrap 但本机无 bwrap、--sandbox e2b、danger-full-access + bwrap
  // 等直接报错退出（exit 2），绝不静默降级裸奔；auto 回落到工具级不报错。
  try {
    resolveSandboxBackend(loadConfig(home), args.sandbox ?? undefined);
  } catch (err) {
    process.stderr.write(t("err.prefix", { err: err instanceof Error ? err.message : String(err) }) + "\n");
    return 2;
  }
  if (args.contextWindow !== null && (typeof args.contextWindow !== "number" || !Number.isInteger(args.contextWindow) || args.contextWindow < 1)) {
    process.stderr.write(t("err.contextWindow") + "\n");
    return 1;
  }

  if (args.task !== undefined) return withOneShotSession(args, () => runOneShot(args));
  return runRepl(args);
}

// Bun --compile 入口：直接跑 main。
if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(t("err.prefix", { err: err instanceof Error ? err.message : String(err) }) + "\n");
    process.exitCode = 1;
  });
}
