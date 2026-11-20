// tests/node/test-gateway-webhooks.test.ts — 网关 webhook 入口（缺口 7）真测：
// 真起一个 Gateway（127.0.0.1:0），POST /api/webhooks/generic 走网关 token 鉴权，
// 事件进任务队列并记 event_triggered；无 token 403、未知来源 400、GET 清单 200。
// HMAC 验签本身在 test-event-triggers.test.ts 里按函数测（需密码箱），这里不重复。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { fakeProvider } from "./fake-provider.ts";
import { RunStore } from "../../src/runs.ts";
import { listTasks } from "../../src/tasks.ts";
import { saveEventTriggers, eventTriggersPath } from "../../src/eventTriggers.ts";

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "nyra-gw-wh-"));
}

async function startGateway(home: string, workdir: string) {
  const gw = new Gateway({
    home, workdir, host: "127.0.0.1", port: 0, mode: "full",
    providerFactory: () => fakeProvider([{ content: "ok" }], { delayMs: 10 }),
    config: { mcp_enabled: false, fallback_enabled: false },
  });
  const info = await gw.start();
  return { gw, info };
}

function seedTrigger(home: string, workdir: string): void {
  saveEventTriggers({
    triggers: [{
      id: "a1b2c3d4e5f6a7b8", name: "deploy-watch", source: "webhook", event: "deploy.done",
      task: "部署完成：{{event.summary}}，数据 {{event.payload}}",
      mode: "readonly", enabled: true, workdir, max_turns: 5,
    }],
  }, eventTriggersPath(home));
}

test("GatewayWebhookTest.test_generic_webhook_enqueues_and_records", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-wh-wd-"));
  seedTrigger(home, workdir);
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const res = await fetch(`${base}/api/webhooks/generic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nyra-Token": gw.token, "X-Nyra-Event": "deploy.done" },
      body: JSON.stringify({ summary: "生产部署完成", version: "1.2.3" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { accepted: boolean; dispatched: { runId: string }[]; skipped: unknown[] };
    expect(body.accepted).toBe(true);
    expect(body.dispatched.length).toBe(1);
    expect(body.skipped).toEqual([]);
    const runId = body.dispatched[0].runId;
    const tasks = listTasks(new RunStore(join(home, "tasks")));
    expect(tasks.map((t) => t.run_id)).toContain(runId);
    expect(tasks.find((t) => t.run_id === runId)?.mode).toBe("readonly");
    const events = new RunStore(join(home, "tasks")).readEvents(runId);
    const ev = events.find((e) => e.type === "event_triggered") as Record<string, unknown> | undefined;
    expect(ev).toBeDefined();
    expect(ev!.trigger_name).toBe("deploy-watch");
    expect(ev!.auth).toBe("gateway-token");
    // 同一事件重复投递：幂等，只返回原 run_id，不建新任务。
    const retry = await fetch(`${base}/api/webhooks/generic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nyra-Token": gw.token, "X-Nyra-Event": "deploy.done" },
      body: JSON.stringify({ summary: "生产部署完成", version: "1.2.3" }),
    });
    expect(retry.status).toBe(202);
    const retryBody = await retry.json() as { dispatched: unknown[]; skipped: { reason: string; runId: string }[] };
    expect(retryBody.dispatched).toEqual([]);
    expect(retryBody.skipped[0].reason).toBe("duplicate");
    expect(retryBody.skipped[0].runId).toBe(runId);
    expect(listTasks(new RunStore(join(home, "tasks"))).length).toBe(1);
  } finally {
    await gw.stop();
  }
});

test("GatewayWebhookTest.test_webhook_auth_and_validation", async () => {
  const home = isolatedHome();
  const workdir = mkdtempSync(join(tmpdir(), "nyra-gw-wh-wd-"));
  seedTrigger(home, workdir);
  const { gw, info } = await startGateway(home, workdir);
  try {
    const base = `http://127.0.0.1:${info.port}`;
    // 无 token：403。
    const noToken = await fetch(`${base}/api/webhooks/generic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nyra-Event": "deploy.done" },
      body: JSON.stringify({ summary: "x" }),
    });
    expect(noToken.status).toBe(403);
    // 未知来源：400。
    const badSource = await fetch(`${base}/api/webhooks/nope`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nyra-Token": gw.token },
      body: JSON.stringify({}),
    });
    expect(badSource.status).toBe(400);
    // 缺事件类型：400。
    const noType = await fetch(`${base}/api/webhooks/generic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nyra-Token": gw.token },
      body: JSON.stringify({ foo: 1 }),
    });
    expect(noType.status).toBe(400);
    // 没配密钥的 github：503，不静默放行。
    const noSecret = await fetch(`${base}/api/webhooks/github`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "push" },
      body: JSON.stringify({}),
    });
    expect(noSecret.status).toBe(503);
    // 清单：只给元数据，不含任务提示词。
    const list = await fetch(`${base}/api/event-triggers`, { headers: { "X-Nyra-Token": gw.token } });
    expect(list.status).toBe(200);
    const listBody = await list.json() as { triggers: Record<string, unknown>[] };
    expect(listBody.triggers.length).toBe(1);
    expect(listBody.triggers[0].name).toBe("deploy-watch");
    expect(listBody.triggers[0]).not.toHaveProperty("task");
    const listNoToken = await fetch(`${base}/api/event-triggers`);
    expect(listNoToken.status).toBe(403);
  } finally {
    await gw.stop();
  }
});
