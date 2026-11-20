# Bot 方向：Telegram 渠道（Phase 1 骨架 + Phase 2 角色与审批）

用户 2026-11-20 给的双场景架构：场景 A（外部社群/客服/办公 IM Bot）
与场景 B（个人/业务自动化监控与任务 Bot）复用同一套 Bot Core（会话
队列 + 幂等去重 + 权限策略 + 模型/工具执行 + 成本计量）。Phase 1 做
了核心骨架 + Telegram 渠道；Phase 2 做了 router（角色与工具白名单）
与 approvalBridge（聊天内审批）+ 用量硬顶；场景 B 的主动推送
（notifier）是 Phase 3。

## 快速开始

1. 在 Telegram 里找 @BotFather，发 `/newbot`，按提示起名字，拿到 token。
2. 把 token 存好（二选一，绝不写进配置文件）：
   - 环境变量：`TELEGRAM_BOT_TOKEN=<token>`；
   - 或密码箱：`nyra vault add TELEGRAM_BOT_TOKEN`（交互输入；没解锁密码箱时
     进 `~/.nyra/keys.json`，0600）。
3. 启动轮询：`nyra bot telegram start`（前台跑；Ctrl+C 或
   `nyra bot telegram stop` 停止）。查看状态：`nyra bot telegram status`。

## 消息处理主链路

```
Telegram getUpdates 长轮询 → 归一化 InboundMessage
  → 幂等去重（messageId，落盘，重启后仍有效）
  → 确定性指令优先（/help、/status、/new、/stop、/model、/approve、/reject）
  → 群聊 @ 过滤（mentionOnly 默认开，没 @ 直接忽略）
  → 配额（单用户/天、单群聊/分钟、当天 token 预算）
  → 会话排队（同一 sessionKey 串行，不同会话并行）
  → 先发“处理中…”占位 → Agent 执行（readonly）→ 分片回发（编辑占位 + 续发）
```

会话 key：群聊按 `telegram:<chatId>:<threadId>`，私聊按
`telegram:<senderId>`。会话历史与长期记忆按这个 key 隔离（Agent 的
会话文件 id 是 `bot-telegram-…`，不含 `:`，过 sessionPath 校验）：
A 用户的上下文绝不进 B 用户的 Agent。

## 确定性指令（不走模型、不扣 token、不计配额）

| 指令 | 作用 |
|---|---|
| `/help` | 帮助：命令列表与限制 |
| `/status` | 运行状态、队列深度、今日与本月花费 |
| `/new` | 开新会话（清除当前会话历史） |
| `/stop` | 停止当前正在处理的任务 |
| `/model` | 当前用的模型 |
| `/approve <id>`、`/reject <id>` | 放行/拒绝一条挂起的审批（Phase 2 接真逻辑；只有 owner/admin 能批，非白名单的放行无效并记审计） |

群聊里发指令也要先 @ Bot（mentionOnly 的规矩对指令同样适用）。

## Phase 2：角色与聊天内审批

### 角色表（按 senderId 认人：owner > admins > members > 默认 guest）

| 角色 | 能用的工具 | 能发起审批 | 能批准审批 | 步数/超时 |
|---|---|---|---|---|
| owner（机主） | 全部工具（除 `browser_*`、`computer_*` 前缀） | 是 | 是 | 按配置 |
| admin（管理员） | 只读工具 + `write_file`、`edit_file`、`plan`、`memory_append`（不给 shell） | 是 | 是 | 按配置 |
| member（受信任用户） | 只读工具 | 否 | 否 | 按配置 |
| guest（默认外部用户） | 只读工具 | 否 | 否 | 最多 6 步、60 秒 |

角色只定默认画像：`profiles` 能覆盖各角色的系统提示词、最大步数与
超时；能不能发起/批准审批是硬边界，配置改不了。按 chatId 的系统提
示词（`chat_system_prompts`）优先于按角色的——特定群聊可以有自己的
Bot 人设。画像变了重建 Agent（会话记忆还在，换的是 mode 与工具集）。

白名单是两道门：Agent 构造时不在白名单的工具直接从 schema 里拿掉
（`disabledTools`），模型看不到也调不到；审批层再拦一次——写操作进
`approveFn` 前先查白名单，不在白名单的直接拒绝、不建审批。

### 审批流程（approvalBridge）

1. owner/admin 的 Agent 要做写操作时，`approveFn` 先在白名单里查一
   遍，通过后建一条挂起审批（`approvalBridge.requestApproval`），向当
   前会话（或 `approval_chat_id` 指定的审批人私聊）发提示：审批 id、
   工具、风险说明、参数摘要（只记参数指纹 `args_hash`，不记原文），并
   附行内按钮「批准」「拒绝」。
2. 审批人回 `/approve <id>` / `/reject <id>`，或点按钮（Telegram
   callback query，本批只认 `bot:approve:<id>` / `bot:reject:<id>`
   两种回调）；放行前校验审批人是否在 owner/admin 白名单内——非白
   名单的放行无效，挂起项还在，并记审计。
3. 挂起动作超时（默认 60 秒，`approval_timeout_ms` 可改，夹在 5 秒到
   10 分钟之间）自动拒绝并记审计；`/stop` 或会话取消时，同会话的挂
   起审批一并取消。
