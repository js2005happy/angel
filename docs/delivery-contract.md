# 交付契约与 Golden 测试集（缺口 29 + G-2）

任务接单时先定验收标准，跑完逐项打分；Golden 集是 Nyra 自己的任务能力回归基线。

## 交付契约：接单时先定验收标准

以前的 `--verify` 是事后二值判断：过了 / 没过，复盘时说不清差在哪。现在接单时把
验收标准写成结构化契约（交付物 + 必填属性 + 检查清单），存进运行记录，跑完
`--verify` 按检查项逐项打分，每项附证据出处。

```
nyra contract create --task "写一份说明并改代码" \
  --deliverable "doc:说明文档" --attr "doc:格式=md" \
  --check "deterministic:has-changes:有改动" \
  --check "deterministic:file-exists:docs/a.md:交付文件在" \
  --check "model:semantic-fit:改动与任务相符" \
  --check "manual:human-check:人工看一眼"
nyra contract show ct_xxxxxx        # 先看一遍验收标准写得对不对
nyra contract activate ct_xxxxxx --yes   # 人工确认，草稿转进行中
nyra "写一份说明并改代码" --contract ct_xxxxxx   # 本次运行挂上契约
nyra contract verify ct_xxxxxx --run <运行 ID> [--repeat 3]  # 事后补评
nyra contract mark-item ct_xxxxxx human-check --pass --evidence "看过了"
nyra contract stats
```

- **三态**：草稿（draft）→ 进行中（active）→ 已接受（accepted）/ 未接受（rejected）。
  草稿不能挂到运行上、不能验收——验收标准须人先看过、点过头。
- **契约带 SHA-256**：正文（任务 + 交付物 + 检查清单）的哈希存进 run 记录
  （`contract_id` / `contract_hash`）；改了契约就是另一份，旧运行的结论不跟着变。
- **检查项三类**：
  - 确定性项（deterministic）：走 checker（见下），不调模型、零成本；
  - 模型项（model）：一次批量调模型逐项判（一个模型调用判全部模型项），
    没验收模型或返回解析不出时记 skipped，不算接受；
  - 人工项（manual）：须人先 `mark-item`（--pass/--fail + 证据出处），没标记时记 pending。
- **结论只有“全部通过才算被接受”**：有 fail → 未接受；全过 → 已接受；
  有 skipped / pending / flaky 但无 fail → 待定（等人工看，不算接受）。
- **易 flaky 的验证可复跑**：`verify --repeat 3` 把确定性项各跑 3 次——全过才算过，
  全不过算不过，中间态记 flaky（结果不稳定，先不算通过）。
- **每次验收记一条 attempt**（最近 20 条）：运行报告顶部读它出三数——检查通过率
  （如 7/9）+ 每被接受任务成本 + 三次复核一致性（如 3/3 一致）。
- **契约进证据链**：挂到运行记 `contract_attached`，验收记 `contract_verified`
  事件；契约正文与逐项明细在 `~/.nyra/contracts.json` 账本里（原子写 0600，
  损坏先备份再抛错），事件是审计副本。
- **收尾自动打分**：挂了契约的运行结束时，RunRecorder 自动逐项打分
  （确定性项 + 人工项；模型项在收尾没有运行实例，记 skipped，等 `contract verify` 再补评），
  结论写进 run 记录与运行报告。打分失败不破坏运行本身。

## checker 即规则代码

验收不要只写自然语言描述，要写成可跑的检查函数（`src/checkers.ts`）。
每个检查项挂一个 checker id，跑的时候按 id 调函数、逐项给出去 / 不过 + 证据出处。

| checker | 意思 |
|---|---|
| `has-changes` / `files-exist` / `diff-stat` / `evidence-complete` / `draft-labeled` / `ui-before-shot` | 缺口 13 验收者的六项确定性检查（同一份语义，不另造一套） |
| `file-exists:<相对路径>` | 交付文件在工作目录里存在 |
| `output-contains:<子串>` | 最终输出文本里出现该子串 |
| `trajectory-contains:<工具名>` | 工具轨迹里出现过该工具 |
| `no-tool:<工具名>` | 工具轨迹里不得出现该工具 |

未知 checker 在立契约时就拒绝，不等到验收才报错。

## Golden 测试集：给 Nyra 自己的任务能力跑分

契约管“这次任务的验收标准是什么”；Golden 集管“Nyra 跑任务的能力有没有退步”——
一小批固定输入，每个配期望输出（须出现的子串）与期望的工具轨迹（按顺序该调哪些工具）：
不只看最后答得对不对，还看它走了哪几步。

```
nyra golden add --name "写说明" --input "写一份说明" \
  --expect-output "已完成" --expect-tool write_file --threshold 0.8
nyra golden run --yes            # 真跑 Golden 集（调模型花真钱，须 --yes）
nyra golden run --case gd_xxxxxx --yes   # 只跑一个用例
nyra golden rescore --run <运行 ID> --case gd_xxxxxx [--output-file <路径>]
nyra golden list / show / remove
```

- **轨迹分**：期望工具按顺序在真实轨迹里出现几成（贪心顺序匹配；多余的步骤不扣分，
  漏掉的扣分）。**结果分**：期望子串在最终输出里出现几成。**合计分**是两项均值，
  ≥ 阈值（默认 0.8，单用例可改）才算通过。
- **分数只作内部回归基线，不对外宣传**——避开“先宣传后交付”的红线。
- **重打分**：`rescore` 从运行记录的 `tool_start` 事件里取真实轨迹，
  不重新执行、不花 token；运行记录里不存最终输出文本，结果分须另给 `--output-file`
  （没给时结果分按空输出算，文案里写明）。
- **跑分记录**在 `~/.nyra/golden.json` 账本里（最近 20 次跑分；原子写 0600，
  损坏先备份再抛错）。

## 诚实边界

- 契约只保证“验收标准事先写清了、逐项结果事后可查”，不保证“标准本身是对的”——
  标准写错了，逐项全过也是错的，标准本身对不对靠人审（`show` 就是干这个的）。
- 确定性检查只核说法与文件存在性，不验语义；模型项的判断是模型给的，也可能判错；
  人工项的结论是人记的，真实性靠人自己。
- 轨迹分只核“调了哪些工具、按什么顺序”，不核“参数对不对、结果好不好”；
  结果分是子串匹配，不是语义判断——输出里出现关键词不等于写对了。
- 真 API 未跑通，只在假 provider 与假执行器上验过；Windows/macOS 真机未验证。
