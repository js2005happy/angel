// tests/node/test-media-ingest.test.ts — 候选提案 4：内置确定性工具 media_ingest。
// 假 yt-dlp 输出 + 假 whisper 上验过（不连真站、不下真二进制）：范围卡校验与
// 五条红线、账本往返与损坏备份、白名单与过期、VTT 解析、探查与 DRM 判定、
// 字幕优先、whisper 兜底、cookies 拒绝、超长/超大拒绝、SHA256 校验与 GPG 口径、
// 工具端到端 + 事件指纹、审批拒绝、路径逃逸拒绝、远端后端拒绝、CLI 端到端。
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import {
  probeMedia, extractAudio, ingestMedia, formatMediaTranscript,
  installYtDlp, resolveMediaConfig, parseVtt, findSha256, handleMedia,
  ytDlpAssetName, mediaBinaryPath,
  type MediaConfig,
} from "../../src/mediaIngest.ts";
import {
  validateMediaScopeCard, parseMediaScopeCard, addMediaScope, removeMediaScope,
  listMediaScopes, loadMediaScopeStore, resolveMediaScope, checkMediaUrl,
  defaultMediaScope, REQUIRED_FORBIDDEN_MEDIA, mediaScopeStorePath,
  type MediaScopeCard,
} from "../../src/mediaScopes.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";
import {
  HOOKED_TOOLS, MUTATING_TOOLS, SESSION_FILE_TOOLS, executeTool, newToolContext,
  type ToolContext,
} from "../../src/tools.ts";
import { DEFAULT_REVIEWED_TOOLS } from "../../src/reviewer.ts";

type Runner = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

const MP3_BYTES = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(1024, 0x61)]);
const PROBE_JSON = { title: "测试视频", duration: 120, availability: "public", is_live: false };
const SUBS_VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n字幕第一行\n\n00:00:03.000 --> 00:00:05.000\n字幕第二行\n";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-media-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-media-wd-"));
  return { home, workdir };
}

function enabledConfig(home: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  saveConfig(home, { media: { enabled: true }, ...extra });
  return loadConfig(home) as Record<string, unknown>;
}

function validCard(over: Partial<MediaScopeCard> = {}): MediaScopeCard {
  return { ...defaultMediaScope(), ...over };
}

/** 假 yt-dlp + 假 whisper + 假 gpg：按命令与参数写文件、回固定输出，不联网。 */
function makeFakeRunner(opts: {
  probeJson?: Record<string, unknown>;
  probeStatus?: number;
  probeStderr?: string;
  subsVtt?: string | null;
  autoSubsVtt?: string | null;
  audioBytes?: Buffer | null;
  whisperText?: string;
  gpgMissing?: boolean;
  gpgVerifyStatus?: number;
  gpgVerifyStderr?: string;
} = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Runner = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const base = cmd.split("/").pop() ?? cmd;
    if (base === "yt-dlp" || base === "yt-dlp.exe" || base === "yt-dlp_linux" || base === "yt-dlp_macos") {
      if (args[0] === "--version") return { status: 0, stdout: "2026.10.26\n", stderr: "" };
      if (args.includes("--dump-json")) {
        if ((opts.probeStatus ?? 0) !== 0) return { status: opts.probeStatus ?? 1, stdout: "", stderr: opts.probeStderr ?? "" };
        return { status: 0, stdout: JSON.stringify(opts.probeJson ?? PROBE_JSON), stderr: "" };
      }
      if (args.includes("--write-subs") || args.includes("--write-auto-subs")) {
        const oi = args.indexOf("-o");
        const dir = oi !== -1 ? dirname(args[oi + 1] as string) : tmpdir();
        const vtt = args.includes("--write-subs") ? opts.subsVtt : opts.autoSubsVtt;
        if (vtt !== null && vtt !== undefined) writeFileSync(join(dir, "subs.zh.vtt"), vtt, "utf-8");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args.includes("-x")) {
        const oi = args.indexOf("-o");
        const dir = oi !== -1 ? dirname(args[oi + 1] as string) : tmpdir();
        if (opts.audioBytes !== null && opts.audioBytes !== undefined) {
          writeFileSync(join(dir, "audio.mp3"), opts.audioBytes);
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (base === "whisper-cli" || base === "whisper") {
      if (args[0] === "--help") return { status: 0, stdout: "", stderr: "" };
      const oi = args.indexOf("--output-file");
      if (oi !== -1) writeFileSync(`${args[oi + 1]}.txt`, opts.whisperText ?? "这是转写出来的文字", "utf-8");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (base === "ffmpeg") return { status: 0, stdout: "", stderr: "" };
    if (base === "gpg") {
      if (args[0] === "--version") {
        return opts.gpgMissing
          ? { status: null, stdout: "", stderr: "not found" }
          : { status: 0, stdout: "gpg 2.4", stderr: "" };
      }
      if (args[0] === "--verify") {
        return { status: opts.gpgVerifyStatus ?? 0, stdout: "", stderr: opts.gpgVerifyStderr ?? "" };
      }
    }
    return { status: null, stdout: "", stderr: `找不到命令 ${cmd}` };
  };
  return { run, calls };
}

function fakeResp(buf: Buffer): Response {
  return {
    ok: true, status: 200,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    json: async () => JSON.parse(buf.toString("utf-8")),
    text: async () => buf.toString("utf-8"),
  } as unknown as Response;
}

function fakeFetchFactory(files: Record<string, Buffer | string>): typeof fetch {
  return (async (url: string | URL) => {
    const key = String(url);
    if (key.includes("api.github.com")) {
      return fakeResp(Buffer.from(JSON.stringify({ tag_name: "2026.10.26" }), "utf-8"));
    }
    const body = files[key];
    if (body === undefined) {
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}), text: async () => "" } as unknown as Response;
    }
    return fakeResp(typeof body === "string" ? Buffer.from(body, "utf-8") : body);
  }) as unknown as typeof fetch;
}

