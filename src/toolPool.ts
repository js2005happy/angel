// src/toolPool.ts — worker threads 工具并行池（第 4 阶段，方案 2.2）。
//
// 用途：把 CPU 密集的活（知识库 BM25 检索、大 JSON 解析）从主线程挪走，
// 多模型调研、群聊多 bot、后台任务并行时主循环不被 JSON 解析/BM25 拖住。
// I/O 密集的活（模型请求、MCP、工具调用）本来就是异步的，不进池。
//
// 自举模式：worker 从本模块自身派生（new Worker(new URL(import.meta.url))），
// 模块顶层按 isMainThread 分支——主线程只暴露 ToolPool，worker 线程只注册
// 任务处理。Bun --compile 产物内可工作（已实测：bun run 与编译后二进制
// 均通过；单独的 worker 文件不会被打进产物，不要拆文件）。
// 池是懒启动的：构造时不建 worker，第一次 run 才建，空闲 gateway 不为池付内存。
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { cpus } from "node:os";
import { randomBytes } from "node:crypto";

export function defaultPoolSize(): number {
  try {
    return Math.max(1, Math.min(4, cpus().length || 1));
  } catch {
    return 2;
  }
}

export type PoolJobKind = "ping" | "bm25" | "spin";

export interface PoolJobMessage {
  id: string;
  kind: PoolJobKind;
  payload: unknown;
}

export interface PoolResultMessage {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** BM25 任务入参：调用方先分词（tokenize 在主线程做，量小），worker 只算分。 */
export interface Bm25Payload {
  queryTokens: string[];
  docTokens: string[][];
  topK: number;
}

/**
 * spin 任务入参：worker 内确定性阻塞 ms 毫秒（Atomics.wait，不烧 CPU）。
 * 用途只有一个——让超时行为可测试：BM25 算得太快（10 万文档约 13ms），
 * 靠“工作量超过超时”赌超时根本不可靠；spin 让 worker 想卡多久卡多久。
 */
export interface SpinPayload {
  ms: number;
}

interface PendingJob {
  id: string;
  kind: PoolJobKind;
  payload: unknown;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  workerIndex: number;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  job: PendingJob | null;
  alive: boolean;
}

function newJobId(): string {
  return randomBytes(8).toString("hex");
}

export class ToolPool {
  readonly size: number;
  private slots: WorkerSlot[] = [];
  private queue: PendingJob[] = [];
  private closed = false;

  constructor(size: number = defaultPoolSize()) {
    this.size = Math.max(1, Math.floor(size) || 1);
  }

  get pending(): number {
    return this.queue.length + this.slots.filter((s) => s.busy).length;
  }

  get running(): number {
    return this.slots.filter((s) => s.alive).length;
  }

  run(kind: PoolJobKind, payload: unknown, timeoutMs = 30000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("工具池已关闭"));
    return new Promise((resolve, reject) => {
      const job: PendingJob = {
        id: newJobId(), kind, payload, resolve, reject, timer: null, workerIndex: -1,
      };
      job.timer = setTimeout(() => this.onJobTimeout(job), Math.max(100, timeoutMs));
      const slot = this.idleSlot();
      if (slot) this.dispatch(slot, job);
      else this.queue.push(job);
    });
  }

  private idleSlot(): WorkerSlot | null {
    this.pruneDead();
    for (const slot of this.slots) {
      if (slot.alive && !slot.busy) return slot;
    }
    if (this.slots.length < this.size) {
      const slot = this.spawnSlot();
      if (slot) return slot;
    }
    return null;
  }

