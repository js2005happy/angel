# 审阅队列（缺口 3b）

> 缺口 3（多线程并行 + worktree + review queue + 手机审批的调度面）的第二批：
> 只做 review queue 与手机审批面。并行 delegate 本身是 3a（见
> docs/parallel-delegate.md），本批消费它每线程的结构化证据。

别家的 review queue 只给 diff；Nyra 的每一项给 **diff + 验证结论 + 成本**，
批复本身也进证据链。

## 队列模型

存储：`~/.nyra/review-queue.json`（单文件 JSON，原子写：同目录 tmp 0600 +
fsync + rename；目录 0700；文件是符号链接时拒绝读写；损坏时抛错，不静默丢队列）。
落盘位置与 runs/evidence 风格一致。

每项字段：

| 字段 | 内容 |
|---|---|
| `id` | 16 位十六进制 |
| `source` | `parallel`（并行线程）/ `automation`（定时任务结果）/ `delegate`（单次委派） |
| `title` / `summary` | 标题 / 结果摘要原文（摘要最多 2000 字） |
| `runId` / `sessionId` | 关联的运行 / 会话 id（没有时为 null） |
| `workdir` | 改动要合回的工作目录 |
| `worktreePath` | worktree 隔离下改动留下的 worktree 路径；无隔离为 null |
| `changedFiles` | 改动文件（相对路径）清单 |
| `diffStat` | `git diff --stat HEAD` 原文；无改动或非 worktree 为 null |
| `verification` | `{status, method, note, at}`：`verified` / `not-verified` / `failed` |
| `spentUsd` | 已花美元；未计价为 null，不编数字 |
| `status` | `pending` / `approved` / `rejected` / `applied` |
| `decidedAt` / `decidedBy` / `decisionNote` | 批复时间 / 批复人 / 批复备注 |
| `appliedAt` / `appliedNote` | 应用时间 / 应用说明 |

状态机：`pending → approved → applied`，或 `pending → rejected`。
`rejected` 与 `applied` 是终态。只允许 pending 的项被批复，只允许 approved
的项被应用——状态不对就抛错，队列原样不动。

## 谁进队

- **并行线程**：`enqueueParallelResults()`（`src/reviewQueue.ts`）消费 3a 的
  `ParallelDelegateResult`。只进“成功且有改动”的线程：失败/超时/被拒的线程
  没有可审的改动，成功但无改动的线程没有可审的东西——两类都进 `skipped`
  返回值，不静默丢掉。`Agent.delegateParallel(tasks, { enqueueReview: true })`
  可以 opt-in 自动入队；**默认不入队**（自动行为必须 opt-in），
  `delegate_parallel` 工具不开这个开关（模型路径不替用户决定什么要审）；
  入队失败不破坏并行结果，原因记在返回的 `reviewEnqueueError` 里。
- **定时任务（Automations）结果**：`enqueueAutomationResults()`。网关调度
  tick（`src/gateway.ts` 的 `startScheduler`）与 `nyra schedule daemon`
  （`src/scheduler.ts` 的 `runDaemon`）在任务跑完后调它：只进跑成功的任务
  （失败的没有可审结果，inbox 已记）。入队失败不破坏调度（只记 stderr）。
  **已知局限**：定时任务结果未上报改动文件（调度器路径不经过 RunRecorder），
  队列里如实记这一点，批复前请结合 inbox 与会话记录核对。
- **手动入队**：`nyra review enqueue --title …`（见下）。

## CLI

```
nyra review list [--status pending|approved|rejected|applied] [--json]
nyra review show <id> [--json]
nyra review approve <id> [--by <批复人>] [--note <备注>]
nyra review reject <id> [--by <批复人>] [--note <备注>]
nyra review verify <id>
nyra review apply <id> [--by <执行人>]
nyra review enqueue --title <标题> [--source parallel|automation|delegate]
  [--summary <摘要>] [--run <运行 id>] [--session <会话 id>]
  [--workdir <目录>] [--worktree <路径>] [--files <逗号分隔>]
  [--diff-stat <文本>] [--spent <美元>]
```

用法错回 2，业务错回 1（stderr 写“错误：…”）。`--by` 缺省为 `cli`。

## 网关 API（供 PWA 消费）

除 `/api/health` 与 `/api/pair` 外都要 `X-Nyra-Token`（owner 或已配对设备）。

| 方法与路径 | 说明 |
|---|---|
| `GET /api/review[?status=…]` | 列出审阅项（待审在前） |
| `GET /api/review/:id` | 看一项 |
| `POST /api/review/:id/decide` | body `{approve: true/false, note?}`：批准/拒绝 |
| `POST /api/review/:id/verify` | 轻量验证（见下） |
| `POST /api/review/:id/apply` | 应用已批准的改动 |

不存在的项回 404，状态不对（如再批已批的项）回 400，`decide` 缺 `approve`
字段回 400。批复人记 token 持有人：本机为 `owner（本机）`，设备为
`device:<设备名>`。

## 审批流程（fail-closed）

1. 改动先进队，状态 `pending`，**不放行**。
2. 人在 CLI 或手机上看 diff 统计、验证结论、成本，逐项批复（批准/拒绝）。
   不点通过就不放行，绝不默认放行、绝不静默通过；超时/断线/异常时保持
   pending，不自动改状态。
