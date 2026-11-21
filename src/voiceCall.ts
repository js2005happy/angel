// src/voiceCall.ts — 缺口 36：实时语音通话通道（§4.3 第一批，扩展缺口 15）。
//
// 做的是“语音通话的最小闭环”，不是真打电话：
//   - 通话状态机（建立 / 接听 / 拒绝 / 挂断）+ 账本落盘；
//   - 通话中一段一段喂音频：VAD 门控（静音段不转写、不花钱）→ 转写
//     （本地 whisper.cpp 优先；云端只在用户显式配了 call_cloud_enabled
//     才走，且过月度硬顶）→ 转写文本交给调用方处理；
//   - agent 的回读文字可合成语音读出来（云端 TTS，同样过硬顶）；
//   - 语音不碰支付与对外发送：转写文本命中支付/外发意图时该段被扣下，
//     须回文字确认（confirm），确认只记“含义已确认”，不执行动作——
//     要执行请把文字当普通任务跑。
//
// 诚实边界（本批没做的，别当成已做）：
//   - 没有真 WebRTC 媒体栈：传输层是本机回环（loopback），不拨真实电话、
//     不走 TURN/SFU；实时流式传输（WebRTC + TURN）是下一批，传输接口
//     VoiceCallTransport 已留好，到时接真实现；
//   - 转写原文不落盘：账本与审计只记时长、字数、引擎、花费与文本指纹，
//     原文只在喂段落时打印一次，确认时凭段落 id 与指纹核对；
//   - VAD 只对 WAV 做真能量检测，其他格式跳过（不假装都测了）；
//   - 真 STT/TTS 未在真 API 上跑通，只在假服务上验过。
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { RunStore } from "./runs.ts";
import { UsageLedger, monthKeyString } from "./usageLedger.ts";
import { checkMonthlyCap, resolveMonthlyLimit } from "./cost.ts";
import { loadConfig, resolveProvider } from "./config.ts";
import { Provider } from "./providers.ts";
import {
  estimateSttCostUsd, estimateTtsCostUsd, httpEndpointOf, loadAudioFile,
  localSttAvailable, playAudioFile, resolveVoiceConfig, shortTextHash, synthesizeSpeech,
  transcribeCloud, transcribeLocal,
  type CommandRunner, type HttpEndpoint, type VoiceConfig,
} from "./voice.ts";
import type { UsageSnapshot } from "./usage.ts";

export class VoiceCallError extends Error {}

