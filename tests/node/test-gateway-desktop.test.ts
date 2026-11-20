// tests/node/test-gateway-desktop.test.ts — 桌面端（`nyra ui` 的 /）新接口专项：
// Key 只回掩码、keys.json 0600、密码箱解锁时进密码箱、测试连接真请求 provider、
// /api/settings 读写 config.json、/api/setup 首次引导、审批规则（项目范围 + 撤销 + 拒绝反馈）。
import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { resolveProvider } from "../../src/config.ts";
import { Vault, vaultPath } from "../../src/vault.ts";
import { maskKey, setKey, keysPath, keyStatus, migrateKeysToVault, getFileKey, validateKey } from "../../src/keystore.ts";
import { fakeProvider } from "./fake-provider.ts";
import { expectPerms } from "./fsPerms.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const SECRET = "sk-test-0123456789abcdefWXYZ";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});
function clearKeyEnv(): void {
  for (const k of ["NYRA_VAULT_PASSWORD", "NYRA_API_KEY", "DEEPSEEK_API_KEY", "MYLLM_API_KEY", "NYRA_PROVIDER", "NYRA_MODEL"]) setEnv(k, undefined);
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("keystore: 掩码只露前缀和末 4 位；非法 Key 拒收", () => {
  expect(maskKey(SECRET)).toBe("sk-…WXYZ");
  expect(maskKey("abcdefghijklmnop")).toBe("…mnop");
  expect(maskKey("short12")).toBe("…12");
  expect(maskKey("")).toBe("");
  expect(maskKey(SECRET)).not.toContain("0123456789");
  expect(() => validateKey("has space")).toThrow();
  expect(() => validateKey("")).toThrow();
  expect(() => validateKey("x".repeat(600))).toThrow();
});

test("keystore: 密码箱没解锁 → keys.json（文件 0600、目录 0700）；解锁后写进密码箱并搬走 keys.json", () => {
  clearKeyEnv();
  const home = join(tmp("nyra-ks-"), "home");
  const r = setKey("DEEPSEEK_API_KEY", SECRET, home);
  expect(r).toEqual({ masked: "sk-…WXYZ", stored: "file" });
  expectPerms(keysPath(home), 0o600);
  expectPerms(home, 0o700);
  expect(getFileKey("DEEPSEEK_API_KEY", home)).toBe(SECRET);
  expect(keyStatus("DEEPSEEK_API_KEY", home)).toEqual({ source: "file", masked: "sk-…WXYZ" });
  // resolveProvider 读得到（deepseek 是连接器 provider：Node 侧没有连接器凭证，界面保存的 Key 照样用上）。
  const resolved = resolveProvider({ home, config: { provider: "deepseek" } });
  expect(resolved.apiKey).toBe(SECRET);
  expect(resolved.keySource).toBe("file");
  expect(resolved.hasKey).toBe(true);
  // 环境变量永远优先。
  setEnv("DEEPSEEK_API_KEY", "sk-from-env-aaaaBBBB");
  expect(keyStatus("DEEPSEEK_API_KEY", home).source).toBe("env");
  expect(resolveProvider({ home, config: { provider: "deepseek" } }).keySource).toBe("env");
  setEnv("DEEPSEEK_API_KEY", undefined);
  // 建密码箱并解锁 → 搬进密码箱，keys.json 删掉。
  new Vault(vaultPath(home)).init("correct horse battery");
  setEnv("NYRA_VAULT_PASSWORD", "correct horse battery");
  expect(migrateKeysToVault(home)).toBe(1);
  expect(existsSync(keysPath(home))).toBe(false);
  const v = new Vault(vaultPath(home));
  expect(v.unlock("correct horse battery")).toBe(true);
  expect(v.get("DEEPSEEK_API_KEY")).toBe(SECRET);
  // 解锁状态下新存的 Key 直接进密码箱，不落 keys.json。
  expect(setKey("MYLLM_API_KEY", "gsk_another_key_9999", home)).toEqual({ masked: "gsk_…9999", stored: "vault" });
  expect(existsSync(keysPath(home))).toBe(false);
  expect(keyStatus("MYLLM_API_KEY", home)).toEqual({ source: "vault", masked: "gsk_…9999" });
  expect(readFileSync(vaultPath(home), "utf-8")).not.toContain("gsk_another_key_9999");
});

test("gateway: /api/setup 首次引导 → /api/keys 保存只回掩码，设备 token 不能管 Key", async () => {
  clearKeyEnv();
  const home = tmp("nyra-dk-");
  const gw = new Gateway({ home, workdir: tmp("nyra-dk-wd-"), host: "0.0.0.0", port: 0, config: { provider: "deepseek", mcp_enabled: false } });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const h = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    const setup = await (await fetch(`${base}/api/setup`, { headers: h })).json() as { needs_setup: boolean; storage: string; providers: { provider: string; source: string; needs_key: boolean }[] };
    expect(setup.needs_setup).toBe(true);
    expect(setup.storage).toBe("file");
    expect(setup.providers.find((p) => p.provider === "deepseek")?.source).toBe("missing");
    expect(setup.providers.find((p) => p.provider === "ollama")?.needs_key).toBe(false);
    const saved = await fetch(`${base}/api/keys`, { method: "POST", headers: h, body: JSON.stringify({ provider: "deepseek", key: SECRET }) });
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({ provider: "deepseek", masked: "sk-…WXYZ", stored: "file" });
    expectPerms(keysPath(home), 0o600);
    const keys = await (await fetch(`${base}/api/keys`, { headers: h })).text();
    expect(keys).not.toContain(SECRET);
    expect(keys).toContain("sk-…WXYZ");
    const after = await (await fetch(`${base}/api/setup`, { headers: h })).json() as { needs_setup: boolean };
    expect(after.needs_setup).toBe(false);
    // Key 绝不出现在 info / settings 里。
    for (const p of ["/api/info", "/api/settings", "/api/setup"]) expect(await (await fetch(base + p, { headers: h })).text()).not.toContain(SECRET);
    // 不认识的 provider / 不用 Key 的 provider / 非法 Key → 400。
    expect((await fetch(`${base}/api/keys`, { method: "POST", headers: h, body: JSON.stringify({ provider: "nope", key: SECRET }) })).status).toBe(400);
    expect((await fetch(`${base}/api/keys`, { method: "POST", headers: h, body: JSON.stringify({ provider: "ollama", key: SECRET }) })).status).toBe(400);
    expect((await fetch(`${base}/api/keys`, { method: "POST", headers: h, body: JSON.stringify({ provider: "deepseek", key: "a b" }) })).status).toBe(400);
    // 已配对手机：能看引导状态，不能读/写 Key、不能改设置。
    const started = gw.startPairing() as { code: string };
    const dev = await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ code: started.code, name: "Pixel" }) })).json() as { token: string };
    const dh = { "X-Nyra-Token": dev.token, "Content-Type": "application/json" };
    expect((await fetch(`${base}/api/keys`, { headers: dh })).status).toBe(403);
    expect((await fetch(`${base}/api/keys`, { method: "POST", headers: dh, body: JSON.stringify({ provider: "deepseek", key: SECRET }) })).status).toBe(403);
    expect((await fetch(`${base}/api/keys/test`, { method: "POST", headers: dh, body: JSON.stringify({ provider: "deepseek" }) })).status).toBe(403);
    expect((await fetch(`${base}/api/settings`, { method: "POST", headers: dh, body: JSON.stringify({ max_turns: 5 }) })).status).toBe(403);
    // 删除。
    expect(await (await fetch(`${base}/api/keys/remove`, { method: "POST", headers: h, body: JSON.stringify({ provider: "deepseek" }) })).json()).toEqual({ ok: true });
    expect(existsSync(keysPath(home))).toBe(false);
  } finally { await gw.stop(); }
});

