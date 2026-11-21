# 信任阶梯（GROK-6，缺口 43 治理深化）

借 GrokBot 多 Bot 团队“参谋长—经理—工作者”背后的“新成员先从小事做起、干好了再放手”
的做法，不抄 GrokBot 的模板文案与岗位描述原文，不拿帖子里的演示数字（20+ 代理、
“1 小时建成团队”）当事实写进文档。

## 一句话

新 agent / 新技能默认只读跑，攒够验证证据（N 次连续成功 + 零违规）才升一级：
只读 → 起草 → 发送 → 购买；每级升级记审计；降级随时可做；每次记成功有概率
被随机抽查，抽中了须人复核才计入——防“刷证据”。

## 级别

| 级别 | 代号 | 能干什么（信任门只拦对外动作） |
|---|---|---|
| 只读 | `readonly` | 只读工具、查询、本地读写；起草/发送/购买都被拦 |
| 起草 | `draft` | 起草类业务动作（draft） |
| 发送 | `send` | 发消息、删除（send_message / delete） |
| 购买 | `purchase` | 付款、签署、转账、改密码（pay / sign / transfer / change_password） |

门按业务动作定级，复用缺口 51 的工具→业务动作映射（`businessActionForTool`）。
**目前映射里只有 `gmail_send` 一只工具**（发消息 → 发送级）；以后 44 号连接器的
写工具落地、映射加了新工具，门自动覆盖，不用再改信任阶梯。查询与本地读写、
shell 不在门内。

## 账本与审计

- 账本 `~/.nyra/trust-ladder.json`：每主体一行（级别、进本级时间、本级连续成功
  数、累计违规数、证据清单），原子写 0600，损坏先备份再抛错，不静默重建。
  每主体最多留 100 条证据，超了丢最老的（只记元数据，不记原文）。
- 审计 `~/.nyra/trust-ladder-audit.jsonl`：登记、记证据、抽查挂起/复核、升级、
  降级、门拦截都记一条（append-only 0600）。审计导出（`nyra governance audit
  export`）已把它算作第 6 个来源，标签 `trust`，与治理审计同一条哈希链。
- 7 个新运行事件已注册进 EVENT_FIELDS（`trust_registered` /
  `trust_evidence_recorded` / `trust_spot_check_flagged` /
  `trust_spot_check_reviewed` / `trust_promoted` / `trust_demoted` /
  `trust_blocked`），时间线有渲染。

## 用法

```sh
# 登记新主体：默认只读起步（须 --yes）
nyra trust register agent bot-a --yes
nyra trust register skill duoasa-skill --yes

# 看级别与进度
nyra trust list
nyra trust show agent bot-a

# 记一条验证证据（成功/违规；须 --yes）
nyra trust evidence agent bot-a success --action "起草周报" --yes
nyra trust evidence agent bot-a violation --action "发错了人" --note "收件人写错" --yes

# 攒够了就升一级（一次只升一级，须 --yes）
nyra trust promote agent bot-a --yes

# 降级随时可做，立即生效（只能往低降，须 --yes）
nyra trust demote agent bot-a --to readonly --yes

# 复核一条被抽查的证据（通过计入，驳回按违规算；须 --yes）
nyra trust review ev_0123456789ab --approve --yes
nyra trust review ev_0123456789ab --reject --yes

# 只判门，不执行（退出码 0 放行 / 2 拦截）
nyra trust check agent bot-a gmail_send
```

## 规则（定死的口径）

- **升级**：本级连续成功满 N 次（默认 5，`config.json` 的
  `trust_ladder.required_successes` 可配 1–20，非法回 5）且自进本级以来零违规，
  才能升一级；一次只升一级，不跳级；最高级（购买）没有更高一级。攒够证据
  **不自动升级**——升级是显式动作（`nyra trust promote --yes`），放手仍须人点头。
- **违规**：一次违规就把本级连续成功计数清零，违规总数 +1。
- **随机抽查**：每次记成功时按概率抽查（默认 10%，`trust_ladder.spot_check_rate`
  可配 0–0.5，非法回 0.1）。被抽中的证据先挂起（不计入升级计数），须人复核：
  通过才计入，驳回按一次违规算。**有待复核的抽查时不许升级**——先审完再说。
  抽查是“防刷证据”的唯一手段：证据本身是人记的，记假的拦不住，只能靠抽查
  抓现行。
- **降级**：随时可做，立即生效，本级计数清零，记审计。降级没有“冷却期”，
  出了事先降下来再查。
- **门**：只对**已登记**的主体生效。没登记的 agent/skill 不在阶梯里，行为与
  以前完全一致——老用户与既有测试不受影响；登记即进阶梯，从只读起步。
  门接在 `checkApproval` 里 Soul invariant 之后、团队门之前；被拦的工具调用
  记 `trust_blocked` 事件与审计，拦截文案写清当前级别、要求级别与还差几次
  成功；拦截是硬约束，审批不能放开它，幂等重试也不会再试（`isApprovalRefusalResult`
  认“信任阶梯拦截”这条标记，与无人值守只读同款口径）。

## 配置

`config.json` 的 `trust_ladder` 一节（非法值回默认）：

```json
"trust_ladder": { "required_successes": 5, "spot_check_rate": 0.1 }
```

`nyra config explain trust_ladder` 可查当前生效值（`docs/CONFIG-MAP.md` 由脚本生成）。

## 已知局限

- 证据是人记的（`nyra trust evidence`）或调用方程序记的，阶梯本身不验证
  “这次成功是真的”——真实性靠抽查 + 人审。证据攒够了也不代表下次不出错。
- 工具层的门只认 agent（`ctx.soulAgent`）：技能级主体只记账本、只供 CLI 与
  程序调用方查门，技能在工具调用点的强制门是后续批次的事。
- 目前工具→业务动作映射里只有 `gmail_send` 一只工具，所以门在工具层今天
  只拦得住“只读级 agent 调 gmail_send”这一种情形；draft/purchase 两档的
  映射分支已写好，等新工具映射进来自动生效。
- 抽查概率是“每次记成功时独立掷骰子”，不是“每 N 条必抽一条”；运气差时
  连抽几次或一次不抽都是正常的。想提高抓现行概率就调高 `spot_check_rate`。
- 真实多 agent 场景只在假 provider 上验过；Windows/macOS 真机未验证。
