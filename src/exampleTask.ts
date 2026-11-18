// src/exampleTask.ts — 本地示例任务（不调模型、不联网、不花钱）。
// 与第 0 阶段 mini-agent 同样的三件事：读 config 子集、读一个文件并打印
// 前 200 字、SQLite 建表插 100 行查计数。向导第三步与 `nyra --example` 共用。
// SQLite 用 node:sqlite（探针已验证在 Bun 下可用；Node 24 下同样可用）。
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, openSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";

/** 只读文件开头的 4096 字节再取前 200 字：预览本来就只要 200 字，
 * 以前是整文件读进内存，大文件会吃光内存。200 个字符最多 800 字节，
 * 4096 字节一定装得下前 200 字（除非文件本身更短）。 */
export function readPreview(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf-8").slice(0, 200);
  } finally {
    closeSync(fd);
  }
}

export interface ExampleTaskResult {
  provider: string;
  model: string;
  file: string;
  preview: string;
  rows: number;
  sqliteMs: number;
  totalMs: number;
}

export function runExampleTask(opts: {
  home: string;
  provider: string;
  model: string;
  file: string;
}): ExampleTaskResult {
  const t0 = performance.now();
  const preview = readPreview(opts.file);
  console.log(`provider=${opts.provider} model=${opts.model}`);
  console.log(`--- ${opts.file} 的前 200 字 ---`);
  console.log(preview);
  console.log("---");

  // SQLite：库放在配置目录里（不污染工作目录），每次重建。
  const dbPath = join(opts.home, "example-task.db");
  if (existsSync(dbPath)) rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    const insert = db.prepare("INSERT INTO notes (body) VALUES (?)");
    const tSql0 = performance.now();
    // 批量写必须包进事务，否则每次插入一次 fsync，会慢两个数量级（第 0 阶段实测）。
    db.exec("BEGIN");
    for (let i = 0; i < 100; i++) insert.run(`note ${i} — hello from nyra example task`);
    db.exec("COMMIT");
    const row = db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number };
    const sqliteMs = performance.now() - tSql0;
    console.log(`sqlite rows=${row.n} insert+query ms=${sqliteMs.toFixed(2)}`);
    const totalMs = performance.now() - t0;
    console.log(`示例任务完成，用时 ${totalMs.toFixed(0)}ms（本地任务，未调模型、未花钱）。`);
    return { provider: opts.provider, model: opts.model, file: opts.file, preview, rows: row.n, sqliteMs, totalMs };
  } finally {
    db.close();
  }
}
