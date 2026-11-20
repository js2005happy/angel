// tests/node/test-voice-commander.test.ts — 缺口 15：语音协调者（Puck 式语音指挥）。
// 假 STT/TTS + 假音频字节 + 假 whisper：覆盖 magic bytes 校验、超限拒绝、
// 转写失败报错、无本地 whisper 且无云端凭证时拒绝、语音指令不自动执行支
// 付、回读默认关、用量账本记了 STT/TTS 花费、CLI 端到端（有音频/无音频/坏音频）。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, AgentError } from "../../src/agent.ts";
import { RunStore, RunRecorder } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import {
  DEFAULT_VOICE_CONFIG, estimateSttCostUsd, estimateTtsCostUsd, handleVoice,
  loadAudioFile, localSttAvailable, prepareAudioInput, resolveVoiceConfig,
  synthesizeSpeech, transcribeAudio, transcribeCloud, transcribeLocal,
  voiceSttUnavailableMessage, type CommandRunner, type VoiceAudioInput,
  type VoiceConfig,
} from "../../src/voice.ts";
import { parseArgs, validateVoiceArgs, attachVoiceInput } from "../../src/cli.ts";

/** 各格式的真 magic bytes（内容是假的，只认头）。 */
const WAV_BYTES = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WAVE"), Buffer.alloc(40, 0x20)]);
const MP3_BYTES = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(60, 0x20)]);
const M4A_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftyp"), Buffer.alloc(40, 0x20)]);
const OGG_BYTES = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(40, 0x20)]);
const FLAC_BYTES = Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(40, 0x20)]);
const WEBM_BYTES = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40, 0x20)]);
const TEXT_BYTES = Buffer.from("这是一段文字，不是音频", "utf-8");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "nyra-voice-home-"));
  const workdir = mkdtempSync(join(tmpdir(), "nyra-voice-wd-"));
  return { home, workdir };
}

function wavInput(source = "cmd.wav"): VoiceAudioInput {
  return prepareAudioInput(WAV_BYTES, source, DEFAULT_VOICE_CONFIG);
}

