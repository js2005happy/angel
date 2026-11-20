// src/lsp.ts — LSP 客户端（缺口 24 第一批）。
//
// 只做两件事：**diagnostics**（诊断/报错）与**符号查询**（定义/引用/文档符号）。
// 不接重命名——重命名仍是确定性写操作，走 apply_patch（保持"改文件必审批 +
// 检查点"的既有纪律，LSP 的 workspace/applyEdit 会绕过这条链）。
//
// 设计纪律（与 repoMap 同一套"不引重依赖、宁可少报不可错报"）：
//   - **不引 LSP SDK / vscode-languageserver**：直接实现 LSP 的 stdio JSON-RPC
//     与 Content-Length 分帧（node:child_process + node:fs 即可）。
//   - **默认不启用**：LSP 服务器是外部进程（tsserver / gopls / pylsp / rust-analyzer），
//     须用户显式在 config 里配 `lsp.servers`；没配就不 spawn、零开销。
//   - **查询只读**：definition / references / documentSymbol / publishDiagnostics
//     全是只读请求，不触发任何文件改动；诊断只被动接收、格式化后交回模型。
//   - **fail-soft**：服务器没装、启动失败、超时，都返回明确的错误文本（而不是
//     抛异常拖垮整个 agent 运行）；符号查不到就是查不到，如实说，不编造。
//   - **省 token**：返回结果截断（默认最多 2000 字符），诊断按严重度排序、
//     只给文件:行:列 + 消息，不带 code action 等重内容。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, join, resolve } from "node:path";

export class LspError extends Error {
  constructor(message: string) { super(message); this.name = "LspError"; }
}

/** 一个语言服务器的配置（config.lsp.servers 里的条目）。 */
export interface LspServerConfig {
  /** 语言服务器可执行文件或命令，如 "typescript-language-server"、"gopls"。 */
  command: string;
  /** 启动参数，如 ["--stdio"]。 */
  args: string[];
  /** 该服务器负责的文件扩展名，如 [".ts", ".tsx"]。 */
  extensions: string[];
}

/** 诊断项（publishDiagnostics 推送，或按需 textDocument/codeAction 拿）。 */
export interface LspDiagnostic {
  file: string;
  line: number;   // 0 基
  column: number; // 0 基
  severity: number; // 1=Error 2=Warning 3=Info 4=Hint
  message: string;
  source?: string;
}

/** 符号（documentSymbol 返回的扁平化项）。 */
export interface LspSymbol {
  name: string;
  kind: number;
  /** 位置行（0 基）。 */
  line: number;
  column: number;
  /** 容器（所属类/函数），无则 null。 */
  container?: string;
}

/** 定义/引用命中的位置。 */
export interface LspLocation {
  uri: string;
  line: number;
  column: number;
}

/** 查询结果的统一输出（已格式化、已截断，可直接交回模型）。 */
export interface LspQueryResult {
  /** 是否成功（服务器没配/失败时为 false，附 reason）。 */
  ok: boolean;
  /** 给模型看的文本。 */
  text: string;
  /** 结构化数据（供测试断言）。 */
  data: LspDiagnostic[] | LspSymbol[] | LspLocation[] | null;
}

/** 结果文本的字符上限（省 token）。 */
export const LSP_MAX_RESULT_CHARS = 2000;
/** 单次请求超时（秒）。 */
export const LSP_REQUEST_TIMEOUT = 15;
/** 服务器启动超时（秒）。 */
export const LSP_STARTUP_TIMEOUT = 20;

const URI_SCHEME = "file://";

/** 绝对路径 → file:// URI。 */
export function toLspUri(absPath: string): string {
  const p = absPath.replace(/\\/g, "/");
  return p.startsWith("/") ? URI_SCHEME + p : URI_SCHEME + "/" + p;
}

