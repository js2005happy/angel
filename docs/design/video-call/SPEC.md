# Nyra 视频通话面板 · 设计规格

给 Muse 的实现说明。这里只有设计（界面、流程、令牌、文案）；连接层、信令、存储都由 Muse 决定，本文不对后端做任何承诺。

- 设计稿源文件：`source/`（`call.py` 生成全部 `call-*.html`，`callkit.py` 是令牌 / 玻璃 / 图标 / 组件）
- 画板（1600×1000 @2x）：本目录 `call-*-light.png` / `call-*-dark.png`
- 单屏（桌面 1440×900、手机 390×844，@1x）：`single/`
- 总览：`call-overview.png`
- **设计稿里所有数字都是示意**：流量、速率、token 数、时长、好友码、时间、文件行数，见第 10 节。

---

## 1. 三个核心概念

1. **好友 = 一个人 + 他的 agent。** 加好友时同时加了对方本人和对方的 agent（每个 agent 都是一个 Nyra，可以有自己的名字，比如 Kite、Pilot）。界面上所有“人”的头像右下角都带一枚 agent 徽章（圆盘 + 光标标志），表示“这个人带着他的 agent”。
2. **人的权限和 agent 的权限分开。** 人能看到的 = 你在通话里共享给他的。agent 能看到 / 能做什么单独设置（好友页“Kite 在我这里的权限”、首次协作弹窗），默认只读。你的 agent 在对方那边的权限由对方决定。
3. **流量 vs token。** 视频 / 语音只走网络流量，不耗 token；agent 在协作里干活才耗 token，而且**谁的 agent 花谁的 token**（Kite 的工作记在林舟账上，不花你的）。**协作时各用各的 token，不混账**：token 归属按 agent 与主人分开算，对方 agent 改你的文件，token 也记在对方账上。这两件事在界面上始终分开：顶栏只说一句话「视频走流量，不耗 token」，不放跳动的数字；**token 的数只在用量弹层（点顶栏信号片打开的「这次通话的用量」）与设置里出现，不出现在通话主界面**（agent 块、协作面板、抽屉里都不放）；审批卡上写清这一下用谁的 token（见 §3.3），那是“这一下谁付钱”，不是跑着的总数。

## 2. 信息架构与流程

```
侧栏「好友与通话」(桌面) / 底部标签「好友」(手机)
 ├─ 我的好友码（二维码 + 短码，可复制 / 分享 / 换一个）
 ├─ 好友请求（接受 / 拒绝；接受后对方 agent 默认只读）
 ├─ 好友列表（人 + agent，在线 / 忙碌 / 离线，视频通话 / 邀请协作）
 └─ 好友详情（人卡 + agent 卡 + “agent 在我这里的权限” + 最近一起做的）

发起 ──► 呼叫中 ──► 对方接听 ──► 通话中
  │          │                    │
  │          └─ 对方离线 → 留言 / 上线时提醒我
  │
来电 ──► 选「带摄像头 / 仅语音」+「我的 Nyra 一起加入」──► 接听 / 拒绝 / 回消息

通话中
 ├─ 第一次和该 agent 协作 → 权限弹窗（只问一次）→ 开始协作 / 只通话
 ├─ 共享协作面板（线程 / 计划 / Diff / 成员）
 │    └─ 对方 agent 想改我的文件 → 审批卡（拒绝 / 总是允许 / 允许一次）
 ├─ 有人发起录制 → 录制同意（全员同意才开始）→ 顶栏常驻「录制中」
 ├─ 弱网 → 自动降为仅语音 + 横幅（网好了自动恢复视频）
 └─ 挂断 → 通话结束总结（时长 / 流量 / token / 一起完成的改动 / 待办）
```

## 3. 屏幕清单

| # | 屏幕 | 桌面 | 手机 |
|---|------|------|------|
| 1 | 好友与通话 | `call-d1-friends-*` | `call-m1-friends-*`（列表 · 详情 · 加好友） |
| 2 | 来电 / 呼叫中 / 对方离线 | `call-d2-incoming-*` | `call-m2-calling-*` |
| 3 | 通话中（核心） | `call-d3-incall-*` | `call-m3-incall-*`（iOS 视频 · 协作抽屉 · Android 视频） |
| 4 | 流量 vs token | 顶栏 + 协作面板底部（d3） | `call-m4-privacy-*` 第 3 屏「这次通话的用量」 |
| 5 | 权限与隐私 | `call-d4-permissions-*`、`call-d5-recording-*` | `call-m4-privacy-*` 第 1、2 屏 |
| 6 | 边缘状态 | `call-d6-weak-*`、`call-d7-summary-*` | `call-m5-edge-*`（弱网 · 离线 Android · 结束总结），`call-m2` 第 3 屏 |

### 3.1 好友与通话（d1 / m1）

