# 模型切换：每 agent 选模型 + 用量触顶自动换（缺口 5）

Nyra 的模型面比别家广（14 个 provider + 本地 Ollama + Codex 登录态），但以前
切换只是配置项：主 agent 没有“选模型”的产品入口，对话中途换不了模型，某家
订阅用量触顶时任务直接失败。本批把切换做成产品功能——每个 agent 可独立选
模型，对话中途可换且不丢历史，触顶时按用户预设的备用链自动换下一家并明确
告知。与 Turnstone 的区别：别家换了就换了，Nyra 换了要留痕——每一次换模型
都进运行事件（何时换、从谁换到谁、为什么换、当时已花多少），与成本硬顶
同口径。

## 安全红线（用户 2026-11-17 定，一条不许破）

- **兜底默认关闭**：`fallback_enabled` 默认 `false`。没开时触顶就是失败，
  不静默换。`--fallback` 只开本次运行，`--no-fallback` 只关本次运行。
- **只用户自己开启**：自动换只能由用户在配置 / 命令行里显式打开，
  Nyra 自己不开。
- **只切允许列表内服务商**：允许列表就是 `fallback_providers`。未知名字
  与 CLI provider（Codex）进不了链；手动换模型也只允许切到列表里的。
- **网页端切换须页面显示**：Web UI 的模型卡是 Hark 的 desktop/ 范围，
  本批只做 CLI + 配置 + 后端；网关的切换照样写进会话事件流。
- **队列/定时任务里不切换**：调度任务与任务队列只用单个 provider
  （`tasks.ts` 的 `buildProvider` 与网关的 `primaryProvider()`），
  触顶就失败，不自动换、不重排。

## 每个 agent 怎么选模型

| Agent | 选模型 | 触顶自动换 |
|---|---|---|
| 主 agent（终端） | `--provider <名> --model <模型>`（本次运行）、`--profile <名>`（profiles 里配 provider/model）、REPL `/model`（对话中途换，本次会话有效） | `fallback_enabled` + `fallback_providers`（config.json 全局），或 `--fallback`（本次运行） |
| 群聊机器人 | 建机器人时配 `provider` / `model`（`room.json` 的 bot 字段） | 该机器人自己的 `fallback_enabled` / `fallback_providers`；`null` = 沿用全局配置 |
| 定时任务 / 任务队列 | profile 的 provider/model | **永不自动换**（设计如此，见上） |
| 压缩 / 子任务 | `compact_model` / `delegate_model`（便宜模型路由） | 走主模型时含兜底链；独立模型自身的兜底不在本批范围（工厂当前未接线，实际回退到主模型） |

## 用量触顶自动换：怎么开、怎么配

