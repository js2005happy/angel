// src/mcp.ts — MCP 客户端（stdio JSON-RPC），与 Python 版 nyra/mcp.py 同语义。
// 协议 2026-07-28：先 server/discover 探测（-32022 时按 supported 列表
// 挑版本），失败回退旧版 initialize（2025-11-25）+ notifications/initialized；
// tools/list 分页；tools/call 遇多轮往返（input_required）直接报错，不假装完成。
// 服务器主动发来的请求一律回 -32601（不支持）。超时放弃的旧响应按 id 丢弃。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_MCP_PRESETS, resolvePreset } from "./mcpPresets.ts";
import { buildBwrapArgv, resolveSandboxBackend, type SandboxMode } from "./sandbox.ts";
import { buildSeatbeltProfile } from "./seatbelt.ts";

export const LATEST_PROTOCOL_VERSION = "2026-07-28";
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"];
export const LEGACY_HANDSHAKE_VERSION = "2025-11-25";
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2024-11-05"];
export const UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022;
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const PROBE_TIMEOUT = 60.0;
const CLIENT_VERSION = "0.3.0";
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 代理环境变量里可能带凭据：绝不原样透传给 MCP 子进程（Python 同规则）。
const PROXY_ENV_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

export class MCPError extends Error {
  constructor(message: string) { super(message); this.name = "MCPError"; }
}

export class MCPRequestError extends MCPError {
  code: number | null;
  data: unknown;
  constructor(message: string, code: number | null = null, data: unknown = null) {
    super(message);
    this.name = "MCPRequestError";
    this.code = code;
    this.data = data;
  }
}

export interface MCPServerConfigLike {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  inherit_env: string[];
}

export class MCPServerConfig implements MCPServerConfigLike {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  inherit_env: string[];
  constructor(name: string, command: string, args: string[] = [], env: Record<string, string> = {}, inheritEnv: string[] = []) {
    this.name = name; this.command = command; this.args = args; this.env = env; this.inherit_env = inheritEnv;
  }

  static fromDict(name: string, raw: unknown): MCPServerConfig {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new MCPError("服务器配置必须是字典");
    const r = raw as Record<string, unknown>;
    const command = r.command;
    if (typeof command !== "string" || !command.trim()) throw new MCPError("command 必须是非空字符串");
    const args = r.args ?? [];
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new MCPError("args 必须是列表，且每一项必须是字符串");
    const env = r.env ?? {};
    if (!env || typeof env !== "object" || Array.isArray(env) ||
      Object.entries(env as Record<string, unknown>).some(([k, v]) => typeof k !== "string" || typeof v !== "string" || !ENV_NAME_RE.test(k))) {
      throw new MCPError("env 的键和值必须是字符串，且键是合法环境变量名");
    }
    const inheritEnv = r.inherit_env ?? [];
    if (!Array.isArray(inheritEnv) || inheritEnv.some((k) => typeof k !== "string" || !ENV_NAME_RE.test(k))) {
      throw new MCPError("inherit_env 必须是合法环境变量名称列表");
    }
    return new MCPServerConfig(name, command, [...(args as string[])], { ...(env as Record<string, string>) }, [...(inheritEnv as string[])]);
  }
}

function stripProxyCredentials(value: string): string {
  // user:pass@host 形式的代理 URL：去掉凭据段，只留 host。
  try {
    const u = new URL(value);
    if (u.username || u.password) { u.username = ""; u.password = ""; return u.toString(); }
  } catch { /* 非 URL 原样返回 */ }
  return value;
}

export interface McpTool { name: string; description: string; inputSchema: Record<string, unknown>; }

/**
 * MCP 沙箱配置（与 Agent/CLI/群聊同款形状，见 sandbox.ts）：MCPToolManager
 * 在 startAll 里用 resolveSandboxBackend 解析一次，解析失败整批拒绝启动。
 * workdir 是服务器进程的工作目录（bwrap/Seatbelt 绑定的工作区）。
 */
export interface McpSandboxOptions {
  backend?: string | null;
  mode?: SandboxMode;
  allowNet?: boolean;
  workdir?: string;
}

