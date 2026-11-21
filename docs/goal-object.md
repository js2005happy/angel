# 长目标对象（GROK-5，缺口 26/30 深化）

## 目标对象是什么

长任务以前没有“完成”的明确定义，模型自己说完了就算。目标对象把“完成”
变成账本上的状态：

- **目标陈述**：一句话写清要达成什么（1–1000 字）；
- **动态进度清单**：目标拆成的若干项，每项有自己的状态；
- **逐项验证**：每一项都须附证据（方法 + 结论 + 通过与否），全部通过才
  允许标完成。

做法借的是 Grok Build / Cursor 的 /goal 背后的“目标对象”设计，不是名字，
也不抄命令。排进缺口 26/30（任务板）深化，见 Hermes/GrokBot 调研报告 §3
的 GROK-5 一节。

```bash
nyra goal create "上线 0.5.4" --item "跑通全量测试" --item "推上 main"
nyra goal list [--status active|paused|completed|cancelled] [--agent nyra]
nyra goal show <目标 id>
```

## 清单状态机

```
pending → in_progress → verified / failed
failed → in_progress（重做）→ verified / failed
pending / in_progress / failed → cancelled（目标取消时跟着取消）
```

- `nyra goal add-item <目标 id> "<标题>"`：进行中（active/paused）的目标
  才能加项；已完成/已取消是终态。清单最多 50 项，标题 1–200 字。
- `nyra goal start-item <目标 id> <清单项 id>`：待做/未通过 → 进行中。
- `nyra goal verify-item <目标 id> <清单项 id> --method "<方法>" --summary "<结论>" [--passed|--failed]`：
  通过 → verified，未通过 → failed（可重做：failed → start-item → 再验）。
  已验证的项可以重验——新证据可以推翻旧结论，不静默保留。
  已取消的项不能验。

## 完成门：清单全过才标完成

```bash
nyra goal complete <目标 id>
```

- 只从 active 标：paused 的目标先 `nyra goal resume` 再标完成。
- 清单是空的标不上去；任一项没过都标不上去，拒绝文案列清还剩哪些项、
  分别卡在哪（几项待做、几项进行中、几项未通过、几项已取消）。
- **任务板行全 done 不算**：目标完成以“清单全过”为准，不以任务板行全
  done 为准；模型自述完成也不算。

## 暂停 / 恢复 / 取消

```bash
nyra goal pause <目标 id>
nyra goal resume <目标 id>
nyra goal cancel <目标 id> "<原因>" --yes
```

- 暂停保留全部进度与指令，恢复后接着干。
- **恢复前重验证**（确定性重核，不调模型）：已验证项的验证记录还在不在；
  关联的任务板任务还在不在（被删了就退回待做：证据所指的任务已不存在）；
  供过 `--files` 的项，按当时存下的证据重跑确定性检查（文件被删改后检查
  不过的，同样退回待做）。退回的项在恢复输出与 `goal_resumed` 事件里都
  有数（`reset_items`）；没退回的项原样保留“已验证”，不重验、不重置。
- **取消是终态**：未终态的清单项（待做/进行中/未通过）跟着进 cancelled，
  已验证的项保留“已验证”（证据本身还成立，只是目标不做了）。取消后任何
  改动都拒绝；已完成的目标不能取消。

## 中途加指令不丢目标

```bash
nyra goal instruct <目标 id> "<追加指令>"
```

指令追加进目标记录，不重置清单、不改已验证项的状态、不动目标状态——
目标丢不了，加指令也不会把已做的进度清掉。进行中与暂停中的目标都能加；
已完成/已取消的目标不能加。

## 与任务板接线：拆 / 关联

```bash
nyra goal split <目标 id> <清单项 id> "<任务标题>" [--agent <名字>]
nyra goal link <目标 id> <清单项 id> <任务板任务 id>
```

- `split` 在任务板上建一行（kind: task）并关联到清单项；`link` 关联一个
  已存在的任务板任务（任务不存在直接拒绝，不建幽灵关联）。
- **两边完成边界各算各的**：任务板行 done 了不等于清单项通过了（行走完
  自己的完成边界——须附验证证据才能 done，项还是待验证，目标照样标不
  上去）；反过来清单项通过了，关联的任务板行也不会自动变 done。

## 逐项验证与 verifier 接线

逐项验证默认是**人工证据口径**：方法 + 结论 + 通过与否，只记“有结论”，
结论的真假由写结论的人负责。

供了 `--files` 时接 verifier 的确定性检查（与 `nyra verifier check` 同款
口径：改动文件须存在、diff 摘要须完整、证据须齐全）：

```bash
nyra goal verify-item <目标 id> <清单项 id> --method "bun test" --summary "全量 2800+ 通过" --passed \
  --files "src/goal.ts,tests/node/test-goal-object.test.ts" --workdir ~/workspace/nyra-p3merge \
  --diff-stat "2 files changed"
```

- 任一检查未通过时，本次验证强制记 failed——声称的 `--passed` 也不认，
  失败的检查名写进结论里；补齐证据（比如补 `--diff-stat`）后可重验。
- 供过 `--files` 的验证会把文件清单、工作目录与 diff 摘要存进验证记录，
  恢复时按这份证据重跑同一组检查。
- 没供 `--files` 时不跑检查，输出里会注明“人工证据口径，未跑确定性检查”。

## 账本与证据链

- 账本 `~/.nyra/goals.json`（原子写 0600，损坏先备份再抛错，与任务板
  `kanban.json` 同款口径）；只记元数据与验证结论，不记任务正文以外的
  模型输出、不记绝对路径。
- 10 个新运行事件已注册进 `src/runs.ts` 的 `EVENT_FIELDS`：`goal_created` /
  `goal_item_added` / `goal_item_started` / `goal_item_verified` /
  `goal_completed` / `goal_paused` / `goal_resumed` / `goal_cancelled` /
  `goal_instruction_added` / `goal_item_linked`（只记元数据与 id，不记目标
  陈述、清单项标题与指令原文；取消原因只记 12 位指纹）。有运行上下文时
  （`--run <运行 id>`）镜像进运行事件，没上下文时账本 history 就是审计。
- 时间线（`nyra timeline`）加渲染：建目标、逐项验证、标完成、暂停/恢复、
  取消、追加指令、关联任务板任务都有中文行。

## 诚实边界

- **清单是模型自己生成的，清单错了目标就错了**：目标对象只保证“清单全过”，
  不保证“清单本身是对的”。清单本身对不对，靠人审清单——建目标时看一眼
  清单有没有漏项、错项，比事后验一百遍都有用。
- **验证是操作性的，不是形式化的**：“清单全过”不等于“目标真对了”。逐项
  验证核的是“按声称的方法跑了、给了结论”，不是“目标在真实世界里真达成
  了”。不要把前者写成后者。
- 确定性检查只核说法与文件存在性，不验语义；模型复核腿不在本批——逐项
  验证默认是人工证据，内容对错仍由写结论的人与最终的人批负责。
- 真实多 agent 场景只在假 provider 上验过；Windows/macOS 真机未验证。