class FakeProvider {
  name = "fake"; model: string; baseUrl = "https://fake.invalid"; apiKey = "fake-key";
  calls: Record<string, unknown>[][] = [];
  script: Record<string, unknown>[];
  idx = 0;
  constructor(script: Record<string, unknown>[], model = "deepseek-flash") { this.script = script; this.model = model; }
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

/** 假 whisper：--help 永远过；--output-file 写转写文本；ffmpeg 写空 wav。 */
function fakeWhisperRunner(transcript = "帮我写一个 out.txt"): CommandRunner {
  return (binary: string, args: string[]) => {
    if (binary === "ffprobe") return { status: 0, stdout: JSON.stringify({ format: { duration: "12.5" } }), stderr: "" };
    if (binary === "ffmpeg") {
      const out = args[args.length - 1];
      writeFileSync(out, Buffer.alloc(10));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.includes("--help")) return { status: 0, stdout: "whisper.cpp", stderr: "" };
    const outIdx = args.indexOf("--output-file");
    if (outIdx >= 0) {
      writeFileSync(`${args[outIdx + 1]}.txt`, transcript, "utf-8");
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unknown command" };
  };
}

/** 假外部命令：whisper 检测失败（本机没有 whisper）。 */
function noLocalRunner(): CommandRunner {
  return (binary: string) => {
    if (binary === "ffprobe") return { status: 0, stdout: JSON.stringify({ format: { duration: "30" } }), stderr: "" };
    return { status: 1, stdout: "", stderr: "not found" };
  };
}

/** 假云端 fetch：按 URL 分发 STT/TTS，记调用次数。 */
function fakeCloudFetch(opts: { sttText?: string; sttSeconds?: number; ttsBytes?: Buffer } = {}) {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/audio/transcriptions")) {
      return new Response(JSON.stringify({ text: opts.sttText ?? "云端转写的任务", usage: { seconds: opts.sttSeconds ?? 30 } }), { status: 200 });
    }
    if (u.endsWith("/audio/speech")) {
      return new Response(opts.ttsBytes ?? Buffer.from("FAKE-MP3"), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

// ---- 校验：magic bytes 与上限 ----

test("VoiceCommanderTest.test_magic_bytes_recognized", () => {
  expect(prepareAudioInput(WAV_BYTES, "a.wav", DEFAULT_VOICE_CONFIG).kind).toBe("wav");
  expect(prepareAudioInput(MP3_BYTES, "a.mp3", DEFAULT_VOICE_CONFIG).kind).toBe("mp3");
  expect(prepareAudioInput(M4A_BYTES, "a.m4a", DEFAULT_VOICE_CONFIG).kind).toBe("m4a");
  expect(prepareAudioInput(OGG_BYTES, "a.ogg", DEFAULT_VOICE_CONFIG).kind).toBe("ogg");
  expect(prepareAudioInput(FLAC_BYTES, "a.flac", DEFAULT_VOICE_CONFIG).kind).toBe("flac");
  expect(prepareAudioInput(WEBM_BYTES, "a.webm", DEFAULT_VOICE_CONFIG).kind).toBe("webm");
  // 扩展名说了不算：.wav 里装文字照样拒绝。
  expect(() => prepareAudioInput(TEXT_BYTES, "fake.wav", DEFAULT_VOICE_CONFIG)).toThrow("不是支持的格式");
  expect(() => prepareAudioInput(Buffer.alloc(0), "empty.wav", DEFAULT_VOICE_CONFIG)).toThrow("空文件");
});

test("VoiceCommanderTest.test_oversize_and_overlong_rejected", () => {
  const small: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, maxBytes: 10 };
  expect(() => prepareAudioInput(WAV_BYTES, "big.wav", small)).toThrow("超过");
  expect(() => loadAudioFile("missing.wav", "/tmp", DEFAULT_VOICE_CONFIG)).toThrow("音频不存在");
  // 时长是 prepareAudioInput 的第 4 个参数（秒数）；上限 10 秒时 12.5 秒拒绝，13 秒以上放行。
  const short: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, maxSeconds: 10 };
  expect(() => prepareAudioInput(WAV_BYTES, "long.wav", short, 12.5)).toThrow("超过");
  const ok: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, maxSeconds: 13 };
  expect(prepareAudioInput(WAV_BYTES, "long.wav", ok, 12.5).durationSeconds).toBe(12.5);
});

test("VoiceCommanderTest.test_config_fallbacks", () => {
  const cfg = resolveVoiceConfig({ voice: { max_bytes: -5, max_seconds: 0, stt_model: "", tts_voice: 123, tts_enabled: "yes" } });
  expect(cfg.maxBytes).toBe(DEFAULT_VOICE_CONFIG.maxBytes);
  expect(cfg.maxSeconds).toBe(DEFAULT_VOICE_CONFIG.maxSeconds);
  expect(cfg.sttModel).toBe(DEFAULT_VOICE_CONFIG.sttModel);
  expect(cfg.ttsVoice).toBe(DEFAULT_VOICE_CONFIG.ttsVoice);
  expect(cfg.ttsEnabled).toBe(false);
  expect(resolveVoiceConfig({}).ttsEnabled).toBe(false);
});

// ---- 转写：本地 / 云端 / 失败 ----

test("VoiceCommanderTest.test_local_stt_transcribes", async () => {
  // 本地 STT 须配模型文件：造一个假模型文件（内容不重要，只验存在）。
  const { workdir } = setup();
  const modelPath = join(workdir, "ggml-tiny.bin");
  writeFileSync(modelPath, Buffer.alloc(10));
  const cfg: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, sttLocalModel: modelPath };
  const out = await transcribeLocal(wavInput(), cfg, "whisper-cli", fakeWhisperRunner("写一个 out.txt"));
  expect(out.text).toBe("写一个 out.txt");
  expect(out.engine).toBe("whisper.cpp");
  expect(out.seconds).toBeNull(); // 没探到时长时为 null，花费记 null
});