/** 默认命令执行器（与 voice.ts 的 defaultRunner 同款：spawnSync + 300 秒超时）。 */
function defaultCommandRunner(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 300_000 });
    if (r.error) return { status: null, stdout: "", stderr: String((r.error as Error).message ?? r.error) };
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (err: unknown) {
    return { status: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** 缺口 36：通话的配置（config.json 的 voice 一节，未配用默认值）。 */
export interface VoiceCallConfig {
  /** 单通电话最长（分钟），默认 120；超时不自动挂断，只拒绝再喂段落。 */
  maxCallMinutes: number;
  /** 单通电话最多段落数，默认 200。 */
  maxSegments: number;
  /** 通话里是否允许走云端 STT/TTS，默认关（显式 opt-in；缺口 15 的 --voice 默认云端兜底，本批通话通道更严）。 */
  callCloudEnabled: boolean;
  /** VAD 判定“有人说话”的最低有声帧比例，默认 0.15。 */
  vadMinSpeechRatio: number;
  /** 单次回读最多字数，默认 2000；超长截断（不读全文）。 */
  replyMaxChars: number;
}

export const DEFAULT_VOICE_CALL_CONFIG: VoiceCallConfig = {
  maxCallMinutes: 120,
  maxSegments: 200,
  callCloudEnabled: false,
  vadMinSpeechRatio: 0.15,
  replyMaxChars: 2000,
};

/** 通话配置解析：非法值回退默认值，不抛错、不挡运行。 */
export function resolveVoiceCallConfig(config: Record<string, unknown>): VoiceCallConfig {
  const raw = config.voice;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (key: string, min: number, max: number, fallback: number): number => {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return fallback;
    return v;
  };
  return {
    maxCallMinutes: num("call_max_minutes", 1, 1440, DEFAULT_VOICE_CALL_CONFIG.maxCallMinutes),
    maxSegments: num("call_max_segments", 1, 1000, DEFAULT_VOICE_CALL_CONFIG.maxSegments),
    callCloudEnabled: o.call_cloud_enabled === true,
    vadMinSpeechRatio: num("call_vad_min_speech_ratio", 0.01, 0.9, DEFAULT_VOICE_CALL_CONFIG.vadMinSpeechRatio),
    replyMaxChars: num("call_reply_max_chars", 100, 10000, DEFAULT_VOICE_CALL_CONFIG.replyMaxChars),
  };
}

// ---- 敏感意图：语音不碰支付与对外发送（确定性关键词判定） ----

const PAYMENT_WORDS = ["支付", "付款", "付钱", "转账", "转钱", "汇款", "发红包", "充值", "下单", "购买", "买单", "结账"];
const PAYMENT_EN = ["pay", "payment", "transfer", "remit", "checkout", "purchase"];
const SEND_WORDS = ["发消息", "发送消息", "发邮件", "发短信", "发给", "发到", "通知他", "通知她", "通知他们"];
const SEND_EN = ["send", "email", "message", "notify"];

/**
 * 转写文本里的敏感意图（确定性判定，只认关键词）：
 * payment = 付钱类；external_send = 对外发消息类；null = 都没命中。
 * 宁可误判不可漏判：命中只是扣下等文字确认，不是拒绝执行。
 */
export function detectSensitiveIntent(text: string): "payment" | "external_send" | null {
  for (const w of PAYMENT_WORDS) if (text.includes(w)) return "payment";
  for (const w of SEND_WORDS) if (text.includes(w)) return "external_send";
  const words = new Set(text.toLowerCase().split(/[^a-z]+/).filter(Boolean));
  for (const w of PAYMENT_EN) if (words.has(w)) return "payment";
  for (const w of SEND_EN) if (words.has(w)) return "external_send";
  return null;
}

// ---- VAD：WAV 能量检测（20ms 帧，RMS 门限） ----

export interface VadResult {
  /** 有声帧占比（0–1）；没解析出 PCM 时为 null。 */
  ratio: number | null;
  /** 帧数；没解析出 PCM 时为 0。 */
  frames: number;
  /** 是否解析出了 PCM。没解析出时按“有人说话”处理（不丢用户语音）。 */
  parsed: boolean;
  /** 是否判定为有人说话。 */
  speech: boolean;
}

/** 解析 WAV 的 PCM 采样（只认 RIFF/WAVE + fmt/data 块；8/16 位 PCM，立体声取均值）。 */
function parseWavPcm(bytes: Buffer): { samples: number[]; sampleRate: number } | null {
  if (bytes.length < 44) return null;
  if (bytes.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  if (bytes.subarray(8, 12).toString("ascii") !== "WAVE") return null;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = bytes.subarray(off, off + 4).toString("ascii");
    const size = bytes.readUInt32LE(off + 4);
    const start = off + 8;
    if (start + size > bytes.length) return null;
    if (id === "fmt " && size >= 16) {
      fmt = {
        audioFormat: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        bits: bytes.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = bytes.subarray(start, start + size);
    }
    off = start + size + (size % 2);
  }
  if (!fmt || !data) return null;
  if (fmt.audioFormat !== 1) return null; // 只认 PCM
  if (fmt.channels < 1 || fmt.sampleRate <= 0) return null;
  const bytesPerSample = fmt.bits === 16 ? 2 : fmt.bits === 8 ? 1 : 0;
  if (bytesPerSample === 0) return null;
  const frameBytes = bytesPerSample * fmt.channels;
  const count = Math.floor(data.length / frameBytes);
  if (count === 0) return null;
  const samples: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    let v = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const p = i * frameBytes + c * bytesPerSample;
      v += fmt.bits === 16 ? data.readInt16LE(p) / 32768 : (data[p] - 128) / 128;
    }
    samples[i] = v / fmt.channels;
  }
  return { samples, sampleRate: fmt.sampleRate };
}

/**
 * WAV 能量门控：20ms 一帧算 RMS，RMS ≥ 0.02 的帧算有声；有声帧占比
 * ≥ minRatio 判定为有人说话。解析失败返回 parsed=false、speech=true
 *（VAD 只是省钱优化，不是安全门；解析失败不丢语音）。
 */
export function vadGateWav(bytes: Buffer, minRatio = DEFAULT_VOICE_CALL_CONFIG.vadMinSpeechRatio): VadResult {
  const pcm = parseWavPcm(bytes);
  if (!pcm) return { ratio: null, frames: 0, parsed: false, speech: true };
  const perFrame = Math.max(1, Math.round(pcm.sampleRate * 0.02));
  const frames = Math.floor(pcm.samples.length / perFrame);
  if (frames === 0) return { ratio: 0, frames: 0, parsed: true, speech: false };
  let speechFrames = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < perFrame; i++) {
      const s = pcm.samples[f * perFrame + i];
      sum += s * s;
    }
    if (Math.sqrt(sum / perFrame) >= 0.02) speechFrames++;
  }
  const ratio = speechFrames / frames;
  return { ratio, frames, parsed: true, speech: ratio >= minRatio };
}

// ---- 传输层接口（本批只有本机回环；WebRTC + TURN 实现下一批接这里） ----

/**
 * 实时媒体传输接口：start/stop 只管媒体通道的开关，不管转写与任务。
 * 本批的实现是 LoopbackTransport（空操作：音频靠喂文件段落进来，不走网络）。
 * 下一批接真 WebRTC 时：实现这个接口、在 startVoiceCall 里按配置选实现，
 * 其余代码（账本、VAD、转写、扣下、回读）不用动。
 */
export interface VoiceCallTransport {
  kind: "loopback" | "webrtc";
  start(callId: string): void;
  stop(callId: string): void;
}

export const LoopbackTransport: VoiceCallTransport = {
  kind: "loopback",
  start(_callId: string): void {},
  stop(_callId: string): void {},
};

// ---- 通话账本与审计 ----

export type VoiceCallStatus = "ringing" | "active" | "ended" | "declined";
export type VoiceCallSegmentStatus = "transcribed" | "held" | "confirmed" | "skipped_silence";
export type VoiceCallVad = "speech" | "silence" | "skipped";

