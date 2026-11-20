# 执行时间线 + 会话回放（缺口 21）

多 agent 任务出问题时，不用再翻原始 `events.jsonl` 拼凑——时间线把一次运行的
全过程按时间顺序重建出来：哪个子 agent 干了什么、哪次模型调用花了多少 token、
哪一步被验收打回。

## 数据来源（不另起一套日志）

时间线从已有证据拼出来：

- `~/.nyra/runs/<运行 ID>/state.json`：任务、状态、用量摘要（token/花费）。
- `~/.nyra/runs/<运行 ID>/events.jsonl`：每行一个事件。

本批补了三个事件（都已注册进 `src/runs.ts` 的 `EVENT_FIELDS`，只记元数据）：

| 事件 | 字段 | 说明 |
| --- | --- | --- |
| `delegate_start` | `task_id`、`model`、`max_turns` | 子任务启动（不记任务文本） |
| `delegate_end` | `task_id`、`ok`、`turns`、`spent_usd`、`verification` | 子任务结束（轮数、花费、验收结论） |
| `llm_span` | `model`、`duration_ms`、`prompt_tokens`、`completion_tokens`、`total_tokens`、`ok` | 单次模型调用（不记 prompt/回答内容） |

旧运行没有这三个事件时，时间线照常工作：模型调用数退回 `turn` 事件计数，
子任务只显示并行委派的汇总（`parallel_delegate` 事件）。

## 命令

```bash
# 文本时间线：统计头 + 按时间编号的步骤
nyra timeline <运行 ID>
nyra timeline <运行 ID> --verbose   # 展开每步细节（耗时、token、验收原因）
nyra timeline <运行 ID> --json      # 机器可读

# 导出 Markdown 报告（落盘 0600）
nyra timeline <运行 ID> --out <路径>

# 会话回放：按轮次分组的逐步 walkthrough
nyra replay <运行 ID>
nyra replay <运行 ID> --verbose
```

退出码：`0` 成功；`2` 用法错误或找不到运行。

## 统计头

时间线顶部一行是运行级统计（与 `nyra evidence verify` 的统计头同口径，
与成本硬顶同口径，不另起一套数字）：总耗时、轮次、模型调用数、工具调用数、
错误数（工具/运行分开计）、token（prompt/completion/合计）、花费
（括号里单列子任务花费）。

## 回放是只读的

`nyra replay` 只展示记录：按原始时序重现每一步的输入摘要、工具调用与结果摘要、
验收结论。**它不重新执行任何工具调用、不花 token、不改文件**——想重跑任务
用 `nyra --resume-run <运行 ID>`，那是另一条路。

## 导出

`--out` 导出的 Markdown 报告与 `nyra evidence verify` 同口径、可审计：
统计头表格 + 步骤表（时间、轮次、步骤、结论）。导出文件落盘 0600，
父目录不存在时创建（0700）。

## 诚实边界

- 时间线只能重建**有事件的**部分：中断截断的尾巴会标“无结果，可能中断”，
  不假装完成了；子任务启动了但没结束的标“未结束”。
- 工具调用的参数原文不在事件里（只有 `args_hash` 指纹），时间线也看不到
  参数原文——想看调用细节去读当时的会话记录。
- 网页版瀑布图（Raven 那种 Agent → Turn → Step 图）本批不做，先 CLI 文本版；
  PWA/网关视图是下一批。
- Windows/macOS 真机未验证（CI 三平台跑过）。
