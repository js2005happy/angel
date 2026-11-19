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
  loadConfig, resolveHome, resolveProvider, resolveProfile, resolveFallbackChain,
  listProfiles, validateMode, resolveSandbox, PROVIDERS, VERSION, envVar, getProviderPresets, saveConfig,
} from "./config.ts";
import { Provider, buildProviderChain, ProviderError } from "./providers.ts";
import { Agent, AgentError, type ContextUsage } from "./agent.ts";
import { RunStore, RunRecorder, prepareResume, loadCompletedWriteKeys, resolveVerifyOrigin, acceptVerifyCommand, resolveVerifySettings, downgradeCompletionClaim, formatRunReport, verifyEvidenceChain, formatEvidenceReport } from "./runs.ts";
import { resolvePricing } from "./cost.ts";
import { handleCost } from "./costCli.ts";
import { classifyFailure, formatFailureLine } from "./failures.ts";
import { parseRules } from "./permissionRules.ts";
import { checkRedlines, formatRedlines } from "./redlines.ts";
import { handleConfig } from "./configCli.ts";
import { measureToolBudget, filterSchemas, summarizeSavings, formatToolBudget } from "./toolBudget.ts";
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
import { formatUsage } from "./usage.ts";
import { formatReplStatus, ToolPrinter, useColor, textWidth } from "./consoleUi.ts";
import { dashboardCostSegment } from "./dashboard.ts";
import { askApproval, approvalHooks } from "./approvalUi.ts";
import { JsonLines, invalidArguments, EXIT_SUCCESS, EXIT_RUNTIME, EXIT_ARGUMENT, EXIT_INCOMPLETE, EXIT_VERIFY, EXIT_INTERRUPTED, EXIT_COST } from "./jsonMode.ts";
import { buildPlan, renderPlan, savePlan, readApprovedPlan, approvedExecutionTask, PlanError } from "./planMode.ts";
import { handleTask } from "./tasks.ts";
import { loadSchedule, saveSchedule, addScheduleTask, removeScheduleTask, listScheduleTasks, runDaemon, ScheduleError, type ScheduleTask } from "./scheduler.ts";
import { knowledgeMain } from "./knowledge.ts";
import { PermissionLedger, PermissionConflict } from "./poppy.ts";
import { doctor as eigenfluxDoctor, onboardingSteps as eigenfluxOnboarding, doctorExitCode as eigenfluxDoctorExitCode } from "./eigenflux.ts";
import { NetworkPolicy } from "./eigenfluxPolicy.ts";
import { printDoctorResult, runDoctor } from "./doctor.ts";
import { t, getLang, setLang, detectLang, extractLangFlag, normalizeLang } from "./i18n.ts";
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
import { listHooks, runHooks, HOOK_EVENTS } from "./hooks.ts";
import { Gateway } from "./gateway.ts";
import { GatewayClient } from "./gatewayClient.ts";
import { ConversationStore } from "./conversations.ts";
import { rewindTo, rewindEdit, rewindFork, storeHistoryToAgentMessages } from "./rewind.ts";
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
  nyra --plan "任务"             只读分析，生成工作目录中的 plan.md，不执行
  nyra --execute-plan --approve-plan <SHA256>   执行经校验值批准的 plan.md
  nyra --verify "<命令>"         任务完成后运行验证命令（退出码 0 才算验证通过）
  nyra --json "任务"             单次非交互任务，输出 JSON Lines
  nyra schedule <list|add|remove|run|daemon>   管理定时任务
  nyra task <add|list|show|cancel|worker|approve>   管理后台任务队列
  nyra kb <create|list|add|search|ask|remove>  本地知识库
  nyra plugin <list|search|install|uninstall|enable|disable|verify|audit|pin|unpin>  插件市场（最小版：技能包，只装带来源、可审计的插件）
  nyra hooks list                列出已安装的钩子（~/.nyra/hooks/<事件>.d/ 下的脚本，详见 docs/hooks.md）
  nyra creator "<一句话需求>" [--yes]   创造模式：一句话搓出插件（先验证、经确认才安装）
  nyra memory <export|export-prompt|import|local|import-zip>  记忆交换
  nyra doctor [--provider 名字]  中文自检：运行时、配置文件、配置目录、Key、网络、磁盘、写权限、密码箱权限
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
  nyra --plan "task"             read-only analysis; writes plan.md in the workdir, runs nothing
  nyra --execute-plan --approve-plan <SHA256>   run a plan.md approved by its checksum
  nyra --verify "<command>"      run a verify command after the task (exit code 0 = verified)
  nyra --json "task"             one non-interactive task, JSON Lines output
  nyra schedule <list|add|remove|run|daemon>   manage scheduled tasks
  nyra task <add|list|show|cancel|worker|approve>   manage the background task queue
  nyra kb <create|list|add|search|ask|remove>  local knowledge base
  nyra plugin <list|search|install|uninstall|enable|disable|verify|audit|pin|unpin>  plugin market (skill packs with source, auditable)
  nyra hooks list                list installed hooks (~/.nyra/hooks/<event>.d/, see docs/hooks.md)
  nyra creator "<one-line idea>" [--yes]   creator mode: build a plugin from one sentence (verified, installed only after you confirm)
  nyra memory <export|export-prompt|import|local|import-zip>  memory exchange
  nyra doctor [--provider name]  self-check: runtime, config, home dir, key, network, disk, write access, vault permissions
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
  /** 本次运行禁用的工具（可重复 --disable-tool）。 */
  disableTools: string[];
  trustAgentsVerify: boolean;
  jsonMode: boolean; autoCompact: boolean; autoCompactThreshold: number | null;
  poppy: boolean; fallback: boolean; noFallback: boolean;
  discoverPoppy: string | null; inspectPoppyIdentity: string | null;
  provider?: string; model?: string; profile?: string;
  mode?: string; maxTurns: number | null; contextWindow: number | null;
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
    verify: null, verifyTimeout: null, verifyRetries: null, maxCost: null, disableTools: [],
    trustAgentsVerify: false, jsonMode: false, autoCompact: false,
    autoCompactThreshold: null, poppy: false, fallback: false, noFallback: false,
    discoverPoppy: null, inspectPoppyIdentity: null,
    maxTurns: null, contextWindow: null,
    workdir: ".", trust: false, sandboxTimeout: null,
    doctor: false, setup: false, example: false,
  };
  const positional: string[] = [];
  const valueFlags = new Set([
    "--provider", "--model", "--profile", "--mode", "--max-turns", "--context-window",
    "--compact", "--resume", "--resume-run", "--verify", "--verify-timeout", "--verify-retries",
    "--auto-compact-threshold", "--discover-poppy", "--inspect-poppy-identity",
    "--approve-plan", "--workdir", "--sandbox", "--sandbox-id", "--sandbox-template", "--sandbox-timeout",
    "--lang",
  ]);
  const subcommands = new Set(["tools", "config", "redlines", "evidence", "cost", "schedule", "task", "ui", "gw", "permissions", "eigenflux", "kb", "plugin", "creator", "memory", "doctor", "setup", "vault", "hooks"]);
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
        case "--disable-tool": args.disableTools.push(value); break;
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

