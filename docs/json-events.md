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

---

## 证据审计（P1-2）

`nyra evidence verify <run-id>` 只读落盘证据，判断"这次运行到底算不算完成"——不重跑命令（重跑结果会因环境变化而不同，不能用来否定当时的结论）。

| 检查 | 级别 | 抓什么 |
|---|---|---|
| `verified_without_cmd` | fail | 自称 verified 却没记录验证命令 |
| `verified_without_pass` | fail | 自称 verified 但退出码非 0 |
| `verified_without_flag` | fail | 自称 verified 但 `passed` 不是 true |
| `failed_but_pass` | fail | 状态 verify_failed 但记录里退出码是 0 |
| `status_unknown` / `status_missing` | fail | 记录损坏或被手改 |
| `tests_modified` | warn | 验证通过但测试文件被改动（怀疑改测试凑绿灯） |
| `unverified_but_pass` | warn | 状态未验证却带着通过记录 |
| `time_inverted` | warn | `updated_at` 早于 `created_at` |

退出码：`0` 自洽（可能有 warn）、`1` 发现矛盾、`2` 找不到运行。

### 为什么先做"自洽"而不是"重放"

重放验证命令只能证明"现在还能过"，证明不了"当时过了"。而自洽审计能抓住伪造与状态漂移——这是"不可自证即不算完成"最便宜也最硬的一道门。重放留到 `--replay`（未实现，需显式指定）。