/** setup 测试用的假 release：三个平台的二进制 + 三行 SHA2-256SUMS 全给齐，
 * 否则 Windows/macOS 上 installYtDlp 要的 yt-dlp.exe / yt-dlp_macos 没 mock、
 * 真请求会 404（Node CI #401 的 5 个失败就是这么来的）。 */
const SETUP_BASE = "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26";
function setupFetch(bin: Buffer, sumsSha: string, withSig = true): typeof fetch {
  const files: Record<string, Buffer | string> = {
    [`${SETUP_BASE}/yt-dlp_linux`]: bin,
    [`${SETUP_BASE}/yt-dlp_macos`]: bin,
    [`${SETUP_BASE}/yt-dlp.exe`]: bin,
    [`${SETUP_BASE}/SHA2-256SUMS`]: `${sumsSha}  yt-dlp_linux\n${sumsSha}  yt-dlp_macos\n${sumsSha}  yt-dlp.exe\n`,
  };
  if (withSig) files[`${SETUP_BASE}/SHA2-256SUMS.sig`] = "fake-sig";
  return fakeFetchFactory(files);
}

// ---- 范围卡 ----

test("MediaIngestTest.test_scope_requires_all_five_red_lines", () => {
  const card = validCard({ forbidden: REQUIRED_FORBIDDEN_MEDIA.slice(0, 4) });
  const errors = validateMediaScopeCard(card);
  expect(errors.join("")).toContain("缺少红线");
  expect(errors.join("")).toContain("再分发");
  expect(validateMediaScopeCard(validCard())).toEqual([]);
});

test("MediaIngestTest.test_scope_cookies_always_forbidden", () => {
  const card = validCard({ allow_cookies: true });
  const errors = validateMediaScopeCard(card);
  expect(errors.join("")).toContain("cookies 一律禁用");
});

test("MediaIngestTest.test_scope_store_roundtrip", () => {
  const { home } = setup();
  const card = validCard({ name: "mine", allowed_hosts: ["example.com"] });
  addMediaScope(home, card);
  expect(listMediaScopes(home).map((s) => s.name)).toEqual(["mine"]);
  expect(loadMediaScopeStore(home).scopes[0]?.allowed_hosts).toEqual(["example.com"]);
  expect(parseMediaScopeCard(JSON.stringify(card)).name).toBe("mine");
  expect(removeMediaScope(home, "mine")).toBe(true);
  expect(listMediaScopes(home)).toEqual([]);
});

