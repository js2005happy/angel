# 语音指挥（缺口 15）

Puck 式语音通话指挥 agent 的异步版：对 Nyra 说一句话，它干完回文字。
本批只做**语音指挥**，不做语音聊天、不做实时通话（实时语音通话是缺口 36
的延伸，见 `docs/` 下 Teamly 调研报告里的缺口 36 定义）。

## 用法

```bash
# 语音文件即任务：先转文字，再当任务文本跑（可再跟一句文字补充）
nyra --voice 录音.wav
nyra --voice 录音.wav "把结果写进 out.txt"

# 任务跑完后把结果读出来（只读结果前 500 字，不读完整证据链）
nyra "做一个季度总结" --speak

# 语音子命令：看配置与可用性、读一段文字、开关自动回读
nyra voice status
nyra voice speak "任务完成"
nyra voice enable-tts   # 每次任务跑完自动回读（默认关）
nyra voice disable-tts
```

`--voice` 只支持一次性任务：不能与 `--resume` / `--resume-run` /
`--plan` / `--execute-plan` 组合、不能进交互模式，组合不对直接报错退出码 2。
`--speak` 不能与 `--json` 组合（JSON 模式只出机器可读结果）。

## 转文字：本地优先、云端兜底、失败就报错

- 本地：whisper.cpp。装好后在 `config.json` 的 `voice` 一节配
  `stt_local_binary`（默认自动找 `whisper-cli` 再找 `whisper`）与
  `stt_local_model`（模型文件路径，**必须配**，否则不走本地）。
  模型路径配了但文件不存在是配置错，直接报错，不悄悄走云端花钱。
- 云端：走当前 provider 的 OpenAI 兼容接口
  `POST {baseUrl}/audio/transcriptions`（multipart，`file` + `model`，
  默认模型 `whisper-1`）。没有 HTTP 端点的 provider（如 Codex CLI）没有
  云端这条路。
- 两条路都不可用时直接报错并指路（装 whisper.cpp 或换支持语音的 provider），
  不静默降级。选中的一路失败也直接报错，**不换另一路重转**（那会多花一份
  云端钱）。
- 只认 WAV / MP3 / M4A / OGG / FLAC / WebM，按文件头识别，不看扩展名；
  单段默认上限 25MB、600 秒，超了拒绝。M4A / FLAC / WebM 先经 ffmpeg 转
  16k 单声道 wav 再转写（没装 ffmpeg 直接报错）；时长用 ffprobe 尽力读，
  读不到不报错、花费记 null。
- 音频文件只读一次进内存：转写用的临时副本处理完即删，不落盘、不进事件。

## 回读：可选、默认关、只读摘要

- TTS 本批只做云端：`POST {baseUrl}/audio/speech`（JSON，mp3，默认模型
  `tts-1`、音色 `alloy`）。本地没有可靠的 TTS 引擎，不自研。
- 回读只读结果前 500 字；合成的 mp3 存 `~/.nyra/voice/speak-<时间戳>.mp3`
  （0600），`voice.tts_player` 配了播放器才播，播失败只警告。
- `nyra voice speak <文字>` 是显式入口；`--speak` 或 `voice.tts_enabled`
  时任务跑完自动回读；回读失败只写一行警告，不破坏已完成的运行。

## 边界：语音不碰支付与对外发送

语音层只把转写文本当任务交给主循环：转写文本里哪怕写着“转 100 元”“发一封
邮件”，语音层自己也不执行任何工具、不碰支付与对外发送——写操作照常走主
循环的审批与权限边界，须回文字确认。队列 / 定时任务里不自动放行、不自动
换模型（与主循环同款红线）。

## 成本与证据

- STT 按分钟、TTS 按字数计价（`voice.stt_price_per_min_usd` /
  `voice.tts_price_per_1k_chars_usd`，默认不配、花费记 null，不编数字），
  进用量账本：单次硬顶与月度硬顶都含语音花费，超限时报错文案带“其中语音
  $X”；时间线与 `nyra verdict --run <运行 ID>` 的花费合计含语音。
- 证据链：新事件 `voice_input`（seconds、chars、engine、cost_usd、
  text_hash）与 `voice_speak`（chars、engine、cost_usd），均已注册进
  `EVENT_FIELDS` 与 `RunRecorder` 转发白名单，`src/timeline.ts` 加渲染；
  只记元数据与文本 SHA-256 前 12 位指纹，**不记音频原文件、不记转写原文、
  不记回读原文、不记音频路径**。用量摘要加 `voice_spent_usd` /
  `voice_calls`。

## 配置

`config.json` 的 `voice` 一节（非法值回退默认值）：

| 键 | 默认 | 说明 |
|---|---|---|
| `max_bytes` | 25MB | 单段音频上限 |
| `max_seconds` | 600 | 单段最长（秒） |
| `stt_model` | `whisper-1` | 云端 STT 模型 |
| `tts_model` | `tts-1` | 云端 TTS 模型 |
| `tts_voice` | `alloy` | TTS 音色 |
| `tts_enabled` | `false` | 任务跑完自动回读 |
| `stt_local_binary` | `null` | 本地 whisper.cpp 二进制（不配自动找） |
| `stt_local_model` | `null` | 本地 whisper 模型文件（配了才走本地） |
| `stt_language` | `auto` | 转写语言（`auto` 不传给云端） |
| `tts_player` | `null` | 回读播放器（不配只保存文件） |
| `stt_price_per_min_usd` | `null` | STT 单价（美元/分钟，不配不计价） |
| `tts_price_per_1k_chars_usd` | `null` | TTS 单价（美元/千字，不配不计价） |

## 已知局限

- 真 STT/TTS 未在真 API 上跑通，只在假服务上验过；本地 whisper.cpp 未打包、
  须用户自己装（模型文件另行下载）。
- 实时语音通话是缺口 36 的事，本批没做；视频通话是缺口 37。
- 回读只读结果摘要，不读完整证据链；`describe_image` 式的语音内嵌指令仍按
  主循环的不可信输入处理。
- Windows/macOS 真机未验证。