/** 路径归一化（正斜杠），保证诊断 map 的 key 与查询入参一致（跨平台）。 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** file:// URI → 绝对路径（Windows 盘符处理）。 */
export function fromLspUri(uri: string): string {
  if (!uri.startsWith(URI_SCHEME)) return uri;
  let rest = uri.slice(URI_SCHEME.length);
  // Windows: file:///C:/... → C:/...
  if (/^\/[A-Za-z]:\//.test(rest)) rest = rest.slice(1);
  return rest.replace(/\//g, "/");
}

/** 诊断严重度 → 中文标签。 */
export function severityLabel(severity: number): string {
  switch (severity) {
    case 1: return "错误";
    case 2: return "警告";
    case 3: return "信息";
    case 4: return "提示";
    default: return "未知";
  }
}

/** 符号 kind（LSP SymbolKind）→ 中文标签。 */
export function symbolKindLabel(kind: number): string {
  const map: Record<number, string> = {
    1: "文件", 2: "模块", 3: "命名空间", 4: "包", 5: "类", 6: "方法",
    7: "属性", 8: "字段", 9: "构造", 10: "枚举", 11: "接口", 12: "函数",
    13: "变量", 14: "常量", 15: "字符串", 16: "数字", 17: "布尔", 18: "数组",
    23: "结构", 24: "事件", 25: "操作符", 26: "类型参数",
  };
  return map[kind] ?? `kind${kind}`;
}

/** 从 config 解析 LSP 服务器列表（纯函数，便于单测）。 */
export function resolveLspServers(config: Record<string, unknown> | null | undefined): LspServerConfig[] {
  const cfg = (config ?? {}) as Record<string, unknown>;
  const lsp = cfg.lsp;
  if (!lsp || typeof lsp !== "object" || Array.isArray(lsp)) return [];
  const servers = (lsp as Record<string, unknown>).servers;
  if (!Array.isArray(servers)) return [];
  const out: LspServerConfig[] = [];
  for (const raw of servers) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const command = typeof r.command === "string" ? r.command.trim() : "";
    if (!command) continue;
    const args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === "string") : [];
    const extensions = Array.isArray(r.extensions)
      ? r.extensions.filter((e): e is string => typeof e === "string" && e.startsWith("."))
      : [];
    out.push({ command, args, extensions });
  }
  return out;
}

/**
 * LSP 客户端：一个语言服务器进程（stdio + Content-Length 分帧）。
 * 握手（initialize/initialized）后即可查询定义/引用/符号，被动接收诊断。
 */
export class LspClient {
  readonly config: LspServerConfig;
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = "";
  private stdoutDecoder = new StringDecoder("utf-8");
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  /** 最近一次 publishDiagnostics 推送（按文件路径）。 */
  diagnostics = new Map<string, LspDiagnostic[]>();
  /** 已打开的文档（didOpen 过）。 */
  private openDocs = new Set<string>();

  constructor(config: LspServerConfig) {
    this.config = config;
  }

  /** 该服务器是否负责某扩展名。 */
  handles(ext: string): boolean {
    return this.config.extensions.length === 0 || this.config.extensions.includes(ext.toLowerCase());
  }

