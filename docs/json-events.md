# JSON 事件流（`--json`）

> 给 CI / 脚本消费的稳定契约。**字段只增不改**：已有字段不重命名、不删除；新增字段
> 老消费者忽略即可。事件名同样只增不改。

## 事件一览

| 事件 | 何时 | 关键字段 |
|---|---|---|
| `run_started` | 运行开始 | `run_id`, `task` |
| `tool_call` / `tool_result` | 每次工具调用 | `name`, `args` / `result` |
| `usage` | 每次收到 provider 用量 | `prompt_tokens`, `completion_tokens`, … |
| `cost` | 成本可计算时（P2-2） | `spent_usd`, `limit_usd`, `remaining_usd` |
| `cost_update` | 每轮一次（P2-3） | `turn`, `max_turns`, `status`, `spent_usd`, `remaining_usd`, `limit_usd`, `prompt_tokens`, `completion_tokens`, `calls`, `missing_calls`, `reason` |
| `model_switch` | 模型切换时（缺口 5：触顶自动换或 REPL `/model` 手动换） | `from`, `to`, `reason`, `trigger`（`quota` / `rate_limit` / `server` / `timeout` / `network` / `other` / `manual`）, `spent_usd`（未计价时为 `null`） |
| `parallel_delegate` | 并行委派结束时（缺口 3a） | `succeeded`, `failed`, `total_spent_usd`（已计价部分合计；超时线程事后花的钱不进合计，未计价时为 `null`）, `max_concurrency` |
| `hook_blocked` | 钩子拦截时（缺口 19：fail-closed 的拦截要留痕） | `event`, `tool`, `hook`, `reason`（原因截断 120 字） |
| `verify_started` / `verify_result` | 验证命令执行 | `command` / `exit_code`, `passed`, `attempt` |
| `run_completed` | 运行结束 | `run_id`, `status` |
| `completion_downgraded` | 未验证却宣称完成（P1-1） | `status`, `claim` |
| `final` | 最终输出文本 | `content` |
| `run_failed` | 运行失败 | `error`, `exit_code` |

## `run_failed.error`（P1-3）

```json
{
  "event": "run_failed",
  "error": {
    "code": "model_error",
    "message": "HTTP 429 Too Many Requests",
    "class": "model_error",
    "retryable": true,
    "error_name": "ProviderError"
  },
  "exit_code": 1
}
```

| 字段 | 说明 |
|---|---|
| `code` | 稳定短码（历史上就是这四个之一） |
| `message` | 原始错误信息，**可能含 provider 文案，不要拿来做逻辑判断** |
| `class` | **四分类**：`tool_error` / `model_error` / `verify_error` / `runtime_error` |
| `retryable` | 是否值得重试（限流/超时/5xx = true；鉴权失败/补丁冲突 = false） |
| `error_name` | 异常类名，排障用 |

### 四分类的含义

| class | 典型来源 | CI 该怎么处理 |
|---|---|---|
| `tool_error` | 命令非零退出、补丁冲突、审批拒绝、沙箱不可用 | 看工具输出，别重试 |
| `model_error` | 限流、鉴权、超时、provider 5xx | `retryable` 为 true 时退避重试 |
| `verify_error` | 验证命令未通过 | 代码问题，报给人修 |
| `runtime_error` | 配置错、状态文件损坏、成本超限、参数非法 | 检查环境/参数 |

> **判据**：不要解析 `message` 做分支判断——它是给人看的。用 `class` + `retryable`。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（`verified` 或 `completed_unverified`） |
| 1 | 运行时错误 |
| 2 | 参数错误 |
| 3 | 未完成（`incomplete`，如轮次用尽） |
| 4 | 验证失败（`verify_failed`） |
| 5 | **成本上限触发**（P2-2，运行已中止） |
| 130 | 被中断（Ctrl-C） |

## 示例：CI 里只用字段做决策

```bash
set +e
nyra --json --max-cost 2 --verify "npm test" "<task>" > events.jsonl
code=$?
case $code in
  0)  echo "ok" ;;
  4)  echo "验证没过，报给人" ; exit 1 ;;
  5)  echo "超预算，中止" ; exit 1 ;;
  *)  # 从事件流里取分类与可重试性
      cls=$(grep '"run_failed"' events.jsonl | tail -1 | sed -n 's/.*"class":"\([a-z_]*\)".*/\1/p')
      retry=$(grep '"run_failed"' events.jsonl | tail -1 | sed -n 's/.*"retryable":\(true\|false\).*/\1/p')
      echo "失败分类=$cls 可重试=$retry"
      [ "$cls" = "model_error" ] && [ "$retry" = "true" ] && exit 75   # 交给重试层
      exit 1 ;;
esac
```

## 不变式（有测试锁定）

1. **失败必有 `class`**：`run_failed.error.class` 一定在四分类里。
2. **`verified` 才有资格说"已验证"**：未验证运行若模型宣称完成，会先发 `completion_downgraded`，`final.content` 里带 `【未验证】` 横幅。
3. **金额算不出就写不出数**：`cost` 事件只在 `priced` 状态发；`unpriced`/`missing` 不发假数字。
   `cost_update` 例外：它每轮都发，算不出金额时 `status` 为 `unpriced`/`missing`、
   金额字段为 `null` 并带 `reason`——消费者据此显示"未知"，而不是收不到事件就当成 0 花费。