test("VoiceCommanderTest.test_local_stt_missing_model_file_errors", async () => {
  const cfg: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, sttLocalBinary: "whisper-cli", sttLocalModel: "/tmp/nyra-voice-no-such-model.gguf" };
  // 模型路径配了但文件不存在是配置错：检测时直接抛错，不悄悄走云端花钱。
  expect(() => localSttAvailable(cfg, fakeWhisperRunner())).toThrow("本地 whisper 模型文件不存在");
  await expect(transcribeAudio({ input: wavInput(), config: cfg, endpoint: null, runCommand: fakeWhisperRunner() }))
    .rejects.toThrow("本地 whisper 模型文件不存在");
});

test("VoiceCommanderTest.test_local_stt_failure_does_not_fall_back", async () => {
  const { workdir } = setup();
  const modelPath = join(workdir, "ggml-tiny.bin");
  writeFileSync(modelPath, Buffer.alloc(10));
  const cfg: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, sttLocalModel: modelPath };
  const failing: CommandRunner = (binary, args) => {
    if (binary === "ffprobe") return { status: 0, stdout: JSON.stringify({ format: { duration: "5" } }), stderr: "" };
    if (args.includes("--help")) return { status: 0, stdout: "whisper.cpp", stderr: "" };
    return { status: 1, stdout: "", stderr: "whisper: decode failed" };
  };
  const { fetchFn, calls } = fakeCloudFetch();
  await expect(transcribeAudio({ input: wavInput(), config: cfg, endpoint: { baseUrl: "https://fake.invalid", apiKey: "k" }, runCommand: failing, fetchFn }))
    .rejects.toThrow("本地 whisper 转写失败");
  expect(calls.length).toBe(0); // 一路失败直接报错，不悄悄换另一路重转
});

test("VoiceCommanderTest.test_cloud_stt_used_when_no_local", async () => {
  const { fetchFn, calls } = fakeCloudFetch({ sttText: "云端转写的任务", sttSeconds: 30 });
  const out = await transcribeCloud(wavInput(), DEFAULT_VOICE_CONFIG, { baseUrl: "https://fake.invalid", apiKey: "k" }, fetchFn);
  expect(out.text).toBe("云端转写的任务");
  expect(out.engine).toBe("cloud:whisper-1");
  expect(out.seconds).toBe(30);
  expect(calls[0]).toBe("https://fake.invalid/audio/transcriptions");
  // 编排层：本地不可用时走云端。
  const via = await transcribeAudio({ input: wavInput(), config: DEFAULT_VOICE_CONFIG, endpoint: { baseUrl: "https://fake.invalid", apiKey: "k" }, runCommand: noLocalRunner(), fetchFn });
  expect(via.engine).toBe("cloud:whisper-1");
});

test("VoiceCommanderTest.test_no_stt_available_rejected", async () => {
  await expect(transcribeAudio({ input: wavInput(), config: DEFAULT_VOICE_CONFIG, endpoint: null, runCommand: noLocalRunner() }))
    .rejects.toThrow(voiceSttUnavailableMessage());
  // 云端 STT 不可达也报错，不静默降级。
  const badFetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  await expect(transcribeCloud(wavInput(), DEFAULT_VOICE_CONFIG, { baseUrl: "https://fake.invalid", apiKey: "k" }, badFetch))
    .rejects.toThrow("云端转写失败");
});

