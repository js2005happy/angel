// tests/node/test-vision-input.test.ts — 缺口 16：图像 / 视频输入。
// 假视觉模型 + 假图片字节 + 假 ffmpeg：覆盖 magic bytes 校验、超限拒绝、
// 不能看图的模型拒绝、采样上限、临时帧处理完即删、事件里只有哈希没有图片
// 内容、用量账本记了视觉花费、CLI 端到端（有图/无图/坏图）。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, AgentError } from "../../src/agent.ts";
import { RunStore, RunRecorder } from "../../src/runs.ts";
import { buildTimeline } from "../../src/timeline.ts";
import {
  DEFAULT_VISION_CONFIG, buildVisionUserMessage, downloadVideo, extractVideoFrames,
  loadImageFile, modelSupportsVision, prepareImageInput, prepareVisionInputs,
  resolveVisionConfig, visionGateMessage, type VisionConfig, type VisionImageInput,
  type CommandRunner,
} from "../../src/vision.ts";
import { executeTool, newToolContext } from "../../src/tools.ts";
import { parseArgs, validateVisionArgs, attachVisionInputs } from "../../src/cli.ts";

/** 1x1 透明 PNG（67 字节，真 magic bytes）。 */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 0x20)]);
const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(20, 0x20)]);
const GIF_BYTES = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40, 0x20)]);
const TEXT_BYTES = Buffer.from("这是一段文字，不是图片", "utf-8");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-vision-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-vision-wd-"));
  return { home, workdir };
}

class FakeProvider {
  name = "fake"; model: string; baseUrl = "https://fake.invalid";
  calls: Record<string, unknown>[][] = [];
  script: Record<string, unknown>[];
  idx = 0;
  constructor(script: Record<string, unknown>[], model = "gpt-4o-mini") { this.script = script; this.model = model; }
  hasCredentials() { return true; }
  redact(t: string) { return t; }
  async listModels() { return [this.model]; }
  async chat(messages: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    this.calls.push(messages);
    const next = this.script[Math.min(this.idx, this.script.length - 1)];
    this.idx += 1;
    return next;
  }
}

