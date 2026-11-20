// src/vision.ts — 视觉模型看屏 plumbing，与 Python 版 nyra/vision.py 同语义。
// 缺口 16 在此接主循环：图片/视频输入的校验、抽帧、模型门禁与消息拼装。
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { lookupBuiltin, MODEL_CATALOG } from "./modelCatalog.ts";
import { formatBytes, sniffImageKind } from "./bot/attachments.ts";
const VISION_SUBSTRINGS = [
  "vision", "vl", "gpt-4o", "gpt-4.1", "gpt-5", "claude", "gemini",
  "qwen-vl", "qwen2-vl", "qwen2.5-vl", "glm-4v", "doubao-seed",
];

export const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * 当前生效的视觉模型子串表：环境变量 NYRA_VISION_MODELS（逗号分隔）
 * 设置后完全替代内置表（不是追加），匹配时忽略大小写——与 Python
 * 版 _vision_substrings() 同语义。未设置或只含空白时用内置表。
 */
export function visionSubstrings(): string[] {
  const override = (process.env.NYRA_VISION_MODELS ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return override.length > 0 ? override : [...VISION_SUBSTRINGS];
}

/**
 * 对应 Python supports_vision(provider_name, model)。
 * TS 侧历史签名是 supportsVision(model)，保持兼容：第一个参数仍是
 * model；model 为空时回退到 providerName。匹配忽略大小写。
 * 注意与 Python 内置表的两处有意差异（现有 Node 测试已锁定）：
 * Python 表含 "grok-4"，本表不含，所以 grok-4.3 在这里返回 false；
 * Python 表用 "claude-sonnet"/"claude-opus"，本表用更宽的 "claude"。
 */
export function supportsVision(model: string, providerName?: string): boolean {
  const target = (model || "").trim().toLowerCase()
    || (providerName || "").trim().toLowerCase();
  if (!target) return false;
  return visionSubstrings().some((s) => target.includes(s));
}

export function imagePart(imageBase64: string, mimeType = "image/png"): Record<string, unknown> {
  return { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } };
}

export function buildImageMessage(text: string, imageBase64: string, mimeType = "image/png"): Record<string, unknown> {
  return {
    role: "user",
    content: [
      { type: "text", text },
      imagePart(imageBase64, mimeType),
    ],
  };
}

/**
 * 对应 Python image_part(png_bytes)：只接受 PNG 字节，非 PNG 抛错
 * （审查修复 F-L1 的口径）。与上面接收 base64 字符串的 imagePart
 * 并存：老调用方传字符串，新调用方（computer_screenshot 的 Buffer）
 * 走这里。
 */
export function imagePartFromBytes(pngBytes: Uint8Array | Buffer): Record<string, unknown> {
  if (!(pngBytes instanceof Uint8Array)) {
    throw new Error("image_part 需要 PNG 字节");
  }
  const data = Buffer.from(pngBytes);
  if (!data.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error("image_part 需要 PNG 字节，收到的数据不是 PNG");
  }
  return imagePart(data.toString("base64"), "image/png");
}

/** 对应 Python build_image_message(text, png_bytes)。 */
export function buildImageMessageFromBytes(text: string, pngBytes: Uint8Array | Buffer): Record<string, unknown> {
  return {
    role: "user",
    content: [
      { type: "text", text },
      imagePartFromBytes(pngBytes),
    ],
  };
}

// ---- 缺口 16：图像 / 视频输入（接主循环）----
//
// 图片只认 magic bytes（复用 src/bot/attachments.ts 的 sniffImageKind，
// 不信扩展名）；视频先抽帧再当图片看（ffmpeg，本地有才行）；图片内容
// 绝不进事件与日志，只记 SHA-256 前 12 位指纹与元信息。

/** 缺口 16：视觉输入的配置（config.json 的 vision 一节，未配用默认值）。 */
export interface VisionConfig {
  /** 单张图片上限（字节），默认 10MB。 */
  maxBytes: number;
  /** 单个视频最多抽几帧，默认 6。 */
  maxFrames: number;
  /** 一次运行最多附几张图片（--image 次数上限），默认 5。 */
  maxImages: number;
  /** 单个视频文件/下载上限（字节），默认 50MB。 */
  videoMaxBytes: number;
  /** 一次运行最多附几个视频，默认 3。 */
  maxVideos: number;
}

