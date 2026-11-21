# 交接契约的程序化验收（Pi Bot 借鉴第 2 条）

交接不只是“把活递过去”。成员交活时，统筹要知道三件事：东西交齐了没、
每项验收过没过、不过时还能改几次。本批把这三件事写成一份**交接契约**，
由程序逐项核对——不调模型，模型只负责干活，不负责自证。

借鉴来源是 Pi Bot 的 group handoff（交付物清单 + 验收项 + 修正轮次上限；
核对是程序做的，不过打回一次，再不过停下等人）。只借设计，不抄它的
API 形状与文案，不接 pi 当内核。Nyra 做得比它多一步：验收结果同时进
信任阶梯（通过记成功、打回/停下记违规）与证据链。

## 契约长什么样

一份契约 = **交付物清单 + 验收项 + 修正轮次上限**：

- **交付物**：`<id>:<相对路径>[:<描述>]`，路径只认工作目录内的相对路径，
  绝对路径、`..` 逃逸一律拒绝（与 GROK-4 文件交接同口径）。
- **验收项**：`<id>:<checker>[:<标签>]`，checker 只能挂 `nyra handover checkers`
  列出来的那些——内置六项复用缺口 13 验收者的 `runDeterministicChecks`
  （`has-changes` / `files-exist` / `diff-stat` / `evidence-complete` /
  `draft-labeled` / `ui-before-shot`）+ 参数化四项（`file-exists:<相对路径>` /
  `output-contains:<子串>` / `trajectory-contains:<工具名>` / `no-tool:<工具名>`），
  未知 checker 在立契约时就拒绝，不等到验收才发现。
- **修正轮次上限** `max-rounds`：默认 1，最多 5；0 表示“交一次就定夺”。
  轮次用完还没过，契约停下等人，不再自动打回。

契约指纹是任务 + 交付物 + 验收项的 SHA-256（时间戳与状态不进指纹）：
同一份标准立两次，指纹相同；改了标准就是另一份契约。

状态：`pending`（待验收）→ `accepted`（已接受）/ `sent-back`（已打回，
还能再交）/ `stopped`（已停下等人）→ `resolved`（人定夺认下，终态）/
`closed`（放弃，终态）。

## 用法

```sh
# 立契约：worker 交给 chief，交一份报告，验收两项，轮次上限默认 1
nyra handover contract create --from worker --to chief --task "写报告并改代码" \
  --deliverable report:report.md:报告 \
  --check exists:file-exists:report.md:报告存在 \
  --check changed:has-changes:有可验收的改动

nyra handover contract list [--status <状态>] [--from <成员>] [--to <统筹>] [--json]
nyra handover contract show <id>          # 看交付物、验收项、轮次、最近一次验收逐项结果

# 程序验收一次（确定性，不调模型、不花 token）
nyra handover contract check <id> --workdir <目录> \
  [--output-file <路径>] [--trajectory <工具1,工具2>] [--run <运行 ID>]
# 全过接受（退出 0）、不过打回（退出 1）、轮次用完停下等人（退出 1）

nyra handover contract resolve <id> --yes   # 停下等人的契约由人看过后认下
nyra handover contract close <id> --yes     # 放弃（待验收 / 已打回 / 已停下等人的都能放弃）
nyra handover checkers                      # 列出能用的 checker
```

## 验收怎么判

一次验收逐项核对，全部通过才算接受：

1. **交付物逐件核对**：文件存在、是普通文件（不是符号链接）、非空。
   路径比较只用词法拼写，不改写返回值（缺口 25 修补第二轮 + Pi Bot
   第 1 条的教训：realpath 只用于越界比较；macOS 上 `/var` 是指向
   `/private/var` 的符号链接，断言按词法路径写）。
2. **验收项逐项跑 checker**：`file-exists` 看文件在不在；`output-contains`
   看输出文本含不含子串（`--output-file` 读）；`trajectory-contains` /
   `no-tool` 看工具轨迹（`--trajectory` 逗号分隔）；内置六项看改动、
   证据与标题（改动文件列表取交付物路径）。