/** 通话里的一段语音（只记元数据与指纹，不记转写原文、不记音频路径）。 */
export interface VoiceCallSegment {
  id: string;
  at: string;
  /** 音频文件名（只有 basename，不记路径）。 */
  source: string;
  /** 音频 SHA-256 前 12 位。 */
  audioHash: string;
  durationSeconds: number | null;
  vad: VoiceCallVad;
  /** VAD 有声帧占比；非 WAV（跳过）时为 null。 */
  vadRatio: number | null;
  /** 转写引擎（whisper.cpp / cloud:<模型>）；静音跳过时为 null。 */
  engine: string | null;
  /** 转写文本 SHA-256 前 12 位；静音跳过时为 null。 */
  textHash: string | null;
  chars: number;
  /** 本段 STT 花费（美元）；本地为 0，未计价为 null。 */
  costUsd: number | null;
  status: VoiceCallSegmentStatus;
  /** 扣下原因：payment / external_send；没扣下时为 null。 */
  heldReason: "payment" | "external_send" | null;
  /** 回读字数；没回读时为 null。 */
  replyChars: number | null;
  /** 回读花费（美元）；没回读/未计价时为 null。 */
  replyCostUsd: number | null;
}

/** 一通电话（传输层本批是本机回环，见文件头诚实边界）。 */
export interface VoiceCall {
  id: string;
  agent: string;
  peer: string | null;
  transport: "loopback";
  status: VoiceCallStatus;
  startedAt: string;
  endedAt: string | null;
  segments: VoiceCallSegment[];
  /** 通话累计 STT 秒数（有时长的段才计）。 */
  sttSeconds: number;
  /** 通话累计回读字数。 */
  ttsChars: number;
  /** 通话累计花费（美元）；任一段未计价时为 null（只记下界）。 */
  costUsd: number | null;
  /** 是否有未计价的花费（为 true 时 costUsd 只是下界）。 */
  costUnpriced: boolean;
  /** 关联的运行 id（有则事件镜像进该运行，无则只写审计）。 */
  runId: string | null;
}

export interface VoiceCallStore {
  version: 1;
  calls: VoiceCall[];
}

export const VOICE_CALLS_FILE = "voice-calls.json";
export const VOICE_CALL_AUDIT_FILE = "voice-call-audit.jsonl";

export function voiceCallsPath(home: string): string {
  return join(home, VOICE_CALLS_FILE);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\+00:00$/, "Z");
}

function newCallId(): string {
  return `call-${nowIso().replace(/[-:T.]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}

function newSegmentId(): string {
  return `seg-${randomBytes(4).toString("hex")}`;
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

export function loadVoiceCallStore(home: string): VoiceCallStore {
  const path = voiceCallsPath(home);
  if (!existsSync(path)) return { version: 1, calls: [] };
  if (lstatSync(path).isSymbolicLink()) throw new VoiceCallError("通话账本不能是符号链接");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    backupCorrupt(path);
    throw new VoiceCallError("通话账本损坏，已备份，请检查后恢复");
  }
  if (!raw || typeof raw !== "object" || (raw as VoiceCallStore).version !== 1 ||
    !Array.isArray((raw as VoiceCallStore).calls)) {
    backupCorrupt(path);
    throw new VoiceCallError("通话账本格式无效，已备份");
  }
  return raw as VoiceCallStore;
}

export function saveVoiceCallStore(home: string, store: VoiceCallStore): void {
  const path = voiceCallsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new VoiceCallError("通话账本不能是符号链接");
  const tmp = join(dirname(path), `.voice-calls-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(store, null, 2), null, "utf-8");
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  try { rmSync(tmp, { force: true }); } catch { /* already renamed */ }
}

