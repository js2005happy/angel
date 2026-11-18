// src/pairing/index.ts — 配对码协作（第 3 阶段已原生化，见 ../pairing.ts）。
// wire 兼容：6 位数字码、5 分钟有效、一次性、错 5 次作废；
// 设备 token 只存 SHA-256；UDP 47831 发现。
export { DeviceRegistry, PairingError, generateCode, hashDeviceToken, defaultDevicesPath, startDiscoveryResponder, DISCOVERY_PORT, DISCOVERY_MAGIC, CODE_TTL_SECONDS, MAX_FAILED_ATTEMPTS } from "../pairing.ts";