test("MediaIngestTest.test_scope_store_corrupt_backed_up", () => {
  const { home } = setup();
  writeFileSync(mediaScopeStorePath(home), "{不是 json", "utf-8");
  expect(() => loadMediaScopeStore(home)).toThrow(/账本损坏，已备份/);
  expect(existsSync(mediaScopeStorePath(home))).toBe(false);
});

test("MediaIngestTest.test_scope_url_check", () => {
  const card = defaultMediaScope();
  expect(checkMediaUrl(card, "https://www.youtube.com/watch?v=abc").inScope).toBe(true);
  expect(checkMediaUrl(card, "https://youtu.be/abc").inScope).toBe(true);
  expect(checkMediaUrl(card, "https://example.com/watch").inScope).toBe(false);
  expect(checkMediaUrl(card, "https://user:pass@www.youtube.com/watch").inScope).toBe(false);
  expect(checkMediaUrl(card, "ftp://www.youtube.com/x").inScope).toBe(false);
  const expired = validCard({ expires_at: "2020-01-01T00:00:00Z" });
  expect(checkMediaUrl(expired, "https://www.youtube.com/watch").inScope).toBe(false);
});

test("MediaIngestTest.test_scope_default_when_no_store", () => {
  const { home } = setup();
  const card = resolveMediaScope(home);
  expect(card.name).toBe("default");
  expect(card.allowed_hosts).toContain("youtube.com");
  expect(card.forbidden).toEqual([...REQUIRED_FORBIDDEN_MEDIA]);
});

// ---- 配置与 VTT ----

test("MediaIngestTest.test_config_falls_back_on_invalid", () => {
  const cfg = resolveMediaConfig({ media: { enabled: true, max_duration_seconds: -5, max_bytes: "x", rate_limit: "abc", sub_langs: "" } });
  expect(cfg.enabled).toBe(true);
  expect(cfg.maxDurationSeconds).toBe(3600);
  expect(cfg.maxBytes).toBe(2 * 1024 * 1024 * 1024);
  expect(cfg.rateLimit).toBe("1M");
  expect(cfg.subLangs).toBe("zh,en");
  expect(resolveMediaConfig({}).enabled).toBe(false);
});

