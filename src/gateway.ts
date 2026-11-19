// src/gateway.ts — 单 gateway（第 3 阶段，nyra/webui.py + nyra/server.py 对应）。
// `nyra ui` 启动 gateway，拥有全部会话；CLI、网页、定时任务、群聊都接
// gateway；gateway 默认按需启动，不强制常驻（一次性任务直接跑完退出，
// 不留进程）。双客户端同时连一个 gateway 时共用同一份会话状态：
// 同一会话同一时刻只跑一个 agent（第二个 send 得 409，不丢消息、
// 不重复发）；历史与事件都从同一份内存 + 会话文件 + conversations 存档读。
// 鉴权与 Python 版一致：除 /api/health 外都要 X-Nyra-Token（owner）或
// 设备 token（手机）；HTML 页与 manifest/icon 允许 ?token=；无 CORS；
// loopback 绑定时校验 Host 头（防 DNS 重绑定）。
// 压缩分层（方案 2.6 第 7 条）：网关阈值 85% 落在这里——用量比 ≥85% 时先
// 剪旧工具结果（不调 LLM），仍超就记事件、等 agent 侧 50% 压缩接手。
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { Agent } from "./agent.ts";
import {
  loadConfig, resolveProfile, resolveProvider, resolveFallbackChain, validateMode,
  getProviderPresets, VERSION, VALID_MODES, type ResolvedProvider,
} from "./config.ts";
import { Provider, buildProviderChain, type ProviderLike } from "./providers.ts";
import { TOOL_SCHEMAS, SESSION_GRANT_TOOLS, APPROVE_ALWAYS, MUTATING_TOOLS } from "./tools.ts";
import { loadSession, saveSession, newSessionId, listSessions, resolveNyraHome } from "./memory.ts";
import { ConversationStore } from "./conversations.ts";
import { trimOldToolResults, GATEWAY_COMPACT_THRESHOLD, DEFAULT_AUTO_COMPACT_THRESHOLD, validateAutoCompactThreshold } from "./compact.ts";
import { loadSchedule, saveSchedule, schedulePath, listScheduleTasks, removeScheduleTask, runDueTasks, type ScheduleTask } from "./scheduler.ts";
import { appendInbox } from "./tasks.ts";
import { buildPlan, renderPlan, savePlan, readApprovedPlan, approvedExecutionTask, PlanError } from "./planMode.ts";
import { loadSkills } from "./skills.ts";
import { pluginSkillDirs } from "./plugins.ts";
import { contextLimit } from "./usage.ts";
import { MCPToolManager, buildMcpManager } from "./mcp.ts";
import { McpCostTracker, estimateToolCost, costLimitUsd } from "./mcpCost.ts";
import { DeviceRegistry, defaultDevicesPath, startDiscoveryResponder, PairingError } from "./pairing.ts";
import { memoryScopes, memoryView, memorySave, MemoryBrowserError } from "./memoryBrowser.ts";
import { listArtifacts, getArtifact } from "./artifacts.ts";
import { GroupStore, type BotConfig } from "./groups.ts";
// 群聊页嵌进二进制（.txt 后缀：bun-types 只给 *.txt 声明了 string 类型；
// 内容分别是群聊页 HTML 与 JS，原文件在 nyra/ 已随 Python 删除，改这里要同步改 .txt）。
import GROUP_UI_HTML from "./assets/group_ui.html.txt" with { type: "text" };
import GROUP_UI_JS from "./assets/group-ui.js.txt" with { type: "text" };
import { decideSmartApproval, reviewerEnabled, smartApprovalConfig, readAudit } from "./smartApprovals.ts";
import { rewind as doRewind, storeHistoryToAgentMessages, type RewindAction } from "./rewind.ts";
import { PAGE_HTML, MOBILE_HTML, MANIFEST, MOBILE_MANIFEST, CSP, solidPng } from "./webuiPage.ts";

export const GATEWAY_DEFAULT_HOST = "127.0.0.1";
export const GATEWAY_DEFAULT_PORT = 8765;
export const APPROVAL_TIMEOUT = 600.0;
export const MAX_BODY = 256 * 1024;
export const MAX_EVENT_TEXT = 4000;
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
export const APPROVAL_ID_RE = /^[0-9a-f]{16}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_PROJECT_ENTRIES = 2000;
const STARTUP_SIZES: [number, number][] = [
  [640, 1136], [750, 1334], [1125, 2436], [1170, 2532], [1284, 2778], [1536, 2048], [2048, 2732],
];

export const FORBIDDEN_PAGE = `<!doctype html><meta charset="utf-8"><title>Nyra</title>
<body style="font:16px system-ui;padding:40px;color:#2A2D34;background:#F3F5F4">
<h1>需要访问 token</h1><p>请使用启动 <code>nyra ui</code> 时终端里打印的完整链接（含 <code>?token=</code>）。</p>
<p>Open the full link printed in the terminal (it contains <code>?token=</code>).</p></body>`;

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function clip(text: unknown, limit = MAX_EVENT_TEXT): string {
  const s = typeof text === "string" ? text : JSON.stringify(text ?? "");
  return s.length > limit ? s.slice(0, limit) + "…" : s;
}

function lanIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

export interface PendingApproval {
  id: string;
  tool: string;
  summary: string;
  always: boolean;
  decision: boolean | string | null;
  resolve: (v: boolean | string) => void;
}

export interface SessionRun {
  sessionId: string;
  agent: Agent | null;
  events: Record<string, unknown>[];
  status: "idle" | "running" | "done" | "error";
  error: string;
  pending: PendingApproval | null;
  baseMessages: Record<string, unknown>[];
}

export interface GatewayOptions {
  home?: string;
  workdir?: string;
  mode?: string;
  providerName?: string | null;
  model?: string | null;
  profile?: string | null;
  maxTurns?: number | null;
  host?: string;
  port?: number;
  token?: string;
  verbose?: boolean;
  config?: Record<string, unknown>;
  providerFactory?: () => ProviderLike;
  reviewerFactory?: () => { chat(messages: unknown[], tools?: unknown, timeout?: number): Promise<Record<string, unknown>> } | null;
}

export class Gateway {
  home: string;
  workdir: string;
  mode: string;
  host: string;
  port: number;
  token: string;
  verbose: boolean;
  config: Record<string, unknown>;
  providerName: string | null;
  model: string | null;
  profile: string | null;
  maxTurns: number | null;
  contextWindowTokens: number | null;
  autoCompactEnabled: boolean;
  autoCompactThreshold: number;
  pairOrigin: string | null = null;
  server: Server | null = null;
  runs: Map<string, SessionRun> = new Map();
  approvals: Map<string, { run: SessionRun; pending: PendingApproval }> = new Map();
  devices: DeviceRegistry;
  private _store: ConversationStore | null = null;
  groups: GroupStore;
  mcpManager: MCPToolManager | null = null;
  mcpCost: McpCostTracker;
  private providerInstance: ProviderLike | null = null;
  private reviewerInstance: { chat(messages: unknown[], tools?: unknown, timeout?: number): Promise<Record<string, unknown>> } | null | undefined = undefined;
  private providerFactory?: () => ProviderLike;
  private reviewerFactory?: GatewayOptions["reviewerFactory"];
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private discoverySocket: { close: () => void } | null = null;
  private projectsLock = false;