test("gateway: /api/keys/test 真的请求 provider 的 /models，回掩码；Key 错时报错且不带 Key", async () => {
  clearKeyEnv();
  const seen: string[] = [];
  const upstream = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      seen.push(new URL(req.url).pathname + " " + auth);
      if (auth !== `Bearer ${SECRET}`) return new Response(JSON.stringify({ error: { message: `invalid key ${auth.slice(7)}` } }), { status: 401, headers: { "content-type": "application/json" } });
      return Response.json({ data: [{ id: "my-model" }, { id: "my-model-mini" }] });
    },
  });
  const home = tmp("nyra-dt-");
  const config = { provider: "myllm", mcp_enabled: false, custom_providers: { myllm: { base_url: `http://127.0.0.1:${upstream.port}/v1`, default_model: "my-model", env_key: "MYLLM_API_KEY" } } };
  const gw = new Gateway({ home, workdir: tmp("nyra-dt-wd-"), host: "127.0.0.1", port: 0, config });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const h = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    const ok = await (await fetch(`${base}/api/keys/test`, { method: "POST", headers: h, body: JSON.stringify({ provider: "myllm", key: SECRET }) })).text();
    expect(ok).not.toContain(SECRET);
    expect(JSON.parse(ok)).toMatchObject({ ok: true, provider: "myllm", masked: "sk-…WXYZ", models: 2, model_found: true });
    expect(seen.at(-1)).toBe(`/v1/models Bearer ${SECRET}`);
    const bad = await (await fetch(`${base}/api/keys/test`, { method: "POST", headers: h, body: JSON.stringify({ provider: "myllm", key: "sk-wrong-key-00001111" }) })).text();
    expect(bad).not.toContain("sk-wrong-key-00001111");
    const badJson = JSON.parse(bad) as { ok: boolean; status: number | null; masked: string };
    expect(badJson.ok).toBe(false);
    expect(badJson.masked).toBe("sk-…1111");
    // 不给 Key 且没保存过 → 不发请求，直接说还没有 Key。
    const before = seen.length;
    const none = await (await fetch(`${base}/api/keys/test`, { method: "POST", headers: h, body: JSON.stringify({ provider: "myllm" }) })).json() as { ok: boolean };
    expect(none.ok).toBe(false);
    expect(seen.length).toBe(before);
    // 保存后不带 Key 也能测（用已保存的）。
    await fetch(`${base}/api/keys`, { method: "POST", headers: h, body: JSON.stringify({ provider: "myllm", key: SECRET }) });
    const again = await (await fetch(`${base}/api/keys/test`, { method: "POST", headers: h, body: JSON.stringify({ provider: "myllm" }) })).json() as { ok: boolean };
    expect(again.ok).toBe(true);
    expect((await (await fetch(`${base}/api/info`, { headers: h })).json() as { credentials: boolean }).credentials).toBe(true);
  } finally { await gw.stop(); upstream.stop(true); }
});