/** 审计链（append-only，0600）：通话动作只记元数据，不记转写原文、不记音频路径。 */
export function appendVoiceCallAudit(home: string, entry: Record<string, unknown>): boolean {
  try {
    const path = join(home, VOICE_CALL_AUDIT_FILE);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) return false;
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify({ at: nowIso(), ...entry }) + "\n", null, "utf-8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** 有运行上下文时把通话事件镜像进运行事件（tasks 目录优先，runs 次之）；没上下文时审计就是记录。 */
function mirrorEvent(home: string, runId: string | null, type: string, fields: Record<string, unknown>): void {
  if (!runId) return;
  for (const dir of ["tasks", "runs"]) {
    try {
      const store = new RunStore(join(home, dir));
      store.load(runId);
      store.appendEvent(runId, type, fields);
      return;
    } catch { /* 不在这个目录，换下一个 */ }
  }
}

function getCall(store: VoiceCallStore, id: string): VoiceCall {
  const call = store.calls.find((c) => c.id === id);
  if (!call) throw new VoiceCallError(`找不到通话 ${id}`);
  return call;
}

function recomputeTotals(call: VoiceCall): void {
  let stt = 0;
  let tts = 0;
  let cost = 0;
  let unpriced = false;
  for (const s of call.segments) {
    if (typeof s.durationSeconds === "number") stt += s.durationSeconds;
    if (typeof s.replyChars === "number") tts += s.replyChars;
    if (s.costUsd === null) unpriced = true;
    else cost += s.costUsd;
    if (s.replyCostUsd === null && s.replyChars !== null) unpriced = true;
    else if (typeof s.replyCostUsd === "number") cost += s.replyCostUsd;
  }
  call.sttSeconds = Math.round(stt * 100) / 100;
  call.ttsChars = tts;
  call.costUsd = unpriced ? null : Math.round(cost * 10000) / 10000;
  call.costUnpriced = unpriced;
}

// ---- 通话生命周期 ----

/**
 * 发起一通电话（状态 ringing）。
 * 机主发起 = 在本机 CLI 上执行即视为机主；呼叫有名有姓的对方（--peer）
 * 须 --yes（对外可见的动作，显式确认才做）。Bot/远端发起不在本批。
 */
export function startVoiceCall(home: string, opts: {
  agent?: string;
  peer?: string | null;
  yes?: boolean;
  runId?: string | null;
}): VoiceCall {
  const agent = typeof opts.agent === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(opts.agent) ? opts.agent : "nyra";
  const peer = typeof opts.peer === "string" && opts.peer.trim() ? opts.peer.trim().slice(0, 100) : null;
  if (peer && !opts.yes) {
    throw new VoiceCallError(`呼叫 ${peer} 须加 --yes 确认（对外可见的动作，须显式确认）`);
  }
  const store = loadVoiceCallStore(home);
  const call: VoiceCall = {
    id: newCallId(), agent, peer, transport: "loopback", status: "ringing",
    startedAt: nowIso(), endedAt: null, segments: [],
    sttSeconds: 0, ttsChars: 0, costUsd: 0, costUnpriced: false,
    runId: opts.runId ?? null,
  };
  store.calls.push(call);
  saveVoiceCallStore(home, store);
  LoopbackTransport.start(call.id);
  appendVoiceCallAudit(home, { op: "started", call_id: call.id, agent, peer, transport: "loopback" });
  mirrorEvent(home, call.runId, "voice_call_started", { call_id: call.id, agent, peer, transport: "loopback" });
  return call;
}

/** 接听（ringing → active）。 */
export function answerVoiceCall(home: string, callId: string): VoiceCall {
  const store = loadVoiceCallStore(home);
  const call = getCall(store, callId);
  if (call.status !== "ringing") throw new VoiceCallError(`通话 ${callId} 现在是 ${call.status}，接不了`);
  call.status = "active";
  saveVoiceCallStore(home, store);
  appendVoiceCallAudit(home, { op: "answered", call_id: call.id });
  mirrorEvent(home, call.runId, "voice_call_answered", { call_id: call.id });
  return call;
}

/** 拒绝来电（ringing → declined）。 */
export function declineVoiceCall(home: string, callId: string): VoiceCall {
  const store = loadVoiceCallStore(home);
  const call = getCall(store, callId);
  if (call.status !== "ringing") throw new VoiceCallError(`通话 ${callId} 现在是 ${call.status}，拒绝不了`);
  call.status = "declined";
  call.endedAt = nowIso();
  saveVoiceCallStore(home, store);
  LoopbackTransport.stop(call.id);
  appendVoiceCallAudit(home, { op: "declined", call_id: call.id });
  mirrorEvent(home, call.runId, "voice_call_declined", { call_id: call.id });
  return call;
}

/** 挂断（active/ringing → ended；ringing 时挂断就是没接上）。 */
export function endVoiceCall(home: string, callId: string): VoiceCall {
  const store = loadVoiceCallStore(home);
  const call = getCall(store, callId);
  if (call.status === "ended" || call.status === "declined") throw new VoiceCallError(`通话 ${callId} 已经结束了`);
  call.status = "ended";
  call.endedAt = nowIso();
  recomputeTotals(call);
  saveVoiceCallStore(home, store);
  LoopbackTransport.stop(call.id);
  const duration = Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000);
  appendVoiceCallAudit(home, {
    op: "ended", call_id: call.id, duration_seconds: duration,
    segments: call.segments.length, stt_seconds: call.sttSeconds,
    tts_chars: call.ttsChars, cost_usd: call.costUsd,
    held: call.segments.filter((s) => s.status === "held").length,
  });
  mirrorEvent(home, call.runId, "voice_call_ended", {
    call_id: call.id, duration_seconds: duration, segments: call.segments.length,
    stt_seconds: call.sttSeconds, tts_chars: call.ttsChars, cost_usd: call.costUsd,
    held: call.segments.filter((s) => s.status === "held").length,
  });
  return call;
}

/** 最近的通话（新的在前）；status 给了只列该状态。 */
export function listVoiceCalls(home: string, status?: VoiceCallStatus, limit = 10): VoiceCall[] {
  const store = loadVoiceCallStore(home);
  const all = [...store.calls].reverse();
  const filtered = status ? all.filter((c) => c.status === status) : all;
  return filtered.slice(0, Math.max(1, Math.min(100, limit)));
}

// ---- 用量与硬顶 ----

/** 一笔语音花费进用量账本（零 token 快照当增量；calls=1 保证未计价也落行）。 */
function recordVoiceSpend(home: string, costUsd: number | null, engine: string, agentId?: string | null): void {
  try {
    const snap: UsageSnapshot = {
      calls: 1, reported_calls: 0, missing_calls: 0,
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      prompt_samples: 0, completion_samples: 0, total_samples: 0,
      last_prompt_tokens: null, context_window_tokens: null,
      context_remaining_tokens: null, context_window_source: "unknown",
      context_window_model: null,
    };
    new UsageLedger(home).recordDelta(snap, null, costUsd, null, engine, undefined, agentId ?? null);
  } catch { /* 账本写失败不破坏通话 */ }
}

