// Bun API 兼容性探针 5：加密 crypto —— PBKDF2-HMAC-SHA256 200,000 次 + AES-256-CTR。
// 做法：与 Python vault.py 同参数派生密钥（salt 固定、密码固定），
// 与 Python 端已知向量比对前 16 字节 hex；再用 AES-256-CTR 加解密往返。
// 影响：vault.py（PBKDF2 200,000 次 + HMAC-CTR）字节级兼容的前提；
// 若 Bun 下 pbkdf2 结果与 Python 不一致，旧 vault.json 读不了，第 2 阶段须改方案。
// 已知向量（与 Python 同参数实测一致）：
// python3 -c "import hashlib; print(hashlib.pbkdf2_hmac('sha256', b'probe-password', bytes(16), 200000, dklen=32).hex())"
// -> d8583695f8fa36bb15ac533e5d71fc4f7d1173516247529db6d82b4903b49773
import { pbkdf2Sync, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const EXPECTED_HEX = "d8583695f8fa36bb15ac533e5d71fc4f7d1173516247529db6d82b4903b49773";
const t0 = performance.now();
const key = pbkdf2Sync("probe-password", Buffer.alloc(16, 0), 200_000, 32, "sha256");
const ms = performance.now() - t0;
if (key.toString("hex") !== EXPECTED_HEX) {
  throw new Error(`PBKDF2 与 Python 向量不一致：Bun=${key.toString("hex")} Python=${EXPECTED_HEX}`);
}
console.log(`pbkdf2 200k 次耗时 ${ms.toFixed(0)}ms，与 Python 向量逐字节一致`);

// AES-256-CTR 加解密往返（vault 的 HMAC-CTR 结构在第 2 阶段按 vault.py 逐字节复刻；
// 这里只验证 CTR 模式本身在 Bun 下可用）
const iv = randomBytes(16);
const plain = Buffer.from("nyra-vault-probe-你好", "utf-8");
const enc = createCipheriv("aes-256-ctr", key, iv);
const cipher = Buffer.concat([enc.update(plain), enc.final()]);
const dec = createDecipheriv("aes-256-ctr", key, iv);
const back = Buffer.concat([dec.update(cipher), dec.final()]);
if (!back.equals(plain)) throw new Error("AES-256-CTR 往返不一致");
console.log("PASS crypto: pbkdf2-sha256 200k 次可用，AES-256-CTR 加解密往返 OK");
process.exit(0);