export const DEFAULT_VISION_CONFIG: VisionConfig = {
  maxBytes: 10 * 1024 * 1024,
  maxFrames: 6,
  maxImages: 5,
  videoMaxBytes: 50 * 1024 * 1024,
  maxVideos: 3,
};

/** 接受的视频扩展名（小写，不含点）。 */
export const VIDEO_EXTENSIONS = ["mp4", "mov", "webm", "mkv", "avi", "m4v"];

/** 视觉输入配置的解析：数字不合法（非正整数/超范围）时回退默认值，不抛错、不挡运行。 */
export function resolveVisionConfig(config: Record<string, unknown>): VisionConfig {
  const raw = config.vision;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (key: string, min: number, max: number, fallback: number): number => {
    const v = o[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return fallback;
    return v;
  };
  return {
    maxBytes: num("max_bytes", 1024, 100 * 1024 * 1024, DEFAULT_VISION_CONFIG.maxBytes),
    maxFrames: num("max_frames", 1, 12, DEFAULT_VISION_CONFIG.maxFrames),
    maxImages: num("max_images", 1, 10, DEFAULT_VISION_CONFIG.maxImages),
    videoMaxBytes: num("video_max_bytes", 1024 * 1024, 500 * 1024 * 1024, DEFAULT_VISION_CONFIG.videoMaxBytes),
    maxVideos: num("max_videos", 1, 5, DEFAULT_VISION_CONFIG.maxVideos),
  };
}

/** 一张已备好的图片（进模型的消息体只用 bytes + mime；其余字段只用于审计与说明）。 */
export interface VisionImageInput {
  bytes: Buffer;
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  /** 全文 SHA-256（事件里只取前 12 位，免得被 redact 当长词串掩掉）。 */
  sha256: string;
  /** 来源描述（文件名或“视频#帧号”），只用于给用户看，不进事件。 */
  source: string;
  sourceKind: "image" | "video-frame";
  /** 视频帧是第几帧（从 1 计）；普通图片没有。 */
  frameIndex?: number;
}

/** SHA-256 前 12 位指纹（事件与日志里只用这个，不记全文哈希）。 */
export function shortImageHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

const IMAGE_MIME: Record<string, VisionImageInput["mime"]> = {
  png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};

/**
 * 把字节校验成一张可进模型的图片：先查大小、再认 magic bytes。
 * 失败抛错（中文说明原因），不静默跳过。
 */
export function prepareImageInput(
  bytes: Buffer,
  source: string,
  cfg: VisionConfig,
  sourceKind: VisionImageInput["sourceKind"] = "image",
  frameIndex?: number,
): VisionImageInput {
  if (bytes.length === 0) throw new Error(`图片 ${source} 是空文件，已跳过`);
  if (bytes.length > cfg.maxBytes) {
    throw new Error(`图片 ${source} 太大（${formatBytes(bytes.length)}，超过 ${formatBytes(cfg.maxBytes)} 上限）`);
  }
  const kind = sniffImageKind(bytes);
  if (!kind) {
    throw new Error(`图片 ${source} 不是支持的格式（只认 PNG/JPEG/WebP/GIF，按文件头识别，不看扩展名）`);
  }
  return {
    bytes, mime: IMAGE_MIME[kind],
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source, sourceKind, ...(frameIndex !== undefined ? { frameIndex } : {}),
  };
}

/** 读一张本地图片文件（路径相对 workdir 解析）并校验成视觉输入。 */
export function loadImageFile(path: string, workdir: string, cfg: VisionConfig): VisionImageInput {
  const abs = resolve(workdir, path);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`图片不存在：${path}`);
  return prepareImageInput(readFileSync(abs), basename(abs), cfg);
}

/**
 * 模型能不能看图：内置模型表的 supportsVision 显式值优先（精确与同系列
 * 推断都算）；没标的回退到模型名启发式（supportsVision，与旧 plumbing 同款）。
 * 未知模型默认按看不了图处理——宁可拒绝，不假装能看。
 */