test("gateway: /api/settings 读写 config.json 并立即生效；非法值 / 未知字段 400", async () => {
  clearKeyEnv();
  const home = tmp("nyra-ds-");
  const gw = new Gateway({ home, workdir: tmp("nyra-ds-wd-"), host: "127.0.0.1", port: 0, providerFactory: () => fakeProvider([{ content: "ok" }]) as never, config: { mcp_enabled: false } });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const h = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    const view = await (await fetch(`${base}/api/settings`, { headers: h })).json() as Record<string, Record<string, unknown>>;
    expect(view.general.default_mode).toBe("auto");
    expect(view.context.auto_compact_enabled).toBe(false);
    expect(Array.isArray(view.mcp.servers)).toBe(true);
    const res = await fetch(`${base}/api/settings`, { method: "POST", headers: h, body: JSON.stringify({ default_mode: "readonly", max_turns: 40, auto_compact_enabled: true, auto_compact_threshold: 0.7, tool_search_enabled: true, language: "en" }) });
    expect(res.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf-8")) as Record<string, unknown>;
    expect(saved.mode).toBe("readonly");
    expect(saved.max_turns).toBe(40);
    expect(saved.auto_compact_enabled).toBe(true);
    expect(saved.auto_compact_threshold).toBe(0.7);
    expect((saved.tool_search as { enabled: boolean }).enabled).toBe(true);
    expect(saved.language).toBe("en");
    expect(gw.autoCompactEnabled).toBe(true);
    expect(gw.autoCompactThreshold).toBe(0.7);
    for (const body of [{ default_mode: "full" }, { max_turns: 0 }, { auto_compact_threshold: 3 }, { secret: 1 }, {}, { language: "fr" }, { default_provider: "nope" }]) {
      expect((await fetch(`${base}/api/settings`, { method: "POST", headers: h, body: JSON.stringify(body) })).status).toBe(400);
    }
    const p = await (await fetch(`${base}/api/settings`, { method: "POST", headers: h, body: JSON.stringify({ default_provider: "qwen", default_model: "qwen-turbo" }) })).json() as { model: { default_provider: string; default_model: string } };
    expect(p.model).toEqual({ default_provider: "qwen", default_model: "qwen-turbo" });
  } finally { await gw.stop(); }
});

test("gateway: /api/info 的 shell 字段——只有桌面外壳模式是 desktop", async () => {
  const a = new Gateway({ home: tmp("nyra-sh-"), workdir: "/tmp", port: 0, config: {}, shell: "desktop" });
  const b = new Gateway({ home: tmp("nyra-sh-"), workdir: "/tmp", port: 0, config: {} });
  const c = new Gateway({ home: tmp("nyra-sh-"), workdir: "/tmp", port: 0, config: {}, shell: "evil" });
  expect(a.info().shell).toBe("desktop");
  expect(b.info().shell).toBeNull();
  expect(c.info().shell).toBeNull();
});

