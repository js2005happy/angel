# 循环守卫与幂等重试

OpenMausBot B、C 两项的 Node 实现（思路借鉴，TypeScript 重写）。
代码：`src/repeatGuard.ts`、`src/providers.ts`（分类 + 同 provider 重试）、
`src/tools.ts`（`executeToolIdempotent`）、`src/agent.ts`（守卫接入）。
测试：`tests/node/test-repeat-guard.test.ts`、`tests/node/test-idempotent-retry.test.ts`。

## 循环守卫（RepeatGuard，默认开启）

工具调用按“工具名 + 规范化参数（key 排序后 JSON）”做 key、结果文本做
SHA-256 摘要，逐调用计数（不要求连续，两个卡住的调用交替出现也算）。

| 阈值 | 行为 |
|---|---|
| 同一失败调用 **3 次** | 第 4 次起拒绝执行，给模型写纸条：“换一个输入、换一种方法，或直接说出卡点，不要重复同一调用。” |
| 同一成功调用返回同一答案 **3 次** | 提醒模型可能在原地打转（纸条附在工具结果后）。 |
| 同一成功调用返回同一答案 **10 次** | 直接停掉本轮，返回诚实失败文案。 |

补充规则：

- 摘要前先把结果截断到 **4000 字符**（`REPEAT_DIGEST_TRUNCATE_CHARS`），长文本才稳定。
- 截图类结果不计入：`browser_screenshot` / `computer_screenshot` 的返回文本
  （路径 + 大小）不能代表答案；内嵌的 base64 图片数据（`data:image/...;base64,`）
  同样跳过。
- 失败指结果以 `错误：` 或 `执行失败：` 开头（与 `executeTool` 的错误返回一致）。
- 停轮 / 达到最大轮数时的返回文案是诚实失败表述：分清“失败的调用”和
  “被拒绝的调用”，列出调用名与次数，并写明“失败步骤里有报错原文”，
  不让模型用漂亮话盖过去。

## 工具调用幂等重试

重试不重复产生副作用。`executeToolIdempotent()`（`src/tools.ts`，Agent
的工具循环已改用它，MCP 直连分支除外）：

| 工具类 | 失败后怎么办 |
|---|---|
| 只读工具，可直接重试 | `read_file`、`list_dir`、`grep_search`、`git_status`、`web_fetch`、`web_search`、`read_skill`、`poppy_discover`、`poppy_identity_check`、`poppy_permission_check`：直接重试，至多 **2 次**，退避 200ms / 500ms。 |
| 写操作，可核查 | 重试前先读回目标状态确认是否已生效：`write_file`（读回比对全文）、`edit_file`（读回含 `new_text`）、`plan`（读回比对整份计划内容）、`memory_append`（读记忆文件含该文本）、`save_skill`（读技能文件含指令）。已生效 → 报告“已生效，未重复执行”，不再执行；未生效 → 重试至多 2 次，每次失败后会再核查一次。 |
| 写操作，无法核查 | `apply_patch`、`shell`、`http_post`、浏览器 / 电脑操作、`delegate`、MCP：**不盲目重试**，直接返回原错误。 |
| 截图类 | `browser_screenshot` / `computer_screenshot` 不在只读表里：每次执行都会在本地多存一个截图文件，故不自动重试。 |

注意：每次重试都会重新走审批（`checkApproval`）与 PreToolUse 钩子；
会话级“始终允许”授权能覆盖同一目标时不再打扰用户。审批拒绝
（`ApprovalRequired`）直接冒泡，绝不重试。

## Provider 重试：分类表与退避

`FallbackProvider.chat()`：同一 provider 失败时先做至多 **2 次**带退避重试，
再切换。切换判定不动——`quota` 仍按现有 `RECOVERABLE_KINDS` 决定是否切换
（用量上限是否应触发切换，待总协调另定）。

| 错误 | 重试？ | 备注 |
|---|---|---|
| 429 / 过载 / 5xx / 连接重置 / 超时（`rate_limit`、`server`、`timeout`、`network`） | 是，至多 2 次 | 退避 1s / 3s + ±25% 抖动，可中断（`AbortSignal`，用户叫停立即取消、不再重发）。 |
| 用量上限（`quota`，或消息含 weekly/monthly/usage limit、out of credits、quota exceeded、用量上限、余额不足等，即使状态码是 429、措辞像 rate limit） | 否 | 消息文本层面的用量上限模式优先于 429 匹配；`classifyHttpError()` 先看文本、再看状态码。 |
| 认证（401/403）、未知模型、无效请求、404、用户中断、安全拦截 | 否 | 换模型 / 重试都修不好，或绝不重放。 |

其他约束：

- 重试受整条链 2× 单次超时的总预算约束：剩余时间不够“一次退避 + 一次重试（重试超时按剩余预算封顶，低于 0.2 秒不重试）”时直接改走切换，免得重试一个挂起的 provider 吃光预算、后面的 provider 一次都试不到。
- 重试记录在 `FallbackProvider.retries` 里（与 `switches` 并列，网页端可展示）。
- `KeyRotatingProvider` 未改：多 Key 轮换语义不变。
- `CliProvider` 的 `classifyCodexError` 本来就是用量上限模式先于 rate limit，本次未动。
- 每次重试都是一次新的模型调用（可能重复计费）；瞬时失败且无任何模型调用
  已回答时才重发——一旦某次调用已成功返回，即按成功处理，不再重发。