test("VoiceCommanderTest.test_cost_estimates_null_when_unpriced", () => {
  expect(estimateSttCostUsd(60, DEFAULT_VOICE_CONFIG)).toBeNull(); // 默认没配单价
  expect(estimateTtsCostUsd(2, DEFAULT_VOICE_CONFIG)).toBeNull();
  const priced: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, sttPricePerMinUsd: 0.006, ttsPricePer1kCharsUsd: 0.015 };
  expect(estimateSttCostUsd(60, priced)).toBeCloseTo(0.006, 10);
  expect(estimateTtsCostUsd(1000, priced)).toBeCloseTo(0.015, 10);
  expect(estimateSttCostUsd(null, priced)).toBeNull();
});

// ---- TTS ----

test("VoiceCommanderTest.test_cloud_tts_synthesizes", async () => {
  const { fetchFn, calls } = fakeCloudFetch({ ttsBytes: Buffer.from("FAKE-MP3-BYTES") });
  const out = await synthesizeSpeech("任务完成", DEFAULT_VOICE_CONFIG, { baseUrl: "https://fake.invalid", apiKey: "k" }, fetchFn);
  expect(out.engine).toBe("cloud:tts-1");
  expect(out.bytes.equals(Buffer.from("FAKE-MP3-BYTES"))).toBe(true);
  expect(calls[0]).toBe("https://fake.invalid/audio/speech");
});

// ---- Agent 集成：转写进主循环 + 成本硬顶 + 回读 ----

test("VoiceCommanderTest.test_agent_voice_task_transcribes_then_runs", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([withUsage(textReply("已写好 out.txt"))]);
  const { fetchFn } = fakeCloudFetch({ sttText: "写一个 out.txt", sttSeconds: 60 });
  const priced: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, sttPricePerMinUsd: 0.006 };
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    voiceInputs: [wavInput()], voiceConfig: priced, voiceRunner: noLocalRunner(), voiceFetch: fetchFn,
  });
  const store = new RunStore(join(home, "runs"));
  const recorder = new RunRecorder(store, agent, "", {});
  const out = await recorder.run("");
  expect(out).toContain("已写好 out.txt");
  // 转写文本进了第一轮的用户消息（转写即任务）。
  const firstCall = provider.calls[0];
  const userMsg = firstCall[1] as Record<string, unknown>;
  expect(userMsg.role).toBe("user");
  expect(userMsg.content).toContain("写一个 out.txt");
  // 事件里只有指纹与花费，没有音频路径与音频内容。
  const events = readFileSync(join(home, "runs", recorder.runId, "events.jsonl"), "utf-8");
  expect(events).toContain("voice_input");
  expect(events).not.toContain("cmd.wav");
  expect(events).not.toContain("写一个 out.txt");
  // 用量摘要记了语音花费（60 秒 × $0.006/分钟 = $0.006）。
  const state = store.load(recorder.runId);
  expect(state.usage_summary?.voice_spent_usd).toBeCloseTo(0.006, 10);
  expect(state.usage_summary?.voice_calls).toBe(1);
  expect(agent.voiceSpentUsd).toBeCloseTo(0.006, 10);
});

test("VoiceCommanderTest.test_agent_voice_cost_cap_counts_voice", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([withUsage(textReply("不该被调用"))]);
  const { fetchFn } = fakeCloudFetch({ sttText: "写一个 out.txt", sttSeconds: 60 });
  const priced: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, sttPricePerMinUsd: 0.06 };
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    voiceInputs: [wavInput()], voiceConfig: priced, voiceRunner: noLocalRunner(), voiceFetch: fetchFn,
    maxCostUsd: 0.05, // STT 要花 $0.06，硬顶在转写后、模型调用前拦住
  });
  await expect(agent.run("")).rejects.toThrow(/成本上限已超.*语音/);
  expect(provider.calls.length).toBe(0); // 没烧模型 token
});