  constructor(opts: GatewayOptions = {}) {
    this.home = resolveNyraHome(opts.home);
    this.workdir = opts.workdir ?? process.cwd();
    this.config = opts.config ?? loadConfig(this.home);
    this.mode = validateMode(opts.mode ?? (resolveProfile(opts.profile ?? null, this.config).mode as string) ?? "auto");
    this.host = opts.host ?? GATEWAY_DEFAULT_HOST;
    this.port = opts.port ?? GATEWAY_DEFAULT_PORT;
    this.token = opts.token ?? randomBytes(24).toString("base64url");
    this.verbose = opts.verbose ?? false;
    this.providerName = opts.providerName ?? null;
    this.model = opts.model ?? null;
    this.profile = opts.profile ?? null;
    this.maxTurns = opts.maxTurns ?? null;
    this.contextWindowTokens = contextLimit(this.config.context_window_tokens as number | null | undefined ?? null);
    this.autoCompactEnabled = Boolean(this.config.auto_compact_enabled ?? false);
    this.autoCompactThreshold = validateAutoCompactThreshold(
      (this.config.auto_compact_threshold as number | undefined) ?? DEFAULT_AUTO_COMPACT_THRESHOLD,
    );
    this.providerFactory = opts.providerFactory;
    this.reviewerFactory = opts.reviewerFactory;
    this.devices = new DeviceRegistry(defaultDevicesPath(this.home));
    this.groups = new GroupStore(join(this.home, "groups"));
    this.mcpCost = new McpCostTracker(this.home);
    if (!isLoopbackHost(this.host)) {
      const lan = lanIPv4();
      this.pairOrigin = `http://${lan ?? this.host}:${this.port}`;
    }
  }

  // -- provider ---------------------------------------------------------
  provider(): ProviderLike {
    if (this.providerFactory) {
      if (!this.providerInstance) this.providerInstance = this.providerFactory();
      return this.providerInstance;
    }
    if (this.providerInstance) return this.providerInstance;
    const profile = resolveProfile(this.profile, this.config);
    const primaryCfg = resolveProvider({
      home: this.home, config: this.config,
      providerName: this.providerName ?? profile.provider, model: this.model ?? profile.model ?? undefined,
    });
    const chain = resolveFallbackChain(this.config, primaryCfg.name);
    this.providerInstance = buildProviderChain(
      primaryCfg, chain,
      (record) => this.onSwitch(record),
      {
        resolver: (name: string) => resolveProvider({ home: this.home, config: this.config, providerName: name }),
      },
    );
    if (this.maxTurns === null) this.maxTurns = (this.config.max_turns as number | undefined) ?? 20;
    return this.providerInstance;
  }

  /** 定时任务/队列用的主 provider：不走兜底链（安全红线：队列里不切换）。 */
  primaryProvider(): ProviderLike {
    if (this.providerFactory) return this.providerFactory();
    const profile = resolveProfile(this.profile, this.config);
    const cfg = resolveProvider({
      home: this.home, config: this.config,
      providerName: this.providerName ?? profile.provider, model: this.model ?? profile.model ?? undefined,
    });
    if ((cfg as ResolvedProvider).auth === "cli") {
      throw new Error("定时任务不得使用 CLI provider（Codex），请在配置里改用 HTTP provider");
    }
    return new Provider(cfg);
  }

  private reviewer(): { chat(messages: unknown[], tools?: unknown, timeout?: number): Promise<Record<string, unknown>> } | null {
    if (this.reviewerInstance !== undefined) return this.reviewerInstance;
    if (this.reviewerFactory) {
      this.reviewerInstance = this.reviewerFactory();
      return this.reviewerInstance;
    }
    if (!reviewerEnabled(this.config)) { this.reviewerInstance = null; return null; }
    const cfg = smartApprovalConfig(this.config);
    try {
      const resolved = resolveProvider({
        home: this.home, config: this.config,
        providerName: cfg.reviewer_provider ?? undefined, model: cfg.reviewer_model ?? undefined,
      });
      const p = new Provider(resolved);
      if (!p.hasCredentials()) { this.reviewerInstance = null; return null; }
      this.reviewerInstance = p;
      return p;
    } catch {
      this.reviewerInstance = null;
      return null;
    }
  }

  private onSwitch(record: { from: string; to: string; error: string }): void {
    const reason = record.error.length > 120 ? record.error.slice(0, 117) + "…" : record.error;
    process.stderr.write(`模型切换：${record.from} 失败（${reason}），已切换到 ${record.to} 继续\n`);
    for (const run of this.runs.values()) {
      if (run.status === "running") this.record(run, "model_switch", { from: record.from, to: record.to, error: reason });
    }
  }

  // -- sessions ---------------------------------------------------------
  getRun(sessionId: string, create?: true): SessionRun;
  getRun(sessionId: string, create: false): SessionRun | null;
  getRun(sessionId: string, create = true): SessionRun | null {
    let run = this.runs.get(sessionId);
    if (!run && create) {
      run = { sessionId, agent: null, events: [], status: "idle", error: "", pending: null, baseMessages: [] };
      this.runs.set(sessionId, run);
    }
    return run ?? null;
  }

  newSession(): string {
    const sid = newSessionId();
    this.getRun(sid);
    return sid;
  }

  sessionKnown(sid: string): boolean {
    if (this.getRun(sid, false)) return true;
    return loadSession(sid, this.home) !== null;
  }

  sessionMessages(sessionId: string): Record<string, unknown>[] {
    const run = this.getRun(sessionId, false);
    if (run && run.status === "running") return [...run.baseMessages];
    if (run && run.agent) return [...run.agent.messages];
    return loadSession(sessionId, this.home) ?? [];
  }

  sessionView(sessionId: string, since = 0): Record<string, unknown> {
    const run = this.getRun(sessionId, false);
    const messages = this.sessionMessages(sessionId);
    let events: Record<string, unknown>[] = [];
    let status = "idle";
    let pending: Record<string, unknown> | null = null;
    let error = "";
    let total = 0;
    if (run) {
      events = run.events.slice(since);
      status = run.status;
      error = run.error;
      total = run.events.length;
      if (run.pending) {
        const { resolve: _r, decision: _d, ...rest } = run.pending as unknown as Record<string, unknown>;
        void _r; void _d;
        pending = rest;
      }
    }
    const plan = this.findPlan(messages, run?.events ?? []);
    return {
      id: sessionId, status, error, messages, events, next: total, pending,
      evidence: this.listEvidence(sessionId),
      plan,
      usage: run?.agent ? run.agent.usage.snapshot() : null,
      // 调研报告第 3 项：上下文补齐（学 Claude Code）——/context 可视化的
      // 网页端接口：沿用 sessionView 的返回体，加 context breakdown 字段；
      // 无 live agent 时为 null（读会话文件时不拼系统提示，不编造数字）。
      context: run?.agent ? run.agent.contextUsage() : null,
      auto_compact_count: run?.agent ? run.agent.autoCompactCount : 0,
    };
  }