test("MediaIngestTest.test_parse_vtt_strips_timestamps_and_tags", () => {
  const text = parseVtt("WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\n<c.color>你好</c>世界\n\n00:00:03.000 --> 00:00:05.000\n你好世界\n\n00:00:05.000 --> 00:00:07.000\n第二行 &amp; 更多\n");
  expect(text).toBe("你好世界\n第二行 & 更多");
  expect(parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n")).toBe("");
});

// ---- 探查与 DRM 判定 ----

test("MediaIngestTest.test_probe_refuses_non_public", () => {
  const { run } = makeFakeRunner({ probeJson: { ...PROBE_JSON, availability: "premium_only" } });
  expect(() => probeMedia("https://www.youtube.com/watch?v=x", "yt-dlp", run)).toThrow(/不是公开视频/);
});

test("MediaIngestTest.test_probe_refuses_login_error", () => {
  const { run } = makeFakeRunner({ probeStatus: 1, probeStderr: "ERROR: This video is only available to Music Premium members. Sign in to confirm." });
  expect(() => probeMedia("https://www.youtube.com/watch?v=x", "yt-dlp", run)).toThrow(/疑似 DRM\/付费墙/);
});

test("MediaIngestTest.test_probe_refuses_live", () => {
  const { run } = makeFakeRunner({ probeJson: { ...PROBE_JSON, is_live: true } });
  expect(() => probeMedia("https://www.youtube.com/watch?v=x", "yt-dlp", run)).toThrow(/直播内容暂不支持/);
});

// ---- 流水线：字幕优先、whisper 兜底 ----

test("MediaIngestTest.test_ingest_subtitles_first_no_audio_download", async () => {
  const { home } = setup();
  const config = enabledConfig(home);
  const { run, calls } = makeFakeRunner({ subsVtt: SUBS_VTT });
  const result = await ingestMedia({
    url: "https://www.youtube.com/watch?v=abc", home, config, runCommand: run,
  });
  expect(result.source).toBe("subs");
  expect(result.text).toBe("字幕第一行\n字幕第二行");
  expect(result.costUsd).toBeNull();
  expect(result.bytes).toBe(0);
  expect(calls.some((c) => c.args.includes("-x"))).toBe(false);
  expect(calls.some((c) => c.args.includes("--write-subs"))).toBe(true);
  expect(calls.some((c) => c.args.includes("--no-playlist"))).toBe(true);
  expect(calls.flatMap((c) => c.args).some((a) => a.includes("cookies"))).toBe(false);
  const formatted = formatMediaTranscript(result);
  expect(formatted).toContain("标题：测试视频");
  expect(formatted).toContain("转写来源：字幕（免费、零 token）");
});

test("MediaIngestTest.test_ingest_auto_subs_when_no_manual_subs", async () => {
  const { home } = setup();
  const config = enabledConfig(home);
  const { run } = makeFakeRunner({ subsVtt: null, autoSubsVtt: SUBS_VTT });
  const result = await ingestMedia({
    url: "https://www.youtube.com/watch?v=abc", home, config, runCommand: run,
  });
  expect(result.source).toBe("auto-subs");
  expect(result.text).toContain("字幕第一行");
});

test("MediaIngestTest.test_ingest_whisper_fallback_without_subs", async () => {
  const { home } = setup();
  const modelFile = join(home, "ggml-tiny.bin");
  writeFileSync(modelFile, "fake-model");
  const config = enabledConfig(home, { voice: { stt_local_model: modelFile } });
  const { run, calls } = makeFakeRunner({ subsVtt: null, autoSubsVtt: null, audioBytes: MP3_BYTES });
  const result = await ingestMedia({
    url: "https://www.youtube.com/watch?v=abc", home, config, runCommand: run,
  });
  expect(result.source).toBe("whisper.cpp");
  expect(result.text).toBe("这是转写出来的文字");
  expect(result.bytes).toBe(MP3_BYTES.length);
  expect(result.costUsd).toBeNull();
  expect(calls.some((c) => c.args.includes("-x"))).toBe(true);
  expect(calls.some((c) => c.args.includes("--max-filesize"))).toBe(true);
  expect(calls.some((c) => c.args.includes("--limit-rate"))).toBe(true);
});

test("MediaIngestTest.test_ingest_refuses_out_of_scope_url", async () => {
  const { home } = setup();
  const config = enabledConfig(home);
  const { run } = makeFakeRunner();
  await expect(ingestMedia({
    url: "https://example.com/watch", home, config, runCommand: run,
  })).rejects.toThrow(/不在媒体范围内/);
});

test("MediaIngestTest.test_ingest_refuses_when_disabled", async () => {
  const { home } = setup();
  const config = loadConfig(home) as Record<string, unknown>;
  const { run } = makeFakeRunner();
  await expect(ingestMedia({
    url: "https://www.youtube.com/watch?v=abc", home, config, runCommand: run,
  })).rejects.toThrow(/媒体抓取未开启/);
});

test("MediaIngestTest.test_ingest_refuses_too_long_video", async () => {
  const { home } = setup();
  const config = enabledConfig(home);
  const { run } = makeFakeRunner({ probeJson: { ...PROBE_JSON, duration: 7200 } });
  await expect(ingestMedia({
    url: "https://www.youtube.com/watch?v=abc", home, config, runCommand: run,
  })).rejects.toThrow(/视频太长/);
});

test("MediaIngestTest.test_ingest_refuses_missing_binary", async () => {
  const { home } = setup();
  const config = enabledConfig(home);
  const run: Runner = () => ({ status: null, stdout: "", stderr: "not found" });
  await expect(ingestMedia({
    url: "https://www.youtube.com/watch?v=abc", home, config, runCommand: run,
  })).rejects.toThrow(/nyra media setup/);
});

// ---- 上限 ----

test("MediaIngestTest.test_extract_audio_size_cap", () => {
  const cfg: MediaConfig = { enabled: true, maxDurationSeconds: 3600, maxBytes: 100, rateLimit: "1M", subLangs: "zh,en" };
  const dir = mkdtempSync(join(tmpdir(), "nyra-media-cap-"));
  const { run } = makeFakeRunner({ audioBytes: MP3_BYTES });
  expect(() => extractAudio("https://www.youtube.com/watch?v=abc", "yt-dlp", cfg, dir, run)).toThrow(/音频太大/);
});

// ---- setup：SHA256 与 GPG ----

test("MediaIngestTest.test_setup_sha256_ok_without_gpg", async () => {
  const { home } = setup();
  const bin = Buffer.from("fake-yt-dlp-binary-bytes");
  const sha = createHash("sha256").update(bin).digest("hex");
  const fetchFn = setupFetch(bin, sha);
  const { run } = makeFakeRunner({ gpgMissing: true });
  const result = await installYtDlp(home, { fetchFn, runCommand: run });
  expect(result.shaVerified).toBe(true);
  expect(result.gpgVerified).toBeNull();
  expect(result.gpgNote).toContain("没有 gpg");
  expect(existsSync(result.path)).toBe(true);
  expect(readFileSync(result.path).equals(bin)).toBe(true);
  if (process.platform !== "win32") expectPerms(result.path, 0o700);
});

test("MediaIngestTest.test_setup_sha256_mismatch_refuses", async () => {
  const { home } = setup();
  const bin = Buffer.from("fake-yt-dlp-binary-bytes");
  const fetchFn = setupFetch(bin, "0".repeat(64), false);
  const { run } = makeFakeRunner();
  await expect(installYtDlp(home, { fetchFn, runCommand: run })).rejects.toThrow(/SHA256 校验失败/);
  expect(existsSync(mediaBinaryPath(home))).toBe(false);
});

test("MediaIngestTest.test_setup_gpg_verified_when_key_present", async () => {
  const { home } = setup();
  const bin = Buffer.from("fake-yt-dlp-binary-bytes");
  const sha = createHash("sha256").update(bin).digest("hex");
  const fetchFn = setupFetch(bin, sha);
  const { run } = makeFakeRunner({ gpgVerifyStatus: 0 });
  const result = await installYtDlp(home, { fetchFn, runCommand: run });
  expect(result.gpgVerified).toBe(true);
  expect(result.gpgNote).toBeNull();
});

test("MediaIngestTest.test_setup_gpg_bad_signature_refuses", async () => {
  const { home } = setup();
  const bin = Buffer.from("fake-yt-dlp-binary-bytes");
  const sha = createHash("sha256").update(bin).digest("hex");
  const fetchFn = setupFetch(bin, sha);
  const { run } = makeFakeRunner({ gpgVerifyStatus: 1, gpgVerifyStderr: "gpg: BAD signature" });
  await expect(installYtDlp(home, { fetchFn, runCommand: run })).rejects.toThrow(/GPG 签名校验失败/);
  expect(existsSync(mediaBinaryPath(home))).toBe(false);
});

test("MediaIngestTest.test_setup_asset_name_per_platform", () => {
  expect(ytDlpAssetName("win32")).toBe("yt-dlp.exe");
  expect(ytDlpAssetName("darwin")).toBe("yt-dlp_macos");
  expect(ytDlpAssetName("linux")).toBe("yt-dlp_linux");
});

test("MediaIngestTest.test_setup_win32_and_darwin_assets", async () => {
  const { home } = setup();
  const bin = Buffer.from("fake-yt-dlp-binary-bytes");
  const sha = createHash("sha256").update(bin).digest("hex");
  const fetchFn = setupFetch(bin, sha);
  const { run } = makeFakeRunner({ gpgMissing: true });
  for (const platform of ["win32", "darwin"]) {
    const result = await installYtDlp(home, { fetchFn, runCommand: run, platform });
    expect(result.shaVerified).toBe(true);
    expect(existsSync(result.path)).toBe(true);
  }
  expect(existsSync(join(home, "bin", "yt-dlp.exe"))).toBe(true);
  expect(existsSync(mediaBinaryPath(home))).toBe(true);
});

test("MediaIngestTest.test_find_sha256_parses_sums", () => {
  expect(findSha256(`${"a".repeat(64)}  yt-dlp_linux\n${"b".repeat(64)} *yt-dlp_macos\n`, "yt-dlp_macos")).toBe("b".repeat(64));
  expect(findSha256("nope\n", "yt-dlp_linux")).toBeNull();
});

// ---- 工具接线 ----

test("MediaIngestTest.test_tool_sets_include_media_ingest", () => {
  expect(MUTATING_TOOLS.has("media_ingest")).toBe(true);
  expect(HOOKED_TOOLS.has("media_ingest")).toBe(true);
  expect(SESSION_FILE_TOOLS.has("media_ingest")).toBe(true);
  expect(DEFAULT_REVIEWED_TOOLS).toContain("media_ingest");
});

test("MediaIngestTest.test_tool_ingest_end_to_end", async () => {
  const { home, workdir } = setup();
  enabledConfig(home);
  const { run } = makeFakeRunner({ subsVtt: SUBS_VTT });
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  const ctx: ToolContext = newToolContext({
    workdir, home, mode: "full", interactive: false,
    mediaRunner: run, onEvent: (kind, data) => events.push({ kind, data }),
  });
  const result = await executeTool("media_ingest", {
    url: "https://www.youtube.com/watch?v=abc", out: "out/转写.txt",
  }, ctx);
  expect(result).toContain("已抓取 out/转写.txt");
  const target = join(workdir, "out", "转写.txt");
  expect(existsSync(target)).toBe(true);
  expectPerms(target, 0o600);
  expect(readFileSync(target, "utf-8")).toContain("字幕第一行");
  const ingested = events.find((e) => e.kind === "media_ingested");
  expect(ingested).toBeDefined();
  expect(ingested?.data.host).toBe("www.youtube.com");
  expect(ingested?.data.source).toBe("subs");
  expect(ingested?.data.duration_seconds).toBe(120);
  expect(ingested?.data.bytes).toBe(0);
  expect(String(ingested?.data.text_hash)).toMatch(/^[0-9a-f]{12}$/);
  expect(ingested?.data.cost_usd).toBeNull();
  // 事件里不记转写原文、完整 URL 与绝对路径。
  expect(JSON.stringify(ingested?.data)).not.toContain("字幕第一行");
  expect(JSON.stringify(ingested?.data)).not.toContain("watch?v=");
  expect(JSON.stringify(ingested?.data)).not.toContain(workdir);
});

test("MediaIngestTest.test_tool_ingest_approval_refusal", async () => {
  const { home, workdir } = setup();
  enabledConfig(home);
  const { run } = makeFakeRunner({ subsVtt: SUBS_VTT });
  const ctx = newToolContext({ workdir, home, mode: "auto", interactive: true, approveFn: async () => false, mediaRunner: run });
  const result = await executeTool("media_ingest", {
    url: "https://www.youtube.com/watch?v=abc", out: "out/转写.txt",
  }, ctx);
  expect(result.startsWith("错误")).toBe(true);
  expect(existsSync(join(workdir, "out", "转写.txt"))).toBe(false);
});

test("MediaIngestTest.test_tool_ingest_path_escape_refused", async () => {
  const { home, workdir } = setup();
  enabledConfig(home);
  const { run } = makeFakeRunner({ subsVtt: SUBS_VTT });
  const ctx = newToolContext({ workdir, home, mode: "full", interactive: false, mediaRunner: run });
  const result = await executeTool("media_ingest", {
    url: "https://www.youtube.com/watch?v=abc", out: "../逃逸.txt",
  }, ctx);
  expect(result.startsWith("错误")).toBe(true);
  expect(existsSync(join(workdir, "..", "逃逸.txt"))).toBe(false);
});

test("MediaIngestTest.test_tool_ingest_backend_refused", async () => {
  const { home, workdir } = setup();
  enabledConfig(home);
  const { run } = makeFakeRunner({ subsVtt: SUBS_VTT });
  const ctx = newToolContext({ workdir, home, mode: "full", interactive: false, backend: { name: "e2b" }, mediaRunner: run });
  const result = await executeTool("media_ingest", {
    url: "https://www.youtube.com/watch?v=abc", out: "out/转写.txt",
  }, ctx);
  expect(result).toContain("远端后端不支持");
  expect(existsSync(join(workdir, "out", "转写.txt"))).toBe(false);
});

test("MediaIngestTest.test_tool_ingest_disabled_refused", async () => {
  const { home, workdir } = setup();
  const { run } = makeFakeRunner({ subsVtt: SUBS_VTT });
  const ctx = newToolContext({ workdir, home, mode: "full", interactive: false, mediaRunner: run });
  const result = await executeTool("media_ingest", {
    url: "https://www.youtube.com/watch?v=abc",
  }, ctx);
  expect(result).toContain("媒体抓取未开启");
});

// ---- 时间线渲染 ----

test("MediaIngestTest.test_timeline_renders_media_event", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-media-tl-"));
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  const runId = state.run_id;
  writeFileSync(join(home, "runs", runId, "events.jsonl"), [
    JSON.stringify({ at: state.created_at, type: "media_ingested", host: "www.youtube.com", title_hash: "abc123def456", duration_seconds: 120, bytes: 0, source: "subs", text_hash: "def456abc123", cost_usd: null }),
  ].join("\n") + "\n");
  const tl = buildTimeline(store, runId);
  const text = formatTimelineText(tl);
  expect(text).toContain("抓取媒体转写");
  expect(text).toContain("www.youtube.com");
  expect(text).toContain("subs");
});

