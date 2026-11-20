// tests/node/test-lsp.test.ts — LSP 客户端（缺口 24）。
// 只接 diagnostics 与符号查询；重命名走 apply_patch（不接 workspace/applyEdit）。
// 覆盖纯函数（URI/严重度/符号种类/配置解析/格式化）+ 一个 mock 语言服务器的端到端握手。
import { test, expect } from "bun:test";
import {
  toLspUri, fromLspUri, severityLabel, symbolKindLabel, languageIdFor,
  resolveLspServers, formatDiagnostics, formatSymbols, formatLocations,
  LspClient, type LspDiagnostic, type LspSymbol, type LspLocation,
} from "../../src/lsp.ts";

test("toLspUri / fromLspUri：POSIX 与 Windows 往返", () => {
  expect(toLspUri("/a/b.ts")).toBe("file:///a/b.ts");
  expect(fromLspUri("file:///a/b.ts")).toBe("/a/b.ts");
  expect(fromLspUri("file:///C:/a/b.ts")).toBe("C:/a/b.ts");
});

test("severityLabel / symbolKindLabel", () => {
  expect(severityLabel(1)).toBe("错误");
  expect(severityLabel(2)).toBe("警告");
  expect(severityLabel(3)).toBe("信息");
  expect(severityLabel(4)).toBe("提示");
  expect(severityLabel(99)).toBe("未知");
  expect(symbolKindLabel(5)).toBe("类");
  expect(symbolKindLabel(12)).toBe("函数");
  expect(symbolKindLabel(999)).toBe("kind999");
});

test("languageIdFor 按扩展名映射", () => {
  expect(languageIdFor("a.ts")).toBe("typescript");
  expect(languageIdFor("a.py")).toBe("python");
  expect(languageIdFor("a.go")).toBe("go");
  expect(languageIdFor("a.unknown")).toBe("plaintext");
});

test("resolveLspServers：解析合法配置，跳过非法条目", () => {
  const config = {
    lsp: {
      servers: [
        { command: "typescript-language-server", args: ["--stdio"], extensions: [".ts", ".tsx"] },
        { command: "", args: [], extensions: [] }, // 无命令：跳过
        { command: "gopls", args: [], extensions: [".go"] },
        "not-an-object", // 非法：跳过
      ],
    },
  };
  const servers = resolveLspServers(config);
  expect(servers.length).toBe(2);
  expect(servers[0].command).toBe("typescript-language-server");
  expect(servers[1].command).toBe("gopls");
});

test("resolveLspServers：无 lsp 配置 → 空列表", () => {
  expect(resolveLspServers({})).toEqual([]);
  expect(resolveLspServers(null)).toEqual([]);
  expect(resolveLspServers({ lsp: {} })).toEqual([]);
});

test("formatDiagnostics：按严重度排序 + 截断", () => {
  const diags: LspDiagnostic[] = [
    { file: "a.ts", line: 0, column: 0, severity: 2, message: "警告消息" },
    { file: "a.ts", line: 1, column: 2, severity: 1, message: "错误消息" },
  ];
  const out = formatDiagnostics(diags);
  expect(out.indexOf("错误消息")).toBeLessThan(out.indexOf("警告消息"));
  expect(out).toContain("a.ts:2:3"); // line 1 → 2, column 2 → 3
  expect(formatDiagnostics([])).toContain("没有诊断");
});

test("formatSymbols / formatLocations", () => {
  const syms: LspSymbol[] = [{ name: "Foo", kind: 5, line: 0, column: 0 }];
  expect(formatSymbols(syms)).toContain("Foo [类] @1:1");
  expect(formatSymbols([])).toContain("没有可识别的符号");

  const locs: LspLocation[] = [{ uri: "/a/b.ts", line: 3, column: 5 }];
  expect(formatLocations(locs)).toContain("/a/b.ts:4:6");
  expect(formatLocations([])).toContain("未找到");
});

// ---- 端到端：mock 语言服务器（stdio + Content-Length 分帧） ----

/** 一个极简 mock LSP 服务器：应答 initialize 与 documentSymbol，推送一条诊断。 */
function mockLspServerScript(): string {
  return `
const { writeSync } = process.stdout;
let buf = Buffer.alloc(0);
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  const header = Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf-8");
  process.stdout.write(header);
  process.stdout.write(body);
}
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const idx = buf.indexOf("\\r\\n\\r\\n");
    if (idx < 0) break;
    const header = buf.slice(0, idx).toString("utf-8");
    const m = /content-length:\\s*(\\d+)/i.exec(header);
    if (!m) { buf = buf.slice(idx + 4); continue; }
    const len = parseInt(m[1], 10);
    const bodyStart = idx + 4;
    if (buf.length < bodyStart + len) break;
    const body = buf.slice(bodyStart, bodyStart + len).toString("utf-8");
    buf = buf.slice(bodyStart + len);
    let msg; try { msg = JSON.parse(body); } catch { continue; }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
    } else if (msg.method === "initialized") {
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: msg.params?.uri ?? "file:///a.ts", diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "mock error" }] } });
    } else if (msg.method === "textDocument/didOpen") {
      // 推送诊断
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: msg.params.textDocument.uri, diagnostics: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } }, severity: 2, message: "mock warning" }] } });
    } else if (msg.method === "textDocument/documentSymbol") {
      send({ jsonrpc: "2.0", id: msg.id, result: [{ name: "Foo", kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }] });
    } else if (msg.method === "textDocument/definition") {
      send({ jsonrpc: "2.0", id: msg.id, result: [{ uri: "file:///a.ts", range: { start: { line: 2, character: 1 }, end: { line: 2, character: 2 } } }] });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  }
});
`;
}

test("LspClient 端到端：握手 + 文档符号 + 定义 + 诊断", async () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nyra-lsp-mock-"));
  const script = path.join(dir, "server.js");
  fs.writeFileSync(script, mockLspServerScript());
  // 要诊断的文件
  const target = path.join(dir, "a.ts");
  fs.writeFileSync(target, "export function foo() {}\n");

  const client = new LspClient({ command: process.execPath, args: [script], extensions: [".ts"] });
  try {
    const symbols = await client.documentSymbols(target);
    expect(symbols.length).toBe(1);
    expect(symbols[0].name).toBe("Foo");

    const defs = await client.definition(target, 0, 0);
    expect(defs.length).toBe(1);
    expect(defs[0].line).toBe(2);

    await client.openDocument(target);
    // 等诊断推送
    await new Promise((r) => setTimeout(r, 100));
    const diags = client.getDiagnostics(target);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].severity).toBe(2);
  } finally {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
