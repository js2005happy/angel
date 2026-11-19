# 分应用文风学习（缺口 4）

> 2026-11-20，P3。只学能力、不抄实现：接口语义学 Turnstone 的
> “How you write”（每个渠道各存一套用户文风画像，代笔时按画像写）与
> ChatGPT Work（接 Gmail/Slack/Drive 学用户怎么写），实现是 Nyra
> 自己的确定性启发式提炼 + 本地 JSON 存储，不抄别家的代码、界面文案
> 与视觉，不调模型、不联网。

## 问题

Nyra 在任何渠道代笔都一个味，越用越像 AI；记忆是事实与偏好，不是
文风——Nyra 以前没有“学用户怎么写”这件事。

## 红线（比别家更严）

- **只学用户自己已发送的消息**：样本由用户主动提供（文件或 stdin），
  Nyra 不读他人发来的消息学文风，不碰 OAuth 拉取历史（那是缺口 6 的事）。
- **显式 opt-in**：`nyra style learn` 先展示提炼出的画像，用户确认后
  才保存；`--yes` 只用于脚本，仍是用户显式调用。
- **本地存储、可查看可删除**：画像存在 `~/.nyra/styles/<渠道>.json`，
  `nyra style show/delete` 查看/删除；**样本原文绝不保存**，只存提炼
  出的画像。
- **画像只影响措辞风格**：不影响事实内容，不影响审批规则；保存与删除
  进证据链（`~/.nyra/evidence/style/`，`style_learn` / `style_delete`），
  记了学到什么、谁确认的、删了什么。查看是只读操作，不写证据。
- **提炼是确定性启发式，不是模型判断**：问候、落款、语气、长度、标点、
  缩写都按固定规则从样本里数出来；启发式会错，保存前用户看一眼、存
  后可直接改 JSON，这是设计不是缺陷。

## 存储

- 每渠道一条画像：`~/.nyra/styles/<渠道>.json`，与 `MEMORY.md` 同级管理。
- 渠道名：小写字母开头，只含小写字母/数字/`_`/`-`，最长 32 字符
  （与群组名同形）。报告里点名的渠道是 `gmail`、`outlook`、`slack`、
  `imessage`、`whatsapp`；不在表里的渠道名只要合规也能用，以后加
  Telegram 等不用改代码。
- 画像字段（`src/style.ts` 的 `StyleProfile`）：`tone`（正式/随意/中性）、
  `length`（短/中/长，中位长度分档：< 40 字 / 40–200 字 / > 200 字）、
  `typical_chars`（样本中位长度）、`greeting`（问候习惯）、`signoff`
  （落款习惯）、`punctuation`（标点习惯摘要）、`abbreviations`（缩写习惯
  摘要）、`notes`（自由备注，提炼时为空，用户可直接改 JSON 补充）、
  `sample_count`（提炼用的样本条数）、`learned_at`、`source`。
- 原子写：同目录 tmp（0600）+ fsync + rename，`styles/` 目录 0700；
  失败不损坏旧画像。画像损坏时 `loadStyleProfile` 抛错（`nyra style show`
  会报出来）；主循环注入时损坏的画像只跳过不注入，不拦运行。

## 提炼规则（`learnStyleProfile`）

- 至少 3 条样本才提炼（太少看不出习惯）；多于 50 条只用前 50 条。
- 样本文件格式：空行分隔多条消息；没有空行时每行一条（`parseSamples`）。
- 问候：样本开头命中问候词（你好/您好/早上好/Hi/Hello 等）的占比 ≥ 50%
  才算习惯，否则“无固定问候，直接说事”。
- 落款：样本末行命中落款词（谢谢/祝好/Best/Thanks 等）的占比 ≥ 30%
  才算习惯，否则“无固定落款”。
- 语气：正式标记（您/请/感谢/麻烦/此致等）与随意标记（哈哈/嗯嗯/哦/啦/
  ～/表情符号等）的出现次数相减，多的一方定语气，相等为中性。
- 标点：感叹号与表情符号的样本占比、省略号的有无，拼成一句话摘要。
- 缩写：命中英文缩写（pls/thx/btw/asap/fyi 等）与中文语气词（嗯/哦/哈等）
  高频出现时记下来，两边都没有就是“无明显缩写习惯”。

## CLI

```sh
# 从已发送消息样本学一套画像（先展示、确认后才保存）
nyra style learn gmail ~/sent-gmail.txt
nyra style learn slack - < ~/sent-slack.txt   # 从 stdin 读样本
nyra style learn gmail ~/sent-gmail.txt --yes # 脚本里跳过确认

# 查看 / 列出 / 删除
nyra style show gmail
nyra style show            # 列出全部画像
nyra style list
nyra style delete gmail [--yes]

# 导出 / 导入（Markdown，只追加不覆盖，同渠道已有就跳过）
nyra style export
nyra style import styles.md
```

代笔时用画像：`nyra --channel gmail "帮我回这封邮件"`——`--channel`
指定本次运行的代笔渠道，`Agent.buildSystemPrompt` 按渠道注入画像
（有画像才加，没有零影响）。注入段注明来源渠道，并写清边界：只影响
措辞风格，不改变事实内容，不改变审批规则，不模仿样本里的具体措辞与
个人信息。

## 随记忆快照导入/导出

画像随记忆快照一起走（`src/memoryExchange.ts`）：`nyra memory export`
在记忆分区之后追加 `## 文风画像（<渠道>）` 一节（没有画像时输出与以前
完全一致）；`nyra memory import` 读到这一节时一并导入，同渠道已有就
跳过、不覆盖。两端都过记忆快照同一套 `scrubSecrets` 脱敏（备注是用户
手写的自由文本，可能含凭据），含凭据的行直接删掉并计数。导入会重置
`source` 为“从记忆快照导入（本地）”；`sample_count` 与 `learned_at`
按快照里的值恢复，没有就记 0 与导入时间。

## 已知局限

- 提炼是启发式：问候/落款阈值、语气词表都是固定规则，中英混杂或样本
  风格本身就不一致时，画像可能抓偏——保存前请看一眼，存后可直接改 JSON。
- 画像只在终端一次性任务与 REPL 生效：`--channel` 经 `buildAgent` 传给
  Agent；网关（`nyra ui`）与群聊机器人建 Agent 时不传 channel，暂不注入
  画像（以后接）。
- 画像不参与记忆检索：文风画像与 MEMORY.md 的事实记忆是两套存储，
  `nyra memory search` 搜不到画像；`nyra style show` 才是查看入口。
- 多设备之间画像不同步：画像只在本地 `~/.nyra/styles/`，换机器要走
  `nyra style export/import` 或记忆快照手动带过去。
