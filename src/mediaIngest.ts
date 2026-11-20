// src/mediaIngest.ts — 候选提案 4：内置确定性工具 media_ingest（学 yt-dlp 的能力，不抄它的代码）。
//
// 定位（评估报告 §0）：yt-dlp 解决“拿到视频”，Nyra 解决“看懂视频并交出
// 可验证的稿子”——后者才是 Nyra 比原项目好的地方。流水线：
//   用户给链接 → ① 取：--dump-json 先探（标题/时长/可用性）→ ② 批：范围卡
//   白名单 + 时长/大小硬顶 → ③ 转写（按成本从低到高）：字幕优先（零 token）
//   → 无字幕走本地 whisper.cpp，本地没有再走云端 STT → ④ 自证：事件 +
//   产物指纹进证据链。
//
// 红线（评估报告 §2/§6，写进代码不是写进口号）：
//   - yt-dlp 二进制绝不随仓分发、随 Release 附带、打进安装包：只由
//     `nyra media setup` 按官方 URL 按需下载，验 SHA256（必验）+ GPG
//     （本机有 gpg 且钥匙环里已有官方公钥时验，没有只警告、不谎称已验）。
//   - yt-dlp 仓库有 .NO_AI 政策：绝不用 AI 向该仓库提 issue/PR/评论，
//     只把官方 release 二进制当外部依赖调用，不 fork、不改、不声称合作。
//   - 不写任何 yt-dlp 的替代实现；不绕过 DRM/付费墙；不带 cookies、不读
//     浏览器登录态、不传账号密码；不绕地区限制；不批量搬运、不再分发。
//   - 下载只进临时目录、处理完即删；产物（转写文本）只写工作区内指定路径。
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  statSync, writeFileSync, renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, saveConfig, resolveProvider } from "./config.ts";
import {
  resolveVoiceConfig, transcribeAudio, estimateSttCostUsd, httpEndpointOf,
  shortTextHash, prepareAudioInput, type VoiceConfig, type CommandRunner,
  type HttpEndpoint,
} from "./voice.ts";
import { formatBytes } from "./bot/attachments.ts";
import {
  resolveMediaScope, checkMediaUrl, addMediaScope, removeMediaScope,
  listMediaScopes, findMediaScope, parseMediaScopeCard, mediaScopeCardTemplate,
  type MediaScopeCard,
} from "./mediaScopes.ts";
import { Provider } from "./providers.ts";

/** 候选提案 4：媒体抓取的配置（config.json 的 media 一节，未配用默认值）。 */
export interface MediaConfig {
  /** 默认关：显式 opt-in（与 reviewer / repo_map 同口径）。 */
  enabled: boolean;
  /** 单个视频最长（秒），默认 3600（1 小时）。 */
  maxDurationSeconds: number;
  /** 单次下载/音频上限（字节），默认 2GB。 */
  maxBytes: number;
  /** 下载限速（yt-dlp --limit-rate 原样传，如 1M、500K），默认 1M。 */
  rateLimit: string;
  /** 字幕语言（逗号分隔，按顺序优先），默认 zh,en。 */
  subLangs: string;
}

export const DEFAULT_MEDIA_CONFIG: MediaConfig = {
  enabled: false,
  maxDurationSeconds: 3600,
  maxBytes: 2 * 1024 * 1024 * 1024,
  rateLimit: "1M",
  subLangs: "zh,en",
};

