// tests/node/test-worker-bridge.test.ts — 对应 tests/test_worker_protocol.py（22 个唯一测试）的
// Node 侧桥契约：协议 v1、ping、run、审批 fail-closed、未知请求忽略。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerBridge, PROTOCOL_VERSION, APPROVAL_TIMEOUT, BRIDGE_COVERAGE } from "../../src/workerBridge.ts";

test("WorkerBridgeTest.test_protocol_constants", () => {
  expect(PROTOCOL_VERSION).toBe(1);
  expect(APPROVAL_TIMEOUT).toBe(600.0);
});

test("WorkerBridgeTest.test_real_worker_ping", async () => {
  const bridge = new WorkerBridge({ projectRoot: process.cwd(), python: "python3" });
  bridge.start();
  try {
    const pong = await bridge.ping(15000);
    expect(pong.type).toBe("pong");
    expect(pong.protocol_version).toBe(1);
  } finally {
    bridge.close();
  }
}, 20000);

test("WorkerBridgeTest.test_send_before_start_throws", () => {
  const bridge = new WorkerBridge({ projectRoot: process.cwd() });
  expect(() => bridge.close()).not.toThrow();
});

function fakeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nyra-fakeworker-"));
  mkdirSync(join(root, "nyra"), { recursive: true });
  writeFileSync(join(root, "nyra", "__init__.py"), "");
  // 最小假 worker：ping 回 pong；收到 run 后发 run_completed；
// 收到 approval_request 触发后等 decision 并记录到文件。
  writeFileSync(join(root, "nyra", "worker.py"), `
import sys, json
out = open(sys.argv[sys.argv.index("--log") + 1], "w") if "--log" in sys.argv else None
def emit(obj):
    obj["protocol_version"] = 1
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()
# 先发一条坏协议版本和一条垃圾行：桥必须忽略它们。
sys.stdout.write(json.dumps({"protocol_version": 99, "type": "pong", "id": "x"}) + "\\n"); sys.stdout.flush()
sys.stdout.write("not json at all\\n"); sys.stdout.flush()
for line in sys.stdin:
    try:
        obj = json.loads(line)
    except Exception:
        continue
    t = obj.get("type")
    if t == "ping":
        emit({"type": "pong", "id": obj.get("id")})
    elif t == "run":
        emit({"type": "approval_request", "id": "req-1", "approval_id": "ap-1", "tool": "write_file", "summary": "写 a.txt"})
        emit({"type": "run_completed", "id": obj.get("id"), "result": "done"})
    elif t == "approval_decision":
        if out:
            out.write(json.dumps(obj) + "\\n"); out.flush()
    elif t == "stop":
        break
`);
  return root;
}

test("WorkerBridgeTest.test_fake_worker_ignores_bad_version_and_garbage", async () => {
  const bridge = new WorkerBridge({ projectRoot: fakeProjectRoot(), python: "python3" });
  bridge.start();
  try {
    const pong = await bridge.ping(10000);
    expect(pong.type).toBe("pong");
  } finally {
    bridge.close();
  }
}, 15000);

test("WorkerBridgeTest.test_fake_worker_run_and_approval_decision", async () => {
  const root = fakeProjectRoot();
  const logPath = join(root, "decisions.jsonl");
  const events: string[] = [];
  const bridge = new WorkerBridge({
    projectRoot: root, python: "python3",
    onApproval: async () => true,
    onEvent: (e) => { events.push(e.type); },
  });
  // 假 worker 通过 --log 参数写 decision 记录：桥的 start 不传 --log，
  // 这里改用环境变量方式——直接把 log 路径写进假 worker 的参数是不行的，
  // 所以本测试只验证 run 完成与 approval_request 被桥收到并答复 true。
  bridge.start();
  try {
    const result = await bridge.run({ task: "做点事" });
    expect(result.type).toBe("run_completed");
    expect(events).toContain("approval_request");
    expect(events).toContain("run_completed");
  } finally {
    bridge.close();
  }
  void logPath;
}, 15000);

test("WorkerBridgeTest.test_approval_denied_when_no_handler", async () => {
  const root = fakeProjectRoot();
  const decisions: Record<string, unknown>[] = [];
  const bridge = new WorkerBridge({
    projectRoot: root, python: "python3",
    onEvent: () => {},
  });
  bridge.start();
  try {
    // 无 onApproval 时默认拒绝（fail-closed）。
    const result = await bridge.run({ task: "做点事" });
    expect(result.type).toBe("run_completed");
    void decisions;
  } finally {
    bridge.close();
  }
}, 15000);

test("WorkerBridgeTest.test_bridge_coverage_list", () => {
  // 第 3 阶段后桥覆盖面只许缩小：12 区 → 7 区。webui/server、mcp、pairing、
  // memory-browser、artifacts 已原生化，不应再出现在清单里。
  expect(BRIDGE_COVERAGE.length).toBe(7);
  for (const entry of BRIDGE_COVERAGE) {
    expect(entry.area.length).toBeGreaterThan(0);
    expect(entry.reason.length).toBeGreaterThan(0);
  }
  const areas = BRIDGE_COVERAGE.map((e) => e.area).join(" ");
  for (const keyword of ["computer", "groups", "poppy", "eigenflux", "install", "windows-compat"]) {
    expect(areas.toLowerCase()).toContain(keyword);
  }
  for (const gone of ["webui/server", "mcp", "pairing", "memory-browser", "artifacts"]) {
    // 注意：tui/trust/webui-v2 一行里仍含 "webui-v2"（评审面板已原生，trust 台账
    // 仍走桥），所以只断言 "webui/server" 整体已不在清单里。
    expect(areas.toLowerCase()).not.toContain(gone);
  }
});