- **我的好友码卡**：二维码（白底黑码，两种主题都保持白底以便扫码）+ 短码 `NYR-7K4Q-2M`（JetBrains Mono 粗体）+ 复制 / 分享。说明行：有效期、重新生成、“加好友后对方的 agent 默认只读”。码格式、有效期、二维码内容（稿里是 `nyra://add/<code>`）都是示意，由 Muse 定。
- **好友请求卡**：头像（带 agent 徽章）+「Mark Chen 想加你为好友 · 连同他的 agent Pilot」+ 拒绝 / 接受。下方灰底提示接受的后果。
- **好友行**：头像 40（徽章）· 名字 · 状态点 + 状态文字 · 第二行「agent 标志 + agent 名 · X 的 agent · 权限摘要」· 右侧「视频通话」「邀请协作」。离线时两个按钮置灰（opacity .4，仍可点 → 走“对方离线”流程）。
- **状态点**：在线 `--add` 实心；忙碌 `--warn` 实心；离线空心圆环 `--mu2`。状态一定配文字，不只靠颜色。
- **好友详情**：左右两张卡把「人」和「她的 agent」分开；下面“Kite 在我这里的权限”逐项列出：允许（绿）/ 需你批准（琥珀）/ 不允许（灰描边）。
- **手机**：大标题页 + 底部玻璃标签栏（线程 · 好友 · 自动化 · 设置）；加好友是玻璃底部弹层，分段「我的码 / 扫一扫 / 输入码」。

### 3.2 来电 / 去电 / 对方离线（d2 / m2）

- **桌面来电**：主界面压暗（`--g-scrim`）+ 背景轻微模糊；正中一张强玻璃卡 520 宽：
  - 顶行：🔒 端到端加密 · 视频走流量，不耗 token
  - 头像 104 + 两圈淡环（响铃动画，见 5.2）+ 右下 agent 圆标 44
  - 「林舟 邀请你视频通话」/「她的 agent Kite 也会加入 · 协作：app / Fix login timeout」
  - 我的摄像头预览 170×112 + 分段「带摄像头 / 仅语音」+ 开关「我的 Nyra 一起加入（可随时静音）」
  - 按钮：拒绝（红）· 回条消息 · 接听（绿 `#1F883D`）
  - 键盘：Enter 接听，Esc 拒绝。稿里写“30 秒无应答记为未接”——时长是建议值，Muse 可改。
  - App 不在前台时：建议用系统通知（实现方式由 Muse 定），不在稿内。
- **手机来电**：全屏，背景是对方视频的模糊（或头像）+ 50% 黑罩；底部媒体玻璃卡放分段、开关和三个 68 圆按钮（拒绝 / 回消息 / 接听）。
- **呼叫中**：全屏自己的预览 + 顶部渐变压暗；中间「正在呼叫 林舟… / Kite 也会收到邀请 · 响铃 12 秒」；底部玻璃控制条（麦克风 / 摄像头 / 翻转 / 挂断）。
- **对方离线**：深色底、无视频；「林舟现在不在线 / 上次在线 2 小时前 · Kite 也不在线」；底部玻璃卡：留言输入、「她上线时提醒我」、关闭；说明「Kite 离线时也不能代她接听或协作」。

### 3.3 通话中（d3 / m3）— 核心

**桌面（1440×900）布局**：

- 顶栏（玻璃，浮在内容上，左右各 12、距顶 10、高 50、圆角 16）：窗口按钮 · 对方头像 26 + 名字 + 协作上下文 + 计时（等宽）· 右侧 4 个状态片：`🔒 端到端加密`、`● 未录制 / ● 录制中 · 全员已同意`（红）、`信号良好`（静态信号指示，不跳数字；点它进用量弹层看实时速率与已用流量；弱网时显示「信号较弱」）、`视频走流量，不耗 token`；再右是「布局」「收起协作面板」两个图标按钮。
- 舞台（左侧 984 宽）：**按主人成对排列**——左列「我的 Nyra」+「我」，右列「林舟的 Kite」+「林舟」。上排 agent 块（高 208），下排人的视频块（高 560，圆角 16）。成对排列让“谁的 agent”一眼可见，不用读字。
  - 人的视频块：左上名字牌（媒体玻璃，头像 18 + 名字）、右上麦克风状态；正在说话 = 2px `--fg` 描边、外偏移 2px。名字牌放在**上方**，因为控制条浮在下方。
  - agent 块：实色面板（`--side` + 1px `--line`，不是玻璃——它不是浮层）。左上「标志 Nyra · 我的 agent」，右上不再放 token 数；中间左侧是动画圆标（56），右侧是状态大字（15/600）+ 细节（等宽：文件名、最近两步）。token 的数只在用量弹层与设置里看，不在 agent 块上。
- 控制条（玻璃，居中于舞台，距底 22，圆角 22，内边距 8）：静音 · 摄像头 · 共享屏幕 ｜ agent 按钮（标志 +「Nyra 在听」+「邀请 agent / 让它静音」+ ▾ 菜单）｜ 聊天（角标）· 更多 ｜ 挂断（红，64 宽）。按钮 52×52、圆角 16，图标 20 + 10.5px 标签。开启态 `--chip` 底；关闭态（如摄像头关）反色实心。
- 共享协作面板（玻璃，右侧 432 宽，距顶 70、距底 12，圆角 16）：
  - 标题「共享协作 · app · fix/login-timeout」+ 成员头像（2 人 + 2 agent）
  - 标签：线程 · 计划 3/5 · Diff 2 · 成员 4
  - 「谁在改什么」：每行 = 谁（agent 标志 / 人头像）+ 在做什么（文件名等宽）+ 状态片（等你批准 · 琥珀 / 已完成 · 绿 / 时间）
  - **审批卡**：和现有审批卡同一结构与文案——图标 + 标题「Kite 想修改你的 auth/client.py +6 −2」+ 副标题「林舟的 agent · 改你的文件要你批准 · 用林舟的 token」+ diff 片段 + 「查看完整 diff」+ **拒绝 / 总是允许 / 允许一次**（允许一次为主按钮）。“总是允许”的作用域：只对本次通话里这个 agent、这一类操作（建议按路径前缀，如 `auth/`）——具体粒度 Muse 定，但界面上要在 hover / 次级说明里写清范围。
  - 共享线程消息（人 = 灰气泡；agent = 标志 + 名字 + “· 我的 / · 林舟的”）
  - 底部不放用量卡：token 的数只在用量弹层与设置里出现，协作面板里不放；「视频走流量，不耗 token」这句话顶栏已有，不再重复。
  - 输入框「在共享线程里说点什么，@Kite @Nyra」