/** 媒体配置的解析：数字不合法（非正整数/超范围）时回退默认值，不抛错、不挡运行。 */
export function resolveMediaConfig(config: Record<string, unknown>): MediaConfig {
  const raw = config.media;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (key: string, min: number, max: number, fallback: number): number => {
    const v = o[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return fallback;
    return v;
  };
  const str = (key: string, fallback: string): string => {
    const v = o[key];
    return typeof v === "string" && v.trim() ? v.trim() : fallback;
  };
  return {
    enabled: o.enabled === true,
    maxDurationSeconds: num("max_duration_seconds", 1, 86400, DEFAULT_MEDIA_CONFIG.maxDurationSeconds),
    maxBytes: num("max_bytes", 1024 * 1024, 10 * 1024 * 1024 * 1024, DEFAULT_MEDIA_CONFIG.maxBytes),
    rateLimit: /^(\d+(?:\.\d+)?)([KM]?)$/.test(str("rate_limit", DEFAULT_MEDIA_CONFIG.rateLimit))
      ? str("rate_limit", DEFAULT_MEDIA_CONFIG.rateLimit)
      : DEFAULT_MEDIA_CONFIG.rateLimit,
    subLangs: str("sub_langs", DEFAULT_MEDIA_CONFIG.subLangs),
  };
}

// ---- yt-dlp 二进制：发现与安装 ----

/** 已核实的最新稳定版（2026-11-20 实查 GitHub releases/latest）；setup 取不到最新版时回退到它。 */
export const YT_DLP_PINNED_VERSION = "2026.10.26";
export const YT_DLP_REPO = "yt-dlp/yt-dlp";

/** 平台对应的官方 release 附件名（评估报告 §1：PyInstaller 独立二进制）。 */
export function ytDlpAssetName(platform: string = process.platform): string {
  if (platform === "win32") return "yt-dlp.exe";
  if (platform === "darwin") return "yt-dlp_macos";
  return "yt-dlp_linux";
}

/** setup 的安装位置：~/.nyra/bin/yt-dlp（不进仓库、不进安装包、不进 PATH）。 */
export function mediaBinaryPath(home: string): string {
  return join(home, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
}

/** 外部命令执行器（测试可注入假实现；下载步可能很久，超时放 30 分钟）。 */
function defaultMediaRunner(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { status: null, stdout: "", stderr: String((r.error as Error).message ?? r.error) };
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (err: unknown) {
    return { status: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** 找 yt-dlp：先看 ~/.nyra/bin（setup 装的），再看 PATH；都没有返回 null。 */
export function findYtDlpBinary(home: string, run: CommandRunner = defaultMediaRunner): { path: string; source: "installed" | "path" } | null {
  const installed = mediaBinaryPath(home);
  if (existsSync(installed)) return { path: installed, source: "installed" };
  if (run("yt-dlp", ["--version"]).status !== null) return { path: "yt-dlp", source: "path" };
  return null;
}

/** 二进制缺失时的指路文案（不编“请稍后再试”这种空话）。 */
export function mediaBinaryMissingMessage(): string {
  return "本机没有 yt-dlp：先跑 nyra media setup 按官方 release 下载并验签安装（只装到 ~/.nyra/bin，不进仓库、不进安装包），或自己装好 yt-dlp 放进 PATH；详见 docs/media-ingest.md";
}

// ---- 探查与 DRM/付费墙判定 ----

/** 疑似 DRM/付费墙/需登录的报错关键词（命中即拒绝，不重试、不换路绕过）。 */
const DRM_ERROR_KEYWORDS = [
  "private video", "sign in", "log in", "login", "premium",
  "members only", "members-only", "drm", "encrypted", "age confirm",
  "only available", "join this channel", "this video is for",
  "requires authentication", "cookies",
];

export function looksLikeDrmOrPaywall(text: string): boolean {
  const lower = (text ?? "").toLowerCase();
  return DRM_ERROR_KEYWORDS.some((k) => lower.includes(k));
}

export interface MediaProbe {
  title: string;
  host: string;
  durationSeconds: number | null;
  availability: string | null;
  isLive: boolean;
}

/**
 * 先探后下：--dump-json 拿标题/时长/可用性，下载前先判 DRM/付费墙与超长。
 * availability 不是 public 直接拒绝；直播暂不支持（等回放）。
 */
export function probeMedia(url: string, binary: string, run: CommandRunner = defaultMediaRunner): MediaProbe {
  const r = run(binary, ["--dump-json", "--no-playlist", "--no-warnings", "--skip-download", "--socket-timeout", "30", url]);
  if (r.status === null) throw new Error(`yt-dlp 执行失败：找不到 ${binary}（${mediaBinaryMissingMessage()}）`);
  if (r.status !== 0) {
    const errText = (r.stderr ?? "").trim().slice(0, 300);
    if (looksLikeDrmOrPaywall(errText)) {
      throw new Error(`该内容疑似 DRM/付费墙或需要登录，已拒绝（不绕过、不带 cookies）：${errText || "无报错输出"}`);
    }
    throw new Error(`yt-dlp 探查失败（退出码 ${r.status}）：${errText || "无报错输出"}`);
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    throw new Error("yt-dlp 返回的不是合法 JSON（站点可能改了提取器，请先跑 nyra media setup 看看有没有新版）");
  }
  const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : "（无标题）";
  const duration = typeof data.duration === "number" && Number.isFinite(data.duration) && data.duration > 0
    ? Math.round(data.duration)
    : null;
  const availability = typeof data.availability === "string" ? data.availability : null;
  const isLive = data.is_live === true;
  if (availability !== null && availability !== "public") {
    throw new Error(`该内容不是公开视频（availability=${availability}），不处理 DRM/付费墙内容`);
  }
  if (isLive) throw new Error("直播内容暂不支持转写（先等直播结束、再给回放链接）");
  return { title, host: new URL(url).hostname, durationSeconds: duration, availability, isLive };
}

// ---- 字幕（零 token 的第一来源）----

/**
 * VTT → 纯文本：去 WEBVTT 头、时间戳行、序号行与 <...> 标签；连续重复行
 * 去重（自动字幕常重复）；空行跳过。返回空串 = 这份字幕没内容。
 */
export function parseVtt(text: string): string {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "WEBVTT") continue;
    if (line.startsWith("NOTE")) continue;
    if (line.includes("-->")) continue;
    if (/^\d+$/.test(line)) continue;
    const clean = line
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
      .trim();
    if (!clean) continue;
    if (out.length && out[out.length - 1] === clean) continue;
    out.push(clean);
  }
  return out.join("\n");
}

/** 在临时目录里按 sub_langs 顺序挑一份字幕（文件名形如 subs.zh.vtt）。 */
function readBestSubtitle(tmpDir: string, subLangs: string): string | null {
  const langs = subLangs.split(",").map((s) => s.trim()).filter(Boolean);
  let files: string[];
  try {
    files = readdirSync(tmpDir).filter((f) => f.endsWith(".vtt"));
  } catch {
    return null;
  }
  for (const lang of langs) {
    const hit = files.find((f) => f === `subs.${lang}.vtt` || f.endsWith(`.${lang}.vtt`));
    if (hit) {
      const text = parseVtt(readFileSync(join(tmpDir, hit), "utf-8"));
      if (text) return text;
    }
  }
  for (const f of files.sort()) {
    const text = parseVtt(readFileSync(join(tmpDir, f), "utf-8"));
    if (text) return text;
  }
  return null;
}

/**
 * 字幕两路：先人工字幕（--write-subs），没有再自动字幕（--write-auto-subs）。
 * 两路都失败/都没内容返回 null（调用方走音频兜底）；某一路命令本身失败
 * 不抛错——字幕缺失不是错误，只是换条路。
 */
export function fetchSubtitles(
  url: string, binary: string, cfg: MediaConfig, tmpDir: string,
  run: CommandRunner = defaultMediaRunner,
): { text: string; source: "subs" | "auto-subs" } | null {
  for (const mode of ["subs", "auto-subs"] as const) {
    const flag = mode === "subs" ? "--write-subs" : "--write-auto-subs";
    const r = run(binary, [flag, "--sub-langs", cfg.subLangs, "--sub-format", "vtt", "--skip-download", "--no-playlist", "--no-warnings", "--socket-timeout", "30", "-o", join(tmpDir, "subs"), url]);
    if (r.status === null) throw new Error(`yt-dlp 执行失败：找不到 ${binary}（${mediaBinaryMissingMessage()}）`);
    if (r.status !== 0) continue;
    const text = readBestSubtitle(tmpDir, cfg.subLangs);
    if (text) return { text, source: mode };
  }
  return null;
}

// ---- 音频提取（无字幕时的兜底）----

/**
 * 只提音频轨（-x mp3），不下视频：省带宽省磁盘。限速 + --max-filesize
 * 双硬顶；DRM/付费墙报错直接拒绝。返回音频文件绝对路径（调用方处理完即删）。
 */
export function extractAudio(
  url: string, binary: string, cfg: MediaConfig, tmpDir: string,
  run: CommandRunner = defaultMediaRunner,
): string {
  const args = [
    "-x", "--audio-format", "mp3", "--audio-quality", "0",
    "--no-playlist", "--no-warnings", "--socket-timeout", "30",
    "--limit-rate", cfg.rateLimit, "--max-filesize", String(cfg.maxBytes),
    "-o", join(tmpDir, "audio.%(ext)s"), url,
  ];
  const r = run(binary, args);
  if (r.status === null) throw new Error(`yt-dlp 执行失败：找不到 ${binary}（${mediaBinaryMissingMessage()}）`);
  if (r.status !== 0) {
    const errText = (r.stderr ?? "").trim().slice(0, 300);
    if (looksLikeDrmOrPaywall(errText)) {
      throw new Error(`该内容疑似 DRM/付费墙或需要登录，已拒绝：${errText || "无报错输出"}`);
    }
    throw new Error(`音频提取失败（退出码 ${r.status}）：${errText || "无报错输出"}`);
  }
  const audioPath = join(tmpDir, "audio.mp3");
  if (!existsSync(audioPath)) throw new Error("音频提取后没找到音频文件（站点可能改了提取器）");
  const size = statSync(audioPath).size;
  if (size === 0) throw new Error("提取到的音频是空文件");
  if (size > cfg.maxBytes) {
    throw new Error(`音频太大（${formatBytes(size)}，超过 ${formatBytes(cfg.maxBytes)} 上限）`);
  }
  return audioPath;
}

// ---- 抓取编排 ----

export interface MediaIngestResult {
  title: string;
  host: string;
  url: string;
  durationSeconds: number | null;
  /** 下载/提取的媒体字节数（字幕路径为 0，没下任何媒体文件）。 */
  bytes: number;
  /** 转写来源：subs / auto-subs / whisper.cpp / cloud:<模型名>。 */
  source: string;
  engine: string;
  text: string;
  textHash: string;
  titleHash: string;
  /** 云端 STT 花费（美元）；本地/字幕路径为 null（不编数字）。 */
  costUsd: number | null;
}

/**
 * 抓取入口（确定性流水线，不调模型）：
 * 未开启 → 拒绝；范围卡 → 白名单 + 过期；先探（DRM/超长）→ 字幕优先 →
 * 无字幕提音频走 voice.ts 的转写（本地 whisper.cpp 优先、否则云端；
 * 选中一路失败直接抛错，不换路重转）。下载与音频只进临时目录、处理完即删。
 */
export async function ingestMedia(opts: {
  url: string;
  home: string;
  config: Record<string, unknown>;
  scopeName?: string;
  runCommand?: CommandRunner;
  fetchFn?: typeof fetch;
  sttEndpoint?: HttpEndpoint | null;
}): Promise<MediaIngestResult> {
  const cfg = resolveMediaConfig(opts.config);
  if (!cfg.enabled) {
    throw new Error("媒体抓取未开启：先跑 nyra media enable 显式开启（默认关；详见 docs/media-ingest.md）");
  }
  const card = resolveMediaScope(opts.home, opts.scopeName);
  const check = checkMediaUrl(card, opts.url);
  if (!check.inScope) throw new Error(`不在媒体范围内：${check.reason}`);
  const run = opts.runCommand ?? defaultMediaRunner;
  const found = findYtDlpBinary(opts.home, run);
  if (!found) throw new Error(mediaBinaryMissingMessage());
  const binary = found.path;
  const probe = probeMedia(opts.url, binary, run);
  if (probe.durationSeconds !== null && probe.durationSeconds > cfg.maxDurationSeconds) {
    throw new Error(`视频太长（${probe.durationSeconds} 秒，超过 ${cfg.maxDurationSeconds} 秒上限）`);
  }
  const dir = mkdtempSync(join(tmpdir(), "nyra-media-"));
  try {
    const subs = fetchSubtitles(opts.url, binary, cfg, dir, run);
    if (subs) {
      return {
        title: probe.title, host: probe.host, url: opts.url,
        durationSeconds: probe.durationSeconds, bytes: 0,
        source: subs.source, engine: subs.source === "subs" ? "subtitle" : "auto-subtitle",
        text: subs.text, textHash: shortTextHash(subs.text), titleHash: shortTextHash(probe.title),
        costUsd: null,
      };
    }
    // 无字幕 → 提音频转写：转写上限用媒体的上限（不是 voice 的 25MB/600 秒，
    // 那是 --voice 单段语音的上限；媒体 ingest 的上限由 media.* 管）。
    const voiceCfg: VoiceConfig = {
      ...resolveVoiceConfig(opts.config),
      maxBytes: cfg.maxBytes,
      maxSeconds: cfg.maxDurationSeconds,
    };
    const audioPath = extractAudio(opts.url, binary, cfg, dir, run);
    const bytes = readFileSync(audioPath);
    const input = prepareAudioInput(bytes, "audio.mp3", voiceCfg, probe.durationSeconds);
    const result = await transcribeAudio({
      input, config: voiceCfg, endpoint: opts.sttEndpoint ?? null,
      runCommand: run, fetchFn: opts.fetchFn,
    });
    return {
      title: probe.title, host: probe.host, url: opts.url,
      durationSeconds: probe.durationSeconds, bytes: bytes.length,
      source: result.engine, engine: result.engine,
      text: result.text, textHash: shortTextHash(result.text), titleHash: shortTextHash(probe.title),
      costUsd: estimateSttCostUsd(result.seconds, voiceCfg),
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 抓取结果排成结构化文本（标题/来源/时长/转写来源 + 正文；只含文本，不含媒体）。 */
export function formatMediaTranscript(r: MediaIngestResult): string {
  const sourceLabel = r.source === "subs"
    ? "字幕（免费、零 token）"
    : r.source === "auto-subs"
      ? "自动字幕（免费、零 token）"
      : r.source;
  return [
    `标题：${r.title}`,
    `来源：${r.host}`,
    `时长：${r.durationSeconds !== null ? `${r.durationSeconds} 秒` : "未知"}`,
    `转写来源：${sourceLabel}`,
    "---",
    r.text,
  ].join("\n");
}

// ---- setup：按官方 URL 下载并验签安装 ----

async function downloadBytes(url: string, fetchFn: typeof fetch, maxBytes: number): Promise<Buffer> {
  let resp: Response;
  try {
    resp = await fetchFn(url, { headers: { "User-Agent": "nyra-media-setup" } });
  } catch (err: unknown) {
    throw new Error(`下载失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!resp.ok) throw new Error(`下载失败（HTTP ${resp.status}）：${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`下载的文件太大（${formatBytes(buf.length)}，超过 ${formatBytes(maxBytes)} 上限）`);
  if (buf.length === 0) throw new Error(`下载的文件是空的：${url}`);
  return buf;
}

async function downloadText(url: string, fetchFn: typeof fetch): Promise<string> {
  return (await downloadBytes(url, fetchFn, 1024 * 1024)).toString("utf-8");
}

/** 在官方 SHA2-256SUMS 里找附件名对应的哈希（格式：`<sha256>  <文件名>`）。 */
export function findSha256(sumsText: string, asset: string): string | null {
  for (const line of sumsText.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m && m[2].trim() === asset) return m[1].toLowerCase();
  }
  return null;
}

export interface MediaSetupResult {
  path: string;
  version: string;
  tag: string;
  shaVerified: boolean;
  /** true = GPG 签名已验证；null = 未验（原因见 gpgNote，绝不谎称已验）。 */
  gpgVerified: boolean | null;
  gpgNote: string | null;
}

/**
 * 安装 yt-dlp：取最新 release（取不到回退已核实的 pinned 版）→ 下载官方
 * 二进制 + SHA2-256SUMS → SHA256 必验（失败拒绝安装）→ GPG 有条件验
 * （本机有 gpg 且钥匙环里已有官方公钥才验；没公钥只警告、不挡安装，
 * 更不谎称已验；签名本身不对直接拒绝安装）→ 装到 ~/.nyra/bin，0700。
 */
export async function installYtDlp(
  home: string,
  input?: { fetchFn?: typeof fetch; runCommand?: CommandRunner },
): Promise<MediaSetupResult> {
  const fetchFn = input?.fetchFn ?? fetch;
  const run = input?.runCommand ?? defaultMediaRunner;
  const asset = ytDlpAssetName();
  let tag = YT_DLP_PINNED_VERSION;
  try {
    const resp = await fetchFn("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest", {
      headers: { "User-Agent": "nyra-media-setup", Accept: "application/vnd.github+json" },
    });
    if (resp.ok) {
      const data = await resp.json() as Record<string, unknown>;
      if (typeof data.tag_name === "string" && data.tag_name.trim()) tag = data.tag_name.trim();
    }
  } catch { /* 取不到最新版就用已核实的 pinned 版，不挡安装 */ }
  const base = `https://github.com/${YT_DLP_REPO}/releases/download/${tag}`;
  const binBytes = await downloadBytes(`${base}/${asset}`, fetchFn, 100 * 1024 * 1024);
  const sumsText = await downloadText(`${base}/SHA2-256SUMS`, fetchFn);
  const want = findSha256(sumsText, asset);
  if (!want) {
    throw new Error(`官方 SHA2-256SUMS 里没有 ${asset} 这一行，拒绝安装（不上没法验签的二进制）`);
  }
  const got = createHash("sha256").update(binBytes).digest("hex");
  if (got.toLowerCase() !== want) {
    throw new Error(`SHA256 校验失败（${asset}），拒绝安装：下载的文件可能被篡改或损坏`);
  }
  let gpgVerified: boolean | null = null;
  let gpgNote: string | null = null;
  let sigBytes: Buffer | null = null;
  try {
    sigBytes = await downloadBytes(`${base}/SHA2-256SUMS.sig`, fetchFn, 1024 * 1024);
  } catch { /* 官方没给 .sig 就跳过 GPG，只记一句 */ }
  if (!sigBytes) {
    gpgNote = "官方 release 没有提供 SHA2-256SUMS.sig，GPG 未验（SHA256 已通过）";
  } else {
    const dir = mkdtempSync(join(tmpdir(), "nyra-media-setup-"));
    try {
      const sumsPath = join(dir, "SHA2-256SUMS");
      const sigPath = join(dir, "SHA2-256SUMS.sig");
      writeFileSync(sumsPath, sumsText, { mode: 0o600 });
      writeFileSync(sigPath, sigBytes, { mode: 0o600 });
      if (run("gpg", ["--version"]).status === null) {
        gpgNote = "本机没有 gpg，GPG 签名未验（SHA256 已通过；要验签请装 gpg 并按官方 README 导入签名公钥后重跑）";
      } else {
        const v = run("gpg", ["--verify", sigPath, sumsPath]);
        if (v.status === 0) {
          gpgVerified = true;
        } else if (/no public key/i.test(v.stderr ?? "")) {
          gpgNote = "GPG 签名未验：本机钥匙环里没有 yt-dlp 官方签名公钥（SHA256 已通过；要验签请按官方 README 导入公钥后重跑）";
        } else {
          throw new Error(`GPG 签名校验失败，拒绝安装：${(v.stderr ?? "").trim().slice(0, 200) || "未知原因"}`);
        }
      }
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  const dest = mediaBinaryPath(home);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, binBytes, { mode: 0o700 });
  renameSync(tmp, dest);
  const ver = run(dest, ["--version"]);
  const version = ver.status === 0 ? (ver.stdout ?? "").trim().split("\n")[0] ?? "" : tag;
  return { path: dest, version: version || tag, tag, shaVerified: true, gpgVerified, gpgNote };
}

// ---- `nyra media` 子命令 ----

/** `nyra media` 的输入注入（测试用：假 fetch / 假命令执行器）。 */
export interface MediaCliInput {
  fetchFn?: typeof fetch;
  runCommand?: CommandRunner;
}

export async function handleMedia(argv: string[], home: string, workdir: string, input?: MediaCliInput): Promise<number> {
  const config = loadConfig(home);
  const cfg = resolveMediaConfig(config);
  const cmd = argv[0];
  if (!cmd || cmd === "status") {
    const found = (() => {
      try { return findYtDlpBinary(home, input?.runCommand); } catch { return null; }
    })();
    process.stdout.write(`媒体抓取：${cfg.enabled ? "已开启" : "未开启（默认关，nyra media enable 开启）"}\n`);
    process.stdout.write(`yt-dlp：${found ? `可用（${found.path}，${found.source === "installed" ? "nyra media setup 装的" : "PATH 上的"}）` : "未装（nyra media setup 安装）"}\n`);
    process.stdout.write(`上限：单视频最长 ${cfg.maxDurationSeconds} 秒、单次 ${formatBytes(cfg.maxBytes)}、限速 ${cfg.rateLimit}、字幕语言 ${cfg.subLangs}\n`);
    const scopes = listMediaScopes(home);
    process.stdout.write(`范围卡：${scopes.length} 个${scopes.length ? `（${scopes.map((s) => s.name).join("、")}）` : "（没有自定义卡，用内置默认卡：YouTube/Bilibili/TikTok）"}\n`);
    if (!cfg.enabled) process.stdout.write("开启：nyra media enable（先确认只抓自己给的公开链接、只为自己看/学习）\n");
    return 0;
  }
  if (cmd === "enable" || cmd === "disable") {
    saveConfig(home, { media: { ...((config.media as Record<string, unknown>) ?? {}), enabled: cmd === "enable" } });
    process.stdout.write(`媒体抓取已${cmd === "enable" ? "开启" : "关闭"}${cmd === "enable" ? "（只抓用户给的公开链接；DRM/付费墙、cookies、批量搬运一律拒绝，详见 docs/media-ingest.md）" : ""}\n`);
    return 0;
  }
  if (cmd === "setup") {
    try {
      const r = await installYtDlp(home, input);
      process.stdout.write(`yt-dlp 已安装：${r.path}（版本 ${r.version}，release ${r.tag}）\n`);
      process.stdout.write(`SHA256 已验证${r.gpgVerified ? "；GPG 签名已验证" : ""}${r.gpgNote ? `\n注意：${r.gpgNote}` : ""}\n`);
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`安装失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (cmd === "ingest") {
    const usage = "用法：nyra media ingest <链接> [--out <路径>] [--scope <范围卡名>] [--langs <zh,en>]";
    let url: string | undefined;
    let out: string | undefined;
    let scopeName: string | undefined;
    let langs: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i] as string;
      if (arg === "--out" && i + 1 < argv.length) out = argv[++i];
      else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
      else if (arg === "--scope" && i + 1 < argv.length) scopeName = argv[++i];
      else if (arg.startsWith("--scope=")) scopeName = arg.slice("--scope=".length);
      else if (arg === "--langs" && i + 1 < argv.length) langs = argv[++i];
      else if (arg.startsWith("--langs=")) langs = arg.slice("--langs=".length);
      else if (arg.startsWith("--")) {
        process.stderr.write(`${usage}\n未知参数：${arg}\n`);
        return 2;
      } else if (!url) url = arg;
      else {
        process.stderr.write(`${usage}\n一次只抓一个链接\n`);
        return 2;
      }
    }
    if (!url) {
      process.stderr.write(`${usage}\n`);
      return 2;
    }
    const ingestConfig: Record<string, unknown> = {
      ...config,
      ...(langs ? { media: { ...((config.media as Record<string, unknown>) ?? {}), sub_langs: langs } } : {}),
    };
    let endpoint: HttpEndpoint | null = null;
    try {
      const primary = resolveProvider({ home, config });
      if (primary.auth !== "cli" && primary.apiKey) endpoint = httpEndpointOf(new Provider(primary));
    } catch { endpoint = null; }
    try {
      const result = await ingestMedia({
        url, home, config: ingestConfig, scopeName,
        runCommand: input?.runCommand, fetchFn: input?.fetchFn, sttEndpoint: endpoint,
      });
      const text = formatMediaTranscript(result);
      if (out) {
        const outAbs = resolve(workdir, out);
        mkdirSync(dirname(outAbs), { recursive: true });
        writeFileSync(outAbs, text, { mode: 0o600 });
        process.stdout.write(`已抓取 ${basename(outAbs)}（${result.host}，${result.durationSeconds ?? "?"} 秒；转写来源：${result.source}${result.costUsd !== null ? `，花费 $${result.costUsd.toFixed(4)}` : ""}）\n`);
      } else {
        process.stdout.write(text + "\n");
      }
      return 0;
    } catch (err: unknown) {
      process.stderr.write(`抓取失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }
  if (cmd === "scope") {
    const sub = argv[1];
    if (sub === "list") {
      const scopes = listMediaScopes(home);
      if (!scopes.length) {
        process.stdout.write("还没有自定义范围卡（用内置默认卡：YouTube/Bilibili/TikTok；nyra media scope template 取模板，建好后 scope add）\n");
        return 0;
      }
      for (const s of scopes) {
        process.stdout.write(`- ${s.name}：host ${s.allowed_hosts.join("、")}，上限 ${s.max_duration_seconds} 秒 / ${formatBytes(s.max_bytes)}${s.expires_at ? `，到期 ${s.expires_at}` : ""}\n`);
      }
      return 0;
    }
    if (sub === "add") {
      const file = argv[2];
      if (!file) { process.stderr.write("错误：用法：nyra media scope add <范围卡.json>\n"); return 2; }
      try {
        const card = parseMediaScopeCard(readFileSync(resolve(workdir, file), "utf-8"));
        addMediaScope(home, card);
        process.stdout.write(`已建媒体范围卡 ${card.name}（host ${card.allowed_hosts.join("、")}，上限 ${card.max_duration_seconds} 秒 / ${formatBytes(card.max_bytes)}）\n`);
        return 0;
      } catch (err: unknown) {
        process.stderr.write(`建卡失败：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
    }
    if (sub === "remove") {
      const name = argv[2];
      if (!name) { process.stderr.write("错误：用法：nyra media scope remove <范围卡名>\n"); return 2; }
      if (!removeMediaScope(home, name)) { process.stderr.write(`错误：没有叫 ${name} 的媒体范围卡\n`); return 1; }
      process.stdout.write(`已删媒体范围卡 ${name}\n`);
      return 0;
    }
    if (sub === "show") {
      const name = argv[2];
      if (!name) { process.stderr.write("错误：用法：nyra media scope show <范围卡名>\n"); return 2; }
      const card = findMediaScope(home, name);
      if (!card) { process.stderr.write(`错误：没有叫 ${name} 的媒体范围卡\n`); return 1; }
      process.stdout.write(JSON.stringify(card, null, 2) + "\n");
      return 0;
    }
    if (sub === "check") {
      const url = argv[2];
      if (!url) { process.stderr.write("错误：用法：nyra media scope check <URL> [--scope <范围卡名>]\n"); return 2; }
      const scopeIdx = argv.indexOf("--scope");
      const scopeName = scopeIdx !== -1 ? argv[scopeIdx + 1] : undefined;
      let card: MediaScopeCard;
      try {
        card = resolveMediaScope(home, scopeName);
      } catch (err: unknown) {
        process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      const result = checkMediaUrl(card, url);
      process.stdout.write(`${result.inScope ? "在范围内" : "不在范围内"}：${result.reason}\n`);
      return result.inScope ? 0 : 3;
    }
    if (sub === "template") {
      process.stdout.write(mediaScopeCardTemplate());
      return 0;
    }
    process.stdout.write("用法：nyra media scope <list|add <文件>|remove <名>|show <名>|check <URL> [--scope <名>]|template>\n");
    return 2;
  }
  process.stdout.write("用法：nyra media <status|enable|disable|ingest <链接> [--out <路径>]|setup|scope ...>（详见 docs/media-ingest.md）\n");
  return 2;
}

/** 测试用：handleMedia 的同款入口。 */
export { handleMedia as handleMediaCommand };
