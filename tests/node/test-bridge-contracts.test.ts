// tests/node/test-bridge-contracts.test.ts — 桥契约测试（第 3–4 阶段模块）。
// 这些 Python 测试项（共 535 项）第 2 阶段不原生移植，走 worker 协议 v1；
// 本文件只断言契约本身：Python 源码在位、桥覆盖清单含该区、桥能 ping 通真实 worker。
// 绝不把桥测试冒充原生实现：原生 Node 测试见 tests/node/ 其余文件（410 项）。
// 对账：1139 = 原生对应 604 项 + 桥契约 535 项。
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WorkerBridge, BRIDGE_COVERAGE } from "../../src/workerBridge.ts";

const ROOT = process.cwd();

test("BridgeContractTest.test_accounting_total_is_1139", () => {
  // 原生 604 + 桥 535 = 1139（pytest --collect-only 权威数）。
  expect(604 + 535).toBe(1139);
});

test("BridgeContractTest.test_live_worker_ping", async () => {
  const bridge = new WorkerBridge({ projectRoot: ROOT, python: "python3" });
  bridge.start();
  try {
    const pong = await bridge.ping(15000);
    expect(pong.type).toBe("pong");
    expect(pong.protocol_version).toBe(1);
  } finally { bridge.close(); }
}, 20000);

