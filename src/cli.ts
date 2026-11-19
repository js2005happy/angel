// src/cli.ts — Nyra Node 版命令行入口（第 2 阶段）。
// 命令与 flag 与 Python 版 nyra/cli.py 一一对应：一次性任务 / REPL /
// schedule 子命令 / task 子命令 / --plan / --execute-plan / --resume /
// --resume-run / --verify / --list-providers / --list-skills / --json / --mode。
// 终端交互按方案 2.6 末尾：审核选择器默认是、REPL 状态行、命令实时流式输出。
// permissions / eigenflux 在第 4 阶段已原生化（src/poppy.ts、src/eigenflux.ts、
// src/eigenfluxPolicy.ts）；worker 桥与 Python 运行时已移除。
// ui（gateway）与 MCP 客户端在第 3 阶段已原生化。
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, realpathSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadConfig, resolveHome, resolveProvider, resolveProfile, resolveFallbackChain,
  listProfiles, validateMode, resolveSandbox, PROVIDERS, VERSION, envVar, getProviderPresets,
} from "./config.ts";
import { Provider, buildProviderChain, ProviderError } from "./providers.ts";
import { Agent, AgentError } from "./agent.ts";
import { RunStore, RunRecorder, prepareResume, resolveVerifyOrigin, acceptVerifyCommand, resolveVerifySettings, formatRunReport } from "./runs.ts";
import { loadSession, listSessions, saveSession, newSessionId } from "./memory.ts";
import { loadSkills } from "./skills.ts";
import { renderBanner } from "./banner.ts";
import { formatUsage } from "./usage.ts";
import { formatReplStatus, ToolPrinter } from "./consoleUi.ts";
import { askApproval } from "./approvalUi.ts";
import { JsonLines, invalidArguments, EXIT_SUCCESS, EXIT_RUNTIME, EXIT_ARGUMENT, EXIT_INCOMPLETE, EXIT_VERIFY, EXIT_INTERRUPTED } from "./jsonMode.ts";
import { buildPlan, renderPlan, savePlan, readApprovedPlan, approvedExecutionTask, PlanError } from "./planMode.ts";
import { handleTask } from "./tasks.ts";
import { loadSchedule, saveSchedule, addScheduleTask, removeScheduleTask, listScheduleTasks, runDaemon, ScheduleError, type ScheduleTask } from "./scheduler.ts";
import { knowledgeMain } from "./knowledge.ts";
import { PermissionLedger, PermissionConflict } from "./poppy.ts";
import { doctor as eigenfluxDoctor, onboardingSteps as eigenfluxOnboarding, doctorExitCode as eigenfluxDoctorExitCode } from "./eigenflux.ts";
import { NetworkPolicy } from "./eigenfluxPolicy.ts";
import { printDoctorResult, runDoctor } from "./doctor.ts";
import { runExampleTask } from "./exampleTask.ts";
import { printNoKeyAndExitCode } from "./noKey.ts";
import { defaultExampleFile, runWizard } from "./wizard.ts";
import { ensureNyraHome } from "./migration.ts";
import { ApprovalRequired, TOOL_SCHEMAS } from "./tools.ts";
import { Vault, vaultUsage, VaultError } from "./vault.ts";
import { runCreator, verifyStagedPlugin, installStagedPlugin, describePlannedChanges, CreatorError } from "./creator.ts";
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
  nyra --resume <会话 ID>        继续指定会话
  nyra --resume-run <运行 ID>    从运行记录断点续跑
  nyra --plan "任务"             只读分析，生成工作目录中的 plan.md，不执行
  nyra --execute-plan --approve-plan <SHA256>   执行经校验值批准的 plan.md
  nyra --verify "<命令>"         任务完成后运行验证命令（退出码 0 才算验证通过）
  nyra --json "任务"             单次非交互任务，输出 JSON Lines
  nyra schedule <list|add|remove|run|daemon>   管理定时任务
  nyra task <add|list|show|cancel|worker|approve>   管理后台任务队列
  nyra kb <create|list|add|search|ask|remove>  本地知识库
  nyra plugin <list|search|install|uninstall|enable|disable|verify|audit|pin|unpin>  插件市场（最小版：技能包，只装带来源、可审计的插件）
  nyra creator "<一句话需求>" [--yes]   创造模式：一句话搓出插件（先验证、经确认才安装）
  nyra memory <export|export-prompt|import|local|import-zip>  记忆交换
  nyra doctor [--provider 名字]  中文自检：运行时、配置文件、配置目录、Key、网络、磁盘、写权限、密码箱权限
  nyra setup                     首次启动向导
  nyra --example [文件]          本地示例任务（不调模型、不花钱）
  nyra ui                        网页界面（本地网页，含模式切换与创造模式）
  nyra permissions ...           Poppy 站点授权意向（本地账本，只记录不授权）
  nyra eigenflux ...             EigenFlux 接入检测与本地网络限制（第 4 阶段已原生化）