export function modelSupportsVision(model: string, provider?: string): { supported: boolean; source: "catalog" | "heuristic"; detail: string } {
  const found = lookupBuiltin(model);
  if (found && found.entry.supportsVision === true) {
    return { supported: true, source: "catalog", detail: `模型 ${model} 在内置模型表里标注支持看图` };
  }
  if (found && found.entry.supportsVision === false) {
    return { supported: false, source: "catalog", detail: `模型 ${model} 在内置模型表里标注不支持看图（纯文本模型）` };
  }
  const ok = supportsVision(model, provider);
  return {
    supported: ok, source: "heuristic",
    detail: ok
      ? `模型名 ${model} 命中视觉模型特征`
      : `模型 ${model} 不在内置模型表里、名字也不含视觉特征，默认按看不了图处理`,
  };
}

/** 内置模型表里明确标注支持看图的模型（用于拒绝文案里给用户指路）。 */
export function visionCapableModels(): string[] {
  return MODEL_CATALOG.filter((e) => e.supportsVision === true).map((e) => e.model);
}

/** 看不了图时的拒绝文案：说什么模型、为什么、换哪个模型。 */
export function visionGateMessage(model: string, provider?: string): string {
  const gate = modelSupportsVision(model, provider);
  const known = visionCapableModels();
  const hint = known.length
    ? `换一个能看图的模型再试，如 ${known.join("、")}（--model 指定）`
    : "换一个能看图的模型再试";
  return `当前模型 ${model} 看不了图（${gate.detail}）。${hint}；也可以先不传图、只用文字描述。`;
}

/** 任务文本 + 图片拼成第一条用户消息（多段 content，原样透传给 chat/completions）。 */
export function buildVisionUserMessage(task: string, images: VisionImageInput[]): Record<string, unknown> {
  return {
    role: "user",
    content: [
      { type: "text", text: task },
      ...images.map((img) => imagePart(img.bytes.toString("base64"), img.mime)),
    ],
  };
}

/** 外部命令执行器（测试可注入假实现，不依赖本机 ffmpeg）。 */
export type CommandRunner = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

