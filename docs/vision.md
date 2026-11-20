# 图像 / 视频输入（缺口 16）

Nyra 能看图了：任务可以附图片（本地路径），也可以附视频（本地文件或公开直链）。
图片进主循环的第一条用户消息，视觉模型直接看原图；视频先抽帧，抽出的帧当图片
走同一条路。

## 用法

```sh
# 一张报错截图：模型直接看图再回答
nyra --image ./error.png "这张报错截图是什么意思"

# 多张图（可重复 --image）+ 一个视频（本地文件）
nyra --image a.png --image b.png --video ./demo.mp4 "对比这两张设计稿，再看视频里演示的操作"

# 公开直链视频（只接受 http/https 的 video 内容，不带 cookie、不走 yt-dlp）
nyra --video https://example.com/demo.mp4 "视频里演示了什么"

# 任务进行中也可以随时让模型看一张图（只读工具，不写文件）
# → 模型调用 describe_image，参数 path 是工作目录下的图片路径
```

`--image` / `--video` 只支持一次性任务：不能与 `--resume` / `--resume-run` /
`--plan` / `--execute-plan` 组合，也不能在交互模式（REPL）里用——组合不对
直接报错退出（退出码 2），不建 agent、不烧 token。

## 图片怎么校验

- 只认 magic bytes（文件头），不看扩展名：PNG / JPEG / WebP / GIF（复用
  Bot Phase 3 `src/bot/attachments.ts` 的 `sniffImageKind` 口径）。`.png`
  里装文字照样拒绝。
- 单张超 `vision.max_bytes`（默认 10MB）直接拒绝，并明说超了多少。
- 一次最多 `vision.max_images` 张（默认 5 张），多了直接拒绝。
- 任一张失败即整体报错，不静默跳过某一张（用户看得到哪张出了问题）。

## 视频怎么采样

- 本地视频：ffprobe 读时长 → 按 `时长 / max_frames` 均匀采样（默认最多
  6 帧）；ffprobe 读不到时长时回退到只抽关键帧。
- 公开链接：先下载（只接受 http/https、只要 `video/` 内容或视频扩展名，
  流式读 + 上限熔断），落临时文件再抽帧。
- 视频本身不进模型、不存原片：抽出的帧落临时目录，读完即删；下载的临时
  文件同样处理完即删。
- 单个视频超 `vision.video_max_bytes`（默认 50MB）直接拒绝；一次最多
  `vision.max_videos` 个（默认 3 个）。
- 只处理用户自给的本地视频与公开链接，不碰 DRM / 付费墙（需要登录或
  cookie 的链接下不下来，会直接报错）。

## 哪个模型能看图

接线前先过模型能力表（`src/modelCatalog.ts` 的 `supportsVision`）：

- 表里明确标 `true` 的才放行（当前：grok-4.3、grok-4.5、gpt-4o-mini、
  gemini-2.5-flash、gemini-2.5-pro）。
- 表里标 `false` 的（纯文本模型，如 DeepSeek 两款、Hermes、Qwen 全系）
  直接拒绝，并告诉你换哪个模型（`--model` 指定）。
- 表里没标的走模型名启发式兜底；启发式也不认的按看不了图拒绝——
  **宁可拒绝，不假装能看**。拒绝发生在首轮模型调用之前，不烧 token。

视觉调用走现有 provider 体系（Act 模型优先，与主循环同一口径），token
与花费进用量账本（`usage.record` + `checkCost`，与成本硬顶同口径）。

## 审批与证据

- 看图本身是读操作，不须审批；但模型据此做的写操作照常过审批（`--mode`
  与审批规则不变）。
- 看了哪张图进证据链：新事件 `vision_input`（已注册进 `src/runs.ts` 的
  `EVENT_FIELDS` 与 `RunRecorder` 转发白名单），只记张数、图片指纹
  （SHA-256 前 12 位）、模型、来源种类（`image` / `video-frame`）——
  **图片内容绝不进事件**。
- `nyra timeline <运行 ID>` 能直接读出“看了几张图（哪个模型）”。
- 图片里的文字同样是外部数据：`describe_image` 工具返回的描述会包一层
  untrusted 标记，其中的指令性文字不会被执行。

## 配置

`config.json` 的 `vision` 一节（都在 `DEFAULT_CONFIG` 里有默认值，不配也能用）：

```json
{
  "vision": {
    "max_bytes": 10485760,
    "max_frames": 6,
    "max_images": 5,
    "video_max_bytes": 52428800,
    "max_videos": 3
  }
}
```

数字不合法（非正整数、超范围）时回退默认值，不抛错、不挡运行。

## 已知局限

- 真视觉模型调用未在真 API 上跑通，只在假模型上验过（假视觉模型 +
  假图片字节 + 假 ffmpeg）。
- 视频抽帧依赖本机装了 ffmpeg / ffprobe；没装时直接报错（见报错里的
  安装提示），不静默降级。
- 模型看图的能力以 `src/modelCatalog.ts` 的标注为准；新模型没核实前
  走启发式，可能误拒（换表里确认支持的模型即可）。
- `describe_image` 工具每次执行都是一次计费的视觉调用；图片只记元信息
  的旧行为（Bot Phase 3 的附件处理）不受影响——那是另一条路。
- yt-dlp 的 `media_ingest`（视频 → 转写 → 提炼 → 成稿）是下一批，
  本批只做图像/视频输入，不含它。
- Windows / macOS 真机未验证。