4. 结论写两处：`~/.nyra/bot-audit.jsonl` 一行审计（只记结论，不记用
   户原文），与运行事件 `bot_approval_requested` /
   `bot_approval_decided`（已注册进 `EVENT_FIELDS`）。`/status` 能看
   到当前挂起审批数。

### 用量硬顶（审批绕不过配额）

- 执行前先做月度硬顶预检（本月已花 ≥ 上限直接回绝，不调模型）；
  单次硬顶走 Agent 自带的 checkCost；高频触发仍走 Phase 1 的三档配
  额（单用户/天、单群聊/分钟、当天 token 预算），审批放行不绕过配额。
- 拒绝的审批不扣 token（只记审计与事件）；放行后执行的花费照常进
  用量账本（delta 制，与 CLI 同口径）。

## 配额与成本

默认配额（config.json 的 `bot` 一节可改）：

- 单用户每天最多 100 条进模型的消息；
- 单群聊每分钟最多 10 条；
- 当天 token 预算默认不设（`daily_token_budget_usd: null`）。

用量记进现有用量账本（与 CLI 同口径：provider 实报 token + 已配单价
才算钱，算不出不挡人）；月度硬顶与单次硬顶走 Agent 自带的 checkCost，
超了直接中止（与 CLI 同一条诚实边界）。模型兜底链不进 Bot：只用主
provider，绝不自动换模型。

## 安全边界

- Bot token 只从环境变量或密码箱读，绝不硬编码、不记日志、不记审计；
  报错里只写方法名与 HTTP 状态（URL 里含 token，绝不能进错误文案）。
- 外部用户默认只读：guest/member 的 Agent mode 写死 `readonly`，只
  能问答与查询；owner/admin 的写操作逐次走聊天内审批（Phase 2），
  白名单外的工具模型看不到也调不到，审批层再拦一次。
- 审批拒绝绝不重试：审批拒绝曾是“错误字符串”进幂等重试，重试时
  `idempotentRetry` 短路跳过审批、把拒绝过的写操作执行了（Phase 2
  修，见 `isApprovalRefusalResult`；回归测试
  `test_approval_refusal_never_retries` 盯着）。拒绝后模型只看到一
  句“用户拒绝执行”，可以换做法继续，不会静默执行。
- 去重与配额记录在 `~/.nyra/bot-dedup.json` / `~/.nyra/bot-quota.json`
  （0600、原子写）；每条处理过的消息写一行 `~/.nyra/bot-audit.jsonl`
 （只记 channel、sessionKey、messageId、结论、字数、花费，不记用户原文）。
- 附件（图片/文件）Phase 1 不下载、不解析，只回一句说明。

## 配置（config.json 的 `bot` 一节）

```json
{
  "bot": {
    "enabled": false,
    "mention_only": true,
    "max_turns": 12,
    "timeout_ms": 120000,
    "per_user_daily_limit": 100,
    "per_chat_per_minute_limit": 10,
    "daily_token_budget_usd": null,
    "admins": [],
    "owner": null,
    "members": [],
    "approval_timeout_ms": 60000,
    "approval_chat_id": null,
    "chat_system_prompts": {},
    "profiles": {},
    "telegram": { "enabled": false, "username": null }
  }
}
```

`admins` 是管理员的 Telegram 用户 id（数字 id，不是 @用户名），留给
Phase 2 的审批指令认人；`owner` 是机主的 id（只认一个），`members`
是受信任用户 id 列表。`approval_timeout_ms` 是挂起审批的超时（默认
60 秒，夹在 5 秒到 10 分钟之间，超时自动拒绝）；`approval_chat_id`
为空时审批提示发在当前会话，填了则发到指定审批人私聊。
`chat_system_prompts` 按 chatId 覆盖系统提示词；`profiles` 按角色
覆盖系统提示词、最大步数与超时（例：`"profiles": {"guest":
{"maxTurns": 4}}`）。`timeout_ms` 是单条消息从入队到出结果的超时
（默认 120 秒；超时按取消处理）。

## 已知局限（诚实边界）

- 真实 Telegram Bot 未接通：token 须用户在 @BotFather 建机器人后提供；
  轮询与审批按钮只在本地用假 Telegram API 验过。
- `/stop` 与超时不能真中断在跑的模型调用：Agent.run 不支持
  AbortSignal。做到的是：排队中的任务直接出队；在跑的任务不再等结果、
  不回发，后台调用跑完后结果丢弃、Agent 实例丢弃、会话文件按取消前
  的快照恢复（取消瞬间恢复一次，后台调用结束后再恢复一次；若期间已
  有新任务，不恢复，以免抹掉新进度）。彻底的中断要等 Agent 层接
  AbortSignal，以后单独一批。
- 超长回复按 4000 字符分片；代码围栏切开时自动补收尾/重开围栏。
- 群聊 @ 判定靠 Bot 用户名（启动时 getMe 拿一次）；拿不到时退化为看
  文本里的 @，text_mention 实体在没拿到 Bot id 时宁可漏判也不误判。
- `nyra bot telegram start` 是前台进程（pid 记在
  `~/.nyra/bot-telegram.pid`）；机器重启后要重新启动，常驻化（系统
  服务/守护进程）是以后的一批。