/**
 * 云端语音前的月度硬顶判定（与 cost.ts 同口径：本月已花是下界，只会晚
 * 触发、不会误触发；没配上限不挡人；算不出金额时不假装封顶）。
 */
export function checkCallCloudCap(home: string, config: Record<string, unknown>, additionalUsd: number | null): { allowed: boolean; reason: string | null } {
  const limit = resolveMonthlyLimit(config);
  if (limit === null) return { allowed: true, reason: null };
  const spentBefore = new UsageLedger(home).monthTotal(monthKeyString(new Date())).spentUsd;
  const check = checkMonthlyCap(spentBefore, additionalUsd, limit);
  if (!check.exceeded) return { allowed: true, reason: null };
  const spent = check.monthSpentUsd !== null ? `$${check.monthSpentUsd.toFixed(4)}` : "未知";
  return {
    allowed: false,
    reason: `本月已花 ${spent}，超过月度上限 $${limit.toFixed(2)}，云端语音已停（本地 whisper.cpp 不受影响）`,
  };
}

function cloudSttUnavailableMessage(callCloudEnabled: boolean): string {
  if (!callCloudEnabled) {
    return "没有可用的转写路：本地 whisper.cpp 没装或没配模型文件，且通话里的云端转写默认关闭。两条路任选其一：1）装 whisper.cpp 并在 config.json 的 voice.stt_local_model 里填模型文件路径；2）在 config.json 的 voice.call_cloud_enabled 设为 true 才走云端（云端要花钱，且过月度硬顶）。详见 docs/voice.md";
  }
  return "没有可用的转写路：本地 whisper.cpp 没装或没配模型文件，且当前 provider 没有 HTTP 音频接口或未配密钥。换一个支持语音接口的 HTTP provider（--provider 指定）并配好密钥，或装本地 whisper.cpp。详见 docs/voice.md";
}

// ---- 喂段落：VAD → 转写 → 敏感意图扣下 → 可选回读 ----

export interface FeedSegmentResult {
  call: VoiceCall;
  segment: VoiceCallSegment;
  /** 转写原文（只返回给调用方显示，不落盘）。 */
  transcript: string | null;
  /** 是否因静音被跳过（没转写、没花钱）。 */
  skippedSilence: boolean;
  /** 是否因敏感意图被扣下。 */
  held: boolean;
  /** 回读音频保存路径；没回读时为 null。 */
  replyPath: string | null;
  /** 回读被截断时为 true（只读前 replyMaxChars 字）。 */
  replyTruncated: boolean;
}

