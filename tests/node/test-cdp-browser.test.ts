// tests/node/test-cdp-browser.test.ts — 对应 tests/test_cdp_browser.py 的 Node 移植。
// 全部 mock：假 CDPTransport / 假 fetch / 假 WebSocket，不连真实 Chrome，
// 不联网。只覆盖协议层（消息形态、错误口径、超时）；不覆盖真实页面。
import { test, expect } from "bun:test";
import {
  CDPBrowser,
  CDPError,
  GlobalWebSocketTransport,
  cdpErrorMessage,
  DEFAULT_PORT,
  type CDPTransport,
} from "../../src/cdpBrowser.ts";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([PNG_MAGIC, Buffer.from("fake-png-body")]);
const WS_URL = "ws://127.0.0.1:9222/devtools/page/ABC";

function reply(id: number, result: Record<string, unknown>): string {
  return JSON.stringify({ id, result });
}

function event(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ method, params });
}

/** 假 transport：按脚本队列回消息，记录发出的 JSON。 */
class FakeTransport implements CDPTransport {
  sent: string[] = [];
  closed = false;
  private readonly replies: string[];
  private readonly recvBehavior: "queue" | "hang" | "reject" | "events";

  constructor(
    replies: string[] = [],
    recvBehavior: "queue" | "hang" | "reject" | "events" = "queue",
  ) {
    this.replies = [...replies];
    this.recvBehavior = recvBehavior;
  }

  sendText(text: string): void {
    this.sent.push(text);
  }

  async recvText(_timeoutMs?: number): Promise<string> {
    if (this.recvBehavior === "hang") return new Promise(() => {});
    if (this.recvBehavior === "reject") {
      throw new Error("等待消息超时");
    }
    if (this.recvBehavior === "events") {
      return event("Network.dataReceived");
    }
    const next = this.replies.shift();
    if (next === undefined) throw new Error("no reply scripted");
    return next;
  }

  close(): void {
    this.closed = true;
  }
}

function sentJson(transport: FakeTransport, index: number) {
  return JSON.parse(transport.sent[index]) as Record<string, unknown>;
}

function browserWith(transport: FakeTransport): CDPBrowser {
  return new CDPBrowser(WS_URL, { transport, timeoutMs: 1000 });
}

// ---- 连接 ----

test("CDPBrowserTest.test_connect_rejects_non_loopback_host", async () => {
  await expect(
    CDPBrowser.connect("ws://example.com:9222/devtools/page/X"),
  ).rejects.toThrow("只允许连接本机 Chrome");
  await expect(
    CDPBrowser.connect("http://127.0.0.1:9222/devtools/page/X"),
  ).rejects.toThrow("只允许连接本机 Chrome");
  expect(cdpErrorMessage(new CDPError("失败"))).toBe("失败");
  expect(DEFAULT_PORT).toBe(9222);
});

test("CDPBrowserTest.test_connect_with_injected_transport", async () => {
  const transport = new FakeTransport();
  const browser = await CDPBrowser.connect(WS_URL, { transport });
  expect(browser.wsUrl).toBe(WS_URL);
  browser.close();
  expect(transport.closed).toBe(true);
});

test("CDPBrowserTest.test_connect_to_chrome_picks_page_target", async () => {
  const transport = new FakeTransport();
  const fetchImpl = (async () => {
    const targets = [
      { type: "background_page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/BG" },
      { type: "page", webSocketDebuggerUrl: WS_URL },
    ];
    return new Response(JSON.stringify(targets), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const browser = await CDPBrowser.connectToChrome(9222, {
    transport,
    fetchImpl,
  });
  expect(browser.wsUrl).toBe(WS_URL);
  browser.close();
});

test("CDPBrowserTest.test_connect_to_chrome_no_chrome_running", async () => {
  const fetchImpl = (async () => {
    throw new Error("fetch failed");
  }) as unknown as typeof fetch;
  await expect(
    CDPBrowser.connectToChrome(9222, { fetchImpl }),
  ).rejects.toThrow(
    "未检测到本机 Chrome（http://127.0.0.1:9222/json 无法访问）",
  );
});

test("CDPBrowserTest.test_connect_to_chrome_no_page_target", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify([{ type: "background_page" }]), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  await expect(
    CDPBrowser.connectToChrome(9222, { fetchImpl }),
  ).rejects.toThrow("没有可用的页面目标");
});

test("CDPBrowserTest.test_connect_to_chrome_bad_target_list", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ not: "a list" }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  await expect(
    CDPBrowser.connectToChrome(9222, { fetchImpl }),
  ).rejects.toThrow("Chrome 目标列表格式异常");
});

// ---- 低层调用 ----

test("CDPBrowserTest.test_call_message_shape_and_skips_events", async () => {
  const transport = new FakeTransport([
    event("Page.loadEventFired"),
    "not json at all",
    reply(1, { value: 42 }),
  ]);
  const browser = browserWith(transport);
  const result = await browser.call("Runtime.evaluate", {
    expression: "1+1",
    returnByValue: true,
  });
  expect(result).toEqual({ value: 42 });
  expect(sentJson(transport, 0)).toEqual({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression: "1+1", returnByValue: true },
  });
  browser.close();
});