test("VoiceCommanderTest.test_agent_voice_command_does_not_auto_execute_payment", async () => {
  const { home, workdir } = setup();
  const provider = new FakeProvider([withUsage(textReply("已收到，请确认后再转"))]);
  const { fetchFn } = fakeCloudFetch({ sttText: "把 100 元转给张三", sttSeconds: 10 });
  const agent = new Agent(provider as never, {
    workdir, home, mode: "full", maxTurns: 5, skillsDirs: [],
    voiceInputs: [wavInput()], voiceConfig: DEFAULT_VOICE_CONFIG, voiceRunner: noLocalRunner(), voiceFetch: fetchFn,
  });
  const out = await agent.run("");
  expect(out).toContain("请确认");
  // 语音层只把转写文本当任务交给主循环：模型收到的是文字消息，语音层自己
  // 没执行任何工具、没碰支付——写操作照常走主循环的审批。
  const firstCall = provider.calls[0];
  const userMsg = firstCall[1] as Record<string, unknown>;
  expect(userMsg.content).toContain("把 100 元转给张三");
  expect(provider.calls.length).toBe(1);
});

test("VoiceCommanderTest.test_agent_speak_result_off_by_default", async () => {
  const { home, workdir } = setup();
  const agent = new Agent(new FakeProvider([textReply("ok")]) as never, {
    workdir, home, mode: "full", skillsDirs: [],
  });
  expect(await agent.speakResult("任务完成")).toBeNull();
  expect(existsSync(join(home, "voice"))).toBe(false);
});

test("VoiceCommanderTest.test_agent_speak_result_writes_file_and_records", async () => {
  const { home, workdir } = setup();
  const { fetchFn } = fakeCloudFetch({ ttsBytes: Buffer.from("FAKE-MP3") });
  const priced: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, ttsEnabled: true, ttsPricePer1kCharsUsd: 15 };
  const agent = new Agent(new FakeProvider([textReply("ok")]) as never, {
    workdir, home, mode: "full", skillsDirs: [], voiceConfig: priced, voiceFetch: fetchFn,
  });
  const store = new RunStore(join(home, "runs"));
  const recorder = new RunRecorder(store, agent, "做点事", {});
  const spoken = await agent.speakResult("任务完成：out.txt 已写好");
  expect(spoken).not.toBeNull();
  expect(spoken!.chars).toBe("任务完成：out.txt 已写好".length); // 16 字（含空格）
  expect(spoken!.costUsd).toBeCloseTo(16 * 15 / 1000, 10); // 16 字 × $15/千字
  expect(existsSync(spoken!.path)).toBe(true);
  expect(readFileSync(spoken!.path).equals(Buffer.from("FAKE-MP3"))).toBe(true);
  if (process.platform !== "win32") expectPerms(spoken!.path, 0o600);
  expect(agent.voiceSpentUsd).toBeCloseTo(spoken!.costUsd!, 10);
  // voice_speak 事件进了证据链（只记元数据，不记音频内容）。
  const events = readFileSync(join(home, "runs", recorder.runId, "events.jsonl"), "utf-8");
  expect(events).toContain("voice_speak");
  expect(events).not.toContain("任务完成");
});

// ---- 时间线渲染 ----

test("VoiceCommanderTest.test_timeline_renders_voice_events", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-voice-tl-"));
  const store = new RunStore(join(home, "runs"));
  const state = store.create("做点事", "sess-1", home, "auto", 10);
  const runId = state.run_id;
  writeFileSync(join(home, "runs", runId, "events.jsonl"), [
    JSON.stringify({ at: state.created_at, type: "voice_input", seconds: 30, chars: 8, engine: "cloud:whisper-1", cost_usd: 0.003, text_hash: "abc123" }),
    JSON.stringify({ at: state.created_at, type: "voice_speak", chars: 12, engine: "cloud:tts-1", cost_usd: 0.001 }),
  ].join("\n") + "\n");
  const tl = buildTimeline(store, runId);
  const text = formatTimelineText(tl);
  expect(text).toContain("语音转写");
  expect(text).toContain("语音回读");
  expect(text).toContain("cloud:whisper-1");
});

// ---- CLI 端到端 ----