export async function feedCallSegment(opts: {
  home: string;
  workdir: string;
  callId: string;
  audioPath: string;
  config: Record<string, unknown>;
  voiceCfg: VoiceConfig;
  callCfg: VoiceCallConfig;
  endpoint: HttpEndpoint | null;
  runCommand?: CommandRunner;
  fetchFn?: typeof fetch;
  /** agent 的回读文字（调用方给）；不给 = 只转写不回读。 */
  speakReply?: string | null;
  agentId?: string | null;
}): Promise<FeedSegmentResult> {
  const run = opts.runCommand ?? defaultCommandRunner;
  const store = loadVoiceCallStore(opts.home);
  const call = getCall(store, opts.callId);
  if (call.status !== "active") throw new VoiceCallError(`通话 ${opts.callId} 现在是 ${call.status}，喂不了段落（先接听）`);
  if (call.segments.length >= opts.callCfg.maxSegments) {
    throw new VoiceCallError(`通话 ${opts.callId} 已满 ${opts.callCfg.maxSegments} 段，先挂断再开新通话`);
  }
  const elapsedMin = (Date.now() - Date.parse(call.startedAt)) / 60000;
  if (elapsedMin > opts.callCfg.maxCallMinutes) {
    throw new VoiceCallError(`通话 ${opts.callId} 已超过 ${opts.callCfg.maxCallMinutes} 分钟上限，先挂断再开新通话`);
  }
  const input = loadAudioFile(opts.audioPath, opts.workdir, opts.voiceCfg, run);
  const segId = newSegmentId();
  const base: Omit<VoiceCallSegment, "engine" | "textHash" | "chars" | "costUsd" | "status" | "heldReason" | "replyChars" | "replyCostUsd"> = {
    id: segId, at: nowIso(), source: input.source,
    audioHash: input.sha256.slice(0, 12), durationSeconds: input.durationSeconds,
    vad: "skipped", vadRatio: null,
  };

  // VAD 门控：WAV 做真能量检测；其他格式跳过（不假装都测了）。
  if (input.kind === "wav") {
    const gate = vadGateWav(input.bytes, opts.callCfg.vadMinSpeechRatio);
    if (gate.parsed) {
      base.vad = gate.speech ? "speech" : "silence";
      base.vadRatio = gate.ratio;
      if (!gate.speech) {
        const segment: VoiceCallSegment = {
          ...base, engine: null, textHash: null, chars: 0, costUsd: 0,
          status: "skipped_silence", heldReason: null, replyChars: null, replyCostUsd: null,
        };
        call.segments.push(segment);
        recomputeTotals(call);
        saveVoiceCallStore(opts.home, store);
        appendVoiceCallAudit(opts.home, { op: "transcribed", call_id: call.id, segment_id: segId, vad: "silence", seconds: input.durationSeconds, chars: 0, engine: null, cost_usd: 0 });
        mirrorEvent(opts.home, call.runId, "voice_call_transcribed", { call_id: call.id, segment_id: segId, vad: "silence", seconds: input.durationSeconds, chars: 0, engine: "", cost_usd: 0, text_hash: "" });
        return { call, segment, transcript: null, skippedSilence: true, held: false, replyPath: null, replyTruncated: false };
      }
    }
  }

  // 转写：本地优先；云端只在显式配了 call_cloud_enabled 才走。
  let text: string;
  let seconds: number | null;
  let engine: string;
  let local: { binary: string } | null = null;
  try {
    local = localSttAvailable(opts.voiceCfg, run);
  } catch (err: unknown) {
    throw new VoiceCallError(err instanceof Error ? err.message : String(err));
  }
  if (local !== null) {
    const out = await transcribeLocal(input, opts.voiceCfg, local.binary, run);
    text = out.text;
    seconds = out.seconds;
    engine = out.engine;
  } else if (opts.callCfg.callCloudEnabled && opts.endpoint !== null) {
    const est = estimateSttCostUsd(input.durationSeconds, opts.voiceCfg);
    const cap = checkCallCloudCap(opts.home, opts.config, est);
    if (!cap.allowed) throw new VoiceCallError(cap.reason ?? "月度硬顶已触发，云端转写已停");
    const out = await transcribeCloud(input, opts.voiceCfg, opts.endpoint, opts.fetchFn);
    text = out.text;
    seconds = out.seconds;
    engine = out.engine;
  } else {
    throw new VoiceCallError(cloudSttUnavailableMessage(opts.callCfg.callCloudEnabled));
  }
  const costUsd = engine === "whisper.cpp" ? 0 : estimateSttCostUsd(seconds, opts.voiceCfg);
  recordVoiceSpend(opts.home, costUsd, engine, opts.agentId ?? call.agent);
  const textHash = shortTextHash(text);
  const intent = detectSensitiveIntent(text);
  const segment: VoiceCallSegment = {
    ...base, engine, textHash, chars: text.length, costUsd,
    status: intent ? "held" : "transcribed", heldReason: intent,
    replyChars: null, replyCostUsd: null,
  };
  call.segments.push(segment);
  recomputeTotals(call);
  saveVoiceCallStore(opts.home, store);
  appendVoiceCallAudit(opts.home, {
    op: "transcribed", call_id: call.id, segment_id: segId, vad: base.vad,
    seconds, chars: text.length, engine, cost_usd: costUsd, text_hash: textHash,
    status: segment.status,
  });
  mirrorEvent(opts.home, call.runId, "voice_call_transcribed", {
    call_id: call.id, segment_id: segId, vad: base.vad, seconds,
    chars: text.length, engine, cost_usd: costUsd, text_hash: textHash,
  });
  if (intent) {
    appendVoiceCallAudit(opts.home, { op: "blocked", call_id: call.id, segment_id: segId, reason: intent, text_hash: textHash });
    mirrorEvent(opts.home, call.runId, "voice_call_blocked", { call_id: call.id, segment_id: segId, reason: intent, text_hash: textHash });
    return { call, segment, transcript: text, skippedSilence: false, held: true, replyPath: null, replyTruncated: false };
  }

  // 回读：调用方给的文字才合成；云端 TTS 同样过硬顶；超长截断。
  let replyPath: string | null = null;
  let replyTruncated = false;
  if (typeof opts.speakReply === "string" && opts.speakReply.trim()) {
    let replyText = opts.speakReply.trim();
    if (replyText.length > opts.callCfg.replyMaxChars) {
      replyText = replyText.slice(0, opts.callCfg.replyMaxChars);
      replyTruncated = true;
    }
    if (opts.endpoint === null) {
      throw new VoiceCallError("回读失败：当前 provider 没有 HTTP 音频接口或未配密钥（回读只有云端 TTS，本地没有可靠的 TTS 引擎）");
    }
    const cap = checkCallCloudCap(opts.home, opts.config, estimateTtsCostUsd(replyText.length, opts.voiceCfg));
    if (!cap.allowed) throw new VoiceCallError(cap.reason ?? "月度硬顶已触发，云端回读已停");
    const out = await synthesizeSpeech(replyText, opts.voiceCfg, opts.endpoint, opts.fetchFn);
    const replyCost = estimateTtsCostUsd(out.chars, opts.voiceCfg);
    recordVoiceSpend(opts.home, replyCost, out.engine, opts.agentId ?? call.agent);
    const dir = join(opts.home, "voice");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `call-${call.id}-${segId}.mp3`;
    replyPath = join(dir, name);
    writeFileSync(replyPath, out.bytes, { mode: 0o600 });
    segment.replyChars = out.chars;
    segment.replyCostUsd = replyCost;
    recomputeTotals(call);
    saveVoiceCallStore(opts.home, store);
    appendVoiceCallAudit(opts.home, { op: "spoken", call_id: call.id, segment_id: segId, chars: out.chars, engine: out.engine, cost_usd: replyCost });
    mirrorEvent(opts.home, call.runId, "voice_call_spoken", { call_id: call.id, segment_id: segId, chars: out.chars, engine: out.engine, cost_usd: replyCost });
    playAudioFile(replyPath, opts.voiceCfg, run);
  }
  return { call, segment, transcript: text, skippedSilence: false, held: false, replyPath, replyTruncated };
}

