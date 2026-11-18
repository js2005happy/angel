// src/workerBridge.ts — 过渡桥：Node host 通过 worker 协议 v1 调 Python worker。
// 协议见 nyra/worker_protocol.py：stdin JSONL 请求（run / approval_decision /
// stop / ping），stdout JSONL 事件（仅协议行），stderr 只做日志。
// 审批 fail-closed：decision 必须命名待决请求（id + approval_id），带
// decided_by: "human" 与布尔 approved；超时即拒绝，绝不批准。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const APPROVAL_TIMEOUT = 600.0;

export interface BridgeEvent {
  protocol_version: number;
  seq: number;
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface RunRequest {
  task: string;
  workdir?: string;
}

export interface BridgeOptions {
  python?: string;
  projectRoot?: string;
  sessionId?: string;
  workdir?: string;
  provider?: string;
  model?: string;
  mode?: string;
  maxTurns?: number;
  /** 收到 approval_request 时调用；返回 true=批准，false=拒绝。未提供则一律拒绝。 */
  onApproval?: (req: { id: string; approvalId: string; tool: string; summary: string }) => Promise<boolean> | boolean;
  onEvent?: (event: BridgeEvent) => void;
  onStderr?: (line: string) => void;
}

function newId(prefix = "req"): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

export class WorkerBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private buffer = "";
  private pending = new Map<string, { resolve: (e: BridgeEvent) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private runWaiters: { resolve: (e: BridgeEvent) => void; reject: (err: Error) => void }[] = [];
  private approvalWaiters = new Map<string, { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }>();
  private opts: BridgeOptions;
  private started = false;

  constructor(opts: BridgeOptions = {}) {
    this.opts = opts;
  }

  start(): void {
    if (this.started) return;
    const args = ["-m", "nyra.worker"];
    if (this.opts.sessionId) args.push("--session", this.opts.sessionId);
    if (this.opts.workdir) args.push("--workdir", this.opts.workdir);
    if (this.opts.provider) args.push("--provider", this.opts.provider);
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.mode) args.push("--mode", this.opts.mode);
    if (this.opts.maxTurns !== undefined) args.push("--max-turns", String(this.opts.maxTurns));
    const python = this.opts.python ?? "python3";
    this.child = spawn(python, args, {
      cwd: this.opts.projectRoot ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.started = true;
    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf-8");
    this.child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) this.opts.onStderr?.(line);
      }
    });
    this.child.on("exit", (code) => {
      const err = new Error(`Python worker 已退出（code ${code}）`);
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
      for (const w of this.runWaiters) w.reject(err);
      this.runWaiters = [];
      for (const [, w] of this.approvalWaiters) { clearTimeout(w.timer); w.resolve(false); }
      this.approvalWaiters.clear();
    });
  }

  private send(obj: Record<string, unknown>): string {
    if (!this.child || !this.child.stdin.writable) throw new Error("Python worker 未启动");
    const id = (obj.id as string) ?? newId();
    const line = JSON.stringify({ protocol_version: PROTOCOL_VERSION, ...obj, id });
    this.child.stdin.write(line + "\n");
    return id;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let event: BridgeEvent;
      try { event = JSON.parse(line) as BridgeEvent; } catch { continue; }
      if (event.protocol_version !== PROTOCOL_VERSION) continue;
      this.dispatch(event);
    }
  }

  private dispatch(event: BridgeEvent): void {
    this.opts.onEvent?.(event);
    if (event.type === "approval_request" && typeof event.id === "string") {
      const approvalId = event.approval_id as string;
      const timer = setTimeout(() => {
        this.approvalWaiters.delete(event.id!);
        // 超时即拒绝：不发 decision，worker 端到时自动拒绝。
        this.sendApprovalDecision(event.id!, approvalId, false);
      }, APPROVAL_TIMEOUT * 1000);
      this.approvalWaiters.set(event.id, {
        resolve: (approved: boolean) => {
          clearTimeout(timer);
          this.sendApprovalDecision(event.id!, approvalId, approved);
        },
        timer,
      });
      void (async () => {
        let approved = false;
        try {
          approved = this.opts.onApproval
            ? await this.opts.onApproval({
                id: event.id!, approvalId,
                tool: String(event.tool ?? ""), summary: String(event.summary ?? ""),
              })
            : false;
        } catch { approved = false; }
        const waiter = this.approvalWaiters.get(event.id!);
        if (waiter) { this.approvalWaiters.delete(event.id!); waiter.resolve(approved); }
      })();
      return;
    }
    if (event.type === "pong" && event.id) {
      const p = this.pending.get(event.id);
      if (p) { this.pending.delete(event.id); clearTimeout(p.timer); p.resolve(event); }
      return;
    }
    if (event.type === "run_completed" || event.type === "run_incomplete" || event.type === "run_failed") {
      const waiter = this.runWaiters.shift();
      if (waiter) waiter.resolve(event);
      return;
    }
    if (event.type === "error" && event.id) {
      const p = this.pending.get(event.id);
      if (p) { this.pending.delete(event.id); clearTimeout(p.timer); p.reject(new Error(String(event.error ?? "worker 错误"))); }
    }
  }

  private sendApprovalDecision(id: string, approvalId: string, approved: boolean): void {
    this.send({
      type: "approval_decision", id, approval_id: approvalId,
      decided_by: "human", approved,
    });
  }

  async ping(timeoutMs = 10000): Promise<BridgeEvent> {
    const id = newId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ping 超时"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: "ping", id });
    });
  }

  /** 一次只跑一个 run：须等 terminal 事件（run_completed / run_incomplete / run_failed）再发下一个。 */
  async run(req: RunRequest): Promise<BridgeEvent> {
    const id = newId("run");
    const promise = new Promise<BridgeEvent>((resolve, reject) => {
      this.runWaiters.push({ resolve, reject });
    });
    this.send({ type: "run", id, task: req.task, ...(req.workdir ? { workdir: req.workdir } : {}) });
    return promise;
  }

  stop(): void {
    try { this.send({ type: "stop", id: newId() }); } catch { /* ignore */ }
  }

  close(): void {
    this.stop();
    try { this.child?.stdin.end(); } catch { /* ignore */ }
    try { this.child?.kill("SIGTERM"); } catch { /* ignore */ }
    this.child = null;
    this.started = false;
  }
}