test("gateway: 桌面审批——编辑带 diff、命令 Always（本项目）记规则并可撤销、拒绝带反馈回到模型", async () => {
  clearKeyEnv();
  const home = tmp("nyra-da-");
  const workdir = tmp("nyra-da-wd-");
  const seen: unknown[][] = [];
  const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const base0 = fakeProvider([
    { content: "", toolCalls: [call("w1", "write_file", { path: "notes.txt", content: "hello\nworld\n" })] },
    { content: "", toolCalls: [call("c1", "shell", { command: "git status" })] },
    { content: "", toolCalls: [call("c2", "shell", { command: "git status -s" })] },
    { content: "", toolCalls: [call("c3", "shell", { command: "rm -rf build" })] },
    { content: "改用只读查看。" },
  ]);
  const provider = { ...base0, async chat(messages: unknown[], tools?: unknown, timeout?: number) { seen.push(JSON.parse(JSON.stringify(messages))); return base0.chat(messages, tools, timeout); } };
  const gw = new Gateway({ home, workdir, host: "127.0.0.1", port: 0, mode: "auto", providerFactory: () => provider as never, config: { mcp_enabled: false, fallback_enabled: false } });
  const info = await gw.start();
  try {
    const url = `http://127.0.0.1:${info.port}`;
    const h = { "X-Nyra-Token": gw.token, "Content-Type": "application/json" };
    type A = { id: string; tool: string; summary: string; command: string | null; suggestion: { label: string } | null };
    const pending = async () => ((await (await fetch(`${url}/api/approvals`, { headers: h })).json()) as { approvals: A[] }).approvals[0];
    const sid = (await (await fetch(`${url}/api/sessions`, { method: "POST", headers: h, body: "{}" })).json() as { id: string }).id;
    await fetch(`${url}/api/sessions/${sid}/messages`, { method: "POST", headers: h, body: JSON.stringify({ text: "写个笔记再看仓库" }) });
    const edit = await waitFor(pending);
    expect(edit.tool).toBe("write_file");
    expect(edit.summary).toContain("+hello"); // 桌面 Diff 面板用 parseDiff 解析这段统一 diff
    await fetch(`${url}/api/approvals/${edit.id}`, { method: "POST", headers: h, body: JSON.stringify({ approve: true }) });
    const cmd = await waitFor(async () => { const a = await pending(); return a && a.tool === "shell" ? a : null; });
    expect(cmd.command).toBe("git status");
    expect((await fetch(`${url}/api/approvals/${cmd.id}`, { method: "POST", headers: h, body: JSON.stringify({ approve: true, scope: "project" }) })).status).toBe(200);
    const danger = await waitFor(async () => { const a = await pending(); return a && a.command === "rm -rf build" ? a : null; });
    expect(danger.suggestion).toBeNull();
    const rules = await (await fetch(`${url}/api/rules`, { headers: h })).json() as { rules: { id: string; scope: string; label: string }[] };
    const rule = rules.rules.find((r) => r.scope === "project");
    expect(rule?.label).toBe("以 `git status` 开头的命令");
    expect((await fetch(`${url}/api/approvals/${danger.id}`, { method: "POST", headers: h, body: JSON.stringify({ approve: false, feedback: "不要删 build，用 git diff 只读看" }) })).status).toBe(200);
    await waitFor(async () => ((await (await fetch(`${url}/api/sessions/${sid}`, { headers: h })).json()) as { status: string }).status === "done");
    expect(JSON.stringify(seen.at(-1))).toContain("不要删 build，用 git diff 只读看");
    expect(readFileSync(join(workdir, "notes.txt"), "utf-8")).toBe("hello\nworld\n");
    // 撤销项目规则。
    expect((await fetch(`${url}/api/rules/${rule!.id}/revoke`, { method: "POST", headers: h, body: "{}" })).status).toBe(200);
    const after = await (await fetch(`${url}/api/rules`, { headers: h })).json() as { rules: { id: string }[] };
    expect(after.rules.some((r) => r.id === rule!.id)).toBe(false);
    expect((await fetch(`${url}/api/rules/${rule!.id}/revoke`, { method: "POST", headers: h, body: "{}" })).status).toBe(404);
  } finally { await gw.stop(); }
});
