// src/mailInbox.ts — 邮件即任务入口（缺口 22）：收件即任务，邮件收结果。
//
// 与缺口 7（事件触发）的区别：缺口 7 要用户先配好触发器模板，事件只是
// 填进模板的变量；缺口 22 里邮件本身就是任务——白名单发件人发来的邮件，
// 主题 + 正文直接变成任务内容进队列，跑完把结果回信发回去。
// 别家（Manus Mail / Genspark Claw / Comet Max）只靠白名单；Nyra 是
// 白名单 + 审批双保险：非白名单发件人不触发；进队列的任务仍按现有审批
// 规则跑（auto 非交互时写操作照常挂起等审批，不自动放行），成本上限、
// 白名单/沙箱全部继承。
//
// 权限边界：
// - 整个入口默认关闭（enabled: false），显式启用 + 加白名单才是 opt-in；
// - 只允许 readonly / auto，`full` 在设置层就拒绝（addTask 再拦一次）；
// - 邮件正文是不可信外部数据：进任务提示词前包 wrapUntrusted，正文里
// 的指令性文字一律不执行；发件人只认白名单里的邮箱地址；
// - 回信只回给白名单发件人、只回原线程（threadId），一次任务最多回一封
// （replied 标志）；Gmail 未授权时不回信、不报错打断任务，只记 stderr；
// - 首轮轮询只建基线不派发，否则首次启用会把收件箱旧邮件全派一遍。
// 可审计：每封入队邮件在新任务的 events.jsonl 记一条 `mail_task_enqueued`
// （邮件 id、线程、发件人、主题、run_id、模式）；入队与回信的对应关系
// 在 ~/.nyra/mail-inbox-runs.json（最近 1000 条）。
import { randomBytes } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync,
  openSync, readFileSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { dirname, join} from "node:path";
import { addTask, TASKS_DIR, nyraHome} from "./tasks.ts";
import { RunStore} from "./runs.ts";
import { wrapUntrusted} from "./untrusted.ts";
import { GMAIL_POLL_INTERVAL_SECONDS} from "./eventTriggers.ts";
import type { GmailMessage, GmailTransport} from "./connectors/gmail.ts";

export class MailInboxError extends Error {
  constructor(message: string) { super(message); this.name = "MailInboxError";}
}

export const MAIL_INBOX_FILE = "mail-inbox.json";
export const MAIL_INBOX_RUNS_FILE = "mail-inbox-runs.json";
export const MAIL_INBOX_POLL_STATE_FILE = join("event-sources", "mail-inbox.json");
/** 任务提示词上限 8000 字（addTask 的 MAX_TASK_CHARS）：留 200 字给头部。 */
const MAX_TASK_TOTAL_CHARS = 7800;
const RUNS_KEEP = 1000;
const SEEN_KEEP = 500;
const MAX_REPLY_CHARS = 2000;

export interface MailInboxSettings {
  enabled: boolean;
  allowlist: string[];
  reply_results: boolean;
  mode: "readonly" | "auto";
  max_body_chars: number;
}

export function defaultMailInboxSettings(): MailInboxSettings {
  return { enabled: false, allowlist: [], reply_results: true, mode: "auto", max_body_chars: 4000};
}

export function mailInboxPath(home?: string): string {
  return join(nyraHome(home), MAIL_INBOX_FILE);
}

export function mailInboxRunsPath(home?: string): string {
  return join(nyraHome(home), MAIL_INBOX_RUNS_FILE);
}