  private subprocessEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      // 代理变量可能带凭据：剥掉凭据段，与 MCP 同规则。
      const upper = k.toUpperCase();
      if (["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].includes(k)) {
        env[k] = v.replace(/\/\/[^@/]+@/, "//");
        continue;
      }
      env[k] = v;
    }
    return env;
  }

  private start(): void {
    if (this.process) return;
    const child = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"], env: this.subprocessEnv(),
    });
    this.process = child;
    this.stdoutDecoder = new StringDecoder("utf-8");
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", () => { /* 服务器日志不进协议流，丢弃 */ });
    child.stdin.on("error", (err: Error) => this.failPending(new LspError(`LSP 服务器 ${this.config.command} 写入失败：${err.message}`)));
    child.on("error", (err: Error) => this.failPending(new LspError(`LSP 服务器 ${this.config.command} 启动失败：${err.message}`)));
    child.on("exit", () => this.failPending(new LspError(`LSP 服务器 ${this.config.command} 已退出`)));
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  // Content-Length 分帧解析：读满 Header（\r\n\r\n），按 Content-Length 读 body。
  private onStdout(chunk: Buffer): void {
    this.buffer += this.stdoutDecoder.write(chunk);
    let idx: number;
    while ((idx = this.buffer.indexOf("\r\n\r\n")) >= 0) {
      const header = this.buffer.slice(0, idx);
      const lenMatch = /content-length:\s*(\d+)/i.exec(header);
      if (!lenMatch) {
        // 无 Content-Length 的帧不合法，丢弃头部重试。
        this.buffer = this.buffer.slice(idx + 4);
        continue;
      }
      const len = parseInt(lenMatch[1], 10);
      const bodyStart = idx + 4;
      if (this.buffer.length < bodyStart + len) break; // 还没收满
      const body = this.buffer.slice(bodyStart, bodyStart + len);
      this.buffer = this.buffer.slice(bodyStart + len);
      try {
        this.dispatch(JSON.parse(body) as Record<string, unknown>);
      } catch { /* 解析失败的帧丢弃 */ }
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const method = typeof msg.method === "string" ? msg.method : null;
    if (method) {
      // 服务器主动推送（notification 或 request）。
      if (method === "textDocument/publishDiagnostics") {
        this.onPublishDiagnostics((msg.params ?? {}) as Record<string, unknown>);
      }
      // 服务器主动请求（如 workspace/applyEdit）：一律不支持。
      if (msg.id !== undefined && this.process?.stdin.writable) {
        this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Nyra 不支持服务器主动请求" } });
      }
      return;
    }
    if (msg.id === undefined) return;
    const id = msg.id as number;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.error !== undefined && msg.error !== null) {
      const e = msg.error as Record<string, unknown>;
      p.reject(new LspError(typeof e.message === "string" ? e.message : "LSP 服务器返回错误"));
      return;
    }
    p.resolve((msg.result ?? {}) as Record<string, unknown>);
  }

  private onPublishDiagnostics(params: Record<string, unknown>): void {
    const uri = typeof params.uri === "string" ? params.uri : "";
    const file = normalizePath(fromLspUri(uri));
    const diags = Array.isArray(params.diagnostics) ? params.diagnostics as Record<string, unknown>[] : [];
    const out: LspDiagnostic[] = [];
    for (const d of diags) {
      const range = (d.range ?? {}) as Record<string, unknown>;
      const start = (range.start ?? {}) as Record<string, unknown>;
      out.push({
        file,
        line: typeof start.line === "number" ? start.line : 0,
        column: typeof start.character === "number" ? start.character : 0,
        severity: typeof d.severity === "number" ? d.severity : 0,
        message: typeof d.message === "string" ? d.message : "",
        source: typeof d.source === "string" ? d.source : undefined,
      });
    }
    this.diagnostics.set(file, out);
  }

  private write(msg: Record<string, unknown>): void {
    if (!this.process || this.process.exitCode !== null || !this.process.stdin.writable) {
      throw new LspError(`LSP 服务器 ${this.config.command} 未就绪`);
    }
    const body = JSON.stringify(msg);
    const frame = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
    this.process.stdin.write(frame, (err) => {
      if (err && this.process?.stdin && !this.process.stdin.writable) {
        this.failPending(new LspError(`LSP 服务器 ${this.config.command} 写入失败：${err.message}`));
      }
    });
  }

  private request(method: string, params: Record<string, unknown>, timeout = LSP_REQUEST_TIMEOUT): Promise<Record<string, unknown>> {
    if (!this.process) this.start();
    if (!this.process) return Promise.reject(new LspError(`LSP 服务器 ${this.config.command} 未启动`));
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspError(`LSP 请求 ${method} 超时`));
      }, timeout * 1000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** initialize 握手（懒执行一次）。 */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.start();
      await this.request("initialize", {
        processId: process.pid,
        rootUri: null,
        capabilities: {
          textDocument: {
            documentSymbol: { hierarchicalDocumentSymbolSupport: false },
            publishDiagnostics: { relatedInformation: false },
            definition: { linkSupport: false },
            references: {},
          },
        },
      }, LSP_STARTUP_TIMEOUT);
      this.write({ jsonrpc: "2.0", method: "initialized", params: {} });
      this.initialized = true;
    })().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  /** 打开文档（触发服务器分析并推送诊断）。 */
  async openDocument(absPath: string): Promise<void> {
    await this.ensureInitialized();
    const abs = normalizePath(absPath);
    const uri = toLspUri(abs);
    if (this.openDocs.has(uri)) return;
    const fs = require("node:fs") as typeof import("node:fs");
    let text = "";
    try { text = fs.readFileSync(absPath, "utf-8"); } catch { return; }
    this.write({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: languageIdFor(abs), version: 1, text } } });
    this.openDocs.add(uri);
  }

  /** 取某文件的诊断（路径归一化后查询）。 */
  getDiagnostics(absPath: string): LspDiagnostic[] {
    return this.diagnostics.get(normalizePath(absPath)) ?? [];
  }

  /** 查询某符号的定义。 */
  async definition(absPath: string, line: number, column: number): Promise<LspLocation[]> {
    await this.ensureInitialized();
    await this.openDocument(absPath);
    const result = await this.request("textDocument/definition", {
      textDocument: { uri: toLspUri(absPath) },
      position: { line, character: column },
    });
    return parseLocations(result);
  }

  /** 查询某符号的引用。 */
  async references(absPath: string, line: number, column: number): Promise<LspLocation[]> {
    await this.ensureInitialized();
    await this.openDocument(absPath);
    const result = await this.request("textDocument/references", {
      textDocument: { uri: toLspUri(absPath) },
      position: { line, character: column },
      context: { includeDeclaration: true },
    });
    return parseLocations(result);
  }

  /** 查询文档符号（扁平化）。 */
  async documentSymbols(absPath: string): Promise<LspSymbol[]> {
    await this.ensureInitialized();
    await this.openDocument(absPath);
    const result = await this.request("textDocument/documentSymbol", {
      textDocument: { uri: toLspUri(absPath) },
    });
    return flattenSymbols(result, absPath);
  }

  /** 关闭并销毁（释放子进程）。 */
  close(): void {
    if (this.process) {
      try { this.process.stdin.end(); } catch { /* ignore */ }
      try { this.process.kill(); } catch { /* ignore */ }
      this.process = null;
      this.initialized = false;
      this.initPromise = null;
      this.openDocs.clear();
      this.diagnostics.clear();
      this.pending.clear();
    }
  }
}