function textReply(text: string): Record<string, unknown> {
  return { choices: [{ message: { content: text, tool_calls: [] } }] };
}
function withUsage(reply: Record<string, unknown>): Record<string, unknown> {
  return { ...reply, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
}

function pngInput(source = "cat.png"): VisionImageInput {
  return prepareImageInput(PNG_BYTES, source, DEFAULT_VISION_CONFIG);
}

// ---- 校验：magic bytes 与上限 ----

test("VisionInputTest.test_magic_bytes_recognized", () => {
  expect(prepareImageInput(PNG_BYTES, "a.png", DEFAULT_VISION_CONFIG).mime).toBe("image/png");
  expect(prepareImageInput(JPEG_BYTES, "a.jpg", DEFAULT_VISION_CONFIG).mime).toBe("image/jpeg");
  expect(prepareImageInput(WEBP_BYTES, "a.webp", DEFAULT_VISION_CONFIG).mime).toBe("image/webp");
  expect(prepareImageInput(GIF_BYTES, "a.gif", DEFAULT_VISION_CONFIG).mime).toBe("image/gif");
  // 扩展名说了不算：.png 里装文字照样拒绝。
  expect(() => prepareImageInput(TEXT_BYTES, "fake.png", DEFAULT_VISION_CONFIG)).toThrow("不是支持的格式");
  expect(() => prepareImageInput(Buffer.alloc(0), "empty.png", DEFAULT_VISION_CONFIG)).toThrow("空文件");
});

test("VisionInputTest.test_oversize_rejected", () => {
  const cfg: VisionConfig = { ...DEFAULT_VISION_CONFIG, maxBytes: 10 };
  expect(() => prepareImageInput(PNG_BYTES, "big.png", cfg)).toThrow("超过");
  expect(() => loadImageFile("missing.png", "/tmp", DEFAULT_VISION_CONFIG)).toThrow("图片不存在");
  const { workdir } = setup();
  writeFileSync(join(workdir, "cat.png"), PNG_BYTES);
  expect(loadImageFile("cat.png", workdir, DEFAULT_VISION_CONFIG).mime).toBe("image/png");
  // 绝对路径同样能读（相对 workdir 解析，resolve 会原样接受绝对路径）。
  expect(loadImageFile(join(workdir, "cat.png"), workdir, DEFAULT_VISION_CONFIG).mime).toBe("image/png");
});

test("VisionInputTest.test_resolve_vision_config_fallbacks", () => {
  expect(resolveVisionConfig({})).toEqual(DEFAULT_VISION_CONFIG);
  const bad = resolveVisionConfig({ vision: { max_bytes: -5, max_frames: 0, max_images: "x", video_max_bytes: 10, max_videos: 99 } });
  expect(bad).toEqual(DEFAULT_VISION_CONFIG); // 非法值一律回退默认值，不抛错
  const ok = resolveVisionConfig({ vision: { max_frames: 3, max_images: 2 } });
  expect(ok.maxFrames).toBe(3);
  expect(ok.maxImages).toBe(2);
  expect(ok.maxBytes).toBe(DEFAULT_VISION_CONFIG.maxBytes);
});

// ---- 模型门禁 ----

test("VisionInputTest.test_model_gate", () => {
  expect(modelSupportsVision("grok-4.3").supported).toBe(true);
  expect(modelSupportsVision("grok-4.5").supported).toBe(true);
  expect(modelSupportsVision("gpt-4o-mini").supported).toBe(true);
  const deep = modelSupportsVision("deepseek-flash");
  expect(deep.supported).toBe(false);
  expect(deep.source).toBe("catalog");
  const unknown = modelSupportsVision("some-new-model-xyz");
  expect(unknown.supported).toBe(false); // 未知模型默认看不了图，宁可拒绝
  const msg = visionGateMessage("deepseek-flash");
  expect(msg).toContain("deepseek-flash");
  expect(msg).toContain("看不了图");
  expect(msg).toContain("grok-4.3"); // 给用户指路：换哪个模型
});

test("VisionInputTest.test_agent_refuses_non_vision_model_without_burning_tokens", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([withUsage(textReply("不该被调用"))], "deepseek-flash");
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [], visionInputs: [pngInput()],
  });
  await expect(agent.run("描述这张图")).rejects.toThrow("看不了图");
  expect(provider.calls.length).toBe(0); // 门禁在首轮调用前拒绝，没烧 token
});

// ---- 首轮带图进主循环 + 证据链 + 用量 ----

test("VisionInputTest.test_first_turn_sends_image_and_records_hash_only_event", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([withUsage(textReply("图里是一只猫"))], "gpt-4o-mini");
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [], visionInputs: [pngInput()],
  });
  const store = new RunStore(join(home, "runs"));
  const recorder = new RunRecorder(store, agent, "描述这张图", {});
  const out = await agent.run("描述这张图");
  expect(out).toContain("一只猫");
  // 第一轮发给模型的用户消息是多段 content：文本 + 图片。
  const firstCall = provider.calls[0];
  const userMsg = firstCall[1] as Record<string, unknown>;
  expect(userMsg.role).toBe("user");
  const parts = userMsg.content as Record<string, unknown>[];
  expect(parts[0]).toEqual({ type: "text", text: "描述这张图" });
  const imgPart = parts[1] as Record<string, unknown>;
  expect(imgPart.type).toBe("image_url");
  const url = ((imgPart.image_url as Record<string, unknown>).url as string);
  expect(url.startsWith("data:image/png;base64,")).toBe(true);
  expect(url).toContain(PNG_BYTES.toString("base64"));
  // 用完即清，不会重发。
  expect(agent.visionInputs.length).toBe(0);
  // 事件里只有哈希没有图片内容。
  const events = store.readEvents(recorder.runId);
  const visionEv = events.find((e) => e.type === "vision_input");
  expect(visionEv).toBeDefined();
  expect(visionEv!.count).toBe(1);
  expect(visionEv!.model).toBe("gpt-4o-mini");
  expect(visionEv!.kinds).toBe("image");
  expect(String(visionEv!.hashes)).toMatch(/^[0-9a-f]{12}$/);
  expect(JSON.stringify(visionEv)).not.toContain(PNG_BYTES.toString("base64"));
  expect(JSON.stringify(visionEv)).not.toContain("iVBORw0K");
  // 时间线能直接读出“看了几张图”。
  const tl = buildTimeline(store, recorder.runId);
  expect(tl.steps.some((s) => s.title.includes("看了 1 张图"))).toBe(true);
  // 用量账本记了这次视觉调用的花费（与成本硬顶同口径）。
  const snap = agent.usage.snapshot();
  expect(snap.calls).toBe(1);
  expect(snap.prompt_tokens).toBe(100);
  expect(snap.completion_tokens).toBe(50);
});