// ---- 文字确认：只记“含义已确认”，不执行动作 ----

/**
 * 确认一段被扣下的语音指令（held → confirmed）。
 * 确认只表示“这段话的意思没错、可以执行”，执行本身不在这里做——
 * 要执行请把文字当普通任务跑（转写原文不落盘，确认时凭段落 id 与指纹核对）。
 */
export function confirmCallSegment(home: string, callId: string, segmentId: string): VoiceCallSegment {
  const store = loadVoiceCallStore(home);
  const call = getCall(store, callId);
  const seg = call.segments.find((s) => s.id === segmentId);
  if (!seg) throw new VoiceCallError(`通话 ${callId} 里找不到段落 ${segmentId}`);
  if (seg.status !== "held") throw new VoiceCallError(`段落 ${segmentId} 现在是 ${seg.status}，不用确认`);
  seg.status = "confirmed";
  saveVoiceCallStore(home, store);
  appendVoiceCallAudit(home, { op: "confirmed", call_id: call.id, segment_id: segmentId, reason: seg.heldReason });
  mirrorEvent(home, call.runId, "voice_call_confirmed", { call_id: call.id, segment_id: segmentId, reason: seg.heldReason ?? "" });
  return seg;
}

// ---- 通话总结（三本账分开：传输 / 理解 / 干活） ----

export interface VoiceCallSummary {
  id: string;
  agent: string;
  peer: string | null;
  status: VoiceCallStatus;
  durationSeconds: number | null;
  segments: number;
  transcribed: number;
  skippedSilence: number;
  held: number;
  confirmed: number;
  sttSeconds: number;
  ttsChars: number;
  costUsd: number | null;
  costUnpriced: boolean;
}

export function summarizeVoiceCall(call: VoiceCall): VoiceCallSummary {
  const duration = call.endedAt
    ? Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000)
    : null;
  return {
    id: call.id, agent: call.agent, peer: call.peer, status: call.status,
    durationSeconds: duration, segments: call.segments.length,
    transcribed: call.segments.filter((s) => s.status === "transcribed").length,
    skippedSilence: call.segments.filter((s) => s.status === "skipped_silence").length,
    held: call.segments.filter((s) => s.status === "held").length,
    confirmed: call.segments.filter((s) => s.status === "confirmed").length,
    sttSeconds: call.sttSeconds, ttsChars: call.ttsChars,
    costUsd: call.costUsd, costUnpriced: call.costUnpriced,
  };
}

/** 通话总结文本（用量弹层与结束总结的数据口径：token 只在用量弹层与结束总结里按主人拆分，不上通话主界面）。 */
export function formatCallSummary(call: VoiceCall): string {
  const s = summarizeVoiceCall(call);
  const money = (v: number | null): string => (v === null ? "未计价" : `$${v.toFixed(4)}`);
  const lines = [
    `通话 ${s.id}（${s.peer ?? "本机回环"} · agent ${s.agent}）：${s.status}`,
    `时长：${s.durationSeconds !== null ? `${Math.floor(s.durationSeconds / 60)} 分 ${s.durationSeconds % 60} 秒` : "进行中"}`,
    `段落：共 ${s.segments} 段（转写 ${s.transcribed} · 静音跳过 ${s.skippedSilence} · 待确认 ${s.held} · 已确认 ${s.confirmed}）`,
    `理解（STT）：${(s.sttSeconds / 60).toFixed(1)} 分钟，花费 ${money(s.costUsd)}${s.costUnpriced ? "（有未计价部分，花费只是下界）" : ""}`,
    `回读（TTS）：${s.ttsChars} 字`,
    "传输：本批是本机回环，不走网络、不花 token；实时 WebRTC 传输是下一批。",
    "模型调用（LLM）：本次通话未调用 LLM，无 token 花费。",
  ];
  return lines.join("\n");
}

// ---- `nyra voice call` 子命令 ----

/** `nyra voice call` 的输入注入（测试用：假 fetch / 假命令执行器）。 */
export interface VoiceCallCliInput {
  fetchFn?: typeof fetch;
  runCommand?: CommandRunner;
}

function resolveCallEndpoint(home: string, config: Record<string, unknown>): HttpEndpoint | null {
  try {
    const primary = resolveProvider({ home, config });
    if (primary.auth === "cli" || !primary.apiKey) return null;
    const provider = new Provider(primary);
    return httpEndpointOf(provider);
  } catch {
    return null;
  }
}

function usageError(msg: string): number {
  process.stderr.write(`${msg}\n`);
  process.stderr.write("用法：nyra voice call <start [--peer <名字>] [--agent <id>] [--yes]|answer <通话 id>|decline <通话 id>|end <通话 id>|status [通话 id]|list|segment <通话 id> <音频路径> [--speak-reply \"<文字>\"]|confirm <通话 id> <段落 id>>\n");
  return 2;
}