- 只有对方 agent 改**我的**文件才需要我批准；我的 Nyra 改我自己的文件沿用我现有的审批设置（不在本稿新增规则）。

**手机（390×844）**：

- 通话画面**两种主题都是深色媒体舞台**（视频看起来最好、玻璃在视频上最清楚）；浅色 / 深色的差别体现在弹层、抽屉和非通话页。
- 全屏对方视频 + 上下渐变压暗；顶部媒体玻璃条：最小化 · 名字 + 计时 · 🔒 端到端加密 · 未录制 · 右侧信号片（信号良好，不跳数字；点它进用量弹层）；右上自己的画中画 104×140。
- 两张 agent 小片（媒体玻璃）：动画圆标 22 + 「Kite · 林舟的 / 正在编辑 client.py」「Nyra · 我的 / 在听」。
- 协作提示条：左侧琥珀竖条 +「协作 · 1 个待你批准 / 上滑打开 · Kite 想改 auth/client.py」。
- 底部媒体玻璃控制条：麦克风 · 摄像头 · 共享屏幕 · agent · 聊天 · 挂断（50 圆，挂断 62 宽红）。
- **协作抽屉**：上滑后视频缩到顶部，强玻璃底部弹层：分段「视频 / 协作 · 1」、谁在改什么、审批卡（「允许 Kite 改这个文件？」+ diff + 拒绝 / 总是允许 / 允许一次 + 「先存检查点 · 可在电脑上 /undo」）、线程输入框。分段可点也可上下滑。
- Android：同一布局，状态栏 38 高、打孔摄像头、控制条距底 20；系统返回手势 = 收起抽屉 / 最小化通话（不挂断）。

### 3.4 流量 vs token（d3 顶栏 / m4 第 3 屏）

- 顶栏信号片：只显示信号图标 + 「信号良好」/「信号较弱」，不放实时速率与已用流量（不跳数字）。点它 → 「这次通话的用量」弹层（桌面与手机同款）：实时速率、已用流量、网络类型、视频清晰度、两行 token（按 agent 与主人分列）、开关「蜂窝网络下省流量（最高 360p，弱网时先关视频）」。弱网时顶栏信号片显示「信号较弱」，横幅里再写一句「网好了视频会自己回来」。
- token 永远和 agent 绑定显示，并写明是谁的 token：「Nyra · 我的 token」「Kite · 林舟的 token」。不要出现一个不分人的 token 总数。token 的数只在用量弹层与设置里出现，不出现在通话主界面（agent 块、协作面板、抽屉里都不放）。
- 实测流量 / token 从哪里来由 Muse 定；稿里的数字全部是示意。

### 3.5 权限与隐私（d4 / d5 / m4）

- **首次协作权限**（每个对方 agent 只问一次，之后在好友详情里改）：
  - 共享范围片：`app/` · 分支 `fix/login-timeout` · 线程（可「改范围」）
  - 三选一：只读 / **可提议修改，每次要我批准（推荐，默认选中）** / 可直接改共享分支（只在该分支，可 /undo）
  - 开关：在我的机器上运行命令（默认关；开了每条也要批准）· 读取共享范围外的文件与项目（**锁定为关**）· 看到我的屏幕共享（只在我主动共享时）
  - 说明：你的 Nyra 在对方那边的权限由对方决定；Kite 用林舟的 token
  - 按钮：先不协作，只通话 / 开始协作
- **端到端加密 / 录制状态**：顶栏常驻两枚状态片，任何时刻都可见（桌面顶栏、手机顶条）。录制中为红色并写“全员已同意”。加密是否真的端到端取决于 Muse 的连接层；**只有实现真正做到端到端时才显示这枚状态片**，否则改文案（如“已加密传输”）——不能先写上。
- **录制同意**：「林舟想录制这次通话 / 要每个人都同意才会开始录。你不同意，就不会录」；列出会录什么（画面 / 声音 / 屏幕共享，共享线程的消息与改动记录）和录像在谁那边（发起方）；「不同意 / 同意录制」。录像存储方式由实现决定，稿里只写“给谁”。

### 3.6 边缘状态（d6 / d7 / m5）