3. 批准 ≠ 合并。`apply` 是单独一步，只接受 `approved` 的项：
   - 有 worktree 时，把 `changedFiles` 从 worktree 逐个拷回 `workdir`
     （每文件 tmp + rename，父目录自动建）；任一文件拷失败就抛错、状态保持
     `approved`（不把半成品记成 `applied`，已拷好的文件与失败清单都在错误里写清）。
   - 无 worktree 时改动已在工作目录内，只记 `applied` 并注明无需合并——
     对这类项队列是事后验收（批准即接受现状，拒绝只留记录；想撤销请用影子快照回滚，见 docs/shadow-snapshots.md）。

## 验证结论（诚实边界）

3a 的 `verification` 恒为 `not-verified`；本批**不做自动验证**，队列如实
显示 not-verified 并注明“未经核实”，不编验证结论。本批只附一个轻量
verifier——`nyra review verify <id>` / `POST /api/review/:id/verify`
（方法 `files-exist`）：

- 验证了什么：每个改动文件在 worktree（有则优先）或工作目录里存在；
  有改动文件时 diffStat 非空。
- **没验证什么：没跑测试、没跑类型检查、没审代码语义。** 通过它不等于
  “代码是对的”——验证结论的 note 里原样写清这一点。
- 失败时 verification 记 `failed` 并列出缺的文件；既无 worktree 也无工作
  目录时直接报错（无处核对，不假装验过）。只允许 pending / approved 的项。

缺口 13（验收者）开启后，`verify` 改跑完整验收（详见 `docs/verifier.md`）：
先跑确定性四项（改动存在、文件存在、diff 完整、证据齐全），再由验收模型
复核，方法记 `verifier` 或 `verifier-deterministic`，并另记一条
`verifier_verdict` 事件；未开启时沿用上面这套 `files-exist`，行为一字不改。
注意：只验新文件时 `git diff --stat HEAD` 是空的（untracked 文件不在 diff
里），`diff-stat` 一项会失败——与这里的 `files-exist` 同一口径。

## 证据链字段

批复、入队、验证、应用都记审计。新事件类型（已在 `src/runs.ts` 的
`EVENT_FIELDS` 注册，否则 `appendEvent` 白名单校验会让事件静默丢失）：

| 事件 | 字段 |
|---|---|
| `review_enqueued` | `item_id`, `source`, `spent_usd` |
| `review_decision` | `item_id`, `decision`, `decided_by`, `spent_usd` |
| `review_verified` | `item_id`, `status`, `method` |
| `review_applied` | `item_id`, `files`（拷回的文件，逗号分隔） |
| `verifier_verdict`（缺口 13） | `target`, `verdict`, `reason`, `verifier_model`, `source`, `checks_passed`, `checks_failed` |
| `verifier_rework`（缺口 13） | `target`, `attempt`, `reason` |

写到哪：有 `runId` 且 `~/.nyra/runs` 或 `~/.nyra/tasks` 下有该运行目录时，
写该运行的 `events.jsonl`；否则写 `~/.nyra/evidence/review/` 下的证据文件
（`001_review_decision_<id>.md` 之类，含改了什么、验证结论、成本、谁批的、
依据什么证据）；两路都失败时调用方会看到 `evidenceChannel: "none"`（CLI
会额外打一条警告到 stderr），不静默假装已记录。这些事件只进 `events.jsonl`，
不进 `--json` 实时事件流（见 docs/json-events.md 的事件表口径）。

## 手机审批面

手机 PWA（`/m`）新增**审阅**标签页（底部五标签：对话 / 审阅 / 自动化 /
技能 / 设置；文案在 `src/i18n.ts` 的 `m.review.*`，中英）：

- 每项一张卡：标题、来源、状态、验证结论、成本、改动文件、摘要、
  diffStat（截断 1500 字）；未验证的待审项有红色提示“批准前请先看改动与摘要”。
- 待审项三个按钮：**拒绝 / 核对文件 / 批准**；已批准的项：**核对文件 / 应用改动**。
- 批复后立即刷新列表；断线时不改任何状态，下次轮询（1.5 秒）再读。
- 审批大按钮的既有弹层（`/api/approvals`，Codex 式）不受影响，两套审批并存：
  弹层管“这次工具调用放不放行”，审阅队列管“这批改动合不合入”。

## 已知局限（诚实边界）

- **PWA 审批面未在真机上验证**：接线已完成（网关 API + 审阅标签页 +
  批复/验证/应用全流程），但本批没有真机，只在本地用网关 HTTP 测试验过
  API 与页面含审阅标签页。**待用户在真机上验证后才算可用**，不要声称已验证。
  推送通知（push）不在本批范围（报告原文是“先在真机上验证现有 PWA 再谈推送”）。
- **验证是轻量的**（验收者未开启时）：`files-exist` 只核对文件存在，不跑
  测试、不审语义；开启验收者后 `verify` 改跑完整验收（确定性四项 + 模型
  复核，见上与 `docs/verifier.md`）。
- **定时任务结果无改动文件**：调度器路径不经过 RunRecorder，进队项的
  `changedFiles` 为空、`diffStat` 为 null，验证栏如实注明；`verify` 对这类项
  会报错（无处核对）。
- **apply 不是事务**：worktree 拷回按文件逐个原子写，但整批不是事务——
  中途失败时已拷好的文件留在工作目录，状态保持 `approved`，错误里写清
  已拷与未拷的清单，需人工核对后重试。
- **非 worktree 改动已在工作目录内**：队列对它只是事后验收，不能“拦下”
  已经落地的改动；拒绝只留记录，撤销请走影子快照。
- 未在真机 Windows/macOS 上跑过本批流程，靠 CI 的三平台任务验证。