export function mailInboxPollStatePath(home?: string): string {
  return join(nyraHome(home), MAIL_INBOX_POLL_STATE_FILE);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 发件人头里抠邮箱地址："张三 <a@b.com>" → a@b.com；裸地址原样返回；一律小写。 */
export function extractEmailAddress(from: string): string {
  const m = /<([^<>@\s]+@[^<>@\s]+)>/.exec(from);
  const addr = (m? m[1]: from).trim().toLowerCase();
  return addr;
}

export function validateMailInboxSettings(raw: Record<string, unknown>): MailInboxSettings {
  const out = defaultMailInboxSettings();
  if (raw.enabled!== undefined) {
    if (typeof raw.enabled!== "boolean") throw new MailInboxError("mail-inbox 的 enabled 必须是布尔值");
    out.enabled = raw.enabled;
  }
  if (raw.allowlist!== undefined) {
    if (!Array.isArray(raw.allowlist)) throw new MailInboxError("mail-inbox 的 allowlist 必须是邮箱数组");
    const seen = new Set<string>();
    for (const item of raw.allowlist) {
      if (typeof item!== "string") throw new MailInboxError("mail-inbox 的 allowlist 里只能是邮箱字符串");
      const addr = item.trim().toLowerCase();
      if (!EMAIL_RE.test(addr)) throw new MailInboxError(`白名单邮箱无效：${item}`);
      seen.add(addr);
    }
    out.allowlist = [...seen];
  }
  if (raw.reply_results!== undefined) {
    if (typeof raw.reply_results!== "boolean") throw new MailInboxError("mail-inbox 的 reply_results 必须是布尔值");
    out.reply_results = raw.reply_results;
  }
  if (raw.mode!== undefined) {
    if (raw.mode!== "readonly" && raw.mode!== "auto") throw new MailInboxError("mail-inbox 只允许 readonly 或 auto（full 拒绝，与任务队列同规则）");
    out.mode = raw.mode;
  }
  if (raw.max_body_chars!== undefined) {
    if (typeof raw.max_body_chars!== "number" ||!Number.isInteger(raw.max_body_chars) || raw.max_body_chars < 100 || raw.max_body_chars > 7000) {
      throw new MailInboxError("mail-inbox 的 max_body_chars 必须是 100–7000 的整数");
    }
    out.max_body_chars = raw.max_body_chars;
  }
  return out;
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */}
}

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true});
  const tmp = join(dirname(path), `.${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(data, null, 2), null, "utf-8");
    fsyncSync(fd);
  } finally { closeSync(fd);}
  try { renameSync(tmp, path);} catch (err) { try { rmSync(tmp, { force: true});} catch { /* ignore */} throw err;}
}

export function loadMailInboxSettings(home?: string): MailInboxSettings {
  const p = mailInboxPath(home);
  if (!existsSync(p)) return defaultMailInboxSettings();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    backupCorrupt(p);
    throw new MailInboxError("邮件入口设置文件损坏，已备份，请检查后重新设置");
  }
  if (!raw || typeof raw!== "object" || Array.isArray(raw)) {
    backupCorrupt(p);
    throw new MailInboxError("邮件入口设置文件格式无效，已备份");
  }
  return validateMailInboxSettings(raw as Record<string, unknown>);
}

export function saveMailInboxSettings(settings: MailInboxSettings, home?: string): string {
  const p = mailInboxPath(home);
  atomicWriteJson(p, settings);
  return p;
}

export function addMailInboxSender(settings: MailInboxSettings, email: string): boolean {
  const addr = email.trim().toLowerCase();
  if (!EMAIL_RE.test(addr)) throw new MailInboxError(`白名单邮箱无效：${email}`);
  if (settings.allowlist.includes(addr)) return false;
  settings.allowlist.push(addr);
  return true;
}

export function removeMailInboxSender(settings: MailInboxSettings, email: string): boolean {
  const addr = email.trim().toLowerCase();
  const idx = settings.allowlist.indexOf(addr);
  if (idx < 0) return false;
  settings.allowlist.splice(idx, 1);
  return true;
}

// ---- 入队 ↔ 回信的对应账本 ----

export interface MailInboxRun {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  runId: string;
  at: string;
  replied: boolean;
}

export function loadMailInboxRuns(home: string): MailInboxRun[] {
  const p = mailInboxRunsPath(home);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as { runs?: unknown};
    if (!raw ||!Array.isArray(raw.runs)) return [];
    return (raw.runs as MailInboxRun[]).filter(
      (r) => r && typeof r.messageId === "string" && typeof r.threadId === "string"
      && typeof r.from === "string" && typeof r.runId === "string",
    );
  } catch {
    // 账本只是入队↔回信的对应关系，不是安全控制：损坏就备份后从空开始，
    // 已入队的任务不受影响（seenIds 仍防重复入队），不拦轮询。
    backupCorrupt(p);
    return [];
  }
}

export function saveMailInboxRuns(home: string, runs: MailInboxRun[]): void {
  atomicWriteJson(mailInboxRunsPath(home), { runs: runs.slice(-RUNS_KEEP)});
}

export function listMailInboxPublic(home?: string): {
  enabled: boolean; allowlist: string[]; reply_results: boolean; mode: string; pending_replies: number;
} {
  const h = home?? nyraHome();
  const settings = loadMailInboxSettings(h);
  const pending = loadMailInboxRuns(h).filter((r) =>!r.replied).length;
  return {
    enabled: settings.enabled,
    allowlist: [...settings.allowlist],
    reply_results: settings.reply_results,
    mode: settings.mode,
    pending_replies: pending,
  };
}

// ---- 任务内容：邮件本身就是任务 ----

/**
* 把一封邮件拼成任务提示词。头部是元数据（发件人/主题/日期/线程 id，
* 供 agent 必要时用 gmail 工具在原线程里追问）；正文是不可信外部数据，
* 包 wrapUntrusted 再交给模型，正文里的指令性文字不直接执行。
* 总长度卡在 7800 字以内（addTask 上限 8000）。
*/
export function buildMailTask(mail: GmailMessage, maxBodyChars = 4000): string {
  const header = [
    "以下任务来自一封邮件，发件人已在白名单内。",
    `发件人：${mail.from}`,
    `主题：${mail.subject}`,
    `日期：${mail.date}`,
    `线程：${mail.threadId}`,
    "",
  ].join("\n");
  const budget = Math.max(100, Math.min(maxBodyChars, MAX_TASK_TOTAL_CHARS - header.length - 200));
  const body = (mail.bodyText?? "").slice(0, budget);
  const wrapped = wrapUntrusted(body, "mail-inbox");
  const out = `${header}${wrapped}`;
  return out.length > MAX_TASK_TOTAL_CHARS? out.slice(0, MAX_TASK_TOTAL_CHARS): out;
}

// ---- 轮询：新邮件 → 白名单 → 入队 ----

export interface MailInboxPollState {
  lastPollAt: string | null;
  seenIds: string[];
}

export interface MailInboxPollResult {
  checked: number;
  newMail: number;
  enqueued: number;
  skippedNotAllowlisted: number;
  errors: number;
  skipped: string | null;
}

export function loadMailInboxPollState(home: string): MailInboxPollState {
  const p = mailInboxPollStatePath(home);
  if (!existsSync(p)) return { lastPollAt: null, seenIds: []};
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<MailInboxPollState>;
    return {
      lastPollAt: typeof raw.lastPollAt === "string"? raw.lastPollAt: null,
      seenIds: Array.isArray(raw.seenIds)? raw.seenIds.filter((x): x is string => typeof x === "string"): [],
    };
  } catch {
    backupCorrupt(p);
    return { lastPollAt: null, seenIds: []};
  }
}

export function saveMailInboxPollState(home: string, state: MailInboxPollState): void {
  atomicWriteJson(mailInboxPollStatePath(home), state);
}

function gmailAfterDate(d: Date): string {
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
* 轮询一次 Gmail 收件箱，白名单发件人的新邮件直接进任务队列。
* 首轮只建基线（把当前收件箱记为已见，不派发）；未到轮询间隔直接返回
* not-due（守护进程每轮都调，但不频繁打 API）；CLI `--once` 用 force。
* 单封邮件读失败只记 errors，不破坏整轮轮询。
*/
export async function pollMailInbox(
  transport: GmailTransport,
  opts: { home: string; now?: Date; force?: boolean},
): Promise<MailInboxPollResult> {
  const home = opts.home;
  const now = opts.now?? new Date();
  const settings = loadMailInboxSettings(home);
  if (!settings.enabled) return { checked: 0, newMail: 0, enqueued: 0, skippedNotAllowlisted: 0, errors: 0, skipped: "disabled"};
  if (!settings.allowlist.length) return { checked: 0, newMail: 0, enqueued: 0, skippedNotAllowlisted: 0, errors: 0, skipped: "no-allowlist"};
  const allowlist = new Set(settings.allowlist);
  const state = loadMailInboxPollState(home);
  if (!opts.force && state.lastPollAt) {
    const last = Date.parse(state.lastPollAt);
    if (!Number.isNaN(last) && now.getTime() - last < GMAIL_POLL_INTERVAL_SECONDS * 1000) {
      return { checked: 0, newMail: 0, enqueued: 0, skippedNotAllowlisted: 0, errors: 0, skipped: "not-due"};
    }
  }
  const base = state.lastPollAt? new Date(Date.parse(state.lastPollAt) - 86_400_000): now;
  const { messages} = await transport.search(`in:inbox after:${gmailAfterDate(base)}`, 25);
  const seen = new Set(state.seenIds);
  const unseen = messages.filter((m) =>!seen.has(m.id));
  if (state.lastPollAt === null) {
    // 首轮建基线：不派发，只记已见。
    saveMailInboxPollState(home, {
        lastPollAt: now.toISOString(),
        seenIds: [...new Set([...state.seenIds,...messages.map((m) => m.id)])].slice(-SEEN_KEEP),
      });
    return { checked: messages.length, newMail: unseen.length, enqueued: 0, skippedNotAllowlisted: 0, errors: 0, skipped: "first-run-baseline"};
  }
  const runs = loadMailInboxRuns(home);
  const store = new RunStore(join(nyraHome(home), TASKS_DIR));
  let enqueued = 0;
  let skippedNotAllowlisted = 0;
  let errors = 0;
  let runsChanged = false;
  for (const m of unseen) {
    if (runs.some((r) => r.messageId === m.id)) continue;
    const sender = extractEmailAddress(m.from);
    if (!allowlist.has(sender)) {
      skippedNotAllowlisted += 1;
      continue;
    }
    let full: GmailMessage;
    try {
      full = await transport.get(m.id);
    } catch (err: unknown) {
      errors += 1;
      process.stderr.write(`邮件入口：读邮件 ${m.id} 失败，已跳过：${err instanceof Error? err.message: String(err)}\n`);
      continue;
    }
    const prompt = buildMailTask(full, settings.max_body_chars);
    const taskState = addTask(prompt, {
        workdir: process.cwd(),
        mode: settings.mode,
        home,
      });
    store.appendEvent(taskState.run_id, "mail_task_enqueued", {
        message_id: m.id,
        thread_id: m.threadId,
        from: sender,
        subject: m.subject.slice(0, 200),
        run_id: taskState.run_id,
        mode: settings.mode,
      });
    runs.push({
        messageId: m.id, threadId: m.threadId, from: sender,
        subject: m.subject, runId: taskState.run_id,
        at: now.toISOString(), replied: false,
      });
    runsChanged = true;
    enqueued += 1;
  }
  if (runsChanged) {
    try { saveMailInboxRuns(home, runs);} catch (err: unknown) {
      process.stderr.write(`邮件入口：入队账本保存失败：${err instanceof Error? err.message: String(err)}\n`);
    }
  }
  saveMailInboxPollState(home, {
      lastPollAt: now.toISOString(),
      seenIds: [...new Set([...state.seenIds,...messages.map((m) => m.id)])].slice(-SEEN_KEEP),
    });
  return { checked: messages.length, newMail: unseen.length, enqueued, skippedNotAllowlisted, errors, skipped: null};
}

// ---- 回信：任务跑完把结果寄回原线程 ----

export interface MailReplyResult {
  replied: boolean;
  reason: string | null;
  messageId?: string;
}

/**
* 任务跑完后回信（由 tasks.ts 的 runOne / approveTask 在任务终态时调用）。
* 只回给白名单发件人、只回原线程、一次任务最多回一封；reply_results 关了、
* 账本里没这条任务、已经回过，都直接跳过。Gmail 未授权或发送失败时不抛错
* （不破坏任务结果），只记 stderr、replied 保持 false。
* transport 可注入（测试用 stub）；不传时现场建一个（需 Gmail 已启用+已授权）。
*/
export async function replyMailResultForRun(
  runId: string,
  status: string,
  output: string,
  opts: { home?: string; transport?: GmailTransport},
): Promise<MailReplyResult> {
  const home = opts.home ?? nyraHome();
  const settings = loadMailInboxSettings(home);
  const runs = loadMailInboxRuns(home);
  const record = runs.find((r) => r.runId === runId);
  if (!record) return { replied: false, reason: "not-a-mail-task"};
  if (record.replied) return { replied: false, reason: "already-replied"};
  if (!settings.enabled ||!settings.reply_results) return { replied: false, reason: "reply-disabled"};
  let transport = opts.transport;
  if (!transport) {
    try {
      const { createGmailTransport} = await import("./connectors/gmail.ts");
      const { loadConfig} = await import("./config.ts");
      transport = createGmailTransport(home, loadConfig(home));
    } catch (err: unknown) {
      process.stderr.write(`邮件入口：回信失败（Gmail 未就绪）：${err instanceof Error? err.message: String(err)}\n`);
      return { replied: false, reason: "gmail-not-ready"};
    }
  }
  const body = [
    `状态：${status}`,
    `原邮件主题：${record.subject}`,
    `任务：${runId}`,
    "",
    (output?? "").slice(0, MAX_REPLY_CHARS),
    "",
    "—— 本邮件由 Nyra 自动回复，详情请用 nyra task show 查看该任务。",
  ].join("\n");
  try {
    const sent = await transport.send({
        to: [record.from],
        subject: `Re: ${record.subject}`,
        body,
        threadId: record.threadId,
      });
    record.replied = true;
    try { saveMailInboxRuns(home, runs);} catch (err: unknown) {
      process.stderr.write(`邮件入口：回信账本保存失败：${err instanceof Error? err.message: String(err)}\n`);
    }
    return { replied: true, reason: null, messageId: sent.id};
  } catch (err: unknown) {
    process.stderr.write(`邮件入口：回信发送失败：${err instanceof Error? err.message: String(err)}\n`);
    return { replied: false, reason: "send-failed"};
  }
}
