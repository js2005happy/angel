// src/cdpBrowser.ts — Chrome DevTools Protocol 客户端原生 Node 移植，
// 对应 nyra/cdp_browser.py + nyra/websocket.py。
//
// 只连本机 Chrome（DevTools 的 /json/list 与 WebSocket 都只走 loopback），
// 从不自动启动 Chrome——Chrome 没开就明确报错，让用户自己用
// `chrome --remote-debugging-port=9222` 启动。
// 只用 Node/Bun 内置：HTTP 探测走全局 fetch，WebSocket 走全局
// WebSocket（Bun / Node 24 内置），不用任何 npm 依赖。
// Python 版是 socket 手写 RFC 6455 客户端；Node 版用全局 WebSocket
// 替代，帧处理/掩码/ping-pong 由运行时负责。
//
// 错误约定（接线时注意）：所有失败都以 CDPError（中文 message）抛出，
// 绝不把 fetch / WebSocket 的原始错误直接漏出去；tools.ts 接线处
// 用 cdpErrorMessage(err) 转成 `错误：<中文>` 字符串返回。
// 审批不在这里做（tools.ts 的 checkApproval 已做）。

export const DEFAULT_PORT = 9222;
export const CONNECT_TIMEOUT_MS = 10_000;
export const CALL_TIMEOUT_MS = 30_000;
export const LOAD_WAIT_TIMEOUT_MS = 10_000;

const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export class CDPError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CDPError";
  }
}

/** 把任意失败转成一句中文（接线处：`错误：${cdpErrorMessage(err)}`）。 */
export function cdpErrorMessage(err: unknown): string {
  if (err instanceof CDPError) return err.message;
  if (err instanceof Error) return err.message || "浏览器操作失败";
  return String(err);
}

// ---- 传输层抽象：测试注入假 transport；生产用全局 WebSocket ----

export interface CDPTransport {
  sendText(text: string): void | Promise<void>;
  recvText(timeoutMs?: number): Promise<string>;
  close(): void | Promise<void>;
}

export type WebSocketFactory = (url: string) => WebSocket;

export interface CDPOptions {
  /** 单次调用超时（毫秒），默认 30_000。 */
  timeoutMs?: number;
  /** 连接超时（毫秒），默认 10_000。 */
  connectTimeoutMs?: number;
  /** 注入的 transport（测试用）；给了它就不再建 WebSocket。 */
  transport?: CDPTransport;
  /** 注入的 WebSocket 构造器（测试用）；默认用全局 WebSocket。 */
  createWebSocket?: WebSocketFactory;
  /** 注入的 fetch（测试用）；默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/**
 * 全局 WebSocket 的 CDPTransport 适配：事件式 WebSocket 转成
 * Python WebSocketClient 那样的 send_text / recv_text 阻塞式接口。
 * 收到 ping 时运行时自动回 pong；这里只收文本消息进队列。
 */
export class GlobalWebSocketTransport implements CDPTransport {
  private readonly ws: WebSocket;
  private readonly queue: string[] = [];
  private readonly waiters: Array<{
    resolve: (value: string) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event: MessageEvent) => {
      void this.onMessage(event.data);
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      this.flushWaiters(new Error("连接已关闭"));
    });
    ws.addEventListener("error", () => {
      // close 事件随后会到；这里不单独 reject，等 close 处理。
    });
  }

  /** 等 WebSocket open；超时或失败时 reject（调用方包成 CDPError）。 */
  static connect(
    url: string,
    timeoutMs: number,
    createWebSocket: WebSocketFactory,
  ): Promise<GlobalWebSocketTransport> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = createWebSocket(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // 忽略。
        }
        reject(new Error("连接 Chrome 超时"));
      }, timeoutMs);
      const cleanup = () => clearTimeout(timer);
      ws.addEventListener("open", () => {
        cleanup();
        resolve(new GlobalWebSocketTransport(ws));
      }, { once: true });
      ws.addEventListener("error", () => {
        cleanup();
        reject(new Error("连接 Chrome 失败"));
      }, { once: true });
    });
  }

  private async onMessage(data: unknown): Promise<void> {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder("utf-8").decode(data);
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      text = await data.text();
    } else if (data instanceof Uint8Array) {
      text = new TextDecoder("utf-8").decode(data);
    } else {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(text);
    } else {
      this.queue.push(text);
    }
  }

  private flushWaiters(err: Error): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  sendText(text: string): void {
    if (this.closed || this.ws.readyState === WebSocket.CLOSED) {
      throw new Error("连接已关闭");
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket 未连接");
    }
    this.ws.send(text);
  }

  recvText(timeoutMs?: number): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new Error("连接已关闭"));
    return new Promise((resolve, reject) => {
      const ms = timeoutMs ?? CALL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error("等待消息超时"));
      }, ms);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flushWaiters(new Error("连接已关闭"));
    try {
      this.ws.close();
    } catch {
      // 忽略。
    }
  }
}

