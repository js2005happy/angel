# 持久任务板、崩溃自续与副作用队列（缺口 26、30，DSH-4）

## 任务板：任务是账本里的一行

Nyra 的任务以前只活在内存与串行 delegate 里：崩溃即丢、无依赖、无熔断、
无审阅往返、无完成门。任务板把任务变成 `~/.nyra/kanban.json` 里的一行
（原子写 0600，损坏先备份再抛错）：

```bash
nyra kanban create "修登录 bug" --kind task --agent nyra
nyra kanban list [--status queued|working|blocked|review|done] [--agent nyra]
nyra kanban show <任务 id>
```

状态机：`queued → working → review → working（批复）/ queued（打回）`；
执行失败回 `queued`（attempts+1），满 3 次熔断进 `blocked`（须人
`nyra kanban reset` 回队列，不自动放行）。

## 完成边界：没验证的完成标不上去

Hermes 只对 PR 任务验 CI checks；Nyra 的完成边界是通用的——任何任务标
`done` 之前须附验证证据（方法 + 结论 + 通过与否），验证不过不许标完成，
验证结论进账本与证据链。模型的自述不算证据。

```bash
nyra kanban start <任务 id> [--run <运行 id>]
nyra kanban verify <任务 id> --method "bun test" --summary "2508 pass" --passed
nyra kanban done <任务 id>
```

验证不过（`--failed`）时任务留在原状态、只记证据——验证失败不是执行
失败，不进熔断计数。审阅往返：

```bash
nyra kanban review <任务 id> [--by <名字>]
nyra kanban decide <任务 id> <approve|reject> [--note "说明"]
```

## 调度 tick：只派发，不执行

```bash
nyra kanban tick     # 取最老 queued 任务进队列（tasks.addTask），执行靠 nyra task worker
nyra kanban sweep    # working 任务绑的运行已失败时走 fail 路径
```

tick 本身不调模型、不执行任务：它 claim 一个 queued 任务（queued →
working），交给 `tasks.addTask` 进队列，执行走 `nyra task worker`——与调度器、
事件触发同一条执行路。派发抛错走同一条 fail 路径（attempts+1）。

## 崩溃自续：子 agent 持久行

delegate 失败即失败：子 agent 没有自己的持久行，网关一崩，中断的轮次、
做到哪一步、为什么停，全丢了。注册表 `~/.nyra/subagents.json` 给每个子
agent 运行一行——状态 + 停止原因 + 心跳检查点 + 续跑次数：

```bash
nyra subagent register <运行 id> [--agent <名字>] [--auto-resume] [--unattended]
nyra subagent heartbeat <运行 id> "做到哪一步"
nyra subagent list [--status running|resume_pending|suspended|completed|failed]
nyra subagent sweep [--auto]
nyra subagent resume <运行 id> [--force]
nyra subagent suspend <运行 id>
```

启动扫荡（`sweep`）：活着的 worker 持有锁时整个扫荡跳过（只在启动时跑，
不跟活着的 worker 抢）；心跳超 120 秒的 running 行标 `resume_pending`、
停止原因 `crashed`；同一运行连崩 3 次仍活跃 → `suspended`（防毒消息无限
崩网关）。`--auto` 只续跑 `auto_resume=true` 的行——`auto_resume` 默认关。

续跑先验状态再动手：注册表状态、运行记录可续跑、工作目录还在、会话能读，
任一不过就抛错、不动运行；续跑动作本身进运行事件。无人值守续跑强制只读
复查（缺口 8 的硬约束）：mode 压成 `readonly`，写操作须人批。挂起的行须
`--force` 并由人确认才续。

已知局限：delegate 子任务目前没有独立的 RunStore 运行（只在父运行的事件里
记 `delegate_start/end`），注册表挂的是任务队列 / 主运行的 runId；delegate
调用点自动注册是下一批（须改 `agent.ts` 的 delegate 路径）。

## 副作用队列：先存后做（DSH-4）

决策后的副作用（写文件、对外发消息、调外部接口）先落库再执行：崩在执行
中途，重启后还能知道“这件事做到哪了”。队列 `~/.nyra/side-effects.json`
只记元数据（种类、描述、目标摘要，不记参数原文与绝对路径）：

```bash
nyra side-effects record "把报告发到群里" --kind external_send --target "telegram:100"
nyra side-effects list [--status pending|done|failed|skipped]
nyra side-effects mark <副作用 id> <done|failed|skipped> [--note "说明"]
nyra side-effects recover
```

恢复时按工单年龄从老到新，每项带 recovery note：先查目录与 git 历史
（只读命令），再决定是“已经做过了”还是“重新执行”。已经做过的不重复
对外动作；没做过的交给执行器重做；没有执行器的留在 pending 并写明原因，
不擅自标 done。已读/未读跨重启保留：恢复只读写副作用队列本身，绝不碰
收件箱（`inbox.jsonl` 的 read 标记重启前后不变）。

## 事件（证据链）

`kanban_created / kanban_transition / kanban_blocked / kanban_reviewed /
kanban_verified`、`subagent_resume_pending / subagent_resumed /
subagent_suspended`、`side_effect_recorded / side_effect_recovered` 已注册
进 `EVENT_FIELDS`，有运行上下文时镜像进运行事件；没上下文时账本 history
就是审计，不静默丢。心跳本身不记事件（太吵），只落在注册表的
`lastHeartbeatAt` 里；续跑动作才进证据链。