test("CDPBrowserTest.test_call_increments_id", async () => {
  const transport = new FakeTransport([reply(1, {}), reply(2, {})]);
  const browser = browserWith(transport);
  await browser.call("Page.enable");
  await browser.call("Page.enable");
  expect(sentJson(transport, 0).id).toBe(1);
  expect(sentJson(transport, 1).id).toBe(2);
  browser.close();
});

test("CDPBrowserTest.test_call_surfaces_cdp_error", async () => {
  const transport = new FakeTransport([
    JSON.stringify({ id: 1, error: { code: -32000, message: "boom" } }),
  ]);
  const browser = browserWith(transport);
  await expect(browser.call("Runtime.evaluate")).rejects.toThrow(
    "CDP 错误 Runtime.evaluate：boom",
  );
  browser.close();
});

test("CDPBrowserTest.test_call_timeout_on_event_stream", async () => {
  // 一直只来事件、没有匹配 id 的响应：走到 deadline 后报超时，不挂住。
  const transport = new FakeTransport([], "events");
  const browser = browserWith(transport);
  await expect(
    browser.call("Runtime.evaluate", null, 50),
  ).rejects.toThrow("Chrome 未响应（Runtime.evaluate 超时）");
  browser.close();
});

test("CDPBrowserTest.test_call_recv_failure_wrapped", async () => {
  const transport = new FakeTransport([], "reject");
  const browser = browserWith(transport);
  await expect(browser.call("Page.enable", null, 500)).rejects.toThrow(
    "等待 Chrome 响应失败：等待消息超时",
  );
  browser.close();
});

test("CDPBrowserTest.test_call_after_close_raises", async () => {
  const transport = new FakeTransport();
  const browser = browserWith(transport);
  browser.close();
  browser.close(); // 幂等
  await expect(browser.call("Page.enable")).rejects.toThrow("浏览器连接已关闭");
});

// ---- 页面动作 ----

test("CDPBrowserTest.test_navigate_issues_methods_and_waits_for_load", async () => {
  const transport = new FakeTransport([
    reply(1, {}), // Page.enable
    reply(2, { frameId: "FRAME-1" }), // Page.navigate
    event("Page.loadEventFired"), // _waitForEvent
  ]);
  const browser = browserWith(transport);
  const frameId = await browser.navigate("https://example.com/x");
  expect(frameId).toBe("FRAME-1");
  expect(sentJson(transport, 0)).toEqual({
    id: 1,
    method: "Page.enable",
    params: {},
  });
  expect(sentJson(transport, 1)).toEqual({
    id: 2,
    method: "Page.navigate",
    params: { url: "https://example.com/x" },
  });
  browser.close();
});

test("CDPBrowserTest.test_navigate_rejects_non_http_url", async () => {
  const transport = new FakeTransport();
  const browser = browserWith(transport);
  await expect(browser.navigate("ftp://example.com/")).rejects.toThrow(
    "只支持打开 http/https 网址",
  );
  await expect(browser.navigate("https://")).rejects.toThrow(
    "只支持打开 http/https 网址",
  );
  expect(transport.sent.length).toBe(0);
  browser.close();
});

test("CDPBrowserTest.test_evaluate_returns_value", async () => {
  const transport = new FakeTransport([
    reply(1, { result: { type: "string", value: "hi" } }),
  ]);
  const browser = browserWith(transport);
  expect(await browser.evaluate("1+1")).toBe("hi");
  expect(sentJson(transport, 0).params).toEqual({
    expression: "1+1",
    returnByValue: true,
    awaitPromise: true,
  });
  browser.close();
});

test("CDPBrowserTest.test_evaluate_surfaces_js_exception", async () => {
  const transport = new FakeTransport([
    reply(1, {
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "TypeError: x is not a function" },
      },
    }),
  ]);
  const browser = browserWith(transport);
  await expect(browser.evaluate("bad()")).rejects.toThrow(
    "页面 JS 报错：TypeError: x is not a function",
  );
  browser.close();
});

test("CDPBrowserTest.test_evaluate_surfaces_subtype_error", async () => {
  const transport = new FakeTransport([
    reply(1, { result: { subtype: "error", description: "oops" } }),
  ]);
  const browser = browserWith(transport);
  await expect(browser.evaluate("bad()")).rejects.toThrow("页面 JS 报错：oops");
  browser.close();
});