/** 桥覆盖清单（第 3 阶段结束时的状态；随移植进度缩小）。
 * 第 3 阶段原生化：webui / server（gateway）、mcp（含成本上限）、
 * pairing、memory-browser、artifacts。仍走桥的区见下表，原因与第 4 阶段计划。 */
export const BRIDGE_COVERAGE: { area: string; reason: string }[] = [
  { area: "computer（截屏/点击/输入/按键/列窗口）+ vision 看屏接线", reason: "第 4 阶段；三后端（scrot/imports/Win32）需真机验证，仍走 worker；vision 接线随 computer 走" },
  { area: "groups（群聊多 Key）", reason: "第 4 阶段；Bot.api_keys 轮换与群聊多 bot 并行仍走 worker；gateway 的群聊 API 现报 501（桥），不假装可用" },
  { area: "poppy（Poppy 客户端、按站权限账本、UCP 购物）", reason: "第 4 阶段；schema 已在 Node tools.ts 声明，执行走 worker；UCP 购物涉支付，须单独验收" },
  { area: "eigenflux（入网/策略）", reason: "第 4 阶段；入网须用户前台逐项确认，仍走 worker" },
  { area: "install / packaging / systemd / launchd / mobile PWA", reason: "第 4 阶段打包；安装脚本与部署仍以 Python 版为准；PWA 壳已原生（/m + manifest），真机安装待验证" },
  { area: "tui / trust / webui-v2 / docs-site", reason: "第 3–4 阶段；TUI 终端交互与 trust 台账未列入第 3 阶段移植范围；webui-v2 评审面板与计划模式已随 gateway 落地（审批 always 授权、计划模式），剩余 trust 台账第 4 阶段" },
  { area: "windows-compat（Windows 兼容守卫）", reason: "第 4 阶段；需 Windows 真机验证，Node 版暂不原生断言" },
];