`config.json`：

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "fallback_enabled": true,
  "fallback_providers": ["deepseek", "xai", "ollama"]
}
```

- `fallback_enabled`：总开关，默认 `false`。开了才会在触顶时自动换。
- `fallback_providers`：允许列表 + 备用顺序。主 agent 永远是链头，
  列表里的按顺序排在后面；显式空列表 `[]` = 无兜底（只剩主 agent）。
  默认 `["deepseek", "xai", "ollama"]`。
- 环境变量同义：`NYRA_FALLBACK=1` / `NYRA_FALLBACK_PROVIDERS=xai,ollama`
  （`NYRA_` 前缀，旧 `ANGEL_` 回退保留）。优先级：显式参数 >
  环境变量 > 配置文件 > 默认。

**什么算“用量触顶”**（触发条件，只分三档，其余失败分类不动）：

| 触发 | 判定 | 行为 |
|---|---|---|
| 用量触顶 | HTTP 402，或 429 但文案是配额类（"weekly limit"、"quota exceeded"、"用量已用完"、"余额不足"等） | **不重试同一家，直接换下一家**——重试同一家没有意义，只会烧钱 |
| 请求过于频繁 | 429 且文案不是配额类 | 先重试同一家（至多 2 次，退避 1s/3s + 抖动，服务端 `Retry-After` 更长时以服务端为准），重试无果再换 |
| 服务端 / 超时 / 网络 | 5xx、超时、连接失败 | 同上：先重试同一家，再换 |

**什么不换**：认证错（401/403）——换模型修不好认证；未知模型、无效
请求、安全拦截、用户中断——直接失败。全部备用都失败时，报错里列出
每一家失败的原因。

**换模型时用户会看到什么**：终端 stderr 一行，例如

```
模型切换（用量触顶）：deepseek 失败（用量上限 (HTTP 429)：…），已切换到 xai 继续
```

括号里是触发原因（用量触顶 / 请求过于频繁 / 服务端错误 / 请求超时 /
网络错误 / 调用失败），不是让用户从报错原文里猜。`--json` 模式发
`model_switch` 事件（见 `docs/json-events.md`）；群聊机器人的切换记在
当条消息的 `model_switches` 里。

## 对话中途换模型：`/model`

REPL 里：

```
/model                              查看当前模型、允许切换的名单、自动换开没开
/model xai                          切到 xai（默认模型 grok-4.3），本次会话有效
/model deepseek:deepseek-v4-pro     切到指定模型
```

- **不丢历史**：只换 provider，会话消息、工具状态、检查点、用量累计
  原样保留——新模型接到的就是同一段对话。
- **只做同 OpenAI 兼容协议内切换**：Codex CLI provider 不能中途接入或
  切出（它走子进程、没有可复用的会话），要用 Codex 请退出重进并用
  `--provider codex` 指定。
- **只切允许列表**：名单是 `primary + fallback_providers`（与兜底链同一份，
  不受 `fallback_enabled` 开关影响——手动换是用户当场点的显式动作，
  不是静默自动切换）。列表外的拒绝并告诉你允许哪些；目标没有凭证也拒绝。
- **换完的模型照样能自动换**：新链以目标为 primary、兜底开关与本次运行
  一致；上下文窗口与单价按新模型重配（`nyra models` 的内置表口径）。
- **留痕**：手动切换同样发 `model_switch` 事件（`trigger: "manual"`），
  进 `events.jsonl`。

`/model` 只改本次会话，不写 `config.json`。要持久换主模型，改配置的
`provider` / `model`，或用 `--provider/--model`、`--profile`。

## 换模型留痕：事件里有什么

自动换与手动换都发 `model_switch` 事件，`events.jsonl` 里一行：

```json
{"at": "2026-11-20T...", "type": "model_switch", "from": "deepseek / deepseek-flash", "to": "xai / grok-4.3", "reason": "用量上限 (HTTP 429)：…", "trigger": "quota", "kind": "quota", "status": 429, "spent_usd": 0.0123}
```

- `trigger`：`quota`（用量触顶）/ `rate_limit` / `server` / `timeout` /
  `network` / `other` / `manual`（手动切换）。
- `spent_usd`：切换当时本次运行已花费（美元）；未配单价或 provider 未报
  用量时为 `null`，不编数字——与成本硬顶同口径。
- `nyra evidence verify` 复核时，`model_switch` 事件与工具调用一样是
  运行记录的一部分。

## 哪些场景不会自动换

- 兜底没开（默认）：触顶直接失败，报错写清是用量上限、不要重复重试。
- 队列 / 定时任务：失败即失败，不换、不重排（失败会进任务记录，等人处理）。
- 备用链里没有能用的下一家（都没配 Key、或列表为空）：失败，报错列出
  每一家的失败原因。
- 认证错、未知模型、安全拦截、用户中断：直接失败，不换。
- 主 agent 是 Codex CLI provider 时：没有兜底链（CLI 不进兜底链）。

## 已知局限

- 中途换模型只做同 OpenAI 兼容协议内切换；Codex CLI 与 Ollama 本地模型
  之间、以及涉及非 OpenAI 协议的模型，暂不支持中途切换。
- 备用链切换后，新模型的上下文窗口按 `nyra models` 的内置表 / 刷新缓存
  解析；表里没有的模型窗口未知时不编数字，自动压缩阈值按未知处理。
- 网关（`nyra ui`）的自动切换沿用全局配置；每会话在网页端单独开关
  兜底、以及 Web UI 模型卡，属于 desktop/（Hark），不在本批范围。
- 群聊机器人中途换模型（`room.json` 改 bot 的 provider/model 后）下次
  发言生效，正在跑的那轮不换。
