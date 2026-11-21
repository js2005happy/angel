# Heartbeat 静默巡查 + 推断承诺（缺口 31）

## 巡查：没事别吵我

调度器只会“到点跑任务”，接不住“收件箱有事就告诉我、没事别吵我”。
Heartbeat 补这一层：每 agent 一个 monitor，按间隔批量检查——

```bash
nyra heartbeat add --agent nyra [--every-minutes 30] [--checks inbox_unread,kanban_blocked,resume_pending,stale_runs,fanout_unfinished]
nyra heartbeat list
nyra heartbeat enable|disable --agent nyra
nyra heartbeat remove --agent nyra --yes
nyra heartbeat run --agent nyra [--force]   # 或 --all
```

- **无事安静（NO_REPLY）**：没发现只记审计（`~/.nyra/evidence/heartbeat/<日期>.jsonl`），
  不写收件箱、不发消息。守护进程每轮顺带跑到期的 monitor（`nyra schedule daemon` 的
  轮询器），同样只读、失败只记 stderr。
- **有发现先记证据再汇报**：发现写进审计文件，再写收件箱（不直接发消息打扰）。
- **检查项全是只读**：未读收件箱条数、任务板熔断任务、待续跑子 agent、已中断运行、
  未完成/未回填的后台扇出（`fanout_unfinished`，H-6 的兜底——扇出中断/失败，
  或跑完了没回填时提醒）。
  巡查本身不写、不发——无人值守时这条同样成立（缺口 8 的硬约束）。

默认间隔 30 分钟（5–1440 分钟可配）；未到间隔的跳过，`--force` 重跑。

## 推断承诺：确认一次才生效

模型从对话里推断出的短期跟进（“下周二提醒我看报价”），只进“提议”态：

```bash
nyra heartbeat commitments propose "下周二提醒我看报价" --remind-at <ISO> --expires-at <ISO> [--agent nyra] [--channel telegram]
nyra heartbeat commitments confirm <承诺 id>   # 用户确认一次
nyra heartbeat commitments list [--status proposed|confirmed|reminded|expired|done]
nyra heartbeat commitments done <承诺 id>
nyra heartbeat commitments expire              # 过期扫荡
nyra heartbeat commitments remind              # 到期提醒
```

- 提议须用户确认一次才生效；确认两次拒绝；过期自动失效——不永久驻留记忆，
  与缺口 2（记忆删除）的语义一致；账本 `~/.nyra/commitments.json` 里过期
  的就是 `expired`，不进记忆、不提醒。
- 到期提醒：已确认且到了提醒时间的，进收件箱提醒一次（状态变 `reminded`，
  不重复提醒）。

## 与缺口 8、缺口 45 的关系

缺口 8 的常驻责任巡查（`nyra responsibility`）是“领一份责任、按节奏复查”；
Heartbeat 是“平时安静巡查、有事才说话”的另一档：责任是用户显式领的，
Heartbeat 是每 agent 常驻的底噪检查。两者都只读、都先记证据再汇报。
持续责任语义（缺口 45，责任对象本身）仍在排队，Heartbeat 是它的先决条件之一。