function isLoopbackWsUrl(wsUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(wsUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return false;
  return LOOPBACK_HOSTS.has((parsed.hostname || "").toLowerCase());
}

function isStrictBase64(text: string): boolean {
  return (
    text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text)
  );
}

export class CDPBrowser {
  readonly wsUrl: string | null;
  private ws: CDPTransport | null;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly createWebSocket: WebSocketFactory;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;
  private closed = false;

  constructor(
    wsUrl: string | null = null,
    options: CDPOptions = {},
  ) {
    this.wsUrl = wsUrl;
    this.ws = options.transport ?? null;
    this.timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.createWebSocket =
      options.createWebSocket ??
      ((url: string) => new WebSocket(url));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // ---- 连接 ----

  static async connect(
    wsUrl: string,
    options: CDPOptions = {},
  ): Promise<CDPBrowser> {
    if (!isLoopbackWsUrl(wsUrl)) {
      throw new CDPError("只允许连接本机 Chrome（ws://127.0.0.1/...）");
    }
    const timeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    if (options.transport) {
      return new CDPBrowser(wsUrl, options);
    }
    const createWs =
      options.createWebSocket ?? ((url: string) => new WebSocket(url));
    let transport: GlobalWebSocketTransport;
    try {
      transport = await GlobalWebSocketTransport.connect(
        wsUrl,
        timeoutMs,
        createWs,
      );
    } catch (err) {
      throw new CDPError(
        `连接 Chrome 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return new CDPBrowser(wsUrl, { ...options, transport });
  }

  static async connectToChrome(
    port: number = DEFAULT_PORT,
    options: CDPOptions = {},
  ): Promise<CDPBrowser> {
    const timeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const fetchImpl = options.fetchImpl ?? fetch;
    let targets: unknown;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(
          `http://127.0.0.1:${port}/json/list`,
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
      }
      targets = await response.json();
    } catch (err) {
      // fetch 失败（含超时 abort）一律按“没检测到 Chrome”报，与 Python
      // 的 URLError 分支同口径。注：Node/Bun 的全局 fetch 默认不走
      // HTTP(S)_PROXY，所以 loopback 不会被代理转走（Python 须显式
      // bypass，见 nyra/net.py；这里不需要）。
      void err;
      throw new CDPError(
        `未检测到本机 Chrome（http://127.0.0.1:${port}/json 无法访问）。`
        + `请先用 chrome --remote-debugging-port=${port} 启动 Chrome。`,
      );
    }
    if (!Array.isArray(targets)) {
      throw new CDPError("Chrome 目标列表格式异常");
    }
    for (const target of targets) {
      if (typeof target !== "object" || target === null) continue;
      const t = target as Record<string, unknown>;
      const wsUrl = t["webSocketDebuggerUrl"];
      if (t["type"] === "page" && typeof wsUrl === "string" && wsUrl) {
        return CDPBrowser.connect(wsUrl, options);
      }
    }
    throw new CDPError("Chrome 正在运行，但没有可用的页面目标（请先打开一个标签页）");
  }

  // ---- 低层调用 ----

  async call(
    method: string,
    params: Record<string, unknown> | null = null,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    if (this.ws === null || this.closed) {
      throw new CDPError("浏览器连接已关闭");
    }
    const msgId = this.nextId;
    this.nextId += 1;
    const payload = { id: msgId, method, params: params ?? {} };
    try {
      await this.ws.sendText(JSON.stringify(payload));
    } catch (err) {
      throw new CDPError(
        `发送 CDP 命令失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const deadline = Date.now() + (timeoutMs ?? this.timeoutMs);
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new CDPError(`Chrome 未响应（${method} 超时）`);
      }
      let raw: string;
      try {
        raw = await this.ws.recvText(remaining);
      } catch (err) {
        throw new CDPError(
          `等待 Chrome 响应失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        continue; // 不是 JSON，跳过。
      }
      if (
        typeof message !== "object" ||
        message === null ||
        (message as Record<string, unknown>)["id"] !== msgId
      ) {
        continue; // 事件或别的调用的响应，跳过。
      }
      const msg = message as Record<string, unknown>;
      if ("error" in msg) {
        const error = msg["error"];
        const detail =
          typeof error === "object" && error !== null
            ? ((error as Record<string, unknown>)["message"] ?? error)
            : error;
        throw new CDPError(`CDP 错误 ${method}：${String(detail)}`);
      }
      const result = msg["result"];
      return typeof result === "object" && result !== null
        ? (result as Record<string, unknown>)
        : {};
    }
  }

  private async waitForEvent(
    method: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let raw: string;
      try {
        raw = await this.ws!.recvText(remaining);
      } catch {
        return false;
      }
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>)["method"] === method
      ) {
        return true;
      }
    }
  }

  // ---- 页面动作 ----

  async navigate(url: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CDPError(`只支持打开 http/https 网址：${url}`);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname
    ) {
      throw new CDPError(`只支持打开 http/https 网址：${url}`);
    }
    await this.call("Page.enable");
    const result = await this.call("Page.navigate", { url });
    await this.waitForEvent("Page.loadEventFired", LOAD_WAIT_TIMEOUT_MS);
    const frameId = result["frameId"];
    return typeof frameId === "string" ? frameId : "";
  }

  async evaluate(
    expression: string,
    timeoutMs?: number,
  ): Promise<unknown> {
    const result = await this.call(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if ("exceptionDetails" in result) {
      const details = result["exceptionDetails"] as Record<string, unknown>;
      const exception = (details["exception"] as Record<string, unknown>) ?? {};
      const text =
        (exception["description"] as string | undefined) ??
        (details["text"] as string | undefined) ??
        "JS 执行失败";
      throw new CDPError(`页面 JS 报错：${text}`);
    }
    const value = result["result"] as Record<string, unknown> | undefined;
    if (typeof value === "object" && value !== null) {
      if (value["subtype"] === "error") {
        throw new CDPError(
          `页面 JS 报错：${String(value["description"] ?? "JS 错误")}`,
        );
      }
      return value["value"] ?? null;
    }
    return null;
  }

  async click(selector: string): Promise<string> {
    const expression =
      "(function(){var el=document.querySelector(" +
      JSON.stringify(selector) +
      "); if(!el) return 'NOT_FOUND'; el.click(); return 'OK';})()";
    const outcome = await this.evaluate(expression);
    if (outcome === "NOT_FOUND") {
      throw new CDPError(`未找到元素：${selector}`);
    }
    return `已点击：${selector}`;
  }

  async screenshot(): Promise<Buffer> {
    const result = await this.call("Page.captureScreenshot", {
      format: "png",
    });
    const data = result["data"];
    if (typeof data !== "string" || !data) {
      throw new CDPError("截图失败：Chrome 未返回图片数据");
    }
    if (!isStrictBase64(data)) {
      throw new CDPError("截图数据无法解码：非法的 base64 数据");
    }
    const raw = Buffer.from(data, "base64");
    if (!raw.subarray(0, 8).equals(PNG_MAGIC)) {
      throw new CDPError("截图失败：Chrome 返回的不是 PNG 数据");
    }
    return raw;
  }

  async title(): Promise<string> {
    return String((await this.evaluate("document.title")) ?? "");
  }

  async currentUrl(): Promise<string> {
    return String((await this.evaluate("window.location.href")) ?? "");
  }

  async visibleText(limit = 8000): Promise<string> {
    const text = await this.evaluate(
      "document.body ? document.body.innerText.slice(0, " +
        String(Math.trunc(limit)) +
        ") : ''",
    );
    return String(text ?? "");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      try {
        const r = ws.close();
        if (r instanceof Promise) r.catch(() => {});
      } catch {
        // 忽略。
      }
    }
  }
}
