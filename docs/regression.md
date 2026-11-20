# 回归测例库（G-3：失败 → 回归测试集）

一次运行跑完后，它的失败步骤可以沉淀为回归测试用例：下次改指令或改
harness 后，先跑回归集——同一类失败再出现就立刻知道，不用等用户撞上。
这是 7×24 自改进环的测例库一面（另一面是时间线的阶段表与验收口径，
见 `docs/timeline.md` 与 `docs/verifier.md`）；两边共用同一份失败口径：
时间线里 `ok: false` 的步骤。

## 只做沉淀与记录

本批只做确定性沉淀与记录，不做更多：

- **沉淀来源**：时间线已经记下的失败步骤（`failedStepSummaries`，与
  阶段表同一份口径）。失败分五类：`tool-failed`（工具失败）、
  `delegate-failed`（子任务失败）、`verdict-failed`（验收未通过）、
  `llm-failed`（模型调用失败）、`run-error`（运行错误/中断/到最大轮数）。
- **只记元数据**：失败类型、步骤标题、来源运行 id。不记 prompt/回答、
  不记参数原文、不记绝对路径。
- **不调模型、不自动改代码、不自动重跑回归集**：跑回归集是下一批；
  “重打分”也是下一批——本批沉淀的是运行里已经打过的分。

## 账本

`~/.nyra/regression-cases.json`（原子写 0600，损坏先备份再抛错，与
`business-redlines.json` 同款口径）。每条用例：`id`（`rg_` + 12 位十六
进制）、`sourceRunId`、`kind`、`title`、`detail`（元数据）、`status`
（`open` / `verified` / `retired`）、`createdAt`；`history` 数组记每次
新增/删除/改状态（只记元数据）。

同一次运行、同类失败、同一步骤标题只留一例——重复沉淀同一条运行时
自动跳过（回报里写跳过数）。

## 命令

```bash
nyra regression list [--json]              # 列出全部用例（默认文本，--json 给脚本）
nyra regression precipitate --run <运行 ID>  # 从一次运行的失败步骤沉淀用例
nyra regression status <用例 id> <open|verified|retired>  # 改用例状态
nyra regression remove <用例 id> --yes      # 删除用例（破坏性操作，须加 --yes）
```

退出码：`0` 成功；`1` 运行失败（找不到用例/账本损坏）；`2` 用法错误
（缺参数、状态值不对、找不到运行）。

## 诚实边界

- 用例只证明“这一步当时失败了”，不证明“现在还会失败”——改完代码后
  要跑回归集重验（下一批），不要只看库里的条数当质量。
- 沉淀不验失败原因：一条用例的标题是当时的步骤标题，根因要人去看时间线
  与会话记录。
- 账本在用户本机，不上传；删用例只删本机记录，不改运行记录本身。
- Windows/macOS 真机未验证（CI 三平台跑过）。