/** 已解析的 MCP 沙箱配置（MCPClient 持有，start() 时直接用，不再二次解析）。 */
export interface ResolvedMcpSandbox {
  backend: string;
  mode: SandboxMode;
  allowNet: boolean;
  workdir: string;
}

/** 在 PATH 里找可执行文件（供 MCP 沙箱找服务器命令的真实位置；找不到返回 null）。 */
export function findOnPath(command: string, pathEnv?: string, platform: string = process.platform): string | null {
  if (isAbsolute(command)) return existsSync(command) ? command : null;
  if (command.includes("/") || (platform === "win32" && command.includes("\\"))) return null;
  const pathValue = pathEnv ?? process.env.PATH ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const candidates = platform === "win32" ? [command, `${command}.exe`, `${command}.cmd`] : [command];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of candidates) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch { /* 不存在或不可读就继续找 */ }
    }
  }
  return null;
}

/**
 * bwrap 追加只读绑定目录：服务器命令本身（绝对路径或 PATH 解析后）与绝对
 * 路径参数所在目录。工作区内或已在系统挂载面里的目录不重复加。
 */
export function mcpServerRoBinds(config: MCPServerConfig, workdir: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const addDir = (dir: string): void => {
    const abs = resolve(dir);
    if (seen.has(abs)) return;
    seen.add(abs);
    const wd = resolve(workdir);
    if (abs === wd || abs.startsWith(wd + "/")) return;
    if (["/usr", "/lib", "/lib64", "/bin", "/etc"].some((base) => abs === base || abs.startsWith(base + "/"))) return;
    out.push(abs);
  };
  const cmdPath = findOnPath(config.command);
  if (cmdPath) addDir(dirname(cmdPath));
  for (const arg of config.args) {
    if (!isAbsolute(arg)) continue;
    try {
      if (!existsSync(arg)) continue;
      addDir(statSync(arg).isDirectory() ? arg : dirname(arg));
    } catch { /* 读不到就跳过，不拦启动 */ }
  }
  return out;
}

/**
 * 按沙箱配置算出 MCP 服务器进程的 spawn 参数（纯函数，可单测）。
 * 返回 [spawn 命令, spawn 参数]。沙箱不可用时抛 MCPError——调用方不启动
 * 该服务器，绝不静默裸奔。
 * - local：原样 spawn（工具级隔离，与 0.5.1 前行为一致）。
 * - bwrap：复用 buildBwrapArgv；服务器命令与绝对路径参数所在目录追加只读
 *   绑定（服务器可执行文件本身常在工作区外，不绑就读不到）。
 * - seatbelt：sandbox-exec -p <profile> <command> <args>，profile 与
 *   toolShell 同款（工作区可写、默认断网）。
 * - jobobject：Job Object 是一锤子脚本执行器（runWindowsSandboxed），装不下
 *   长驻 stdio 进程，显式指定时直接拒绝。
 * - e2b：未接线（见 docs/sandbox.md），显式指定时直接拒绝。
 */
export function sandboxedMcpSpawnArgs(
  config: MCPServerConfig,
  resolved: { backend: string; mode: SandboxMode; allowNet: boolean },
  workdir: string,
): [string, string[]] {
  if (resolved.backend === "local") return [config.command, [...config.args]];
  if (resolved.backend === "bwrap") {
    const argv = buildBwrapArgv(config.command, config.args, {
      workdir,
      allowNet: resolved.allowNet,
      mode: resolved.mode,
      extraRoBinds: mcpServerRoBinds(config, workdir),
    });
    return [argv[0], argv.slice(1)];
  }
  if (resolved.backend === "seatbelt") {
    const profile = buildSeatbeltProfile({ mode: resolved.mode, workdir, allowNet: resolved.allowNet });
    return ["sandbox-exec", ["-p", profile, config.command, ...config.args]];
  }
  if (resolved.backend === "jobobject") {
    throw new MCPError(
      `MCP 服务器 ${config.name} 无法进 Job Object 沙箱：Job Object 是一锤子脚本执行器，装不下长驻 stdio 进程；` +
      "请改用 --sandbox local（工具级）或 bwrap/seatbelt",
    );
  }
  if (resolved.backend === "e2b") {
    throw new MCPError(`MCP 服务器 ${config.name} 无法进 e2b 沙箱：e2b 后端未接线（见 docs/sandbox.md）；请改用 --sandbox local 或 bwrap`);
  }
  throw new MCPError(`MCP 服务器 ${config.name} 的沙箱后端 ${resolved.backend} 未知，拒绝启动`);
}