- **弱网**：自动关掉视频、保留音频，人的块换成头像 + 「仅语音」；舞台中上方强玻璃横幅：信号图标（琥珀）+「网络较弱，已自动切到仅语音 / 网好了视频会自己回来 · 协作和 agent 不受影响」+「仍要开视频」+ 关闭。顶栏信号图标变为 1 格，速率变成 KB/s。触发阈值与恢复策略由 Muse 定。
- **对方离线**：见 3.2。
- **通话结束总结**：强玻璃卡：双方头像 + 「和林舟的通话已结束 / 时间段 · 未录制 · 端到端加密」；三格数据（时长 / 流量含上下行与“不耗 token” / Agent token 按主人拆分）；「一起完成的」（每条改动：谁改的、+/−、谁批准的、检查点、查看 diff；被拒绝的也列出，带附言）；「待办」（来源：共享线程 / 计划，标注负责人）；按钮：关闭 / 再打一次 / **存为线程并加入待办**。

## 4. 组件

| 组件 | 要点 |
|------|------|
| 头像 + agent 徽章 `.av` | 圆形；徽章 = 尺寸 44%（最小 14）的底色圆 + 标志；状态点在右上 |
| agent 圆标 `orb` | 标志 SVG（`docs/assets/nyra-mark.svg` 同一条 evenodd 路径，圆盘 = currentColor，光标镂空）+ 状态装饰 |
| agent 块 `.agt` | 实色面板；谁的 agent / 谁的 token / 状态 / 细节 |
| 视频块 `.tile` | 圆角 16；名字牌 + 麦克风在上；说话描边 |
| 控制条 `.cbar` | 玻璃；按钮 52（手机 50）；挂断红 |
| 状态片 `.chip` | 24 高；`.o` 描边版；`.warn` 琥珀 |
| 审批卡 `.appr` | 与现有审批卡一致：拒绝 / 总是允许 / 允许一次 |
| 权限单选 `.rd` / 开关 `.tg` | 选中项 1.5px `--fg` 描边 + `--chip` 底；关开关是描边圆环（非文字 UI ≥ 3:1） |
| 横幅 | 强玻璃，左侧图标，右侧主动作 + 关闭 |

### agent 状态

| 状态 | 中文 | 圆标装饰（动画） | 细节行 |
|------|------|------------------|--------|
| listen | 在听 | 三圈同心环向外扩散淡出：`@keyframes listen{0%{transform:scale(1);opacity:.5}100%{transform:scale(1.8);opacity:0}}`，1.8s，三圈错开 0.6s | 最近完成的事 |
| think | 思考中 | 一段 70° 的弧绕圆标旋转：`@keyframes think{to{transform:rotate(360deg)}}`，1.2s linear | — |
| edit | 正在编辑 | 虚线环（2 6）缓慢旋转 6s；状态字后跟闪烁光标块（`blink` 1s steps） | 文件名（等宽）+ 最近两步 |
| wait | 等你批准 | 2px `--warn` 实线环，静止；状态字用 `--warntx` | 想改的文件 |
| muted | 已静音 | 圆标 42% 不透明 + 右下静音小圆片 | 「不听也不说，后台任务照常」 |
| offline | 离线 | 圆标 42% 不透明，无装饰 | 上次在线时间 |

`prefers-reduced-motion: reduce` 时全部换成静帧（就是设计稿里画的样子），状态靠文字表达。

## 5. 令牌与玻璃参数

### 5.1 颜色

沿用 `kit.py` / `src/assets/desktop-app.css.txt` 的 LIGHT / DARK 令牌，**不新增品牌色**。通话面板只多了这些：

| 令牌 | 浅色 | 深色 | 用途 |
|------|------|------|------|
| `--mu`（通话面板内） | `#5C5C61` | `#A6A6AB` | 次要文字（实现里玻璃上用的加深 / 提亮值，这里整个通话面板都用） |
| `--mu2`（通话面板内） | `#67676C` | `#8E8E93` | 三级文字 |
| `--gmu` / `--gmu2`（玻璃上） | `#4E4E53` / `#5C5C61` | `#C8C8CD` / `#B4B4B9` | 玻璃上的次要 / 三级文字（比实现再深 / 亮一档，因为玻璃更透） |
| `--warn` | `#B7791F` | `#E3B341` | 琥珀：等批准、弱网图标、环 |
| `--warntx` | `#8A5A00` | `#E3B341` | 琥珀文字（浅色下 `#B7791F` 不够 4.5:1） |
| `--warnbg` | `#FBF3E4` | `rgba(227,179,65,.12)` | 琥珀片底 |
| `--danger` | `#D92D20` | `#D92D20` | 挂断 / 拒绝按钮底（白字 ≥ 4.5:1） |
| `--rectx` | `#A40E26` | `#FF9A92` | 「录制中」文字 |
| 接听绿 | `#1F883D` | `#1F883D` | 接听按钮底（白字 ≥ 4.5:1） |
| 玻璃上的 diff 色 | `--add #1A7F37` / `--rm #CF222E` | `#5BD46A` / `#FF9A92` | 深色玻璃有镜面高光，原 `#3FB950 / #F85149` 不够 4.5:1 |

### 5.2 加强版液态玻璃（比现实现更明显）

和实现的差别：模糊 24 → **40px**，饱和 180% → **220%**，镜面高光更亮（顶部 .55 → **.80**，斜向光带 .2 → **.42**），新增一道**渐变折射边（rim）**，内发光上下都有。文字承载层（`strong`）的填充不降反升，保证对比度。