结论三态：

- **全过 → 已接受**：唤醒统筹（“可以汇总了”）。
- **不过且还有轮次 → 已打回**：轮次 +1，文本给待改清单（哪项没过、
  为什么没过），成员改完再交就是下一轮。
- **不过且轮次用完 → 已停下等人**：不再自动打回，须人 `resolve --yes`
  认下或 `close --yes` 放弃。`resolve` 只有停下等人的契约能做，
  是“人说了算”的口子。

每次验收记一条 attempt（最近 20 条），`show` 里能看到最近一次验收
逐项过了没过。

## 与文件交接的接线（GROK-4）

`nyra team handover send` 可以挂一份契约，`ack` 时先程序验收：

```sh
nyra team handover send --from worker --to chief --task "写报告" \
  --file report.md --contract <契约 id>
nyra team handover ack chief <包 id> [--workdir <目录>]
```

- 发包时契约须存在、待验收、from/to 与本次交接一致，否则拒绝；
  包建好后契约记下包 id（一份契约只挂一个包）。
- `ack` 时先跑程序验收：过了才接下；打回/停下时包保持待接状态，
  对方改完再 `ack`（就是再交一次），轮次用完须人定夺。打回与停下
  同时写进双方的 changelog 与团队审计。
- 验收地默认交出方电脑的 workdir（`--workdir` 可指定别处）；验收的
  输出文本用包里已内联的文件内容拼（大文件只记了 SHA-256，没内联
  进包）。所以**挂到交接包上的契约只用文件类与内置 checker**，
  `output-contains` / `trajectory-contains` 类 checker 请走
  `nyra handover contract check` 单独验（带 `--output-file` /
  `--trajectory`）。
- 没挂契约的包还是老样子：`ack` 直接接下，内容对错仍由 verifier +
  人批负责。

## 信任阶梯与证据链

- **信任阶梯**（GROK-6）：验收通过给交活方记一次成功，打回/停下记
  一次违规（清零本级连续成功计数）。只对已登记的主体生效；交活方
  还没登记时验收照常跑，只是不记信任证据，CLI 会提示先
  `nyra trust register` 登记（默认只读起步）。
- **证据链**：有 `--run` 时结论进该运行的事件（5 个新事件已注册进
  `EVENT_FIELDS`：`handover_contract_accepted` / `handover_contract_sent_back` /
  `handover_contract_stopped` / `handover_contract_resolved` /
  `handover_contract_closed`，只记契约 id、双方名、轮次与通过数，
  不记任务原文、不记文件内容、不记绝对路径；`src/timeline.ts` 加渲染）。
  没 `--run` 时结论只进契约账本与审计，不强行造一个运行。
- **审计**：`~/.nyra/handover-contract-audit.jsonl`（append-only 0600，
  写失败返回 false 不拦验收），记立约 / 挂包 / 每次验收 / 定夺 /
  放弃；SIEM 导出第 10 个来源（标签 `handover_contract`，见
  `docs/governance.md`）。

账本 `~/.nyra/handover-contracts.json`（原子写 0600，损坏先备份
`.corrupt-<时间戳>` 再抛错，不静默重建）。

## 诚实边界

- 程序验收只核“文件在不在、验收项过没过”，不验语义：文件里写错了
  东西、验收项本身写错了，程序照样判通过——标准本身对不对靠人审，
  契约只保证“标准事先写清了、逐项结果事后可查”（与缺口 29 同款边界）。
- 交付物核对只看文件本身，不看“文件是不是这次新改的”；内置六项的
  改动列表取交付物路径，不是 git diff。
- `output-contains` 是子串匹配，不是语义判断；`trajectory-contains`
  只核调了哪些工具，不核参数与结果。
- 真 API 未跑通，只在假 provider 与本地确定性检查上验过；Windows /
  macOS 真机未验证（CI 覆盖三平台）。