export class MCPClient {
  config: MCPServerConfig;
  timeout: number;
  /** 已解析的沙箱配置；为 null 时原样 spawn（0.5.1 前行为）。 */
  sandbox: ResolvedMcpSandbox | null;
  process: ChildProcessWithoutNullStreams | null = null;
  nextId = 1;
  tools: McpTool[] = [];
  era: "modern" | "legacy" | null = null;
  negotiatedVersion: string | null = null;
  serverInfo: Record<string, unknown> | null = null;
  private buffer = "";
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private staleIds = new Set<number>();
  private exitPromise: Promise<number | null> | null = null;
  // stdout 按字节攒行：StringDecoder 会缓存被 chunk 边界切断的多字节字符，
  // 避免逐 chunk 转字符串时出现 U+FFFD 导致整行 JSON 解析失败被静默丢弃。
  private stdoutDecoder = new StringDecoder("utf-8");
  // 传输层诊断计数：行解析失败时不再静默丢弃，而是记下来；请求超时
  // 时据此判断是“服务器没回”还是“回了但解析失败”（后者曾在 Windows
  // 上造成 10 秒超时却无任何线索）。
  private bytesReceived = 0;
  private linesParsed = 0;
  private badLineCount = 0;
  private lastBadLine: string | null = null;

  constructor(config: MCPServerConfig, timeout = 30.0, sandbox: ResolvedMcpSandbox | null = null) {
    this.config = config;
    this.timeout = timeout;
    this.sandbox = sandbox;
  }