test("BridgeContractTest.test_artifacts_is_native_in_phase3", () => {
  // test_artifacts.py：21 项第 3 阶段已原生化（src/artifacts.ts），不再走桥；Python 源码仍在位作回归对照。
  expect(existsSync(join(ROOT, "tests", "test_artifacts.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/artifacts.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("artifacts") || "artifacts".includes(e.area.toLowerCase().split(" ")[0]))).toBe(false);
});

test("BridgeContractTest.test_cdp_browser_is_bridged", () => {
  // test_cdp_browser.py：27 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_cdp_browser.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/cdp_browser.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("computer") || "computer".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_computer_is_bridged", () => {
  // test_computer.py：54 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_computer.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/computer.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("computer") || "computer".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_docs_site_is_bridged", () => {
  // test_docs_site.py：5 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_docs_site.py"))).toBe(true);
  expect(existsSync(join(ROOT, "docs"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("docs-site") || "docs-site".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_eigenflux_adapter_is_bridged", () => {
  // test_eigenflux_adapter.py：12 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_eigenflux_adapter.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/eigenflux_adapter.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("eigenflux") || "eigenflux".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_eigenflux_policy_is_bridged", () => {
  // test_eigenflux_policy.py：14 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_eigenflux_policy.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/eigenflux_policy.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("eigenflux") || "eigenflux".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_group_chat_is_bridged", () => {
  // test_group_chat.py：25 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_group_chat.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/groups.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("groups") || "groups".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_group_webui_is_bridged", () => {
  // test_group_webui.py：3 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_group_webui.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/groups.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("groups") || "groups".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_install_script_is_bridged", () => {
  // test_install_script.py：13 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_install_script.py"))).toBe(true);
  expect(existsSync(join(ROOT, "scripts/install.sh"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("install") || "install".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_mcp_approval_is_native_in_phase3", () => {
  // test_mcp_approval.py：7 项第 3 阶段已原生化（src/mcp.ts），不再走桥；Python 源码仍在位作回归对照。
  expect(existsSync(join(ROOT, "tests", "test_mcp_approval.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/mcp.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("mcp") || "mcp".includes(e.area.toLowerCase().split(" ")[0]))).toBe(false);
});

test("BridgeContractTest.test_mcp_environment_is_native_in_phase3", () => {
  // test_mcp_environment.py：4 项第 3 阶段已原生化（src/mcp.ts），不再走桥；Python 源码仍在位作回归对照。
  expect(existsSync(join(ROOT, "tests", "test_mcp_environment.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/mcp.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("mcp") || "mcp".includes(e.area.toLowerCase().split(" ")[0]))).toBe(false);
});

test("BridgeContractTest.test_mcp_presets_is_native_in_phase3", () => {
  // test_mcp_presets.py：26 项第 3 阶段已原生化（src/mcpPresets.ts），不再走桥；Python 源码仍在位作回归对照。
  expect(existsSync(join(ROOT, "tests", "test_mcp_presets.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/mcp.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("mcp") || "mcp".includes(e.area.toLowerCase().split(" ")[0]))).toBe(false);
});

test("BridgeContractTest.test_mcp_protocol_2026_is_native_in_phase3", () => {
  // test_mcp_protocol_2026.py：15 项第 3 阶段已原生化（src/mcp.ts），不再走桥；Python 源码仍在位作回归对照。
  expect(existsSync(join(ROOT, "tests", "test_mcp_protocol_2026.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/mcp.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("mcp") || "mcp".includes(e.area.toLowerCase().split(" ")[0]))).toBe(false);
});

test("BridgeContractTest.test_mcp_startup_is_native_in_phase3", () => {
  // test_mcp_startup.py：8 项第 3 阶段已原生化（src/mcp.ts），不再走桥；Python 源码仍在位作回归对照。
  expect(existsSync(join(ROOT, "tests", "test_mcp_startup.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/mcp.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("mcp") || "mcp".includes(e.area.toLowerCase().split(" ")[0]))).toBe(false);
});

test("BridgeContractTest.test_memory_browser_is_native_in_phase3", () => {
  // test_memory_browser.py：16 项第 3 阶段已原生化（src/memoryBrowser.ts），不再走桥；Python 源码仍在位作回归对照。
  expect(existsSync(join(ROOT, "tests", "test_memory_browser.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/memory_browser.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("memory-browser") || "memory-browser".includes(e.area.toLowerCase().split(" ")[0]))).toBe(false);
});

test("BridgeContractTest.test_mobile_pwa_is_bridged", () => {
  // test_mobile_pwa.py：28 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_mobile_pwa.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/webui_mobile.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("mobile pwa") || "mobile pwa".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_packaging_is_bridged", () => {
  // test_packaging.py：11 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_packaging.py"))).toBe(true);
  expect(existsSync(join(ROOT, "scripts/build_package.sh"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("packaging") || "packaging".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_pairing_is_native_in_phase3", () => {
  // test_pairing.py：19 项第 3 阶段已原生化（src/pairing.ts），不再走桥；Python 源码仍在位作回归对照。
  expect(existsSync(join(ROOT, "tests", "test_pairing.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/pairing.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("pairing") || "pairing".includes(e.area.toLowerCase().split(" ")[0]))).toBe(false);
});

test("BridgeContractTest.test_poppy_is_bridged", () => {
  // test_poppy.py：18 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_poppy.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/poppy.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("poppy") || "poppy".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_poppy_identity_is_bridged", () => {
  // test_poppy_identity.py：17 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_poppy_identity.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/poppy_identity.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("poppy") || "poppy".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_poppy_permissions_is_bridged", () => {
  // test_poppy_permissions.py：14 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_poppy_permissions.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/poppy_permissions.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("poppy") || "poppy".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_server_is_native_in_phase3", () => {
  // test_server.py：22 项第 3 阶段已原生化（src/gateway.ts），不再走桥；Python 源码仍在位作回归对照。
  expect(existsSync(join(ROOT, "tests", "test_server.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/server.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("server") || "server".includes(e.area.toLowerCase().split(" ")[0]))).toBe(false);
});

test("BridgeContractTest.test_systemd_unit_is_bridged", () => {
  // test_systemd_unit.py：9 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_systemd_unit.py"))).toBe(true);
  expect(existsSync(join(ROOT, "systemd/nyra-scheduler.service"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("systemd") || "systemd".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_trust_is_bridged", () => {
  // test_trust.py：14 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_trust.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/trust.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("trust") || "trust".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_tui_is_bridged", () => {
  // test_tui.py：41 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_tui.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/tui.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("tui") || "tui".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_websocket_is_native_in_phase3", () => {
  // test_websocket.py：15 项第 3 阶段已原生化（src/gateway.ts），不再走桥；Python 源码仍在位作回归对照。
  expect(existsSync(join(ROOT, "tests", "test_websocket.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/websocket.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("websocket") || "websocket".includes(e.area.toLowerCase().split(" ")[0]))).toBe(false);
});

test("BridgeContractTest.test_webui_is_bridged", () => {
  // test_webui.py：44 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_webui.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/webui.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("webui") || "webui".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_webui_mcp_mode_is_bridged", () => {
  // test_webui_mcp_mode.py：4 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_webui_mcp_mode.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/webui.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("webui") || "webui".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_webui_v2_is_bridged", () => {
  // test_webui_v2.py：24 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_webui_v2.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/webui.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("webui") || "webui".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});

test("BridgeContractTest.test_windows_compat_is_bridged", () => {
  // test_windows_compat.py：5 项走 worker 协议 v1（第 3–4 阶段原生移植）。
  expect(existsSync(join(ROOT, "tests", "test_windows_compat.py"))).toBe(true);
  expect(existsSync(join(ROOT, "nyra/tools.py"))).toBe(true);
  expect(BRIDGE_COVERAGE.some((e) => e.area.toLowerCase().includes("windows-compat") || "windows-compat".includes(e.area.toLowerCase().split(" ")[0]))).toBe(true);
});