```css
/* 浅色 */
--g-fill: rgba(255,255,255,.50);      /* 控制条、顶栏、协作面板 */
--g-strong: rgba(255,255,255,.78);    /* 对话框、弹层、审批卡、横幅 */
--g-blur: 40px; --g-sat: 220%;
--g-border: rgba(0,0,0,.10);
--g-inner: inset 0 1px 0 rgba(255,255,255,1), inset 0 0 0 1px rgba(255,255,255,.45),
           inset 0 -1px 0 rgba(255,255,255,.55), inset 0 -22px 40px rgba(255,255,255,.30),
           inset 0 14px 28px rgba(255,255,255,.22);
--g-spec: linear-gradient(180deg, rgba(255,255,255,.80), rgba(255,255,255,0) 48%),
          linear-gradient(112deg, rgba(255,255,255,0) 34%, rgba(255,255,255,.42) 48%, rgba(255,255,255,0) 62%);
--g-rim: linear-gradient(160deg, rgba(255,255,255,1), rgba(255,255,255,.15) 30%, rgba(255,255,255,.05) 60%, rgba(255,255,255,.85));
--g-shadow: 0 18px 50px rgba(0,0,0,.16), 0 2px 6px rgba(0,0,0,.06);
--g-scrim: rgba(242,242,244,.55);     /* 弹窗后面的压暗 */

/* 深色 */
--g-fill: rgba(30,30,33,.50);
--g-strong: rgba(24,24,27,.84);
--g-border: rgba(255,255,255,.12);
--g-inner: inset 0 1px 0 rgba(255,255,255,.30), inset 0 0 0 1px rgba(255,255,255,.06),
           inset 0 -1px 0 rgba(255,255,255,.08), inset 0 -22px 40px rgba(255,255,255,.04),
           inset 0 14px 28px rgba(255,255,255,.035);
--g-spec: linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,0) 48%),
          linear-gradient(112deg, rgba(255,255,255,0) 34%, rgba(255,255,255,.09) 48%, rgba(255,255,255,0) 62%);
--g-rim: linear-gradient(160deg, rgba(255,255,255,.55), rgba(255,255,255,.06) 30%, rgba(255,255,255,0) 60%, rgba(255,255,255,.30));
--g-shadow: 0 22px 60px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.35);
--g-scrim: rgba(0,0,0,.45);

/* 媒体玻璃：手机视频上的一切浮层（两种主题相同），文字一律浅色 */
--m-fill: rgba(22,22,24,.64);  --m-strong: rgba(18,18,20,.76);
--m-border: rgba(255,255,255,.14);
--m-inner: inset 0 1px 0 rgba(255,255,255,.32), inset 0 0 0 1px rgba(255,255,255,.07),
           inset 0 -1px 0 rgba(255,255,255,.08), inset 0 -20px 36px rgba(255,255,255,.045);
--m-spec: linear-gradient(180deg, rgba(255,255,255,.18), rgba(255,255,255,0) 48%),
          linear-gradient(112deg, rgba(255,255,255,0) 34%, rgba(255,255,255,.10) 48%, rgba(255,255,255,0) 62%);
--m-rim: linear-gradient(160deg, rgba(255,255,255,.60), rgba(255,255,255,.06) 30%, rgba(255,255,255,0) 60%, rgba(255,255,255,.32));
/* 媒体玻璃上的文字：#F5F5F7；次要 #D6D6DA；三级 #C4C4C9 */

.glass   { backdrop-filter: blur(var(--g-blur)) saturate(var(--g-sat)); background: var(--g-spec), var(--g-fill);
           border: 1px solid var(--g-border); box-shadow: var(--g-inner), var(--g-shadow); }
.gstrong { /* 同上 */ background: var(--g-spec), var(--g-strong); }
/* 折射边：1px 渐变描边，mask 只露边 */
.glass::after { content:""; position:absolute; inset:-1px; border-radius:inherit; padding:1px; background:var(--g-rim);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask-composite: exclude; pointer-events:none; }
```

视频上的配套压暗（手机）：顶部 `linear-gradient(180deg, rgba(0,0,0,.72), rgba(0,0,0,.25) 18%, transparent 32%)`，底部到 `.55`；状态栏下再垫一层 96px `rgba(0,0,0,.5) → 0`。没有这层，白墙背景上的白字会掉到 3:1 左右。

**只有浮层是玻璃**：控制条、顶栏、协作面板、对话框、底部弹层 / 抽屉、横幅、视频上的名字牌和 agent 小片。agent 块、好友列表行、卡片都是实色。

**回退**（与实现一致）：`prefers-reduced-transparency: reduce` 或不支持 `backdrop-filter` 时，`.glass/.gstrong` 换实色（浅 `#FFFFFF` / 深 `#141415`），媒体玻璃换 `#161618`，折射边和镜面去掉。

### 5.3 尺寸与间距

| 项 | 桌面 | 手机 |
|----|------|------|
| 字体 | Inter；等宽 JetBrains Mono；中文回退 PingFang SC / Noto Sans CJK SC | 同左 |
| 正文 / 次要 / 三级 | 13.5 / 12–12.5 / 11.5 | 15 / 13–13.5 / 12 |
| 玻璃圆角 | 顶栏 16、控制条 22、对话框 22–24、横幅 14、审批卡 12 | 弹层 30（上角）、控制条 32、顶条 20、小片 16 |
| 控制按钮 | 52×52，圆角 16 | 50 圆；来电大按钮 68 |
| 最小点击区 | 28（顶栏按钮）/ 34（对话框按钮） | 44 |