export async function handleVoiceCall(argv: string[], home: string, input?: VoiceCallCliInput): Promise<number> {
  const config = loadConfig(home);
  const voiceCfg = resolveVoiceConfig(config);
  const callCfg = resolveVoiceCallConfig(config);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const flag = (name: string): string | null => {
    const i = rest.indexOf(name);
    return i >= 0 && i + 1 < rest.length ? rest[i + 1] : null;
  };
  const has = (name: string): boolean => rest.includes(name);
  try {
    if (!cmd || cmd === "status") {
      const id = rest[0] && !rest[0].startsWith("--") ? rest[0] : null;
      if (id) {
        const call = getCall(loadVoiceCallStore(home), id);
        process.stdout.write(`${formatCallSummary(call)}\n`);
        return 0;
      }
      const calls = listVoiceCalls(home, undefined, 10);
      if (calls.length === 0) {
        process.stdout.write("还没有通话记录。先开一通：nyra voice call start\n");
        return 0;
      }
      for (const c of calls) {
        const s = summarizeVoiceCall(c);
        process.stdout.write(`${c.id} · ${c.peer ?? "本机回环"} · ${c.status} · ${s.segments} 段 · STT ${(s.sttSeconds / 60).toFixed(1)} 分钟 · 花费 ${s.costUsd === null ? "未计价" : `$${s.costUsd.toFixed(4)}`}\n`);
      }
      return 0;
    }
    if (cmd === "list") {
      const calls = listVoiceCalls(home, undefined, 20);
      if (calls.length === 0) {
        process.stdout.write("还没有通话记录。\n");
        return 0;
      }
      for (const c of calls) {
        process.stdout.write(`${c.id} · ${c.peer ?? "本机回环"} · ${c.status} · ${c.startedAt}\n`);
      }
      return 0;
    }
    if (cmd === "start") {
      const call = startVoiceCall(home, {
        agent: flag("--agent") ?? undefined,
        peer: flag("--peer"),
        yes: has("--yes"),
        runId: flag("--run"),
      });
      process.stdout.write(`通话已建立：${call.id}（${call.peer ?? "本机回环"}，响铃中）\n`);
      process.stdout.write("接听：nyra voice call answer <通话 id>\n");
      return 0;
    }
    if (cmd === "answer" || cmd === "decline" || cmd === "end") {
      const id = rest[0];
      if (!id) return usageError(`用法：nyra voice call ${cmd} <通话 id>`);
      const call = cmd === "answer" ? answerVoiceCall(home, id)
        : cmd === "decline" ? declineVoiceCall(home, id)
        : endVoiceCall(home, id);
      if (cmd === "end") {
        process.stdout.write(`${formatCallSummary(call)}\n`);
      } else {
        process.stdout.write(`通话 ${call.id}：${cmd === "answer" ? "已接听，开始通话" : "已拒绝"}\n`);
      }
      return 0;
    }
    if (cmd === "segment") {
      const id = rest[0];
      const audioPath = rest[1];
      if (!id || !audioPath) return usageError("用法：nyra voice call segment <通话 id> <音频路径> [--speak-reply \"<文字>\"]");
      const endpoint = resolveCallEndpoint(home, config);
      const result = await feedCallSegment({
        home, workdir: process.cwd(), callId: id, audioPath, config,
        voiceCfg, callCfg, endpoint,
        runCommand: input?.runCommand, fetchFn: input?.fetchFn,
        speakReply: flag("--speak-reply"),
      });
      if (result.skippedSilence) {
        process.stdout.write(`段落 ${result.segment.id}：静音，已跳过（没转写、没花钱）\n`);
        return 0;
      }
      process.stdout.write(`转写（${result.segment.engine}，${result.segment.chars} 字${result.segment.costUsd !== null ? `，$${result.segment.costUsd.toFixed(4)}` : "，未计价"}）：${result.transcript ?? ""}\n`);
      if (result.held) {
        const kind = result.segment.heldReason === "payment" ? "支付类" : "对外发送类";
        process.stdout.write(`这段话是${kind}意图，已扣下，没执行。确认含义后执行：nyra voice call confirm ${id} ${result.segment.id}（确认只记“含义已确认”，执行请把文字当普通任务跑；转写原文不落盘）\n`);
        return 0;
      }
      if (result.replyPath) {
        process.stdout.write(`回读已保存：${result.replyPath}（${result.segment.replyChars} 字${result.replyTruncated ? "，已截断" : ""}）\n`);
      }
      return 0;
    }
    if (cmd === "confirm") {
      const id = rest[0];
      const segId = rest[1];
      if (!id || !segId) return usageError("用法：nyra voice call confirm <通话 id> <段落 id>");
      const seg = confirmCallSegment(home, id, segId);
      process.stdout.write(`段落 ${segId} 已确认（${seg.heldReason === "payment" ? "支付类" : "对外发送类"}意图，含义已确认）。确认不执行动作：要执行请把这段话的文字当普通任务跑。\n`);
      return 0;
    }
    return usageError(`未知子命令：${cmd}`);
  } catch (err: unknown) {
    process.stderr.write(`语音通话失败：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