function defaultRunner(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 120_000 });
    if (r.error) return { status: null, stdout: "", stderr: String((r.error as Error).message ?? r.error) };
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (err: unknown) {
    return { status: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** ffprobe 读视频时长（秒）；读不到返回 null（调用方回退到关键帧抽取）。 */
function probeVideoDuration(videoPath: string, run: CommandRunner): number | null {
  const r = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath]);
  if (r.status !== 0) return null;
  const n = parseFloat((r.stdout ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 视频抽帧：按需均匀采样（时长 / 上限帧数定间隔），抽出的帧当图片走同一条路。
 * ffprobe 读不到时长时回退到只抽关键帧。帧落临时目录、读完即删，不存原片。
 * ffmpeg/ffprobe 缺失时直接报错（不静默降级）。
 */
export function extractVideoFrames(videoPath: string, cfg: VisionConfig, run: CommandRunner = defaultRunner): VisionImageInput[] {
  if (!existsSync(videoPath) || !statSync(videoPath).isFile()) throw new Error(`视频不存在：${videoPath}`);
  const size = statSync(videoPath).size;
  if (size > cfg.videoMaxBytes) {
    throw new Error(`视频 ${basename(videoPath)} 太大（${formatBytes(size)}，超过 ${formatBytes(cfg.videoMaxBytes)} 上限）`);
  }
  const ext = extname(videoPath).slice(1).toLowerCase();
  if (!VIDEO_EXTENSIONS.includes(ext)) {
    throw new Error(`视频 ${basename(videoPath)} 格式不支持（只支持 ${VIDEO_EXTENSIONS.join("、")}）`);
  }
  const duration = probeVideoDuration(videoPath, run);
  // 时长读不到（ffprobe 缺失/失败）时回退关键帧抽取；ffmpeg 本身缺失时下面直接报错。
  const filter = duration !== null
    ? `fps=${(cfg.maxFrames / duration).toPrecision(6)}`
    : "select='eq(pict_type,PICT_TYPE_I)'";
  const dir = mkdtempSync(join(tmpdir(), "nyra-video-frames-"));
  try {
    const args = ["-i", videoPath, "-vf", filter];
    if (duration === null) args.push("-vsync", "vfr");
    args.push("-frames:v", String(cfg.maxFrames), "-f", "image2", join(dir, "frame-%03d.png"));
    const r = run("ffmpeg", args);
    if (r.status === null) {
      throw new Error("本机没有 ffmpeg，装好 ffmpeg 才能读视频（见 docs/vision.md）");
    }
    if (r.status !== 0) {
      throw new Error(`视频抽帧失败（ffmpeg 退出码 ${r.status}）：${(r.stderr ?? "").trim().slice(0, 200) || "无报错输出"}`);
    }
    const frames = readdirSync(dir).filter((f) => /^frame-\d+\.png$/.test(f)).sort();
    if (frames.length === 0) throw new Error(`视频 ${basename(videoPath)} 里没抽到任何帧（文件可能损坏或太短）`);
    return frames.map((f, i) => {
      const bytes = readFileSync(join(dir, f));
      return prepareImageInput(bytes, `${basename(videoPath)}#${i + 1}`, cfg, "video-frame", i + 1);
    });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * 下载公开链接的视频（直链）：只接受 http/https、只要 video 内容、
 * 超上限直接拒绝；不带 cookie、不走 yt-dlp、不碰 DRM/付费墙。
 * 返回字节（调用方落临时文件再抽帧，处理完即删）。
 */
export async function downloadVideo(url: string, cfg: VisionConfig, fetchFn: typeof fetch = fetch): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`视频链接不合法：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`视频链接只支持 http/https：${url}`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  let resp: Response;
  try {
    resp = await fetchFn(url, { signal: ctrl.signal, headers: { Accept: "video/*" }, redirect: "follow" });
  } catch (err: unknown) {
    throw new Error(`视频链接下载失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`视频链接返回 HTTP ${resp.status}`);
  const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
  const pathExt = extname(parsed.pathname).slice(1).toLowerCase();
  if (!contentType.startsWith("video/") && !VIDEO_EXTENSIONS.includes(pathExt)) {
    throw new Error("链接返回的不是视频（既不是 video 内容、也不是视频扩展名），请给直链视频地址或下载到本地再传");
  }
  const len = resp.headers.get("content-length");
  if (len !== null && Number(len) > cfg.videoMaxBytes) {
    throw new Error(`视频太大（超过 ${formatBytes(cfg.videoMaxBytes)} 上限）`);
  }
  // 流式读 + 上限熔断（没给 content-length 时也不至于无限下载）。
  const body = resp.body;
  if (!body) {
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > cfg.videoMaxBytes) throw new Error(`视频太大（超过 ${formatBytes(cfg.videoMaxBytes)} 上限）`);
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > cfg.videoMaxBytes) throw new Error(`视频太大（超过 ${formatBytes(cfg.videoMaxBytes)} 上限）`);
        chunks.push(value);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return Buffer.concat(chunks);
}

/**
 * CLI --image / --video 的统一准备：图片直接读、视频先抽帧，全部校验成视觉输入。
 * 任一输入失败即整体报错（不静默跳过某一张，用户看得到哪张出了问题）。
 */
export async function prepareVisionInputs(opts: {
  images: string[];
  videos: string[];
  workdir: string;
  config: Record<string, unknown>;
  runCommand?: CommandRunner;
  fetchFn?: typeof fetch;
}): Promise<VisionImageInput[]> {
  const cfg = resolveVisionConfig(opts.config);
  if (opts.images.length > cfg.maxImages) {
    throw new Error(`图片太多（${opts.images.length} 张，一次最多 ${cfg.maxImages} 张）`);
  }
  if (opts.videos.length > cfg.maxVideos) {
    throw new Error(`视频太多（${opts.videos.length} 个，一次最多 ${cfg.maxVideos} 个）`);
  }
  const out: VisionImageInput[] = [];
  for (const p of opts.images) out.push(loadImageFile(p, opts.workdir, cfg));
  for (const v of opts.videos) {
    if (/^https?:\/\//i.test(v)) {
      const bytes = await downloadVideo(v, cfg, opts.fetchFn);
      const dir = mkdtempSync(join(tmpdir(), "nyra-video-download-"));
      try {
        const ext = extname(new URL(v).pathname).slice(1).toLowerCase();
        const tmpPath = join(dir, `video.${VIDEO_EXTENSIONS.includes(ext) ? ext : "mp4"}`);
        writeFileSync(tmpPath, bytes, { mode: 0o600 });
        out.push(...extractVideoFrames(tmpPath, cfg, opts.runCommand));
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } else {
      out.push(...extractVideoFrames(resolve(opts.workdir, v), cfg, opts.runCommand));
    }
  }
  return out;
}