test("VisionInputTest.test_build_vision_user_message", () => {
  const msg = buildVisionUserMessage("看看", [pngInput("a.png"), pngInput("b.png")]);
  const parts = msg.content as Record<string, unknown>[];
  expect(parts.length).toBe(3);
  expect(parts[0]).toEqual({ type: "text", text: "看看" });
  expect(parts[1].type).toBe("image_url");
});

// ---- 视频：抽帧 + 临时文件处理完即删 ----

test("VisionInputTest.test_extract_video_frames_fake_ffmpeg_and_temp_cleanup", () => {
  const { workdir } = setup();
  const videoPath = join(workdir, "clip.mp4");
  writeFileSync(videoPath, Buffer.alloc(1024, 0));
  const seenDirsBefore = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith("nyra-video-frames-")));
  const calls: string[][] = [];
  const runner: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "ffprobe") return { status: 0, stdout: "30\n", stderr: "" };
    // ffmpeg：按输出模板写 3 帧 PNG。
    const pattern = args[args.length - 1];
    for (let i = 1; i <= 3; i++) {
      writeFileSync(pattern.replace("%03d", String(i).padStart(3, "0")), PNG_BYTES);
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const frames = extractVideoFrames(videoPath, DEFAULT_VISION_CONFIG, runner);
  expect(frames.length).toBe(3);
  expect(frames.every((f) => f.sourceKind === "video-frame" && f.mime === "image/png")).toBe(true);
  expect(frames.map((f) => f.frameIndex)).toEqual([1, 2, 3]);
  expect(calls[0][0]).toBe("ffprobe");
  expect(calls[1][0]).toBe("ffmpeg");
  // 临时帧目录处理完即删（不留 nyra-video-frames-*）。
  const leftovers = readdirSync(tmpdir()).filter((d) => d.startsWith("nyra-video-frames-") && !seenDirsBefore.has(d));
  expect(leftovers).toEqual([]);
});

test("VisionInputTest.test_extract_video_frames_rejects_bad_inputs", () => {
  const { workdir } = setup();
  const runner: CommandRunner = () => ({ status: 0, stdout: "", stderr: "" });
  expect(() => extractVideoFrames(join(workdir, "nope.mp4"), DEFAULT_VISION_CONFIG, runner)).toThrow("视频不存在");
  const badExt = join(workdir, "clip.txt");
  writeFileSync(badExt, Buffer.alloc(10, 0));
  expect(() => extractVideoFrames(badExt, DEFAULT_VISION_CONFIG, runner)).toThrow("格式不支持");
  const big = join(workdir, "big.mp4");
  writeFileSync(big, Buffer.alloc(100, 0));
  expect(() => extractVideoFrames(big, { ...DEFAULT_VISION_CONFIG, videoMaxBytes: 10 }, runner)).toThrow("太大");
  // ffmpeg 缺失（status null）直接报错，不静默降级。
  const missing: CommandRunner = () => ({ status: null, stdout: "", stderr: "spawn ffmpeg ENOENT" });
  const clip = join(workdir, "clip.mp4");
  writeFileSync(clip, Buffer.alloc(100, 0));
  expect(() => extractVideoFrames(clip, DEFAULT_VISION_CONFIG, missing)).toThrow("没有 ffmpeg");
});