## 6. 交互细节

- 控制条在通话中常驻（不自动隐藏），因为它承载了 agent 状态入口；鼠标闲置 3 秒后可降到 70% 不透明（建议，可不做）。
- 键盘建议：空格按住说话（静音时）、`⌘⇧A` 静音、`⌘⇧V` 摄像头、`⌘⇧S` 共享屏幕、`⌘⇧W` 挂断（需二次确认），Windows 用 `Ctrl+Shift`。均为建议，避开现有 `⌘N / ⌘K`。
- agent 按钮 ▾ 菜单：邀请 agent 加入（我的 / 对方的）· 让 Nyra 静音 · 让 Nyra 离开通话 · 权限…。静音 agent 不影响它已经在跑的任务。
- 审批卡出现时：协作面板自动滚到卡片；面板收起时，控制条「聊天」旁出现琥珀角标 + 一次性提示音（可在设置关闭）。审批卡获得焦点但**不抢走**正在说话的麦克风 / 快捷键。
- 拒绝时可附言（沿用现有“拒绝 + 反馈”交互）；附言进共享线程，对方 agent 能看到。
- 屏幕共享时舞台把共享画面放大到人块的位置，两个人块缩成右上角小窗（未出稿，按此规则排）。
- 3 人以上：舞台按“每个人 + 他的 agent”成对往下排；超过 4 对时 agent 块折叠成人块角上的小片（未出稿）。
- 结束总结里的「存为线程并加入待办」= 把共享线程 + 改动 + 待办存成本地一个线程；对方是否同步由 Muse 定。

## 7. 无障碍

- **对比度**：用 `source/contrast_call.py` 在全部 24 张画板上实测——记下每个文字元素的位置和颜色，隐藏文字再截一张取背景像素，按背景**第 10 百分位**（最不利的那块）算 WCAG 对比度。结果：1346 个文字元素，**0 个低于 4.5:1**（≥ 24px 或 ≥ 18.66px 粗体按 3:1）。不计入：弹窗后面被压暗 / 模糊的背景层、置灰的禁用按钮（WCAG 豁免）。注意：真实视频比稿里的亮的可能更亮，媒体玻璃的填充（.64 / .76）和顶部压暗不要再调低。
- 状态不只靠颜色：在线 / 忙碌 / 离线、等批准、录制中都有文字。
- 屏幕阅读器：agent 状态变化用 `aria-live="polite"` 播报（“Kite 正在编辑 auth/client.py”），审批卡出现用 `assertive` 播报一次；来电对话框 `role="alertdialog"`，焦点落在「接听」；弹窗内焦点循环、Esc 关闭（录制同意的 Esc = 不同意）。
- 控制按钮都有可读名（`aria-label`）和按下态（`aria-pressed`），例如“麦克风，已开启”。
- 动画：`prefers-reduced-motion` 全部换静帧；响铃环、listen 扩散都停。
- 字幕 / 转写：不在本稿范围；如果做，入口放在「更多」。

## 8. 文案表（中 / 英）

