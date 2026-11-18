// Bun API 兼容性探针 6：SQLite —— node:sqlite（Node 24 内置）在 Bun 下是否可用。
// 做法：与第 0 阶段 mini-agent 相同的负载：建表、事务内插 100 行、查计数。
// 影响：conversations.py（SQLite FTS5）与示例任务；若 node:sqlite 在 Bun 下
// 不可用，改用 bun:sqlite（API 不同：db.run / db.query / db.transaction），
// 两处调用点都要留分支，不能默认共用一份代码。
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dbPath = join(tmpdir(), "nyra-probe-sqlite.db");
if (existsSync(dbPath)) rmSync(dbPath);
const db = new DatabaseSync(dbPath);
db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
const insert = db.prepare("INSERT INTO notes (body) VALUES (?)");
const t0 = performance.now();
db.exec("BEGIN");
for (let i = 0; i < 100; i++) insert.run(`note ${i} — hello from probe`);
db.exec("COMMIT");
const row = db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number };
const ms = performance.now() - t0;
if (row.n !== 100) throw new Error("count 应为 100，实为 " + row.n);
db.close();
rmSync(dbPath);
console.log(`PASS sqlite: node:sqlite 在 Bun 下可用，100 行事务插入+计数 ${ms.toFixed(2)}ms`);
process.exit(0);