test("VisionInputTest.test_prepare_vision_inputs_limits", async () => {
  const { workdir } = setup();
  const cfg = { vision: { max_images: 2, max_videos: 1 } };
  await expect(prepareVisionInputs({
    images: ["a.png", "b.png", "c.png"], videos: [], workdir, config: cfg,
  })).rejects.toThrow("图片太多（3 张，一次最多 2 张）");
  await expect(prepareVisionInputs({
    images: [], videos: ["a.mp4", "b.mp4"], workdir, config: cfg,
  })).rejects.toThrow("视频太多（2 个，一次最多 1 个）");
});

test("VisionInputTest.test_download_video_rejects_non_http", async () => {
  await expect(downloadVideo("ftp://example.com/v.mp4", DEFAULT_VISION_CONFIG)).rejects.toThrow("只支持 http/https");
  await expect(downloadVideo("not a url", DEFAULT_VISION_CONFIG)).rejects.toThrow("不合法");
  // 假 fetch：非 video 内容 + 非视频扩展名直接拒绝（不下载）。
  const fakeFetch = (async () => ({
    ok: true, status: 200,
    headers: { get: (k: string) => (k === "content-type" ? "text/html" : null) },
    body: null, arrayBuffer: async () => new ArrayBuffer(0),
  })) as unknown as typeof fetch;
  await expect(downloadVideo("https://example.com/page", DEFAULT_VISION_CONFIG, fakeFetch)).rejects.toThrow("不是视频");
});

// ---- describe_image 工具 ----

test("VisionInputTest.test_describe_image_tool", async () => {
  const { workdir } = setup();
  writeFileSync(join(workdir, "cat.png"), PNG_BYTES);
  const seen: { images: VisionImageInput[]; prompt: string }[] = [];
  const ctx = newToolContext({
    workdir, mode: "full", interactive: false,
    visionRunner: async (input) => { seen.push(input); return "图里是一只猫"; },
    visionConfig: DEFAULT_VISION_CONFIG,
  });
  const out = await executeTool("describe_image", { path: "cat.png" }, ctx);
  expect(out).toContain("一只猫");
  expect(seen.length).toBe(1);
  expect(seen[0].images.length).toBe(1);
  expect(seen[0].images[0].mime).toBe("image/png");
  // 坏图：文字文件直接报错，不进模型。
  writeFileSync(join(workdir, "fake.png"), TEXT_BYTES);
  const bad = await executeTool("describe_image", { path: "fake.png" }, ctx);
  expect(bad).toContain("错误");
  expect(bad).toContain("不是支持的格式");
  expect(seen.length).toBe(1); // 坏图没调模型
  // 没接 visionRunner 时明确报错，不假装能看。
  const ctxNoRunner = newToolContext({ workdir, mode: "full", interactive: false });
  const noRunner = await executeTool("describe_image", { path: "cat.png" }, ctxNoRunner);
  expect(noRunner).toContain("错误");
  expect(noRunner).toContain("未接视觉模型");
});

// ---- CLI 端到端：有图 / 无图 / 坏图 ----

test("VisionInputTest.test_cli_parse_args", () => {
  const withImages = parseArgs(["--image", "a.png", "--image=b.png", "--video", "v.mp4", "描述图"]);
  expect(withImages.images).toEqual(["a.png", "b.png"]);
  expect(withImages.videos).toEqual(["v.mp4"]);
  expect(withImages.task).toBe("描述图");
  const plain = parseArgs(["只做文字任务"]);
  expect(plain.images).toEqual([]);
  expect(plain.videos).toEqual([]);
  expect(plain.task).toBe("只做文字任务");
  const videoEq = parseArgs(["--video=https://example.com/v.mp4", "看视频"]);
  expect(videoEq.videos).toEqual(["https://example.com/v.mp4"]);
});