| 位置 | 中文 | English |
|------|------|---------|
| 侧栏 / 标签 | 好友与通话 / 好友 | Friends & calls / Friends |
| 好友页副标题 | 加的是“一个人 + 他的 agent” | You add a person and their agent |
| 好友码 | 我的 Nyra 好友码 · 对方扫码或输入即可加你 | My Nyra friend code · scan or enter it to add me |
| | 好友码 24 小时后失效 · 重新生成 · 加好友后对方的 agent 默认只读 | Code expires in 24 hours · Regenerate · Their agent is read-only by default |
| 按钮 | 复制 / 分享 / 换一个 | Copy / Share / New code |
| 加好友弹层 | 加好友 · 我的码 / 扫一扫 / 输入码 | Add friend · My code / Scan / Enter code |
| 好友请求 | {name} 想加你为好友 · 连同他的 agent {agent} | {name} wants to be friends · together with their agent {agent} |
| | 接受后：{name} 可以给你打视频；{agent} 默认只读，第一次协作前你会再确认它能做什么。 | If you accept, {name} can video call you. {agent} starts read-only, and you'll confirm what it can do before you first work together. |
| 按钮 | 拒绝 / 接受 | Decline / Accept |
| 好友行 | {agent} · {name}的 agent · 只读 / 可提议修改 | {agent} · {name}'s agent · Read-only / Can propose edits |
| 状态 | 在线 / 忙碌 · 通话中 / 离线 · 2 小时前 | Online / Busy · in a call / Offline · 2 h ago |
| 行动 | 视频通话 / 语音 / 邀请协作 | Video call / Voice / Invite to collaborate |
| 详情 | 人 / 她的 agent / 空闲 · 用林舟的 token | Person / Her agent / Idle · uses Lin's tokens |
| 权限标题 | {agent} 在我这里的权限 | What {agent} can do here |
| | 只管 agent；林舟本人能看到的，就是你在通话里共享给她的。 | Agent only. Lin herself sees only what you share in the call. |
| 权限项 | 看共享线程与计划 / 读取共享范围内的文件 / 提议修改你的文件 / 在你的机器上运行命令 / 访问共享范围外的项目与文件 | View shared thread and plan / Read files in the shared scope / Propose edits to your files / Run commands on your machine / Access projects and files outside the shared scope |
| 权限值 | 允许 / 需你批准 / 不允许 | Allowed / Needs your approval / Not allowed |
| 最近 | 最近一起做的 | Recent sessions together |
| 来电 | {name} 邀请你视频通话 | {name} is inviting you to a video call |
| | 她的 agent {agent} 也会加入 · 协作：{project} | Her agent {agent} will join too · Working on: {project} |
| | 怎么加入 · 带摄像头 / 仅语音 | Join with · Camera / Voice only |
| | 我的 Nyra 一起加入（可随时静音） | Bring my Nyra (mute it anytime) |
| 按钮 | 拒绝 / 回条消息 / 接听 | Decline / Reply with message / Accept |
| | Enter 接听 · Esc 拒绝 · 30 秒无应答记为未接 | Enter to accept · Esc to decline · Missed after 30 s |
| 常驻 | 端到端加密 · 视频走流量，不耗 token | End-to-end encrypted · Video uses data, not tokens |
| 呼叫中 | 正在呼叫 {name}… / {agent} 也会收到邀请 · 响铃 12 秒 | Calling {name}… / {agent} is invited too · Ringing 12 s |
| 离线 | {name}现在不在线 / 上次在线 2 小时前 · {agent} 也不在线 | {name} is offline / Last seen 2 h ago · {agent} is offline too |
| | 留个话，她上线时会收到 / 她上线时提醒我 / 关闭 | Leave a message for when she's back / Remind me when she's online / Close |
| | {agent} 离线时也不能代她接听或协作 | {agent} can't answer or collaborate for her while offline |
| 顶栏 | 端到端加密 / 未录制 / 录制中 · 全员已同意 | End-to-end encrypted / Not recording / Recording · everyone agreed |
| | 信号良好（点进用量弹层看实时速率与已用流量） | Signal good (tap for live rate and data used) |
| | 视频走流量，不耗 token | Video uses data, not tokens |
| 控制条 | 静音 / 摄像头 / 共享屏幕 / 聊天 / 更多 / 挂断 | Mute / Camera / Share screen / Chat / More / Leave |
| agent 按钮 | Nyra 在听 · 邀请 agent / 让它静音 | Nyra is listening · Invite agent / Mute it |
| agent 状态 | 在听 / 思考中 / 正在编辑 {file} / 等你批准 / 已静音 / 离线 | Listening / Thinking / Editing {file} / Waiting for your approval / Muted / Offline |
| agent 块 | {agent} · {owner}的 agent / 状态 + 在干什么（不放 token 数） | {agent} · {owner}'s agent / Status and what it's doing (no token count) |
| 协作面板 | 共享协作 / 线程 · 计划 · Diff · 成员 / 谁在改什么 | Shared work / Thread · Plan · Diff · Members / Who's changing what |
| | 等你批准 / 已完成 / 1 分钟前 | Needs your approval / Done / 1 min ago |
| 审批卡 | {agent} 想修改你的 {file} | {agent} wants to edit your {file} |
| | 林舟的 agent · 改你的文件要你批准 · 用林舟的 token | Lin's agent · Edits to your files need your approval · Uses Lin's tokens |
| | 查看完整 diff · 拒绝 / 总是允许 / 允许一次 | View full diff · Deny / Always / Allow once |
| 手机审批 | 允许 {agent} 改这个文件？ / 先存检查点 · 可在电脑上 /undo | Let {agent} edit this file? / Checkpoint first · /undo on your computer |
| 输入框 | 在共享线程里说点什么，@Kite @Nyra | Say something in the shared thread, @Kite @Nyra |
| 抽屉 | 视频 / 协作 · 1 / 协作 · 1 个待你批准 / 上滑打开 | Video / Shared · 1 / Shared · 1 needs your approval / Swipe up to open |
| 用量弹层 | 这次通话的用量 / 实时 / 已用流量 / 网络 / 视频清晰度 | Usage for this call / Live / Data used / Network / Video quality |
| | 蜂窝网络下省流量 · 最高 360p，弱网时先关视频 | Save data on cellular · Up to 360p, video off first on a weak connection |
| | 数字为示意 | Illustrative numbers |
| 首次协作 | 第一次和 {agent} 协作 | First time working with {agent} |
| | 林舟的 agent 在这次协作里能看到、能做什么？只问这一次，之后可在好友页改。 | What can Lin's agent see and do in this session? Asked once; change it later on the Friends page. |
| | 共享范围 · 改范围 | Shared scope · Change |
| | 只读 · 看共享线程、计划和共享范围内的文件，不能提修改 | Read-only · Sees the shared thread, plan and files in scope; can't propose edits |
| | 可提议修改，每次要我批准（推荐） · Kite 的每处改动都会弹出审批卡：拒绝 / 总是允许 / 允许一次 | Can propose edits, each needs my approval (Recommended) · Every change shows an approval card: Deny / Always / Allow once |
| | 可直接改共享分支 · 只在 {branch} 上，不经审批；可随时 /undo 回到检查点 | Can edit the shared branch directly · Only on {branch}, no approval; /undo to any checkpoint |
| | 在我的机器上运行命令 · 测试、构建、脚本——默认不允许；开启后每条命令也要你批准 | Run commands on my machine · Tests, builds, scripts. Off by default; when on, each command still needs approval |
| | 读取共享范围外的文件与项目 · 始终不允许 | Read files and projects outside the scope · Never allowed |
| | 看到我的屏幕共享 · 只在你主动共享屏幕时 | See my screen share · Only when you share your screen |
| | 你的 Nyra 在林舟那边能做什么，由林舟决定。Kite 的工作用林舟自己的 token，不花你的。 | Lin decides what your Nyra can do on her side. Kite's work uses Lin's tokens, not yours. |
| 按钮 | 先不协作，只通话 / 开始协作 | Just call for now / Start collaborating |
| 录制 | {name}想录制这次通话 | {name} wants to record this call |
| | 要每个人都同意才会开始录。你不同意，就不会录。 | Recording starts only if everyone agrees. If you say no, nothing is recorded. |
| | 会录：所有人的画面与声音、屏幕共享 / 会录：共享线程里的消息和改动记录 / 录像保存在发起录制的一方（{name}） | Records: everyone's video and audio, screen shares / Records: shared thread messages and change history / The recording is kept by whoever started it ({name}) |
| | 录制开始后，顶栏会一直显示红色“录制中”；任何人都可以随时停止自己的那一路。 | While recording, a red "Recording" badge stays in the top bar. Anyone can stop their own stream at any time. |
| 按钮 | 不同意 / 同意录制 | Don't agree / Agree to record |
| 弱网 | 网络较弱，已自动切到仅语音 | Weak connection. Switched to voice only |
| | 网好了视频会自己回来 · 协作和 agent 不受影响 | Video comes back when the connection improves · Collaboration and agents keep working |
| | 仍要开视频 / 仅语音 / 正在说话 | Turn video on anyway / Voice only / Speaking |
| 结束 | 通话已结束 / 和{name}的通话已结束 | Call ended / Call with {name} ended |
| | 时长 / 流量 / Agent token / 不耗 token / 各付各的 | Duration / Data / Agent tokens / No tokens used / Each pays their own |
| | 一起完成的 / 待办 | Done together / To-dos |
| | {agent} 修改了 {file} · 你在 14:21 允许一次 · 检查点 4 | {agent} edited {file} · You allowed once at 14:21 · Checkpoint 4 |
| | {agent} 想运行 {cmd} · 你拒绝了 · 附言“{note}” | {agent} wanted to run {cmd} · You denied · Note: "{note}" |
| 按钮 | 关闭 / 再打一次 / 存为线程并加入待办 | Close / Call again / Save as thread and add to-dos |