test("CDPBrowserTest.test_click_found_and_not_found", async () => {
  const found = new FakeTransport([
    reply(1, { result: { type: "string", value: "OK" } }),
  ]);
  const browser = browserWith(found);
  expect(await browser.click("#btn")).toBe("已点击：#btn");
  const expr = String(sentJson(found, 0).params!["expression"] as string);
  expect(expr).toContain('document.querySelector("#btn")');
  browser.close();

  const missing = new FakeTransport([
    reply(1, { result: { type: "string", value: "NOT_FOUND" } }),
  ]);
  const browser2 = browserWith(missing);
  await expect(browser2.click(".nope")).rejects.toThrow("未找到元素：.nope");
  browser2.close();
});

test("CDPBrowserTest.test_screenshot_returns_png_bytes", async () => {
  const transport = new FakeTransport([
    reply(1, { data: PNG.toString("base64") }),
  ]);
  const browser = browserWith(transport);
  const shot = await browser.screenshot();
  expect(shot.equals(PNG)).toBe(true);
  expect(sentJson(transport, 0)).toEqual({
    id: 1,
    method: "Page.captureScreenshot",
    params: { format: "png" },
  });
  browser.close();
});

test("CDPBrowserTest.test_screenshot_rejects_non_png_bytes", async () => {
  const transport = new FakeTransport([
    reply(1, { data: Buffer.from("not png").toString("base64") }),
  ]);
  const browser = browserWith(transport);
  await expect(browser.screenshot()).rejects.toThrow(
    "截图失败：Chrome 返回的不是 PNG 数据",
  );
  browser.close();
});

test("CDPBrowserTest.test_screenshot_rejects_missing_and_bad_data", async () => {
  const missing = new FakeTransport([reply(1, {})]);
  const browser = browserWith(missing);
  await expect(browser.screenshot()).rejects.toThrow(
    "截图失败：Chrome 未返回图片数据",
  );
  browser.close();

  const bad = new FakeTransport([reply(1, { data: "!!!not-base64!!!" })]);
  const browser2 = browserWith(bad);
  await expect(browser2.screenshot()).rejects.toThrow("截图数据无法解码");
  browser2.close();
});

test("CDPBrowserTest.test_title_current_url_visible_text", async () => {
  const transport = new FakeTransport([
    reply(1, { result: { type: "string", value: "My Page" } }),
    reply(2, { result: { type: "string", value: "https://example.com/" } }),
    reply(3, { result: { type: "string", value: "hello world" } }),
  ]);
  const browser = browserWith(transport);
  expect(await browser.title()).toBe("My Page");
  expect(await browser.currentUrl()).toBe("https://example.com/");
  expect(await browser.visibleText(5)).toBe("hello world");
  const expr = String(sentJson(transport, 2).params!["expression"] as string);
  expect(expr).toContain("innerText.slice(0, 5)");
  browser.close();
});

// ---- 全局 WebSocket 适配器（假 WebSocket 对象，不联网） ----

type Listener = (event?: unknown) => void;

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, fn: Listener, opts?: { once?: boolean }): void {
    const wrapped: Listener = (event) => {
      if (opts?.once) {
        const arr = this.listeners.get(type) ?? [];
        this.listeners.set(type, arr.filter((l) => l !== wrapped));
      }
      fn(event);
    };
    const arr = this.listeners.get(type) ?? [];
    arr.push(wrapped);
    this.listeners.set(type, arr);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  emit(type: string, event?: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

test("CDPBrowserTest.test_global_ws_transport_roundtrip", async () => {
  let fake: FakeWebSocket | undefined;
  const factory = (url: string) => {
    expect(url).toBe(WS_URL);
    fake = new FakeWebSocket();
    queueMicrotask(() => {
      fake!.readyState = 1;
      fake!.emit("open");
    });
    return fake as unknown as WebSocket;
  };
  const transport = await GlobalWebSocketTransport.connect(
    WS_URL,
    1000,
    factory,
  );
  transport.sendText(JSON.stringify({ id: 1, method: "Page.enable" }));
  expect(fake!.sent).toEqual([
    JSON.stringify({ id: 1, method: "Page.enable" }),
  ]);
  queueMicrotask(() => {
    fake!.emit("message", { data: JSON.stringify({ id: 1, result: {} }) });
  });
  expect(await transport.recvText(1000)).toBe(
    JSON.stringify({ id: 1, result: {} }),
  );
  transport.close();
});

test("CDPBrowserTest.test_global_ws_transport_recv_timeout", async () => {
  const fake = new FakeWebSocket();
  const factory = () => {
    queueMicrotask(() => {
      fake.readyState = 1;
      fake.emit("open");
    });
    return fake as unknown as WebSocket;
  };
  const transport = await GlobalWebSocketTransport.connect(
    WS_URL,
    1000,
    factory,
  );
  await expect(transport.recvText(50)).rejects.toThrow("等待消息超时");
  transport.close();
});

test("CDPBrowserTest.test_global_ws_connect_timeout", async () => {
  const fake = new FakeWebSocket();
  const factory = () => fake as unknown as WebSocket; // 永远不 open
  await expect(
    GlobalWebSocketTransport.connect(WS_URL, 50, factory),
  ).rejects.toThrow("连接 Chrome 超时");
});