  private spawnSlot(): WorkerSlot | null {
    let worker: Worker;
    try {
      worker = new Worker(new URL(import.meta.url));
    } catch (err: unknown) {
      throw new Error(`启动 worker 失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const slot: WorkerSlot = { worker, busy: false, job: null, alive: true };
    try {
      (worker as unknown as { unref?: () => void }).unref?.();
    } catch { /* 无 unref 也不影响 */ }
    worker.on("message", (msg: PoolResultMessage) => this.onMessage(slot, msg));
    worker.on("error", () => this.onWorkerDead(slot, new Error("worker 异常退出")));
    worker.on("exit", () => {
      if (slot.job) this.onWorkerDead(slot, new Error("worker 异常退出"));
      slot.alive = false;
    });
    this.slots.push(slot);
    return slot;
  }

  private dispatch(slot: WorkerSlot, job: PendingJob): void {
    slot.busy = true;
    slot.job = job;
    job.workerIndex = this.slots.indexOf(slot);
    slot.worker.postMessage({ id: job.id, kind: job.kind, payload: job.payload } satisfies PoolJobMessage);
  }

  private onMessage(slot: WorkerSlot, msg: PoolResultMessage): void {
    const job = slot.job;
    if (!job || msg.id !== job.id) return;
    slot.job = null;
    slot.busy = false;
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    if (msg.ok) job.resolve(msg.result);
    else job.reject(new Error(msg.error || "worker 任务失败"));
    this.pump();
  }

  private onJobTimeout(job: PendingJob): void {
    job.timer = null;
    const slot = this.slots[job.workerIndex];
    if (slot && slot.job === job) {
      slot.job = null;
      slot.busy = false;
      // 卡死的 worker 直接杀掉重建，不让它继续占一个槽位。
      void slot.worker.terminate().catch(() => undefined);
      slot.alive = false;
      this.pruneDead();
    } else {
      const qi = this.queue.indexOf(job);
      if (qi >= 0) this.queue.splice(qi, 1);
    }
    job.reject(new Error(`工具池任务超时（${job.kind}）`));
    this.pump();
  }

  private onWorkerDead(slot: WorkerSlot, err: Error): void {
    slot.alive = false;
    const job = slot.job;
    slot.job = null;
    slot.busy = false;
    if (job) {
      if (job.timer) { clearTimeout(job.timer); job.timer = null; }
      job.reject(err);
    }
    this.pruneDead();
    this.pump();
  }

  private pruneDead(): void {
    this.slots = this.slots.filter((s) => s.alive);
  }

  private pump(): void {
    if (this.closed) return;
    while (this.queue.length > 0) {
      const slot = this.idleSlot();
      if (!slot) return;
      const job = this.queue.shift()!;
      this.dispatch(slot, job);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      if (job.timer) clearTimeout(job.timer);
      job.reject(new Error("工具池已关闭"));
    }
    const terminating = this.slots.map((s) => {
      if (s.job) {
        if (s.job.timer) clearTimeout(s.job.timer);
        s.job.reject(new Error("工具池已关闭"));
        s.job = null;
      }
      return s.worker.terminate().catch(() => undefined);
    });
    this.slots = [];
    await Promise.all(terminating);
  }
}

// ---- worker 线程入口（只在 !isMainThread 时执行） ----
if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on("message", (msg: PoolJobMessage) => {
    void (async () => {
      try {
        if (msg.kind === "ping") {
          port.postMessage({ id: msg.id, ok: true, result: msg.payload } satisfies PoolResultMessage);
          return;
        }
        if (msg.kind === "bm25") {
          const { scoreBm25 } = await import("./knowledge.ts");
          const payload = msg.payload as Bm25Payload;
          const result = scoreBm25(payload.queryTokens, payload.docTokens, payload.topK);
          port.postMessage({ id: msg.id, ok: true, result } satisfies PoolResultMessage);
          return;
        }
        if (msg.kind === "spin") {
          const { ms } = msg.payload as SpinPayload;
          // 确定性阻塞 worker 线程：主线程的超时逻辑靠它验证。
          // Atomics.wait 只在 worker 线程可用，失败则退回忙等。
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0));
          } catch {
            const until = Date.now() + Math.max(0, ms | 0);
            while (Date.now() < until) { /* 忙等 */ }
          }
          port.postMessage({ id: msg.id, ok: true, result: { spunMs: ms } } satisfies PoolResultMessage);
          return;
        }
        port.postMessage({ id: msg.id, ok: false, error: `未知任务类型：${msg.kind}` } satisfies PoolResultMessage);
      } catch (err: unknown) {
        port.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies PoolResultMessage);
      }
    })();
  });
}