// ---- CLI 端到端 ----

test("MediaIngestTest.test_cli_status_enable_disable", async () => {
  const { home, workdir } = setup();
  const out: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out.push(s); return true; }) as typeof process.stdout.write;
  try {
    expect(await handleMedia(["status"], home, workdir)).toBe(0);
    expect(out.join("")).toContain("未开启");
    expect(await handleMedia(["enable"], home, workdir)).toBe(0);
    expect((loadConfig(home) as Record<string, unknown>).media).toMatchObject({ enabled: true });
    expect(await handleMedia(["disable"], home, workdir)).toBe(0);
    expect((loadConfig(home) as Record<string, unknown>).media).toMatchObject({ enabled: false });
    expect(await handleMedia(["bogus"], home, workdir)).toBe(2);
  } finally {
    process.stdout.write = origWrite;
  }
});

test("MediaIngestTest.test_cli_ingest_end_to_end", async () => {
  const { home, workdir } = setup();
  enabledConfig(home);
  const { run } = makeFakeRunner({ subsVtt: SUBS_VTT });
  expect(await handleMedia(["ingest", "https://www.youtube.com/watch?v=abc", "--out", "转写.txt"], home, workdir, { runCommand: run })).toBe(0);
  const target = join(workdir, "转写.txt");
  expect(existsSync(target)).toBe(true);
  expect(readFileSync(target, "utf-8")).toContain("字幕第二行");
  expect(await handleMedia(["ingest"], home, workdir)).toBe(2);
  expect(await handleMedia(["ingest", "https://a.com/x", "https://b.com/y"], home, workdir, { runCommand: run })).toBe(2);
});