  private subprocessEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (PROXY_ENV_VARS.includes(k)) { env[k] = stripProxyCredentials(v); continue; }
      env[k] = v;
    }
    for (const k of this.config.inherit_env) {
      if (process.env[k] !== undefined) env[k] = process.env[k]!;
    }
    Object.assign(env, this.config.env);
    return env;
  }

  start(): void {
    if (this.process) return;
    // 沙箱：按已解析配置算 spawn 参数；算不出来（后端不可用/不支持长驻进程）
    // 直接抛 MCPError，服务器不启动——绝不静默裸奔。
    let command = this.config.command;
    let args = [...this.config.args];
    if (this.sandbox) {
      try {
        [command, args] = sandboxedMcpSpawnArgs(this.config, this.sandbox, this.sandbox.workdir);
      } catch (err) {
        throw new MCPError(`MCP 服务器 ${this.config.name} 无法进沙箱，拒绝启动：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"], env: this.subprocessEnv(),
    });
    this.process = child;
    this.exitPromise = new Promise((resolve) => { child.on("exit", (code) => resolve(code)); });
    this.stdoutDecoder = new StringDecoder("utf-8");
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", () => { /* MCP 服务端日志不进协议流，丢弃 */ });
    child.stdin.on("error", (err: Error) => {
      // stdin 管道断裂时挂起的请求会等满超时才报；直接失败，给出原因。
      this.failPending(new MCPError(`MCP 服务器 ${this.config.name} 写入失败：${err.message}`));
    });
    child.on("error", (err: Error) => {
      // spawn 失败（如命令不存在）时只触发 error，不一定有 exit；
      // 不挂监听会变成未处理异常，挂起的请求也要立即失败而不是等超时。
      this.failPending(new MCPError(`MCP 服务器 ${this.config.name} 启动失败：${err.message}`));
    });
    child.on("exit", () => {
      this.failPending(new MCPError(`MCP 服务器 ${this.config.name} 已退出`));
    });
    this.negotiate();
  }

  /** 传输层已死（stdin 断裂 / 写入失败 / 进程退出）时让挂起的请求
   * 立即失败，而不是等满超时。重复调用无害：已清空的 pending 不再
   * 有待拒绝的项，已落定的 promise 再次 reject 也是空操作。 */
  private failPending(err: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  private onStdout(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.stdoutDecoder.write(chunk);
    this.bytesReceived += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf-8") : chunk.length;
    this.buffer += text;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.badLineCount++;
        this.lastBadLine = line.length > 200 ? line.slice(0, 200) + "……" : line;
        continue;
      }
      this.linesParsed++;
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.method === "string") {
      // 服务器主动请求：最小客户端不支持，一律回 -32601。
      if (msg.id !== undefined && this.process?.stdin.writable) {
        this.writeMessage({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Nyra 不支持服务器主动请求的方法" } });
      }
      return;
    }
    if (msg.id === undefined) return;
    const id = msg.id as number;
    const p = this.pending.get(id);
    if (!p) {
      if (this.staleIds.has(id)) this.staleIds.delete(id);
      return;
    }
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.error !== undefined && msg.error !== null) {
      const e = msg.error as Record<string, unknown>;
      p.reject(new MCPRequestError(
        `MCP 错误：${typeof e.message === "string" ? e.message : "服务器未提供错误说明"}`,
        typeof e.code === "number" ? e.code : null, e.data ?? null,
      ));
      return;
    }
    if (msg.result === undefined || msg.result === null || typeof msg.result !== "object") {
      p.reject(new MCPError("MCP 响应格式无效：缺少 result"));
      return;
    }
    p.resolve(msg.result as Record<string, unknown>);
  }

  private writeMessage(msg: Record<string, unknown>): void {
    if (!this.process) throw new MCPError("MCP 服务器未启动");
    if (this.process.exitCode !== null) throw new MCPError(`MCP 服务器 ${this.config.name} 已退出`);
    if (!this.process.stdin.writable) throw new MCPError("MCP 服务器未启动");
    this.process.stdin.write(JSON.stringify(msg) + "\n", (err) => {
      // 写入回调报错且管道已死（如 EPIPE）时，挂起的请求不再等满
      // 超时，直接失败；管道仍可用时忽略（数据已入队）。
      if (err && this.process?.stdin && !this.process.stdin.writable) {
        this.failPending(new MCPError(`MCP 服务器 ${this.config.name} 写入失败：${err.message}`));
      }
    });
    // 交互式 stdio 协议：写完即刷。Bun 原生 FileSink 有 flush()，
    // 这里若存在就调一次；node:child_process 的 WriteStream 上
    // flush 不是函数，此步为空操作，不影响任何行为。
    const sink = this.process.stdin as unknown as { flush?: unknown };
    if (typeof sink.flush === "function") (sink.flush as () => void).call(this.process.stdin);
  }

  private modernMeta(version: string): Record<string, unknown> {
    return {
      [META_PROTOCOL_VERSION]: version,
      [META_CLIENT_CAPABILITIES]: {},
      [META_CLIENT_INFO]: { name: "Nyra", version: CLIENT_VERSION },
    };
  }

  private async sendRequest(method: string, params: Record<string, unknown> = {}, meta?: Record<string, unknown> | null, timeout?: number): Promise<Record<string, unknown>> {
    // Windows 上偶发（CI 三轮里同一测试必现其一）：请求发出后整个
    // 超时窗口内收到 0 字节、服务器仍活着——请求或回复在传输层
    // 丢了，本地复现不了（Linux 上 10/10 次 1ms 内回包；MITM
    // 1 字节切片亦通过；请求 JSON 全是 ASCII，排除多字节切断）。
    // 只对这种可确认的“零字节丢失”重试一次（新 id），其余失败
    // （服务器已退出、有坏行、已收到部分回复）一律不重试。重试
    // 有极小重复执行风险：若服务器其实已执行但回复丢了，重发会
    // 再执行一次；零字节意味着它大概率根本没收到请求，且原地
    // 10 秒超时后由上层重试的风险与体验都更差，因此接受折中。
    let lastErr: unknown = null;
    let retried = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.sendRequestOnce(method, params, meta, timeout);
      } catch (err) {
        lastErr = err;
        const zeroByte = err instanceof MCPError
          && (err as MCPError & { zeroByteTimeout?: boolean }).zeroByteTimeout === true;
        if (attempt === 0 && zeroByte && this.process !== null && this.process.exitCode === null) {
          retried = true;
          process.stderr.write(`MCP 请求无响应后重试（第 1 次）：${method}（发出后 0 字节，服务器仍在运行）\n`);
          continue;
        }
        if (retried && err instanceof MCPError) err.message += "（已重试 1 次）";
        throw err;
      }
    }
    throw lastErr;
  }

  private async sendRequestOnce(method: string, params: Record<string, unknown> = {}, meta?: Record<string, unknown> | null, timeout?: number): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const body: Record<string, unknown> = { ...params };
    if (meta !== undefined && meta !== null) body._meta = meta;
    else if (this.era === "modern") body._meta = this.modernMeta(this.negotiatedVersion ?? LATEST_PROTOCOL_VERSION);
    const deadline = (timeout ?? this.timeout) * 1000;
    // 发送时快照传输计数：超时后据此判断这段时间内服务器到底回了
    // 什么（没回 / 回了但解析失败 / 回了但 id 对不上），而不是只报
    // 一句“超时”。
    const sentBytes = this.bytesReceived;
    const sentLines = this.linesParsed;
    const sentBad = this.badLineCount;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.staleIds.add(id);
        const serverAlive = this.process !== null && this.process.exitCode === null;
        const serverState = this.process === null ? "客户端已停止"
          : serverAlive ? "服务器仍在运行" : "服务器已退出";
        const recvBytes = this.bytesReceived - sentBytes;
        const recvLines = this.linesParsed - sentLines;
        const recvBad = this.badLineCount - sentBad;
        const detail = `请求发出后已收字节 +${recvBytes}`
          + `，已解析行 +${recvLines}`
          + `，无法解析行 +${recvBad}`
          + (this.lastBadLine !== null ? `，最后无法解析行：${this.lastBadLine}` : "")
          + `，${serverState}`;
        const err = new MCPError(`MCP 请求超时：${method}（${detail}）`);
        // 零字节且服务器活着 = 请求或回复在传输层丢了（见 sendRequest），
        // 可重试；其余超时原因不重试。
        (err as MCPError & { zeroByteTimeout?: boolean }).zeroByteTimeout
          = recvBytes === 0 && recvLines === 0 && recvBad === 0 && serverAlive;
        reject(err);
      }, deadline);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      this.writeMessage({ jsonrpc: "2.0", id, method, params: body });
    } catch (err) {
      const p = this.pending.get(id);
      if (p) { this.pending.delete(id); clearTimeout(p.timer); }
      throw err;
    }
    try {
      return await promise;
    } catch (err) {
      this.staleIds.add(id);
      throw err;
    }
  }

  private sendNotification(method: string, params: Record<string, unknown> = {}): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private async discover(version: string): Promise<Record<string, unknown>> {
    return this.sendRequest("server/discover", {}, this.modernMeta(version), Math.min(this.timeout, PROBE_TIMEOUT));
  }

  private pickModernVersion(data: unknown): string | null {
    if (!data || typeof data !== "object") return null;
    const supported = (data as Record<string, unknown>).supported;
    if (!Array.isArray(supported)) return null;
    for (const v of MODERN_PROTOCOL_VERSIONS) if (supported.includes(v)) return v;
    return null;
  }

  private useModern(result: Record<string, unknown>, requested: string): void {
    const supported = result.supportedVersions;
    if (!Array.isArray(supported) || !supported.length) throw new MCPError("MCP 发现结果格式无效：supportedVersions 必须是列表");
    let version: string | null = null;
    if (supported.includes(requested)) version = requested;
    else version = MODERN_PROTOCOL_VERSIONS.find((v) => supported.includes(v)) ?? null;
    if (!version) throw new MCPError("MCP 服务器不支持任何 Nyra 能用的现代协议版本：" + supported.map(String).join("、"));
    this.negotiatedVersion = version;
    this.era = "modern";
    const meta = result._meta;
    if (meta && typeof meta === "object") {
      const info = (meta as Record<string, unknown>)[META_SERVER_INFO];
      if (info && typeof info === "object") this.serverInfo = info as Record<string, unknown>;
    }
  }

  private async initializeLegacy(): Promise<void> {
    const result = await this.sendRequest("initialize", {
      protocolVersion: LEGACY_HANDSHAKE_VERSION,
      capabilities: {},
      clientInfo: { name: "Nyra", version: CLIENT_VERSION },
    });
    const serverVersion = result.protocolVersion;
    if (typeof serverVersion === "string" && !LEGACY_PROTOCOL_VERSIONS.includes(serverVersion)) {
      // 旧版握手回的版本不在支持列表里：仍按旧版走，但记下协商版本。
      this.negotiatedVersion = serverVersion;
    } else {
      this.negotiatedVersion = typeof serverVersion === "string" ? serverVersion : LEGACY_HANDSHAKE_VERSION;
    }
    this.era = "legacy";
    const info = result.serverInfo;
    if (info && typeof info === "object") this.serverInfo = info as Record<string, unknown>;
    this.sendNotification("notifications/initialized");
  }

  /** 同步协商：discover 失败（-32022 挑版本 / 其他错误）时回退旧版 initialize。 */
  private negotiate(): void {
    // start() 是同步入口：协商在首次请求时以异步方式完成。
    // 为保持与 Python 的 start() 同步语义一致，这里只做标记，真正
    // 的握手在 ensureNegotiated() 里完成（list_tools/call_tool 前调）。
    this.negotiatePromise ??= this.doNegotiate();
  }
  private negotiatePromise: Promise<void> | null = null;

  private async doNegotiate(): Promise<void> {
    try {
      const result = await this.discover(LATEST_PROTOCOL_VERSION);
      this.useModern(result, LATEST_PROTOCOL_VERSION);
      return;
    } catch (err) {
      if (err instanceof MCPRequestError && err.code === UNSUPPORTED_PROTOCOL_VERSION_CODE) {
        const picked = this.pickModernVersion(err.data);
        if (picked) {
          try {
            const result = await this.discover(picked);
            this.useModern(result, picked);
            return;
          } catch { /* 挑版本重试失败，落到旧版握手 */ }
        }
      }
      // 其他 discover 失败（方法不存在、超时等）→ 旧版握手。
      try {
        await this.initializeLegacy();
      } catch (legacyErr) {
        // 协商彻底失败：子进程已无用，按 Python 口径清理（否则静默子进程泄漏）。
        this.stop();
        throw legacyErr;
      }
    }
  }

  async ensureNegotiated(): Promise<void> {
    if (this.negotiatePromise) await this.negotiatePromise;
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensureNegotiated();
    const tools: McpTool[] = [];
    let cursor: string | null = null;
    for (;;) {
      const params: Record<string, unknown> = {};
      if (cursor !== null) params.cursor = cursor;
      const result = await this.sendRequest("tools/list", params);
      const rawTools = result.tools;
      if (!Array.isArray(rawTools)) throw new MCPError("MCP 工具列表格式无效：tools 必须是列表");
      for (const tool of rawTools) {
        if (!tool || typeof tool !== "object") throw new MCPError("MCP 工具格式无效：工具必须是字典");
        const t = tool as Record<string, unknown>;
        if (typeof t.name !== "string" || !t.name) throw new MCPError("MCP 工具格式无效：name 必须是非空字符串");
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          inputSchema: (t.inputSchema && typeof t.inputSchema === "object"
            ? t.inputSchema : { type: "object", properties: {} }) as Record<string, unknown>,
        });
      }
      const next = result.nextCursor;
      if (typeof next !== "string" || !next) break;
      cursor = next;
    }
    this.tools = tools;
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureNegotiated();
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    if (result.resultType === "input_required") {
      const requests = result.inputRequests;
      let detail = "";
      if (requests && typeof requests === "object" && !Array.isArray(requests) && Object.keys(requests).length) {
        detail = "（需要：" + Object.keys(requests).sort().join("、") + "）";
      } else if (Array.isArray(requests) && requests.length) {
        detail = `（需要 ${requests.length} 项输入）`;
      }
      throw new MCPError(`MCP 服务器要求补充输入后重试（多轮往返），Nyra 暂不支持${detail}`);
    }
    const content = result.content ?? [];
    if (!Array.isArray(content)) throw new MCPError("MCP 工具响应格式无效：content 必须是列表");
    const texts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") throw new MCPError("MCP 工具响应格式无效：内容项必须是字典");
      const it = item as Record<string, unknown>;
      if (it.type === "text") {
        if (typeof it.text !== "string") throw new MCPError("MCP 工具响应格式无效：text 必须是字符串");
        texts.push(it.text);
      }
    }
    let output = texts.length ? texts.join("\n") : JSON.stringify(result);
    if (result.isError) output = "MCP 工具返回错误：\n" + output;
    return output;
  }

  stop(): void {
    const proc = this.process;
    if (!proc) return;
    this.process = null;
    this.tools = [];
    this.negotiatePromise = null;
    try {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        const deadline = Date.now() + 2000;
        const iv = setInterval(() => {
          if (proc.exitCode !== null || Date.now() > deadline) {
            clearInterval(iv);
            if (proc.exitCode === null) { try { proc.kill("SIGKILL"); } catch { /* ignore */ } }
            try { proc.stdin.end(); } catch { /* ignore */ }
          }
        }, 50);
      }
    } catch { /* ignore */ }
  }
}

export function loadMcpServers(config: Record<string, unknown>): Record<string, MCPServerConfig> {
  const servers: Record<string, MCPServerConfig> = {};
  let presetNames = (config as Record<string, unknown>).mcp_presets;
  if (!Array.isArray(presetNames) || !presetNames.every((n) => typeof n === "string")) {
    if (presetNames !== undefined) process.stderr.write("mcp_presets 应为预置名列表，已忽略并使用默认预置\n");
    presetNames = [...DEFAULT_MCP_PRESETS];
  }
  const presetArgs = ((config as Record<string, unknown>).mcp_preset_args ?? {}) as Record<string, unknown>;
  for (const name of presetNames as string[]) {
    const [raw, reason] = resolvePreset(name, presetArgs);
    if (raw === null) { process.stderr.write(reason + "\n"); continue; }
    try { servers[name] = MCPServerConfig.fromDict(name, raw); }
    catch (err) { process.stderr.write(`跳过无效 MCP 预置 ${name}: ${err instanceof Error ? err.message : String(err)}\n`); }
  }
  const rawServers = (config as Record<string, unknown>).mcp_servers;
  if (rawServers && typeof rawServers === "object" && !Array.isArray(rawServers)) {
    for (const [name, raw] of Object.entries(rawServers as Record<string, unknown>)) {
      try { servers[name] = MCPServerConfig.fromDict(name, raw); }
      catch (err) { process.stderr.write(`跳过无效 MCP 服务器配置 ${name}: ${err instanceof Error ? err.message : String(err)}\n`); }
    }
  }
  return servers;
}

export function sanitizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

export interface McpToolSchema { type: string; function: { name: string; description: string; parameters: Record<string, unknown> }; [key: string]: unknown }

export class MCPToolManager {
  servers: Record<string, MCPServerConfig>;
  timeout: number;
  clients: Record<string, MCPClient> = {};
  toolSchemas: McpToolSchema[] = [];
  private toolRoutes: Record<string, [string, string]> = {};
  /** 未解析的沙箱配置（startAll 里解析一次）；为 null 时不进沙箱。 */
  sandbox: McpSandboxOptions | null;
  workdir: string;

  constructor(
    servers: Record<string, MCPServerConfig>,
    timeout = 30.0,
    opts: { sandbox?: McpSandboxOptions | null; workdir?: string } = {},
  ) {
    this.servers = { ...servers };
    this.timeout = timeout;
    this.sandbox = opts.sandbox ?? null;
    this.workdir = opts.workdir ?? process.cwd();
  }

  async startAll(): Promise<void> {
    // 沙箱配置只解析一次：显式后端不可用时整批拒绝启动（不逐个服务器重复
    // 报错，也不让任何服务器裸奔）；解析失败直接抛 MCPError。
    let resolved: ResolvedMcpSandbox | null = null;
    if (this.sandbox) {
      try {
        const r = resolveSandboxBackend({
          sandbox: this.sandbox.backend ?? null,
          sandbox_mode: this.sandbox.mode,
          sandbox_allow_net: this.sandbox.allowNet,
        });
        resolved = { backend: r.backend, mode: r.mode, allowNet: r.allowNet, workdir: this.workdir };
      } catch (err) {
        throw new MCPError(`MCP 沙箱配置无法解析，拒绝启动全部服务器：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const [serverName, config] of Object.entries(this.servers)) {
      if (this.clients[serverName]) continue;
      const client = new MCPClient(config, this.timeout, resolved);
      try {
        client.start();
        const tools = await client.listTools();
        const schemas: McpToolSchema[] = [];
        const routes: Record<string, [string, string]> = {};
        for (const tool of tools) {
          const toolName = `mcp_${sanitizeMcpName(serverName)}_${sanitizeMcpName(tool.name)}`;
          if (this.toolRoutes[toolName] || routes[toolName]) throw new MCPError(`工具名称规范化后发生冲突：${toolName}`);
          const parameters = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} };
          schemas.push({
            type: "function",
            function: { name: toolName, description: `[${serverName}] ${tool.description}`, parameters },
          });
          routes[toolName] = [serverName, tool.name];
        }
        this.clients[serverName] = client;
        this.toolSchemas.push(...schemas);
        Object.assign(this.toolRoutes, routes);
      } catch (err) {
        try { client.stop(); } catch (stopErr) { process.stderr.write(`MCP 服务器 ${serverName} 清理失败：${stopErr instanceof Error ? stopErr.message : String(stopErr)}\n`); }
        process.stderr.write(`MCP 服务器 ${serverName} 启动失败：${err instanceof Error ? err.message : String(err)}\n`);
        continue;
      }
    }
  }

  /** 把规范化工具名还原成 [服务器, 原始工具名]；找不到返回 null。 */
  routeFor(toolName: string): [string, string] | null {
    const route = this.toolRoutes[toolName];
    if (!route) return null;
    return route;
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    const route = this.toolRoutes[toolName];
    if (!route) return `错误：未知 MCP 工具 ${toolName}`;
    const [serverName, rawName] = route;
    const client = this.clients[serverName];
    if (!client) return `错误：未知 MCP 工具 ${toolName}`;
    try { return await client.callTool(rawName, args); }
    catch (err) { return `MCP 调用失败：${err instanceof Error ? err.message : String(err)}`; }
  }

  hasTools(): boolean { return this.toolSchemas.length > 0; }

  stopAll(): void {
    const errors: string[] = [];
    for (const [name, client] of Object.entries(this.clients)) {
      try { client.stop(); } catch (err) { errors.push(`${name}：${err instanceof Error ? err.message : String(err)}`); }
    }
    this.clients = {};
    this.toolSchemas = [];
    this.toolRoutes = {};
    if (errors.length) throw new MCPError("停止 MCP 服务器失败：" + errors.join("；"));
  }
}