test("VisionInputTest.test_cli_validate_vision_args", () => {
  expect(validateVisionArgs({ images: [], videos: [] } as never)).toBeNull();
  expect(validateVisionArgs({ images: ["a.png"], videos: [], resumeRun: "x" } as never)).toContain("resume-run");
  expect(validateVisionArgs({ images: ["a.png"], videos: [], resume: "x" } as never)).toContain("resume");
  expect(validateVisionArgs({ images: [], videos: ["v.mp4"], planMode: true } as never)).toContain("plan");
});

test("VisionInputTest.test_cli_attach_vision_inputs_end_to_end", async () => {
  const { home, workdir } = setup();
  writeFileSync(join(workdir, "shot.png"), PNG_BYTES);
  // 有图：挂接后首轮带图进模型。
  const provider = new FakeProvider([withUsage(textReply("截图里有个报错"))], "gpt-4o-mini");
  const agent = new Agent(provider as never, { workdir, home, mode: "full", maxTurns: 5, skillsDirs: [] });
  const args = parseArgs(["--workdir", workdir, "--image", "shot.png", "这张报错截图是什么意思"]);
  await attachVisionInputs(args, agent, {});
  expect(agent.visionInputs.length).toBe(1);
  const out = await agent.run("这张报错截图是什么意思");
  expect(out).toContain("报错");
  const userMsg = provider.calls[0][1] as Record<string, unknown>;
  const parts = userMsg.content as Record<string, unknown>[];
  expect(parts.some((p) => p.type === "image_url")).toBe(true);
  // 无图：挂接是空操作。
  const plainAgent = new Agent(new FakeProvider([textReply("ok")]) as never, { workdir, home, mode: "full", skillsDirs: [] });
  await attachVisionInputs(parseArgs(["纯文字"]), plainAgent, {});
  expect(plainAgent.visionInputs.length).toBe(0);
  // 坏图之一：模型看不了图，挂接直接拒绝。
  const blindAgent = new Agent(new FakeProvider([textReply("ok")], "deepseek-flash") as never, { workdir, home, mode: "full", skillsDirs: [] });
  await expect(attachVisionInputs(parseArgs(["--image", "shot.png", "看图"]), blindAgent, {})).rejects.toThrow("看不了图");
  // 坏图之二：文件不存在，挂接直接报错（不静默跳过）。
  const missingAgent = new Agent(new FakeProvider([textReply("ok")]) as never, { workdir, home, mode: "full", skillsDirs: [] });
  await expect(attachVisionInputs(parseArgs(["--image", "nope.png", "看图"]), missingAgent, {})).rejects.toThrow("图片不存在");
  // 坏图之三：视频走假 ffmpeg 抽帧挂接。
  const videoAgent = new Agent(new FakeProvider([withUsage(textReply("视频里有三帧"))], "gpt-4o-mini") as never, { workdir, home, mode: "full", skillsDirs: [] });
  const videoPath = join(workdir, "clip.mp4");
  writeFileSync(videoPath, Buffer.alloc(512, 0));
  const runner: CommandRunner = (cmd, a) => {
    if (cmd === "ffprobe") return { status: 0, stdout: "12\n", stderr: "" };
    const pattern = a[a.length - 1];
    for (let i = 1; i <= 2; i++) writeFileSync(pattern.replace("%03d", String(i).padStart(3, "0")), PNG_BYTES);
    return { status: 0, stdout: "", stderr: "" };
  };
  // prepareVisionInputs 的视频路径注入 runner（CLI 层 attachVisionInputs 本身用真命令，
  // 这里直接测 prepareVisionInputs 的视频分支，证明抽帧后的帧能进同一条路）。
  const frames = await prepareVisionInputs({ images: [], videos: ["clip.mp4"], workdir, config: {}, runCommand: runner });
  expect(frames.length).toBe(2);
  expect(frames.every((f) => f.sourceKind === "video-frame")).toBe(true);
  videoAgent.visionInputs = frames;
  const vout = await videoAgent.run("视频里有什么");
  expect(vout).toContain("三帧");
  // 视频下载/抽帧的临时目录同样处理完即删。
  expect(readdirSync(tmpdir()).filter((d) => d.startsWith("nyra-video-frames-") || d.startsWith("nyra-video-download-"))).toEqual([]);
});