用户可见文字只出现 **Nyra**（产品名 / 默认 agent 名）和用户自取的 agent 名。

## 9. 稿内的假设与留给 Muse 的事

- 连接层、信令、NAT 穿透、端到端加密的实现方式都由 Muse 定（例如 WebRTC + TURN），本稿不假设任何一种。
- “端到端加密”状态片只在实现真正端到端时显示（见 3.5）。
- 好友码格式、有效期、二维码内容；在线状态如何同步；离线留言怎么送达。
- 弱网阈值、自动恢复视频的条件、蜂窝网络省流量的具体码率。
- 流量和 token 的计数来源与刷新频率。
- 录像的存储位置与格式（稿里只写“在发起方那边”）。
- “总是允许”的作用域粒度（建议：本次通话 × 这个 agent × 路径前缀）。

## 10. 占位数字（全部是示意）

| 值 | 出现位置 |
|----|----------|
| `NYR-7K4Q-2M`、二维码内容 `nyra://add/NYR-7K4Q-2M`、24 小时有效期 | 好友码 |
| ↑ 1.2 MB/s ↓ 2.4 MB/s · 已用 85 MB；弱网 ↑ 24 KB/s ↓ 48 KB/s · 91 MB | 只在用量弹层内（顶栏改静态信号，不再显示） |
| 我的 token 3.2k / 林舟的 token 5.8k；结束时 4.1k / 7.6k，共 11.7k | 只在用量弹层与结束总结内（agent 块、协作面板、抽屉里不再出现） |
| 12:48（通话计时）、32:14、14:02–14:34、14:21、响铃 12 秒、30 秒未接 | 顶栏、总结、呼叫 |
| 412 MB（↑ 138 / ↓ 274） | 总结 |
| `auth/client.py +6 −2`、`tests/test_auth.py +24`、测试 3/3、计划 3/5、Diff 2、成员 4、检查点 4 | 协作面板、总结 |
| 720p · 自动、360p | 用量弹层 |
| 人名（林舟、Mark Chen、许安、周屿、Ana Ruiz）和 agent 名（Kite、Pilot、Atlas、Moss） | 全部 |

视频画面是生成的示意图（`source/call-assets/`），不是真人照片。

## 11. 重新生成

```bash
cd docs/design/video-call/source
# 需要 Inter（Regular / SemiBold / Bold）和 JetBrains Mono（Regular / Bold）的 TTF，放在本目录，文件名见 callkit.py 的 FONTS
python3 call.py            # 生成 call-*.html 与 call-manifest.json
python3 render_call.py     # Playwright 渲染画板与单屏（输出目录见脚本里的 OUT）
python3 call-overview.py   # 总览
python3 contrast_call.py   # 对比度实测
```