test("VoiceCommanderTest.test_cli_parse_and_validate", () => {
  const args = parseArgs(["--voice", "cmd.wav", "写一个 out.txt"]);
  expect(args.voice).toBe("cmd.wav");
  expect(args.task).toBe("写一个 out.txt");
  expect(args.speak).toBe(false);
  expect(parseArgs(["--voice", "a.wav", "--speak"]).speak).toBe(true);
  expect(parseArgs(["写一个 out.txt"]).voice).toBeNull();
  // 组合校验：语音只跟单次正向运行走。
  expect(validateVoiceArgs({ ...parseArgs(["--voice", "a.wav"]), resumeRun: "r1" } as never)).toContain("resume-run");
  expect(validateVoiceArgs({ ...parseArgs(["--voice", "a.wav"]), resume: "s1" } as never)).toContain("resume");
  expect(validateVoiceArgs({ ...parseArgs(["--voice", "a.wav"]), planMode: true } as never)).toContain("plan");
  expect(validateVoiceArgs({ ...parseArgs(["--speak"]), jsonMode: true } as never)).toContain("json");
  expect(validateVoiceArgs(parseArgs(["--voice", "a.wav", "任务"]))).toBeNull();
  expect(validateVoiceArgs(parseArgs(["任务", "--speak"]))).toBeNull();
});

test("VoiceCommanderTest.test_cli_attach_voice_loads_real_file", async () => {
  const { home, workdir } = setup();
  writeFileSync(join(workdir, "cmd.wav"), WAV_BYTES);
  const agent = new Agent(new FakeProvider([textReply("ok")]) as never, {
    workdir, home, mode: "full", skillsDirs: [],
  });
  await attachVoiceInput({ ...parseArgs(["--voice", "cmd.wav"]), workdir } as never, agent, {});
  const inputs = (agent as unknown as { voiceInputs: VoiceAudioInput[] }).voiceInputs;
  expect(inputs.length).toBe(1);
  expect(inputs[0].kind).toBe("wav");
  expect(inputs[0].source).toBe("cmd.wav");
});

test("VoiceCommanderTest.test_cli_attach_bad_audio_rejected", async () => {
  const { home, workdir } = setup();
  writeFileSync(join(workdir, "bad.wav"), TEXT_BYTES);
  const agent = new Agent(new FakeProvider([textReply("ok")]) as never, {
    workdir, home, mode: "full", skillsDirs: [],
  });
  await expect(attachVoiceInput({ ...parseArgs(["--voice", "bad.wav"]), workdir } as never, agent, {}))
    .rejects.toThrow("不是支持的格式");
  // 无音频：attach 是空操作，不报错、不挂输入。
  await attachVoiceInput({ ...parseArgs(["任务"]), workdir } as never, agent, {});
  expect((agent as unknown as { voiceInputs: VoiceAudioInput[] }).voiceInputs).toEqual([]);
});

// ---- nyra voice 子命令 ----

test("VoiceCommanderTest.test_voice_subcommand_status_and_toggle", async () => {
  const { home } = setup();
  // 本机没有 whisper、没有云端凭证：status 照样报出（不抛错）。
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { chunks.push(String(s)); return true; };
  try {
    expect(await handleVoice(["status"], home)).toBe(0);
  } finally {
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
  }
  expect(chunks.join("")).toContain("语音指挥");
  // 开关自动回读写进 config.json。
  expect(await handleVoice(["enable-tts"], home)).toBe(0);
  expect(resolveVoiceConfig(JSON.parse(readFileSync(join(home, "config.json"), "utf-8"))).ttsEnabled).toBe(true);
  expect(await handleVoice(["disable-tts"], home)).toBe(0);
  expect(resolveVoiceConfig(JSON.parse(readFileSync(join(home, "config.json"), "utf-8"))).ttsEnabled).toBe(false);
  expect(await handleVoice(["bogus"], home)).toBe(2);
});