  private findPlan(messages: Record<string, unknown>[], events: Record<string, unknown>[]): Record<string, unknown> | null {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "plan_ready" && e.data && typeof e.data === "object") {
        const d = e.data as Record<string, unknown>;
        return { plan: d.plan, sha256: d.sha256, path: "plan.md", status: "ready" };
      }
    }
    void messages;
    return null;
  }

  private listEvidence(sessionId: string): { name: string }[] {
    const dir = join(this.home, "evidence", sessionId);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir).map((f) => ({ name: f }));
    } catch { return []; }
  }

  sessionsView(): Record<string, unknown> {
    const projects = this.loadProjects();
    const byId = new Map<string, { id: string; preview: string; count: number; mtime: string }>();
    for (const item of listSessions(this.home)) byId.set(item.id, item);
    // 刚建、还没落盘的 live 会话也要出现在列表里（否则新建后列表是空的）。
    for (const [id, run] of this.runs) {
      if (!byId.has(id)) {
        const msgs = run.agent ? run.agent.messages : [];
        const firstUser = msgs.find((m) => m.role === "user");
        byId.set(id, {
          id, preview: typeof firstUser?.content === "string" ? firstUser.content.slice(0, 60) : "",
          count: msgs.length, mtime: new Date().toISOString().slice(0, 19),
        });
      }
    }
    const sessions = [...byId.values()].map((item) => {
      const workdir = projects[item.id];
      return { ...item, workdir: workdir ?? null, project: workdir ? workdir.split("/").pop() ?? null : null };
    });
    return {
      sessions,
      project: { name: this.workdir.split("/").pop() ?? this.workdir, workdir: this.workdir },
    };
  }

  private projectsPath(): string {
    return join(this.home, "sessions", "ui-projects.json");
  }

  private loadProjects(): Record<string, string> {
    try {
      const data = JSON.parse(readFileSync(this.projectsPath(), "utf-8")) as Record<string, unknown>;
      if (!data || typeof data !== "object") return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof k === "string" && typeof v === "string" && SESSION_ID_RE.test(k)) out[k] = v;
      }
      return out;
    } catch { return {}; }
  }

  private rememberProject(sessionId: string): void {
    if (this.projectsLock) return;
    this.projectsLock = true;
    try {
      const data = this.loadProjects();
      const workdir = this.workdir;
      if (data[sessionId] === workdir) return;
      data[sessionId] = workdir;
      const entries = Object.entries(data);
      const trimmed = entries.length > MAX_PROJECT_ENTRIES
        ? Object.fromEntries(entries.slice(-MAX_PROJECT_ENTRIES)) : data;
      const path = this.projectsPath();
      mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(trimmed), "utf-8");
      renameSync(tmp, path);
    } catch { /* 分组是装饰性的，失败不影响运行 */ }
    finally { this.projectsLock = false; }
  }

  record(run: SessionRun, kind: string, data: Record<string, unknown>): void {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === "content" || key === "result") clean[key] = clip(value);
      else if (key === "arguments") clean[key] = value && typeof value === "object" ? value : clip(value, 1000);
      else clean[key] = value;
    }
    run.events.push({ seq: run.events.length, type: kind, data: clean, ts: Date.now() / 1000 });
  }

  info(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      version: VERSION, mode: this.mode, modes: [...VALID_MODES], workdir: this.workdir,
    };
    try {
      const prov = this.provider();
      out.provider = (prov as unknown as { name?: string }).name ?? "?";
      out.model = (prov as unknown as { model?: string }).model ?? "?";
      const has = (prov as unknown as { hasCredentials?: () => boolean }).hasCredentials;
      out.provider_desc = `${out.provider} / ${out.model}`;
      out.credentials = typeof has === "function" ? has.call(prov) : true;
      const switches = (prov as unknown as { switches?: unknown[] }).switches;
      if (switches) out.model_switches = switches;
      const chain = (prov as unknown as { providers?: { name?: string }[] }).providers;
      out.fallback_chain = Array.isArray(chain) && chain.length
        ? chain.map((p) => p.name ?? "?") : [out.provider];
    } catch (err) {
      out.provider = null; out.model = null; out.provider_desc = "";
      out.credentials = false; out.provider_error = err instanceof Error ? err.message : String(err);
      out.fallback_chain = [];
    }
    const presets = getProviderPresets(this.config);
    out.keys = Object.entries(presets).map(([name, preset]) => ({
      provider: name, env: preset.envKey ?? null,
      configured: Boolean(preset.envKey && process.env[preset.envKey]),
      connector: Boolean((preset as unknown as { connector?: boolean }).connector),
      needs_key: preset.envKey !== undefined && preset.envKey !== null && name !== "ollama",
    }));
    out.config = {
      max_turns: this.config.max_turns ?? null,
      context_window_tokens: this.contextWindowTokens,
      auto_compact_enabled: this.autoCompactEnabled,
      auto_compact_threshold: this.autoCompactThreshold,
      mcp_enabled: Boolean(this.config.mcp_enabled ?? false),
      sandbox: (this.config.sandbox as string) || "local",
      profiles: Object.keys((this.config.profiles as Record<string, unknown>) ?? {}).sort(),
    };
    out.mcp_tools = this.mcpManager ? this.mcpManager.toolSchemas.length : 0;
    out.providers = Object.entries(presets).map(([name, preset]) => ({
      provider: name, model: preset.defaultModel ?? null, env_key: preset.envKey ?? null,
    }));
    out.provider_count = Object.keys(presets).length;
    out.tools = TOOL_SCHEMAS.filter((s) => {
      const fn = (s as Record<string, unknown>).function as Record<string, unknown> | undefined;
      return fn && typeof fn.name === "string" && !fn.name.startsWith("poppy_");
    }).map((s) => {
      const fn = (s as Record<string, unknown>).function as Record<string, unknown>;
      return { name: fn.name, description: fn.description ?? "", needs_approval: MUTATING_TOOLS.has(fn.name as string) };
    });
    out.tool_count = (out.tools as unknown[]).length;
    try {
      out.skills = loadSkills([join(process.cwd(), "skills"), join(this.home, "skills"), ...pluginSkillDirs(this.home)])
        .map((s) => ({ name: s.name, description: s.description }));
    } catch { out.skills = []; }
    out.smart_approvals = { reviewer_enabled: reviewerEnabled(this.config) };
    out.mcp_cost = { limit_usd: costLimitUsd(this.config), spent_usd: this.mcpCost.totalUsd() };
    return out;
  }

  setMode(newMode: string): string {
    const mode = validateMode(newMode);
    for (const run of this.runs.values()) {
      if (run.status === "running") throw new Error("有任务正在执行，请完成后再切换模式");
    }
    if (mode === this.mode) return mode;
    if (this.mcpManager) { this.mcpManager.stopAll(); this.mcpManager = null; }
    for (const run of this.runs.values()) {
      if (run.agent) { run.agent.setMode(mode); run.agent.mcpManager = null; }
    }
    this.mode = mode;
    void this.ensureMcpManager();
    for (const run of this.runs.values()) {
      if (run.agent) run.agent.mcpManager = this.mcpManager;
    }
    return mode;
  }

  setProvider(name: string, model?: string | null): Record<string, unknown> {
    const presets = getProviderPresets(this.config);
    if (!presets[name]) throw new Error(`未知的 provider：${name}`);
    this.providerName = name;
    this.model = model ?? null;
    this.providerInstance = null;
    const prov = this.provider();
    for (const run of this.runs.values()) {
      if (run.agent) run.agent.provider = prov;
    }
    return {
      provider: (prov as unknown as { name?: string }).name ?? name,
      model: (prov as unknown as { model?: string }).model ?? model ?? null,
    };
  }

  async ensureMcpManager(): Promise<MCPToolManager | null> {
    if (this.mcpManager) return this.mcpManager;
    // 与 Python webui/server 一致：auto/readonly 不启动 MCP 子进程；
    // full 是显式 opt-in。网页端不能批准本地 MCP 进程启动。
    if (this.mode !== "full") return null;
    if (!this.config.mcp_enabled) return null;
    const manager = await buildMcpManager({ mode: this.mode, interactive: false, config: this.config });
    this.mcpManager = manager;
    return manager;
  }

  pendingApprovals(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const [id, { run, pending }] of this.approvals) {
      out.push({ id, session: run.sessionId, tool: pending.tool, summary: pending.summary, always: pending.always });
    }
    return out;
  }

  // -- approval (smart approvals 接入点) ----------------------------------
  private async approve(run: SessionRun, tool: string, summary: string, details?: Record<string, unknown>): Promise<boolean | string> {
    const command = typeof details?.command === "string" ? details.command : null;
    const decision = await decideSmartApproval({
      tool, summary, command,
      config: this.config,
      reviewer: this.reviewer(),
      reviewerModelName: smartApprovalConfig(this.config).reviewer_model ?? smartApprovalConfig(this.config).reviewer_provider ?? null,
      home: this.home,
    });
    if (decision.verdict === "DENY") {
      this.record(run, "approval_result", { tool, approved: false, always: false, timeout: false, tier: decision.tier, reason: decision.reason });
      return false;
    }
    if (decision.verdict === "APPROVE") {
      this.record(run, "approval_result", { tool, approved: true, always: false, timeout: false, tier: decision.tier, reason: decision.reason });
      return true;
    }
    // ESCALATE → 挂起等人工（评审模型默认关时也走这里，与第 2 阶段二值审批一致）。
    const approvalId = randomBytes(8).toString("hex");
    const canAlways = SESSION_GRANT_TOOLS.has(tool);
    let resolveFn: (v: boolean | string) => void = () => {};
    const waiter = new Promise<boolean | string>((resolve) => { resolveFn = resolve; });
    const pending: PendingApproval = {
      id: approvalId, tool, summary, always: canAlways, decision: null, resolve: resolveFn,
    };
    this.approvals.set(approvalId, { run, pending });
    run.pending = pending;
    this.record(run, "approval", { id: approvalId, tool, summary, always: canAlways, tier: decision.tier, reason: decision.reason });
    let timedOut = false;
    const timer = setTimeout(() => {
      if (this.approvals.has(approvalId)) {
        timedOut = true;
        this.approvals.delete(approvalId);
        if (run.pending === pending) run.pending = null;
        resolveFn(false);
      }
    }, APPROVAL_TIMEOUT * 1000);
    timer.unref?.();
    const decided = await waiter;
    clearTimeout(timer);
    this.approvals.delete(approvalId);
    if (run.pending === pending) run.pending = null;
    const approved = decided === APPROVE_ALWAYS ? true : Boolean(decided);
    const always = decided === APPROVE_ALWAYS;
    this.record(run, "approval_result", { id: approvalId, approved, always, timeout: timedOut });
    return decided;
  }

  decide(approvalId: string, approve: boolean, always = false): boolean {
    const item = this.approvals.get(approvalId);
    if (!item) return false;
    const { pending } = item;
    if (approve && always) {
      if (!pending.always) throw new Error("这个操作不支持“本会话始终允许”，请逐次批准");
      pending.decision = APPROVE_ALWAYS;
    } else {
      pending.decision = Boolean(approve);
    }
    pending.resolve(pending.decision);
    return true;
  }

  // -- running ------------------------------------------------------------
  send(sessionId: string, text: string): SessionRun {
    const run = this.getRun(sessionId);
    if (run.status === "running") throw new Error("这个会话正在执行任务，请等它完成");
    run.events = [];
    run.error = "";
    run.status = "running";
    try {
      if (!run.agent) {
        const provider = this.provider();
        run.agent = new Agent(provider, {
          workdir: this.workdir, mode: this.mode, maxTurns: this.maxTurns ?? 20,
          sessionId, interactive: true,
          messages: loadSession(sessionId, this.home),
          mcpManager: this.mcpManager,
          onEvent: (kind, data) => this.record(run, kind, data),
          approveFn: (tool, summary, details) => this.approve(run, tool, summary, details),
          contextWindowTokens: this.contextWindowTokens,
          autoCompactEnabled: this.autoCompactEnabled,
          autoCompactThreshold: this.autoCompactThreshold,
          home: this.home,
        });
      } else {
        run.agent.setMode(this.mode);
      }
      run.baseMessages = [...run.agent.messages];
    } catch (err) {
      run.status = "error";
      run.error = `无法启动：${err instanceof Error ? err.message : String(err)}`;
      return run;
    }
    this.record(run, "user", { content: text });
    try { this.store.record(sessionId, "user", text); } catch { /* 存档失败不阻塞运行 */ }
    this.rememberProject(sessionId);
    void this.doWork(run, text);
    return run;
  }

  private async doWork(run: SessionRun, text: string): Promise<void> {
    try {
      const provider = run.agent!.provider;
      const has = (provider as unknown as { hasCredentials?: () => boolean }).hasCredentials;
      if (typeof has === "function" && !has.call(provider)) {
        throw new Error("未找到可用的 API 凭据：请设置对应 provider 的环境变量 Key 后重启 ui");
      }
      const finalText = await run.agent!.run(text);
      try { this.store.record(run.sessionId, "assistant", finalText); } catch { /* ignore */ }
      run.status = "done";
      this.gatewayCompactCheck(run);
    } catch (err) {
      run.status = "error";
      run.error = err instanceof Error ? err.message : String(err);
    }
  }

  plan(sessionId: string, text: string): SessionRun {
    const run = this.getRun(sessionId);
    if (run.status === "running") throw new Error("这个会话正在执行任务，请等它完成");
    run.events = [];
    run.error = "";
    run.status = "running";
    run.baseMessages = run.agent ? [...run.agent.messages] : (loadSession(sessionId, this.home) ?? []);
    this.record(run, "user", { content: text, plan: true });
    void (async () => {
      try {
        const provider = this.provider();
        const has = (provider as unknown as { hasCredentials?: () => boolean }).hasCredentials;
        if (typeof has === "function" && !has.call(provider)) {
          throw new PlanError("未找到可用的 API 凭据：请设置对应 provider 的环境变量 Key 后重启 ui");
        }
        const details = await buildPlan(provider, text, this.workdir, TOOL_SCHEMAS as Record<string, unknown>[]);
        const body = renderPlan(text, details);
        const digest = savePlan(this.workdir, body);
        this.rememberProject(sessionId);
        this.record(run, "plan_ready", { plan: body, sha256: digest, path: "plan.md" });
        run.status = "done";
      } catch (err) {
        run.status = "error";
        run.error = `规划失败：${err instanceof Error ? err.message : String(err)}`;
      }
    })();
    return run;
  }

  executePlan(sessionId: string, digest: string): SessionRun {
    if (this.mode === "readonly") throw new Error("只读模式不能执行计划，请切换到 auto 或 full 模式");
    const approved = readApprovedPlan(this.workdir, digest);
    return this.send(sessionId, approvedExecutionTask(approved));
  }

  // -- gateway 压缩分层（85%） --------------------------------------------
  /**
   * 网关层压缩检查：用量比 ≥85% 时先剪旧工具结果（不调 LLM）。
   * 返回是否触发、用量比与消息数变化；仍超 85% 时只记事件，
   * 下一轮由 agent 侧 50% 自动压缩接手（不反复调模型）。
   */
  gatewayCompactCheck(run: SessionRun): { triggered: boolean; ratio: number | null; before: number; after: number } {
    const agent = run.agent;
    if (!agent) return { triggered: false, ratio: null, before: 0, after: 0 };
    const snap = agent.usage.snapshot() as unknown as { last_prompt_tokens: number | null; context_window_tokens: number | null };
    const window = snap.context_window_tokens;
    const last = snap.last_prompt_tokens;
    const ratio = window !== null && window !== undefined && last !== null && last !== undefined && window > 0
      ? last / window : null;
    if (ratio === null || ratio < GATEWAY_COMPACT_THRESHOLD) {
      return { triggered: false, ratio, before: agent.messages.length, after: agent.messages.length };
    }
    const before = agent.messages.length;
    const trimmed = trimOldToolResults(agent.messages as never);
    const changed = JSON.stringify(trimmed) !== JSON.stringify(agent.messages);
    if (changed) {
      agent.messages = trimmed as unknown as Record<string, unknown>[];
      saveSession(agent.sessionId, agent.messages, this.home);
    }
    this.record(run, "gateway_compact", {
      method: changed ? "trim_tool_results" : "none",
      ratio, before, after: agent.messages.length,
      still_above_threshold: ratio >= GATEWAY_COMPACT_THRESHOLD,
    });
    return { triggered: true, ratio, before, after: agent.messages.length };
  }

  // -- rewind ---------------------------------------------------------------
  rewindSession(sessionId: string, messageId: number, action: RewindAction, text?: string | null): Record<string, unknown> {
    const result = doRewind(this.store, sessionId, messageId, action, text ?? null);
    const run = this.getRun(sessionId, false);
    if (result.action !== "fork") {
      // live 会话与会话文件按同一份存档重建，保证三端看到的历史一致。
      const rows = this.store.history(sessionId, 100000);
      const messages = storeHistoryToAgentMessages(rows);
      if (run?.agent) run.agent.messages = messages;
      saveSession(sessionId, messages, this.home);
      if (run) {
        run.baseMessages = [...messages];
        this.record(run, "rewind", { action: result.action, message_id: messageId, kept: result.kept, deleted: result.deleted });
      }
    } else if (result.new_session_id) {
      const rows = this.store.history(result.new_session_id, 100000);
      const messages = storeHistoryToAgentMessages(rows);
      saveSession(result.new_session_id, messages, this.home);
      this.getRun(result.new_session_id);
    }
    return { ...result };
  }

  storeHistory(sessionId: string): Record<string, unknown>[] {
    return this.store.history(sessionId, 100000).map((r) => ({
      id: r.id, role: r.role, text: r.text, tool_name: r.tool_name, created_at: r.created_at,
    }));
  }

  // -- MCP（含成本） ----------------------------------------------------------
  mcpTools(): Record<string, unknown>[] {
    if (!this.mcpManager) return [];
    return this.mcpManager.toolSchemas.map((s) => {
      const name = s.function.name;
      const route = this.mcpManager!.routeFor(name);
      const server = route ? route[0] : "";
      const rawTool = route ? route[1] : name;
      const est = estimateToolCost(this.config, server, rawTool);
      const limit = costLimitUsd(this.config);
      const spent = this.mcpCost.totalUsd();
      return {
        name, description: s.function.description, server, tool: rawTool,
        estimate_usd: est.estimate_usd, priced: est.priced, source: est.source,
        limit_usd: limit, spent_usd: spent,
        estimate_line: this.mcpCost.estimateLine(this.config, server, rawTool),
      };
    });
  }

  async mcpCall(toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.mcpManager) throw new Error("MCP 未启用或无可用服务器");
    const route = this.mcpManager.routeFor(toolName);
    if (!route) throw new Error(`错误：未知 MCP 工具 ${toolName}`);
    const [server, rawTool] = route;
    const estimateLine = this.mcpCost.estimateLine(this.config, server, rawTool);
    const check = this.mcpCost.checkBeforeCall(this.config, server, rawTool);
    if (check.blocked) {
      this.mcpCost.record(server, rawTool, check.estimate_usd, "blocked_over_limit");
      throw new Error(check.blocked);
    }
    const result = await this.mcpManager.execute(toolName, args);
    const failed = result.startsWith("MCP 调用失败") || result.startsWith("错误：");
    const rec = this.mcpCost.record(server, rawTool, check.estimate_usd, failed ? "failed" : "called");
    return { ok: !failed, result, estimate_usd: check.estimate_usd, estimate_line: estimateLine, total_usd_after: rec.total_usd_after };
  }

  // -- schedule ---------------------------------------------------------------
  scheduleList(): ScheduleTask[] {
    return listScheduleTasks(loadSchedule(schedulePath(this.home)));
  }

  scheduleAction(action: string, name: string): Record<string, unknown> {
    const data = loadSchedule(schedulePath(this.home));
    if (action === "add") {
      throw Object.assign(new Error("网页端新建定时任务暂缓开放，等任务队列合并（E）后恢复；请用 nyra schedule add 命令添加"), { status: 409 });
    }
    if (action === "toggle") {
      for (const task of data.tasks) {
        if (task.name === name) {
          task.enabled = !(task.enabled ?? true);
          saveSchedule(data, schedulePath(this.home));
          return { task };
        }
      }
      throw Object.assign(new Error("任务不存在"), { status: 404 });
    }
    if (action === "remove") {
      if (removeScheduleTask(data, name)) {
        saveSchedule(data, schedulePath(this.home));
        return { ok: true };
      }
      throw Object.assign(new Error("任务不存在"), { status: 404 });
    }
    throw Object.assign(new Error("未知的操作"), { status: 400 });
  }

  /** 定时任务守护：到期任务用主 provider（不走兜底链）跑，结果进 inbox。 */
  startScheduler(intervalSeconds = 60): void {
    if (this.schedulerTimer) return;
    const tick = async () => {
      let data;
      try { data = loadSchedule(schedulePath(this.home)); } catch { return; }
      try {
        await runDueTasks(data, async (task) => {
          const agent = new Agent(this.primaryProvider(), {
            workdir: this.workdir, mode: this.mode, maxTurns: this.maxTurns ?? 20,
            sessionId: `schedule-${task.name}`, interactive: false, home: this.home,
            mcpManager: null,
          });
          const out = await agent.run(task.prompt);
          appendInbox(`schedule-${task.name}`, "ok", out.slice(0, 200), this.home);
          return out;
        });
        saveSchedule(data, schedulePath(this.home));
      } catch (err) {
        process.stderr.write(`定时任务执行失败：${err instanceof Error ? err.message : String(err)}\n`);
      }
    };
    this.schedulerTimer = setInterval(() => { void tick(); }, intervalSeconds * 1000);
    this.schedulerTimer.unref?.();
    void tick();
  }

  stopScheduler(): void {
    if (this.schedulerTimer) { clearInterval(this.schedulerTimer); this.schedulerTimer = null; }
  }

  // -- pairing ------------------------------------------------------------------
  startPairing(): Record<string, unknown> {
    if (!this.pairOrigin) {
      throw new PairingError("网页界面只监听本机（127.0.0.1），手机连不上。请用 nyra ui --pair 重新启动");
    }
    const info = this.devices.startPairing();
    return { ...info, url: `${this.pairOrigin}/m#pair=${info.code}` };
  }

  // -- HTTP -----------------------------------------------------------------------
  async start(): Promise<{ host: string; port: number; url: string }> {
    await this.ensureMcpManager();
    const server = createServer((req, res) => { void this.handle(req, res); });
    this.server = server;
    if (!isLoopbackHost(this.host)) {
      try { this.discoverySocket = startDiscoveryResponder({ httpPort: this.port, name: "Nyra" }); } catch { /* 发现端口被占不阻塞启动 */ }
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => resolve());
    });
    const addr = server.address();
    if (addr && typeof addr === "object") this.port = addr.port;
    const shownHost = this.host === "0.0.0.0" ? "127.0.0.1" : this.host;
    if (this.pairOrigin && this.host === "0.0.0.0") {
      const lan = lanIPv4();
      this.pairOrigin = `http://${lan ?? this.host}:${this.port}`;
    }
    return { host: shownHost, port: this.port, url: this.gatewayUrl() };
  }

  gatewayUrl(): string {
    const shown = this.host === "0.0.0.0" ? "127.0.0.1" : this.host;
    const host = shown.includes(":") ? `[${shown}]` : shown;
    return `http://${host}:${this.port}?token=${this.token}`;
  }

  urlJson(): Record<string, unknown> {
    const shown = this.host === "0.0.0.0" ? "127.0.0.1" : this.host;
    return {
      // nyra 固定为 "ui"：桌面端外壳（desktop/src-tauri/src/lib.rs 的
      // parse_start_line）只认这个值，Python 版 url_json() 也是 "ui"。
      nyra: "ui", version: VERSION,
      url: this.gatewayUrl(), host: shown, port: this.port, token: this.token,
    };
  }

  // -- HTTP 路由 ------------------------------------------------------------
  private hostOk(req: IncomingMessage): boolean {
    if (!isLoopbackHost(this.host)) return true;
    const host = (req.headers.host ?? "").trim().toLowerCase();
    const name = host.startsWith("[")
      ? host.split("]", 1)[0] + "]"
      : host.includes(":") ? host.slice(0, host.lastIndexOf(":")) : host;
    return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
  }

  private tokenOk(req: IncomingMessage): boolean {
    const supplied = req.headers["x-nyra-token"] ?? req.headers["x-angel-token"] ?? "";
    if (!supplied || typeof supplied !== "string") return false;
    const a = Buffer.from(supplied, "utf-8");
    const b = Buffer.from(this.token, "utf-8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** 页面/manifest/icon 允许 ?token=；API 一律只认请求头。 */
  private pageTokenOk(req: IncomingMessage): boolean {
    if (this.tokenOk(req)) return true;
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const q = url.searchParams.get("token") ?? "";
      if (!q) return false;
      const a = Buffer.from(q, "utf-8");
      const b = Buffer.from(this.token, "utf-8");
      return a.length === b.length && timingSafeEqual(a, b);
    } catch { return false; }
  }

  private device(req: IncomingMessage): Record<string, unknown> | null {
    const supplied = req.headers["x-nyra-token"];
    if (typeof supplied !== "string" || !supplied) return null;
    return this.devices.authenticate(supplied) as Record<string, unknown> | null;
  }

  /** 返回 "owner" | device | null；null 表示未通过鉴权。 */
  private apiAuth(req: IncomingMessage): "owner" | Record<string, unknown> | null {
    if (this.tokenOk(req)) return "owner";
    const d = this.device(req);
    return d ?? null;
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    const body = Buffer.from(JSON.stringify(data), "utf-8");
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    res.end(body);
  }

  private sendError(res: ServerResponse, status: number, message: string): void {
    this.sendJson(res, status, { error: message });
  }

  private sendHtml(res: ServerResponse, status: number, html: string, csp = true): void {
    const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
    if (csp) headers["Content-Security-Policy"] = CSP;
    res.writeHead(status, headers);
    res.end(html);
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY) throw new Error("请求体过大");
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString("utf-8") || "{}";
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("请求体必须是 JSON 对象");
    return data as Record<string, unknown>;
  }

  private route(req: IncomingMessage): { path: string; query: URLSearchParams } {
    const url = new URL(req.url ?? "/", "http://x");
    return { path: url.pathname, query: url.searchParams };
  }

  private validSid(raw: string): string | null {
    const sid = decodeURIComponent(raw);
    return SESSION_ID_RE.test(sid) ? sid : null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.dispatch(req, res);
    } catch (err) {
      process.stderr.write(`[nyra gateway] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) {
        try { this.sendError(res, 500, "服务器内部错误"); } catch { /* ignore */ }
      } else { try { res.end(); } catch { /* ignore */ } }
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.verbose) process.stderr.write(`[nyra gateway] ${req.method} ${(req.url ?? "").split("?")[0]}\n`);
    if (!this.hostOk(req)) { this.sendError(res, 421, "Host 不被允许"); return; }
    const { path, query } = this.route(req);
    const method = req.method ?? "GET";

    // 手机公共壳：页面与静态资源不含秘密，不用 token；API 仍要鉴权。
    if (method === "GET" && (path === "/m" || path === "/m/")) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP }); res.end(MOBILE_HTML); return; }
    if (method === "GET" && path === "/m/manifest.json") { this.sendJson(res, 200, MOBILE_MANIFEST); return; }
    const iconMatch = /^\/m\/icon-(180|192|512)\.png$/.exec(path);
    if (method === "GET" && iconMatch) {
      const size = Number(iconMatch[1]);
      const png = solidPng(size, size, "#0B0B0C");
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
      res.end(png);
      return;
    }
    const startupMatch = /^\/m\/startup\/(\d{3,4})x(\d{3,4})\.png$/.exec(path);
    if (method === "GET" && startupMatch) {
      const w = Number(startupMatch[1]);
      const h = Number(startupMatch[2]);
      if (!STARTUP_SIZES.some(([a, b]) => a === w && b === h)) { this.sendError(res, 404, "未找到"); return; }
      const png = solidPng(w, h, "#FFFFFF");
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
      res.end(png);
      return;
    }
    if (method === "GET" && (path === "/" || path === "/index.html")) {
      if (!this.pageTokenOk(req) && !this.device(req)) { this.sendHtml(res, 403, FORBIDDEN_PAGE); return; }
      this.sendHtml(res, 200, PAGE_HTML);
      return;
    }
    if (method === "GET" && path === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (method === "GET" && path === "/manifest.json") {
      if (!this.pageTokenOk(req)) { this.sendError(res, 403, "token 无效"); return; }
      this.sendJson(res, 200, MANIFEST);
      return;
    }
    if (method === "GET" && path === "/nyra-mark.svg") {
      if (!this.pageTokenOk(req)) { this.sendError(res, 403, "token 无效"); return; }
      const iconPath = join(process.cwd(), "docs", "assets", "nyra-mark.svg");
      if (!existsSync(iconPath)) { this.sendError(res, 404, "未找到"); return; }
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end(readFileSync(iconPath));
      return;
    }
    if (method === "GET" && path === "/groups") {
      if (!this.pageTokenOk(req)) { this.sendHtml(res, 403, FORBIDDEN_PAGE); return; }
      this.sendHtml(res, 200, GROUP_UI_HTML);
      return;
    }
    if (method === "GET" && path === "/group-ui.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      res.end(GROUP_UI_JS);
      return;
    }

    if (method === "OPTIONS") { this.sendError(res, 403, "不支持跨域请求"); return; }
    if (method === "GET" && path === "/api/health") { this.sendJson(res, 200, { ok: true, version: VERSION }); return; }

    if (!path.startsWith("/api/")) { this.sendError(res, 404, "未找到"); return; }

    // POST /api/pair 是唯一无需鉴权的 API：手机拿一次性配对码换设备 token。
    if (method === "POST" && path === "/api/pair") {
      let body: Record<string, unknown>;
      try { body = await this.readBody(req); } catch (err) { this.sendError(res, 400, `请求无效：${err instanceof Error ? err.message : String(err)}`); return; }
      try {
        const device = this.devices.redeem(String(body.code ?? ""), String(body.name ?? ""));
        this.sendJson(res, 200, device);
      } catch (err) {
        if (err instanceof PairingError) this.sendError(res, 401, err.message);
        else this.sendError(res, 500, `保存设备失败：${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    const who = this.apiAuth(req);
    if (who === null) { this.sendError(res, 403, "token 无效"); return; }
    const isOwner = who === "owner";

    if (method === "GET" && path === "/api/approvals") {
      this.sendJson(res, 200, { approvals: this.pendingApprovals() });
      return;
    }
    if (method === "GET" && (path === "/api/devices" || path === "/api/pair/status")) {
      if (!isOwner) { this.sendError(res, 403, "只能在电脑上管理已配对设备"); return; }
      this.sendJson(res, 200, {
        devices: this.devices.listDevices(),
        pairing: this.devices.pairingStatus(),
        lan: Boolean(this.pairOrigin),
      });
      return;
    }
    if (method === "GET" && path === "/api/info") { this.sendJson(res, 200, this.info()); return; }
    if (method === "GET" && path === "/api/schedule") {
      try { this.sendJson(res, 200, { tasks: this.scheduleList() }); }
      catch (err) { this.sendError(res, 400, `定时任务读取失败：${err instanceof Error ? err.message : String(err)}`); }
      return;
    }
    if (method === "GET" && path === "/api/memory/scopes") {
      this.sendJson(res, 200, { scopes: memoryScopes(this.home) });
      return;
    }
    if (method === "GET" && path === "/api/memory") {
      try {
        const result = memoryView(this.home, query.get("scope") ?? "global", query.get("room"), query.get("bot"));
        this.sendJson(res, 200, result);
      } catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
      return;
    }
    if (method === "GET" && path === "/api/sessions") { this.sendJson(res, 200, this.sessionsView()); return; }
    if (method === "GET" && path === "/api/mcp/tools") { this.sendJson(res, 200, { tools: this.mcpTools() }); return; }
    if (method === "GET" && path === "/api/mcp/spend") {
      this.sendJson(res, 200, { limit_usd: costLimitUsd(this.config), spent_usd: this.mcpCost.totalUsd() });
      return;
    }
    if (method === "GET" && path === "/api/smart-approvals/audit") {
      if (!isOwner) { this.sendError(res, 403, "只能在电脑上查看审批审计日志"); return; }
      this.sendJson(res, 200, { records: readAudit(this.home).slice(-100) });
      return;
    }
    const artifactsMatch = /^\/api\/sessions\/([^/]+)\/artifacts$/.exec(path);
    if (method === "GET" && artifactsMatch) {
      const sid = this.validSid(artifactsMatch[1]);
      if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
      this.sendJson(res, 200, { artifacts: listArtifacts(sid, this.home) });
      return;
    }
    const artifactMatch = /^\/api\/artifacts\/([0-9a-f]{12})$/.exec(path);
    if (method === "GET" && artifactMatch) {
      const rec = getArtifact(artifactMatch[1], this.home);
      if (!rec) { this.sendError(res, 404, "产物不存在"); return; }
      this.sendJson(res, 200, rec);
      return;
    }
    const historyMatch = /^\/api\/sessions\/([^/]+)\/history$/.exec(path);
    if (method === "GET" && historyMatch) {
      const sid = this.validSid(historyMatch[1]);
      if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
      this.sendJson(res, 200, { messages: this.storeHistory(sid) });
      return;
    }
    const eventsMatch = /^\/api\/sessions\/([^/]+)\/events$/.exec(path);
    if (method === "GET" && eventsMatch) {
      const sid = this.validSid(eventsMatch[1]);
      if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
      if (!this.sessionKnown(sid)) { this.sendError(res, 404, "会话不存在"); return; }
      let since = 0;
      try { since = Math.max(0, Number(query.get("since") ?? "0") || 0); } catch { since = 0; }
      this.streamEvents(req, res, sid, since);
      return;
    }
    const sessionGetMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
    if (method === "GET" && sessionGetMatch) {
      const sid = this.validSid(sessionGetMatch[1]);
      if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
      let since = 0;
      try { since = Math.max(0, Number(query.get("since") ?? "0") || 0); } catch { since = 0; }
      this.sendJson(res, 200, this.sessionView(sid, since));
      return;
    }
    if (method === "GET" && path === "/api/groups") {
      this.sendJson(res, 200, { groups: this.groups.listRooms() });
      return;
    }
    const groupMatch = /^\/api\/groups\/([a-z][a-z0-9_-]{0,31})$/.exec(path);
    if (method === "GET" && groupMatch) {
      try { this.sendJson(res, 200, this.groups.get(groupMatch[1])); }
      catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
      return;
    }

    // ---- POST ----
    if (method === "POST") {
      let body: Record<string, unknown>;
      try { body = await this.readBody(req); } catch (err) { this.sendError(res, 400, `请求无效：${err instanceof Error ? err.message : String(err)}`); return; }
      if (path === "/api/pair/start") {
        if (!isOwner) { this.sendError(res, 403, "只能在电脑上管理已配对设备"); return; }
        try { this.sendJson(res, 200, this.startPairing()); }
        catch (err) { this.sendError(res, 409, err instanceof Error ? err.message : String(err)); }
        return;
      }
      const revokeMatch = /^\/api\/devices\/([^/]+)\/revoke$/.exec(path);
      if (revokeMatch) {
        if (!isOwner) { this.sendError(res, 403, "只能在电脑上管理已配对设备"); return; }
        if (!/^[0-9a-f]{16}$/.test(revokeMatch[1])) { this.sendError(res, 400, "设备 id 无效"); return; }
        if (!this.devices.revoke(revokeMatch[1])) { this.sendError(res, 404, "设备不存在"); return; }
        this.sendJson(res, 200, { ok: true });
        return;
      }
      if (path === "/api/memory") {
        try {
          const result = memorySave(
            this.home,
            String(body.scope ?? "global"),
            typeof body.room === "string" ? body.room : null,
            typeof body.bot === "string" ? body.bot : null,
            String(body.revision ?? ""), String(body.content ?? ""),
          );
          this.sendJson(res, 200, result);
        } catch (err) {
          if (err instanceof MemoryBrowserError && err.name === "MemoryConflict") this.sendError(res, 409, err.message);
          else this.sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (path === "/api/sessions") { this.sendJson(res, 201, { id: this.newSession() }); return; }
      if (path === "/api/provider") {
        const name = String(body.provider ?? "").trim();
        if (!name) { this.sendError(res, 400, "请指定 provider"); return; }
        try {
          const switched = this.setProvider(name, typeof body.model === "string" ? body.model.trim() || null : null);
          this.sendJson(res, 200, switched);
        } catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
        return;
      }
      if (path === "/api/mode") {
        try {
          const mode = this.setMode(String(body.mode ?? ""));
          this.sendJson(res, 200, { mode });
        } catch (err) {
          if (err instanceof Error && err.message.includes("正在执行")) this.sendError(res, 409, err.message);
          else this.sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (path === "/api/schedule") {
        try {
          const result = this.scheduleAction(String(body.action ?? ""), String(body.name ?? ""));
          this.sendJson(res, 200, result);
        } catch (err) {
          const status = (err as { status?: number }).status ?? 400;
          this.sendError(res, status, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (path === "/api/mcp/call") {
        const tool = String(body.tool ?? "");
        const args = (body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments))
          ? body.arguments as Record<string, unknown> : {};
        if (!tool) { this.sendError(res, 400, "请指定 MCP 工具"); return; }
        try {
          const result = await this.mcpCall(tool, args);
          this.sendJson(res, 200, result);
        } catch (err) { this.sendError(res, 409, err instanceof Error ? err.message : String(err)); }
        return;
      }
      if (path === "/api/groups") {
        try {
          const bots = (body.bots as BotConfig[] | null | undefined) ?? null;
          const room = this.groups.create(String(body.id ?? ""), String(body.name ?? ""), bots);
          this.sendJson(res, 201, room);
        } catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
        return;
      }
      const groupMsgMatch = /^\/api\/groups\/([a-z][a-z0-9_-]{0,31})\/messages$/.exec(path);
      if (groupMsgMatch) {
        try {
          const rounds = body.rounds === undefined ? 1 : Number(body.rounds);
          const result = await this.groups.send(groupMsgMatch[1], String(body.text ?? ""), rounds);
          this.sendJson(res, 200, result);
        } catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
        return;
      }
      const sendMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
      if (sendMatch) {
        const sid = this.validSid(sendMatch[1]);
        if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
        const text = String(body.text ?? "").trim();
        if (!text) { this.sendError(res, 400, "消息不能为空"); return; }
        try {
          const run = this.send(sid, text);
          this.sendJson(res, 202, { id: sid, status: run.status, error: run.error });
        } catch (err) { this.sendError(res, 409, err instanceof Error ? err.message : String(err)); }
        return;
      }
      const planMatch = /^\/api\/sessions\/([^/]+)\/plan$/.exec(path);
      if (planMatch) {
        const sid = this.validSid(planMatch[1]);
        if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
        const text = String(body.text ?? "").trim();
        if (!text) { this.sendError(res, 400, "任务不能为空"); return; }
        try {
          const run = this.plan(sid, text);
          this.sendJson(res, 202, { id: sid, status: run.status, error: run.error });
        } catch (err) { this.sendError(res, 409, err instanceof Error ? err.message : String(err)); }
        return;
      }
      const execMatch = /^\/api\/sessions\/([^/]+)\/plan\/execute$/.exec(path);
      if (execMatch) {
        const sid = this.validSid(execMatch[1]);
        if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
        const digest = String(body.sha256 ?? "");
        if (!SHA256_RE.test(digest)) { this.sendError(res, 400, "需要完整的 64 位 SHA-256 计划校验值"); return; }
        try {
          const run = this.executePlan(sid, digest);
          this.sendJson(res, 202, { id: sid, status: run.status, error: run.error });
        } catch (err) {
          if (err instanceof Error && err.message.includes("正在执行")) this.sendError(res, 409, err.message);
          else this.sendError(res, 400, err instanceof Error ? err.message : String(err));
        }
        return;
      }
      const rewindMatch = /^\/api\/sessions\/([^/]+)\/rewind$/.exec(path);
      if (rewindMatch) {
        const sid = this.validSid(rewindMatch[1]);
        if (!sid) { this.sendError(res, 400, "会话 id 无效"); return; }
        const messageId = Number(body.message_id);
        const action = String(body.action ?? "") as RewindAction;
        if (!Number.isInteger(messageId) || messageId <= 0) { this.sendError(res, 400, "message_id 无效"); return; }
        if (!["truncate", "edit", "fork"].includes(action)) { this.sendError(res, 400, "未知的回退操作"); return; }
        try {
          const result = this.rewindSession(sid, messageId, action, typeof body.text === "string" ? body.text : null);
          this.sendJson(res, 200, result);
        } catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
        return;
      }
      const decideMatch = /^\/api\/approvals\/([0-9a-f]{16})$/.exec(path);
      if (decideMatch) {
        try {
          const ok = this.decide(decideMatch[1], Boolean(body.approve), Boolean(body.always));
          if (!ok) { this.sendError(res, 404, "审批已失效"); return; }
          this.sendJson(res, 200, { ok: true });
        } catch (err) { this.sendError(res, 400, err instanceof Error ? err.message : String(err)); }
        return;
      }
      this.sendError(res, 404, "未找到");
      return;
    }

    this.sendError(res, 404, "未找到");
  }

  private streamEvents(req: IncomingMessage, res: ServerResponse, sid: string, since: number): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    });
    const write = (text: string): boolean => { try { res.write(text); return true; } catch { return false; } };
    write(": connected\n\n");
    let cursor = Math.max(0, since);
    let lastWrite = Date.now();
    let closed = false;
    req.on("close", () => { closed = true; clearInterval(timer); });
    const timer = setInterval(() => {
      if (closed) { clearInterval(timer); return; }
      try {
        const view = this.sessionView(sid, cursor) as unknown as {
          events: Record<string, unknown>[]; next: number; status: string; error: string;
        };
        for (const event of view.events) {
          if (!write("data: " + JSON.stringify(event) + "\n\n")) return;
          lastWrite = Date.now();
        }
        cursor = view.next;
        if (view.status === "done" || view.status === "error") {
          write("data: " + JSON.stringify({ type: "run_finished", data: { status: view.status, error: view.error }, ts: Date.now() / 1000 }) + "\n\n");
          clearInterval(timer);
          res.end();
          return;
        }
        if (Date.now() - lastWrite >= 15000) { write(": heartbeat\n\n"); lastWrite = Date.now(); }
      } catch { clearInterval(timer); try { res.end(); } catch { /* ignore */ } }
    }, 200);
    timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopScheduler();
    if (this.discoverySocket) { try { this.discoverySocket.close(); } catch { /* ignore */ } this.discoverySocket = null; }
    if (this.mcpManager) { try { this.mcpManager.stopAll(); } catch { /* ignore */ } this.mcpManager = null; }
    if (this.server) {
      await new Promise<void>((resolve) => { this.server!.close(() => resolve()); });
      this.server = null;
    }
    try { this._store?.close(); } catch { /* ignore */ }
  }

  /**
   * 对话存档懒加载：构造/启动时不开 SQLite 库，首次访问会话历史时才建库
   * （第 4 阶段性能收尾：空闲 RSS 不为还没用到的存档付 SQLite 的页成本）。
   */
  get store(): ConversationStore {
    if (!this._store) this._store = new ConversationStore(this.home);
    return this._store;
  }
}
