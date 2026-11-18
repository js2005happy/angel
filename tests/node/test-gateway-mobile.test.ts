// tests/node/test-gateway-mobile.test.ts — 手机 /m 与配对专项（第 3 阶段）。
// /m 页面与静态资源无需 token；配对码换设备 token；设备 token 能用 API
// 但不能管设备；错 5 次作废后须重新生成。PWA 真机安装仍待真机验证。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";

test("GatewayMobileTest.test_m_shell_public_and_manifest", async () => {  const home = mkdtempSync(join(tmpdir(), "nyra-mob-"));
  const gw = new Gateway({ home, workdir: "/tmp", host: "127.0.0.1", port: 0, config: {} });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const page = await fetch(`${base}/m`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Nyra");
    const manifest = await fetch(`${base}/m/manifest.json`);
    expect(manifest.status).toBe(200);
    const m = await manifest.json() as { start_url: string };
    expect(m.start_url).toBe("/m");
    const icon = await fetch(`${base}/m/icon-192.png`);
    expect(icon.status).toBe(200);
    const bytes = new Uint8Array(await icon.arrayBuffer());
    expect(bytes[0]).toBe(0x89); // PNG 魔数
    expect(bytes[1]).toBe(0x50);
    const startup = await fetch(`${base}/m/startup/750x1334.png`);
    expect(startup.status).toBe(200);
    const bad = await fetch(`${base}/m/startup/1x1.png`);
    expect(bad.status).toBe(404);
  } finally {
    await gw.stop();
  }
});

test("GatewayMobileTest.test_pair_flow_device_token_scoped", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-mob-"));
  // --pair 模式：监听 0.0.0.0 才有 pair_origin。
  const gw = new Gateway({ home, workdir: "/tmp", host: "0.0.0.0", port: 0, config: {} });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const owner = { "X-Nyra-Token": gw.token };
    const start = await fetch(`${base}/api/pair/start`, { method: "POST", headers: owner, body: "{}" });
    expect(start.status).toBe(200);
    const started = await start.json() as { code: string; url: string };
    expect(/^[0-9]{6}$/.test(started.code)).toBe(true);
    expect(started.url).toContain("/m#pair=");
    // 错码 5 次作废。
    for (let i = 0; i < 5; i++) {
      const bad = await fetch(`${base}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "000000", name: "手机" }) });
      expect(bad.status).toBe(401);
    }
    const dead = await fetch(`${base}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: started.code, name: "手机" }) });
    expect(dead.status).toBe(401);
    // 重新生成再兑：拿到设备 token。
    const start2 = await fetch(`${base}/api/pair/start`, { method: "POST", headers: owner, body: "{}" });
    const started2 = await start2.json() as { code: string };
    const paired = await fetch(`${base}/api/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: started2.code, name: "我的手机" }) });
    expect(paired.status).toBe(200);
    const device = await paired.json() as { token: string; id: string; name: string };
    expect(device.name).toBe("我的手机");
    // 设备 token 能读会话，但不能管设备。
    const sessions = await fetch(`${base}/api/sessions`, { headers: { "X-Nyra-Token": device.token } });
    expect(sessions.status).toBe(200);
    const devices = await fetch(`${base}/api/devices`, { headers: { "X-Nyra-Token": device.token } });
    expect(devices.status).toBe(403);
    // 撤销后设备 token 立即失效。
    const revoke = await fetch(`${base}/api/devices/${device.id}/revoke`, { method: "POST", headers: owner, body: "{}" });
    expect(revoke.status).toBe(200);
    const gone = await fetch(`${base}/api/sessions`, { headers: { "X-Nyra-Token": device.token } });
    expect(gone.status).toBe(403);
  } finally {
    await gw.stop();
  }
});

test("GatewayMobileTest.test_pair_start_needs_lan_bind", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-mob-"));
  const gw = new Gateway({ home, workdir: "/tmp", host: "127.0.0.1", port: 0, config: {} });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const start = await fetch(`${base}/api/pair/start`, {
      method: "POST", headers: { "X-Nyra-Token": gw.token }, body: "{}",
    });
    expect(start.status).toBe(409);
    expect((await start.json() as { error: string }).error).toContain("只监听本机");
  } finally {
    await gw.stop();
  }
});

test("GatewayMobileTest.test_m_page_has_rewind_buttons_like_desktop", async () => {
  // 回归：手机页曾漏掉回退按钮（第 3 阶段 Playwright 验证发现），须与桌面页一致。
  const home = mkdtempSync(join(tmpdir(), "nyra-mob-"));
  const gw = new Gateway({ home, workdir: "/tmp", host: "127.0.0.1", port: 0, config: {} });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const mobile = await (await fetch(`${base}/m`)).text();
    const desktop = await (await fetch(`${base}/?token=${gw.token}`)).text();
    for (const label of ["回退到此", "编辑重发", "Fork 新会话"]) {
      expect(mobile).toContain(label);
      expect(desktop).toContain(label);
    }
    expect(mobile).toContain("async function doRewind");
    expect(desktop).toContain("async function doRewind");
  } finally {
    await gw.stop();
  }
});