test("MediaIngestTest.test_cli_scope_list_add_remove", async () => {
  const { home, workdir } = setup();
  const out: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out.push(s); return true; }) as typeof process.stdout.write;
  try {
    expect(await handleMedia(["scope", "list"], home, workdir)).toBe(0);
    expect(out.join("")).toContain("内置默认卡");
    const cardFile = join(workdir, "card.json");
    writeFileSync(cardFile, JSON.stringify(validCard({ name: "mine", allowed_hosts: ["example.com"] })), "utf-8");
    expect(await handleMedia(["scope", "add", "card.json"], home, workdir)).toBe(0);
    expect(listMediaScopes(home).map((s) => s.name)).toEqual(["mine"]);
    expect(await handleMedia(["scope", "check", "https://example.com/x", "--scope", "mine"], home, workdir)).toBe(0);
    expect(await handleMedia(["scope", "check", "https://www.youtube.com/watch"], home, workdir)).toBe(0);
    expect(await handleMedia(["scope", "check", "https://example.com/x"], home, workdir)).toBe(3);
    expect(await handleMedia(["scope", "remove", "mine"], home, workdir)).toBe(0);
    expect(listMediaScopes(home)).toEqual([]);
  } finally {
    process.stdout.write = origWrite;
  }
});

test("MediaIngestTest.test_cli_setup_end_to_end", async () => {
  const { home, workdir } = setup();
  const bin = Buffer.from("fake-yt-dlp-binary-bytes");
  const sha = createHash("sha256").update(bin).digest("hex");
  const fetchFn = setupFetch(bin, sha);
  const { run } = makeFakeRunner({ gpgMissing: true });
  expect(await handleMedia(["setup"], home, workdir, { fetchFn, runCommand: run })).toBe(0);
  expect(existsSync(mediaBinaryPath(home))).toBe(true);
});