function fallbackNotice(record: { from: string; to: string; error: string }): void {
  let reason = record.error;
  if (reason.length > 120) reason = reason.slice(0, 117) + "…";
  process.stderr.write(t("fallback.notice", { from: record.from, reason, to: record.to }) + "\n");
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
}

async function buildAgent(args: CliArgs, opts?: { interactive: boolean; skillsDirs?: string[] }): Promise<BuiltAgent> {
  const home = resolveHome();
  const config = loadConfig(home);
  const profile = resolveProfile(args.profile ?? null, config);
  const primaryCfg = resolveProvider({
    home, config,
    providerName: args.provider ?? profile.provider,
    model: args.model ?? profile.model ?? undefined,
  });
  const chain = resolveFallbackChain(config, primaryCfg.name, fallbackEnabled(args) ?? undefined);
  const provider = buildProviderChain(
    primaryCfg, chain,
    (r) => fallbackNotice(r as { from: string; to: string; error: string }),
    {
      resolver: (name: string) => resolveProvider({ home, config, providerName: name }),
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
  const agent = new Agent(provider, {
    workdir: resolve(args.workdir),
    mode,
    maxTurns,
    interactive: opts?.interactive ?? true,
    skillsDirs: opts?.skillsDirs,
    contextWindowTokens: args.contextWindow ?? (typeof config.context_window === "number" ? config.context_window : null),
    autoCompactEnabled: args.autoCompact,
    autoCompactThreshold: args.autoCompactThreshold ?? undefined,
    poppyEnabled: args.poppy,
    home,
    // P2-2：成本硬顶。单价从 config.pricing 按模型名解析；未配置时金额未知（不编造）。
    maxCostUsd: args.maxCost ?? (typeof config.max_cost_usd === "number" ? config.max_cost_usd : null),
    pricing: resolvePricing(config.pricing, provider.model),
    // 辅助任务走便宜模型（对齐 Alma 的 Tool Model）：压缩与子任务默认模型。
    auxModels: (() => { const r = resolveAuxRouting(config, provider.model); return { compact: r.compact, delegate: r.delegate }; })(),
    // 工具集裁剪（config.disabled_tools + --disable-tool）：每轮少发 schema = 每轮省钱。
    disabledTools: [...(Array.isArray(config.disabled_tools) ? config.disabled_tools.filter((t): t is string => typeof t === "string") : []), ...args.disableTools],
    sandbox: {
      backend: sandboxSettings.backend,
      mode: sandboxSettings.mode as "read-only" | "workspace-write" | "danger-full-access",
      allowNet: sandboxSettings.allowNet,
    },
  });
  return { agent, providerName: primaryCfg.name, config, home };
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
  process.stdout.write("用法：nyra memory <export|export-prompt|import|local|import-zip|peer>\n");
  return 2;
}

// ---- 子命令：hooks（调研报告第 1 项：Hooks 确定性钩子层，学 Claude Code） ----
async function handleHooks(argv: string[], home: string): Promise<number> {
  const HOOKS_USAGE = "用法：\n  nyra hooks list   列出已安装的钩子";
  const cmd = argv[0];
  if (cmd !== undefined && cmd !== "list") {
    process.stderr.write(`未知钩子子命令：${cmd}\n${HOOKS_USAGE}\n`);
    return 2;
  }
  const hooks = listHooks(home);
  if (!hooks.length) {
    process.stdout.write("未安装任何钩子。\n");
    process.stdout.write(`放脚本的位置：${join(home, "hooks", "<事件>.d")}/，例如 ${join(home, "hooks", "PreToolUse.d", "lint.sh")}\n`);
    process.stdout.write("事件：PreToolUse、PostToolUse、SessionStart、SessionEnd；用法与例子见 docs/hooks.md。\n");
    return 0;
  }
  for (const event of HOOK_EVENTS) {
    const items = hooks.filter((h) => h.event === event);
    if (!items.length) continue;
    process.stdout.write(`${event}：\n`);
    for (const h of items) process.stdout.write(`- ${h.path}\n`);
  }
  return 0;
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
    process.stdout.write(formatEvidenceReport(result) + "\n");
    return result.passed ? EXIT_SUCCESS : EXIT_VERIFY;
  } catch (err: unknown) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
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
async function runJson(args: CliArgs): Promise<number> {
  const lines = new JsonLines();
  try {
    if (args.planMode || args.executePlan || args.approvePlan) {
      return invalidArguments(process.stdout, "--json 与 --plan/--execute-plan 不能组合使用");
    }
    if (!args.task) return invalidArguments(process.stdout, "--json 需要任务文本");
    const { agent, config, home } = await buildAgent(args, { interactive: false });
    const workdir = resolve(args.workdir);
    const { command, skipReason } = verifySetup(args, config, workdir);
    const [timeout, retries] = resolveVerifySettings(args.verifyTimeout, args.verifyRetries, config);
    const store = new RunStore(join(home, "runs"));
    const recorder = new RunRecorder(store, agent, args.task, {
      verifyCmd: command, verifySkipReason: skipReason, verifyTimeout: timeout, verifyRetries: retries,
    });
    agent.onEvent = (kind, data) => lines.agentEvent(kind, data);
    const result = await recorder.run(args.task);
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
      const { agent } = await buildAgent({ ...args, mode: state.mode, maxTurns: state.max_turns }, { interactive: true });
      agent.ctx.resumeCompletedWriteKeys = completedKeys;
      if (completedKeys.size) process.stderr.write(`续跑幂等：${completedKeys.size} 个已成功的写操作将被跳过（不重复执行）。\n`);
      agent.messages = messages;
      agent.sessionId = state.session_id;
      const [timeout, retries] = resolveVerifySettings(args.verifyTimeout, args.verifyRetries, config);
      const recorder = new RunRecorder(store, agent, state.task, {
        state, interruptedToolCalls: count, verifyTimeout: timeout, verifyRetries: retries,
      });
      const output = await recorder.run(state.task);
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
        const { agent } = await buildAgent(args, { interactive: true });
        const store = new RunStore(join(home, "runs"));
        const recorder = new RunRecorder(store, agent, task, { verifyCmd: null });
        const output = await recorder.run(task);
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
    const built = await buildAgent(args, { interactive: true });
    const { agent } = built;
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
    const recorder = new RunRecorder(store, agent, args.task, {
      verifyCmd: command, verifySkipReason: skipReason, verifyTimeout: timeout, verifyRetries: retries,
    });
    const printer = new ToolPrinter();
    agent.onEvent = (kind, data) => printer.call(kind, data);
    const result = await recorder.run(args.task);
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
    lines.push(t("ctx.window", { n: u.windowTokens.toLocaleString("en-US") }));
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
  try {
    built = await buildAgent(args, { interactive: true });
  } catch (err: unknown) {
    if (err instanceof AgentError && (err as Error).message === "__NO_CREDENTIALS__") return 1;
    process.stderr.write(t("err.prefix", { err: err instanceof Error ? err.message : String(err) }) + "\n");
    return 1;
  }
  const { agent } = built;
  // 调研报告第 1 项：Hooks —— REPL 会话开始/结束触发 SessionStart/SessionEnd。
  // SessionStart 在会话建立后、首个提示前等一次（fail-open：钩子故障/超时只
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
  try { await runHooks("SessionStart", { home, workdir }); } catch { /* 同上：fail-open */ }
  const providerDesc = `${agent.provider.name} / ${(agent.provider as { model?: string }).model ?? ""}`;
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
  agent.onEvent = (kind, data) => {
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
        spinner.stop();
        for (const u of unguard) u();
      }
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
    spinner.stop();
    pet.stop();
    approvalHooks.before = undefined;
    approvalHooks.after = undefined;
    rl.close();
    await endSessionHooks();
    process.removeListener("SIGINT", onReplSigint);
  }
  process.stderr.write(t("repl.usageTitle") + "\n" + formatUsage(agent.usage.snapshot()) + "\n");
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
  if (args.subcommand === "cost") { const cfgCost = loadConfig(home); return handleCost(args.subArgs ?? [], cfgCost, (cfgCost.model as string) ?? null); }
  if (args.subcommand === "schedule") return handleSchedule(args.subArgs ?? [], resolve(args.workdir));
  if (args.subcommand === "task") return handleTask(args.subArgs ?? [], resolve(args.workdir));
  if (args.subcommand === "kb") return knowledgeMain(args.subArgs ?? []);
  if (args.subcommand === "plugin") return handlePlugin(args.subArgs ?? [], home);
  if (args.subcommand === "creator") return handleCreator(args.subArgs ?? [], home, resolve(args.workdir));
  if (args.subcommand === "memory") return handleMemory(args.subArgs ?? [], home);
  if (args.subcommand === "vault") return handleVault(args.subArgs ?? [], home);
  if (args.subcommand === "hooks") return handleHooks(args.subArgs ?? [], home);
  if (args.subcommand === "tools") {
    // 工具集成本体检：每轮发多少 token、谁最贵、裁掉能省多少。
    const cfgTools = loadConfig(home);
    const disabled = [
      ...(Array.isArray(cfgTools.disabled_tools) ? cfgTools.disabled_tools.filter((t): t is string => typeof t === "string") : []),
      ...args.disableTools,
    ];
    const schemas = TOOL_SCHEMAS as unknown as { function?: { name?: string } }[];
    const { kept, dropped } = filterSchemas(schemas, disabled);
    const full = measureToolBudget(schemas, args.contextWindow ?? (typeof cfgTools.context_window === "number" ? cfgTools.context_window : null));
    const after = measureToolBudget(kept, args.contextWindow ?? (typeof cfgTools.context_window === "number" ? cfgTools.context_window : null));
    const saving = summarizeSavings(schemas, kept);
    process.stdout.write(formatToolBudget(full) + "\n");
    if (dropped.length) {
      process.stdout.write(`已裁剪：${dropped.join("、")} → 每轮 ${after.tokensPerTurn} token（省 ${saving.tokensPerTurnSaved}，${(saving.ratio * 100).toFixed(1)}%）\n`);
    } else {
      process.stdout.write("提示：用 --disable-tool <名字> 或 config.disabled_tools 裁剪用不到的工具，每轮都会省下这部分 token。\n");
    }
    return EXIT_SUCCESS;
  }  if (args.subcommand === "config") return handleConfig(args.subArgs ?? [], home);
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
      platform: process.platform,
    });
    process.stdout.write(formatRedlines(result) + "\n");
    return result.ok ? EXIT_SUCCESS : EXIT_RUNTIME;
  }
  if (args.subcommand === "evidence") return handleEvidence(args.subArgs ?? [], home);
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
  if (args.jsonMode) return runJson(args);

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

  if (args.task !== undefined) return runOneShot(args);
  return runRepl(args);
}

// Bun --compile 入口：直接跑 main。
if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(t("err.prefix", { err: err instanceof Error ? err.message : String(err) }) + "\n");
    process.exitCode = 1;
  });
}