/** 语言 ID（LSP 需要，用于服务器选择正确的解析器）。 */
export function languageIdFor(absPath: string): string {
  const dot = absPath.lastIndexOf(".");
  const ext = dot >= 0 ? absPath.slice(dot).toLowerCase() : "";
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact",
    ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".go": "go", ".rs": "rust",
    ".java": "java", ".kt": "kotlin", ".cs": "csharp", ".c": "c", ".h": "c", ".cc": "cpp",
    ".cpp": "cpp", ".hpp": "cpp", ".rb": "ruby", ".php": "php",
  };
  return map[ext] ?? "plaintext";
}

function parseLocations(result: Record<string, unknown>): LspLocation[] {
  if (result == null) return [];
  const items = Array.isArray(result) ? result : [result];
  const out: LspLocation[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    const uri = typeof r.uri === "string" ? r.uri : null;
    const range = (r.range ?? {}) as Record<string, unknown>;
    const start = (range.start ?? {}) as Record<string, unknown>;
    if (!uri) continue;
    out.push({
      uri: fromLspUri(uri),
      line: typeof start.line === "number" ? start.line : 0,
      column: typeof start.character === "number" ? start.character : 0,
    });
  }
  return out;
}

function flattenSymbols(result: Record<string, unknown>, absPath: string): LspSymbol[] {
  const out: LspSymbol[] = [];
  const walk = (items: unknown, container?: string) => {
    if (!Array.isArray(items)) return;
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const r = it as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name : "";
      const kind = typeof r.kind === "number" ? r.kind : 0;
      const range = (r.range ?? r.selectionRange ?? {}) as Record<string, unknown>;
      const start = (range.start ?? {}) as Record<string, unknown>;
      if (name) {
        out.push({
          name, kind,
          line: typeof start.line === "number" ? start.line : 0,
          column: typeof start.character === "number" ? start.character : 0,
          container,
        });
      }
      if (Array.isArray(r.children)) walk(r.children, name || container);
    }
  };
  walk(result, undefined);
  return out;
}

/** 格式化诊断列表（省 token：只给 文件:行:列 严重度 消息，截断）。 */
export function formatDiagnostics(diags: LspDiagnostic[], maxChars = LSP_MAX_RESULT_CHARS): string {
  if (!diags.length) return "没有诊断信息（语言服务器未报告任何错误/警告）。";
  // 按严重度排序（错误在前）。
  const sorted = [...diags].sort((a, b) => a.severity - b.severity || a.line - b.line || a.column - b.column);
  const lines = sorted.map((d) => `${d.file}:${d.line + 1}:${d.column + 1} [${severityLabel(d.severity)}]${d.source ? ` (${d.source})` : ""} ${d.message}`);
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + `\n……（共 ${lines.length} 条，已截断）`;
  return out;
}

/** 格式化符号列表（省 token：只给 名称[种类] 位置）。 */
export function formatSymbols(symbols: LspSymbol[], maxChars = LSP_MAX_RESULT_CHARS): string {
  if (!symbols.length) return "该文件没有可识别的符号。";
  const lines = symbols.map((s) => `${s.name} [${symbolKindLabel(s.kind)}] @${s.line + 1}:${s.column + 1}${s.container ? ` (属于 ${s.container})` : ""}`);
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + `\n……（共 ${lines.length} 个符号，已截断）`;
  return out;
}

/** 格式化位置列表（定义/引用命中）。 */
export function formatLocations(locs: LspLocation[], maxChars = LSP_MAX_RESULT_CHARS): string {
  if (!locs.length) return "未找到定义/引用。";
  const lines = locs.map((l) => `${l.uri}:${l.line + 1}:${l.column + 1}`);
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + `\n……（共 ${lines.length} 处，已截断）`;
  return out;
}