模型兜底默认关闭（只用户开启、只切允许列表内服务商）。`;

export interface CliArgs {
  help: boolean; version: boolean;
  listProviders: boolean; listModels: boolean; listProfiles: boolean;
  listSkills: boolean; listSessions: boolean; listMcp: boolean;
  compact: string | null; resume: string | null; resumeRun: string | null;
  planMode: boolean; executePlan: boolean; approvePlan: string | null;
  verify: string | null; verifyTimeout: number | null; verifyRetries: number | null;
  trustAgentsVerify: boolean;
  jsonMode: boolean; autoCompact: boolean; autoCompactThreshold: number | null;
  poppy: boolean; fallback: boolean; noFallback: boolean;
  discoverPoppy: string | null; inspectPoppyIdentity: string | null;
  provider?: string; model?: string; profile?: string;
  mode?: string; maxTurns: number | null; contextWindow: number | null;
  workdir: string; trust: boolean;
  sandbox?: string | null; sandboxId?: string | null; sandboxTemplate?: string | null; sandboxTimeout: number | null;
  doctor: boolean; setup: boolean; example: boolean; exampleFile?: string;
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
    verify: null, verifyTimeout: null, verifyRetries: null,
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
  ]);
  const subcommands = new Set(["schedule", "task", "ui", "gw", "permissions", "eigenflux", "kb", "plugin", "creator", "memory", "doctor", "setup", "vault"]);
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
  process.stdout.write("未找到可用的 API 凭据。\n设置方法（二选一）：\n");
  process.stdout.write("  1. 环境变量：export DEEPSEEK_API_KEY=<redacted>\n     或通用：export NYRA_API_KEY=<redacted>\n");
  process.stdout.write("  2. 已保存的连接器：如果 DeepSeek / xAI 的 Key 已通过安全流程保存，直接用 --provider deepseek 或 --provider xai 即可，无需再填 Key。\n");
  process.stdout.write(`当前 provider：${providerName}\n`);
}

function fallbackEnabled(args: CliArgs): boolean | null {
  if (args.noFallback) return false;
  if (args.fallback) return true;
  return null;
}

function fallbackNotice(record: { from: string; to: string; error: string }): void {
  let reason = record.error;
  if (reason.length > 120) reason = reason.slice(0, 117) + "…";
  process.stderr.write(`模型切换：${record.from} 失败（${reason}），已切换到 ${record.to} 继续\n`);
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
      process.stderr.write(`警告：无法记录工作区信任：${err instanceof Error ? err.message : String(err)}\n`);
    }
    return null;
  }
  if (config.skip_workspace_trust) return null;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return null;
  if (isTrusted(workdir, home)) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolvePromise) => {
    rl.question(`首次在工作目录 ${resolve(workdir)} 运行 Nyra。信任该目录吗？（y/N）`, (a) => { rl.close(); resolvePromise(a); });
  });
  if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
    process.stdout.write("已拒绝信任该工作目录。\n");
    return 1;
  }
  try { addTrusted(workdir, home); } catch (err: unknown) {
    process.stderr.write(`警告：无法记录工作区信任（本次仍继续）：${err instanceof Error ? err.message : String(err)}\n`);
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
    throw new Error("--max-turns 必须为正整数");
  }
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
      const line = `手机配对码 ${pairing.code}（${Math.floor(Number(pairing.expires_in) / 60)} 分钟内有效，一次性）；手机打开 ${pairing.url} 并输入配对码。`;
      if (printJson) process.stderr.write(line + "\n");
      else process.stdout.write(line + "\n");
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
    lines.emit("final", { content: result });
    if (final.status === "verified" || final.status === "completed_unverified") return EXIT_SUCCESS;
    if (final.status === "verify_failed") return EXIT_VERIFY;
    if (final.status === "incomplete") return EXIT_INCOMPLETE;
    return EXIT_RUNTIME;
  } catch (err: unknown) {
    if (err instanceof ApprovalRequired) {
      return lines.failed("approval_required", "审批被拒绝或超时", EXIT_RUNTIME);
    }
    if (err instanceof AgentError && (err as Error).message === "__NO_CREDENTIALS__") {
      return lines.failed("no_credentials", "未找到可用的 API 凭据", EXIT_RUNTIME);
    }
    return lines.failed("runtime_error", err instanceof Error ? err.message : String(err), EXIT_RUNTIME);
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
      const { agent } = await buildAgent({ ...args, mode: state.mode, maxTurns: state.max_turns }, { interactive: true });
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
    process.stdout.write(result + "\n");
    const final = store.load(recorder.runId);
    process.stderr.write("本次运行用量：\n" + formatUsage(agent.usage.snapshot()) + "\n");
    return final.status === "verify_failed" ? EXIT_VERIFY : EXIT_SUCCESS;
  } catch (err: unknown) {
    if (err instanceof AgentError && (err as Error).message === "__NO_CREDENTIALS__") return 1;
    if (err instanceof ApprovalRequired) {
      process.stderr.write(`等待审批：${(err as ApprovalRequired).tool}\n`);
      return 1;
    }
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
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
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const { agent } = built;
  const printer = new ToolPrinter();
  agent.onEvent = (kind, data) => printer.call(kind, data);
  const providerDesc = `${agent.provider.name} / ${(agent.provider as { model?: string }).model ?? ""}`;
  process.stdout.write(renderBanner(VERSION, providerDesc, agent.mode, agent.sessionId) + "\n");
  process.stdout.write("输入 /help 查看命令，/exit 退出。\n");
  const unread = (await import("./tasks.ts")).formatUnreadInbox(home);
  if (unread) process.stdout.write(unread + "\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (prompt: string): Promise<string | null> => new Promise((resolvePromise) => {
    rl.question(prompt, (answer) => resolvePromise(answer));
  });
  let mode = agent.mode;
  for (;;) {
    const contextUsage = agent.usage.last_prompt_tokens !== null && agent.usage.configuredWindow
      ? agent.usage.last_prompt_tokens / agent.usage.configuredWindow
      : null;
    const status = formatReplStatus(providerDesc, workdir, contextUsage, mode);
    process.stdout.write(status + "\n");
    const line = await ask("nyra> ");
    if (line === null) { process.stdout.write("\n"); break; }
    const text = line.trim();
    if (!text) continue;
    if (text === "/exit" || text === "/quit") break;
    if (text === "/help") {
      process.stdout.write("命令：/help 帮助；/exit 退出；/clear 清空会话；/compact 压缩会话；/mode <readonly|auto|full|creator> 切换模式；/creator 进入创造模式；/commands 列出自定义命令；/undo 撤销最近一轮改动；/rewind N 撤销最近 N 轮文件改动；/rewind-msg <消息 id> 回退到该消息；/rewind-edit <消息 id> <新文本> 编辑重发；/rewind-fork <消息 id> fork 新会话。\n");
      continue;
    }
    if (text === "/clear") {
      agent.messages = [];
      saveSession(agent.sessionId, [], home);
      process.stdout.write("会话已清空。\n");
      continue;
    }
    if (text === "/compact") {
      try {
        const info = await agent.compact();
        process.stdout.write(`已压缩：${info.before} 条 → ${info.after} 条（${info.method}）\n`);
      } catch (err: unknown) {
        process.stderr.write(`压缩失败：${err instanceof Error ? err.message : String(err)}\n`);
      }
      continue;
    }
    if (text.startsWith("/mode ")) {
      const next = text.slice(6).trim();
      try {
        mode = validateMode(next);
        agent.setMode(mode);
        process.stdout.write(`已切换到 ${mode} 模式。\n`);
      } catch {
        process.stderr.write("模式必须是 readonly / auto / full / creator。\n");
      }
      continue;
    }
    if (text === "/creator") {
      try {
        mode = validateMode("creator");
        agent.setMode(mode);
        process.stdout.write("已进入创造模式：一句话描述想要的功能，我来对齐 spec、生成插件、验证后请你确认安装。\n");
      } catch {
        process.stderr.write("切换到创造模式失败。\n");
      }
      continue;
    }
    if (text === "/commands") {
      const found = listCustomCommands(workdir, home);
      if (!found.length) process.stdout.write("还没有自定义命令。在 ~/.nyra/commands/ 或 <工作目录>/.nyra/commands/ 放 Markdown 文件即可。\n");
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
          process.stderr.write("用法：/rewind-msg <消息 id>；/rewind-edit <消息 id> <新文本>；/rewind-fork <消息 id>\n");
          continue;
        }
        let result: { action: string; kept: number; deleted: number; new_session_id: string | null };
        if (text.startsWith("/rewind-msg ")) {
          result = rewindTo(store, agent.sessionId, messageId);
        } else if (text.startsWith("/rewind-fork ")) {
          result = rewindFork(store, agent.sessionId, messageId);
        } else {
          const newText = text.slice(text.indexOf(parts[1]) + parts[1].length).trim();
          if (!newText) { process.stderr.write("用法：/rewind-edit <消息 id> <新文本>\n"); continue; }
          result = rewindEdit(store, agent.sessionId, messageId, newText);
        }
        if (result.action !== "fork") {
          agent.messages = storeHistoryToAgentMessages(store.history(agent.sessionId, 100000));
          saveSession(agent.sessionId, agent.messages, home);
          process.stdout.write(`已回退到消息 ${messageId}：保留 ${result.kept} 条，删除 ${result.deleted} 条。\n`);
        } else {
          process.stdout.write(`已 fork 新会话 ${result.new_session_id}（复制 ${result.kept} 条，原会话不动）。用 nyra --resume ${result.new_session_id} 继续。\n`);
        }
      } catch (err: unknown) {
        process.stdout.write(`回退失败：${err instanceof Error ? err.message : String(err)}\n`);
      } finally {
        store.close();
      }
      continue;
    }
    if (text === "/undo" || text === "/rewind" || text.startsWith("/rewind ")) {
      if (!agent.checkpoints) {
        process.stdout.write("当前后端不支持检查点撤销。\n");
        continue;
      }
      let count = 1;
      if (text.startsWith("/rewind ")) {
        const pieces = text.split(/\s+/);
        if (pieces.length !== 2 || !/^\d+$/.test(pieces[1])) {
          process.stderr.write("用法：/rewind N（1 至 10）\n");
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
        process.stdout.write(`已撤销 ${result.turns} 轮，恢复 ${result.files} 个文件。\n`);
      } catch (err: unknown) {
        process.stdout.write(`撤销失败：${err instanceof Error ? err.message : String(err)}\n`);
      }
      continue;
    }
    agent.ctx.approvedShellCommands?.clear();
    try {
      // 回退存档（第 3 阶段）：本轮问答记入 conversations，供 /rewind-* 用。
      const store = new ConversationStore(home);
      try { store.record(agent.sessionId, "user", text); } catch { /* ignore */ }
      const result = await agent.run(text);
      try { store.record(agent.sessionId, "assistant", result); } catch { /* ignore */ }
      store.close();
      process.stdout.write(result + "\n");
    } catch (err: unknown) {
      if (err instanceof ApprovalRequired) {
        process.stdout.write(`等待审批：${(err as ApprovalRequired).tool}（已记录，可用 nyra task approve 批准后继续）\n`);
        continue;
      }
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    }
    agent.ctx.approvedShellCommands?.clear();
  }
  rl.close();
  process.stderr.write("本次运行用量：\n" + formatUsage(agent.usage.snapshot()) + "\n");
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
  const args = parseArgs(argv);
  if (args.unknown) {
    process.stderr.write(`未知选项：${args.unknown}\n${USAGE}\n`);
    return 2;
  }
  if (args.help) { process.stdout.write(USAGE + "\n"); return 0; }
  if (args.version) { process.stdout.write(`nyra ${VERSION} (node runtime)\n`); return 0; }

  const home = resolveHome();

  // 子命令优先。
  if (args.subcommand === "schedule") return handleSchedule(args.subArgs ?? [], resolve(args.workdir));
  if (args.subcommand === "task") return handleTask(args.subArgs ?? [], resolve(args.workdir));
  if (args.subcommand === "kb") return knowledgeMain(args.subArgs ?? []);
  if (args.subcommand === "plugin") return handlePlugin(args.subArgs ?? [], home);
  if (args.subcommand === "creator") return handleCreator(args.subArgs ?? [], home, resolve(args.workdir));
  if (args.subcommand === "memory") return handleMemory(args.subArgs ?? [], home);
  if (args.subcommand === "vault") return handleVault(args.subArgs ?? [], home);
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
      console.error(`模型配置有问题：${err instanceof Error ? err.message : String(err)}`);
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
      console.error(`模型配置有问题：${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    const file = args.exampleFile || defaultExampleFile(home);
    if (!existsSync(file)) { process.stderr.write(`示例文件不存在：${file}\n`); return 2; }
    try {
      const result = runExampleTask({ home, provider: provider.name, model: provider.model, file });
      return result.rows === 100 ? 0 : 1;
    } catch (err: unknown) {
      process.stderr.write(`示例任务失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  // --resume-run 不能与任务文本、--resume、计划、压缩或列表命令组合使用。
  if (args.resumeRun && (args.task !== undefined || args.resume || args.planMode || args.executePlan || args.approvePlan || args.compact || args.listMcp || args.listProfiles || args.listSessions || args.listSkills || args.inspectPoppyIdentity !== null || args.discoverPoppy !== null)) {
    const message = "--resume-run 不能与任务文本、--resume、计划、压缩或列表命令组合使用";
    if (args.jsonMode) return invalidArguments(process.stdout, message);
    process.stderr.write("错误：" + message + "\n");
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
      const mark = name === current ? "（当前）" : "";
      const auth = p.auth === "cli" ? "复用本机登录，不用 Key" : name === "ollama" ? "本地模型，不用 Key" : `Key 环境变量：${p.envKey}`;
      process.stdout.write(`${name}${mark}：默认模型 ${p.defaultModel ?? "（需指定）"}；${auth}\n`);
    }
    process.stdout.write("自定义 provider：在 ~/.nyra/config.json 的 custom_providers 里添加。\n");
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
      if (!models.length) { process.stdout.write(`${name} 未返回可用模型。\n`); return 0; }
      for (const m of models) process.stdout.write(`- ${m}\n`);
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (args.listProfiles) {
    const config = loadConfig(home);
    const names = listProfiles(config);
    if (!names.length) process.stdout.write("暂无 provider 档案（在 ~/.nyra/config.json 的 profiles 里添加）\n");
    else for (const n of names) process.stdout.write(`- ${n}\n`);
    return 0;
  }
  if (args.listSkills) {
    const skills = loadSkills([join(process.cwd(), "skills"), join(home, "skills"), ...pluginSkillDirs(home)]);
    if (!skills.length) process.stdout.write("暂无技能\n");
    else for (const s of skills) process.stdout.write(`- ${s.name}：${s.description}\n`);
    return 0;
  }
  if (args.listSessions) {
    const sessions = listSessions(home);
    if (!sessions.length) process.stdout.write("暂无历史会话\n");
    else for (const s of sessions) process.stdout.write(`- ${s.id}（${s.count} 条消息）${s.preview}\n`);
    return 0;
  }
  if (args.listMcp) {
    const config = loadConfig(home);
    const servers = loadMcpServers(config);
    const names = Object.keys(servers);
    if (!config.mcp_enabled || !names.length) {
      process.stdout.write("MCP 未启用或无可用服务器。\n在 ~/.nyra/config.json 里设置 \"mcp_enabled\": true 并配置 mcp_servers 或 mcp_presets 后可用。\n");
      process.stdout.write("内置预置（10 个）：" + listPresets().map((p) => p.name).join("、") + "。\n");
      return 0;
    }
    process.stdout.write("已配置的 MCP 服务器（原生客户端，第 3 阶段）：\n");
    for (const name of names) {
      const s = servers[name];
      process.stdout.write(`- ${name}：${s.command} ${s.args.join(" ")}\n`);
    }
    process.stdout.write("工具列表需启动服务器后查看：nyra ui（full 模式）→ 设置 → MCP 工具与成本。\n");
    return 0;
  }
  if (args.compact) {
    try {
      const { agent } = await buildAgent({ ...args, task: undefined }, { interactive: false });
      agent.sessionId = args.compact;
      const messages = loadSession(args.compact, home);
      if (messages === null) { process.stderr.write(`错误：找不到会话 ${args.compact}\n`); return 1; }
      agent.messages = messages;
      const info = await agent.compact();
      process.stdout.write(`已压缩会话 ${args.compact}：${info.before} 条 → ${info.after} 条（${info.method}）\n`);
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`压缩失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  if (args.sandbox && args.sandbox !== "local") {
    process.stderr.write("错误：--sandbox e2b 在 0.4.1 暂不支持（Python 已移除，Node 版 E2B 后端尚未移植）；当前只支持 local\n");
    return 2;
  }
  if (args.contextWindow !== null && (typeof args.contextWindow !== "number" || !Number.isInteger(args.contextWindow) || args.contextWindow < 1)) {
    process.stderr.write("错误：--context-window 必须为正整数\n");
    return 1;
  }

  if (args.task !== undefined) return runOneShot(args);
  return runRepl(args);
}

// Bun --compile 入口：直接跑 main。
if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