/**
 * 按执行权限决定是否启动 MCP 服务（Python agent.build_mcp_manager 同语义）：
 * readonly 或非交互 auto 一律不启动；交互 auto 逐服务器确认；full 直接启动。
 * 未启用（mcp_enabled 非真）或无服务器时返回 null。
 */
export async function buildMcpManager(
  opts: {
    mode?: string; interactive?: boolean; config?: Record<string, unknown>;
    askApproval?: (prompt: string) => Promise<boolean>;
    /** 沙箱配置（与 Agent/CLI 同款形状）；未传时服务器原样启动。 */
    sandbox?: McpSandboxOptions | null;
    /** 服务器进程的工作目录（bwrap/Seatbelt 绑定的工作区）；默认 process.cwd()。 */
    workdir?: string;
  },
): Promise<MCPToolManager | null> {
  const mode = opts.mode ?? "auto";
  const interactive = opts.interactive ?? false;
  if (mode !== "auto" && mode !== "full") return null;
  if (mode === "auto" && !interactive) return null;
  const config = opts.config ?? {};
  if (!config.mcp_enabled) return null;
  const servers = loadMcpServers(config);
  if (!Object.keys(servers).length) return null;
  let approved = servers;
  if (mode === "auto") {
    approved = {};
    for (const [name, server] of Object.entries(servers)) {
      process.stdout.write(`外部 MCP 服务 ${name} 将以当前系统用户启动，可能访问本机文件和网络。\n`);
      const ok = opts.askApproval ? await opts.askApproval(`允许启动该 MCP 服务吗？`) : false;
      if (ok) approved[name] = server;
    }
    if (!Object.keys(approved).length) return null;
  }
  const manager = new MCPToolManager(approved, 30.0, { sandbox: opts.sandbox ?? null, workdir: opts.workdir });
  await manager.startAll();
  if (!manager.hasTools()) { manager.stopAll(); return null; }
  return manager;
}
