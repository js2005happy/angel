# 声明式可复用工作流（缺口 25，第一批）

多步活写成一个 DSL 文件，`nyra workflow run` 按固定图跑；中间要人看一眼就插一个审批节点；先 dry-run 看它会写/会发什么，再拿真实数据试跑一遍，跑通了人确认一次才激活。

做法借的是 Dify 的声明式 Workflow DSL（YAML/JSON 文本、节点编排、Human Input 审批节点）与 Proto 的三级复用阶梯（工作流激活前先拿真实数据试跑、通过才激活；非活跃测试只预览写/发动作而不真执行），不抄 Dify 的节点 API 形状与画布交互，也不拿 Proto 的演示数字当事实。G-5 的三种执行形态（固定图 / 协调者 / 动态）本批只做固定图。

## 一个例子

```yaml
name: 每日简报草稿
version: 1
mode: fixed
description: 拉目录清单，起草一份简报，等人批了再存成文件
max_cost_usd: 0.5
triggers:
  - type: schedule
    cron: "0 8 * * *"
steps:
  - id: fetch
    type: tool
    tool: list_dir
    args:
      path: .
  - id: draft
    type: llm
    prompt: "根据以下目录清单起草今日简报：{{steps.fetch.output}}"
    if: steps.fetch.ok == true
  - id: check
    type: approve
    title: "简报草稿待确认"
    summary: "{{steps.draft.output}}"
    on_reject: skip
  - id: save
    type: tool
    tool: write_file
    args:
      path: "briefing.md"
      content: "{{steps.draft.output}}"
    if: steps.check.approved == true
```

## 节点

节点就是 Nyra 已有的东西，不是新概念：

| type | 意思 | 关键字段 |
| --- | --- | --- |
| `tool` | 调一个 Nyra 工具 | `tool`（名字，导入时对 `TOOL_SCHEMAS` 核对）、`args`（映射，值里能写模板） |
| `llm` | 一次模型调用 | `prompt`（必填）、`system`（可选） |
| `delegate` | 派一个子 agent 跑任务 | `task`（必填）、`max_turns`（1–12，默认 6） |
| `skill` | 按技能正文带路的 delegate 单次任务 | `skill`（技能名）、`task`（必填） |
| `knowledge` | 知识检索（缺口 1 的 BM25 同一套） | `base`（知识库名）、`query`、`top_k`（1–20，默认 5） |
| `approve` | 人工审批节点（复用审阅队列） | `title`（必填）、`summary`、`on_reject`（`fail` 默认 / `skip`） |
| `parallel` | 并行分支（2–8 个，嵌套上限 3 层） | `branches`（分支数组，每个分支是步骤数组） |

控制结构（不是新节点，是步骤上的通用字段）：

- `if: "<条件>"`——条件为假跳过该节点（记 `skipped`）。条件语法见下。
- `for_each: {items: "<模板>", as: <变量名>, max: <上限>}`——对列表逐项跑同一节点。`max` 默认 10、上限 50；列表长度超 `max` 直接拒绝，不静默截断。`items` 可以是 JSON 数组文本（上游工具节点输出的 JSON 数组）——inputs 只认标量、节点输出是字符串，循环否则拿不到数组。轮次结果记为 `<id>[0]`、`<id>[1]`……，合并节点记为 `<id>`（输出是各轮输出拼成的 JSON 数组）。

限制（违反的在 `import`/`validate` 时直接拒绝，不等跑到一半才炸）：

- 步骤 id 全工作流唯一，小写字母开头、只含小写字母/数字/`_`/`-`、不超过 32 字（模板与条件里的路径是 `[A-Za-z0-9_.]`，中文 id 写不进路径）。
- 节点总数（含并行分支内）不超过 50 个。
- 审批节点只认顶层步骤：不许放并行分支里（续跑要回到确定的顶层步号），也不许放循环里。
- 循环嵌套上限 3 层，并行嵌套上限 3 层（G-5 的 ADK 硬规矩：递归设硬深度上限）。
- `mode` 只认 `fixed`。`coordinator` / `dynamic` 会直接拒绝并提示后续批次。

## 条件与模板

`if` 里的条件是确定性表达式，不调模型（G-5 的另一条硬规矩：简单决策用 if/else）：

- 变量：`inputs.<名>`、`steps.<id>.output|ok|approved|spent_usd`、`loop.<变量>|index`。
- 字面量：字符串（单/双引号）、数字、布尔、`null`。
- 运算符：`==` `!=` `>` `>=` `<` `<=`、`contains`（左边字符串含子串，或数组含元素）、`and` `or` `not`、括号。
- 未知变量、类型不匹配（比如对字符串用 `>`）、结果不是布尔值，一律抛错，不静默当 false。

模板用 `{{path}}`，路径与条件里的变量同一套：

- `{{inputs.channel}}`、`{{steps.fetch.output}}`、`{{loop.item}}`、`{{loop.index}}`。
- 整串恰好一个占位符时返回原始值（数组/数字/布尔不被串化）——循环的 `items` 就靠这个；嵌在句子里时按字符串拼。
- 未知变量抛错。

## 审批节点

跑到 `approve` 节点时，工作流挂起（状态 `awaiting_approval`），审阅项进审阅队列（source `automation`，标题写清是哪个工作流的哪个节点）。批复后：

```sh
nyra review approve <审阅项 id> --by <你的名字>   # 或 reject
nyra workflow resume <运行 id>
```

- 批准：审批节点记 `ok`（`approved: true`），从下一顶层步骤续跑。
- 拒绝 + `on_reject: skip`：审批节点记 `skipped`，继续往下跑。
- 拒绝 + `on_reject: fail`（默认）：整轮标失败。
- 还没批复就 `resume` 会直接报错，不会偷偷跑下去。

## dry-run 与 verify

```sh
nyra workflow dry-run <名字> [--input k=v]...
nyra workflow verify <运行 id>
```

dry-run 只列出会写/会发什么，不执行：

- 工具节点按名字分类：`read`（读）/ `write`（写）/ `send`（发）。分类看工具名里的动词（`read/list/search/get` → 读，`send/mail/post/publish/notify` → 发，其余默认按写算——宁可多报，不漏报）。
- `llm` / `delegate` / `skill` 节点记 `unknown-model-action`：动作由模型临场决定，dry-run 无法枚举（可能产生写/发动作），不会假装列全了。
- 循环步骤按一轮列动作，循环变量写成 `<循环项>`，并标“每轮一次”。
- 计划带 SHA-256（定义名 + 输入 + 动作 + 跳过节点算出来的）。`verify` 用运行里存的定义快照重算计划、比哈希：定义快照或输入被改过就失败。

## 成本

- 模型节点按实报 usage 计价（单价表走 `config.json` 的 `pricing`，与 `nyra cost` 同源），记进月度用量账本。没报 usage 的调用金额记 `null`（未知），不编数字。
- `--max-cost N`（美元）或定义里的 `max_cost_usd`：本次运行已知花费超了即停。月度硬顶（`config.json` 的 `monthly_cost_limit_usd`）在每个模型节点前重判。两处都只对已知金额生效——未知部分不假装封顶，文档里明说这是下界。
- 工具节点按 Nyra 全仓惯例判定失败：返回文本以 `错误：`/`执行失败：` 开头即失败（与 consoleUi / gateway / jsonMode / repeatGuard / runs.ts 同口径），不把报错文本当成功输出往下传。边界与全仓一致：文件内容本身以 `错误：` 开头时会被误判为失败。

## 两道门：试跑 + 激活

工作流激活前有两道门（Proto 的做法，Nyra 做得更硬）：

```sh
nyra workflow trial <名字> --yes [--input k=v]...   # 真实数据试跑（真执行）
nyra workflow activate <名字> --yes                  # 人工确认后激活
```

1. `trial` 拿真实数据真执行一遍——写/发动作都会真发生，所以必须加 `--yes`。跑通才记 `trial_passed`（注册表里记试跑运行 id 与时间）。
2. `activate` 人工确认后才标 `active`。没试跑通过的激活不了。
3. 只有 `active` 的工作流才能挂触发器。**触发器执行本身是下一批**：本批 DSL 里只声明 + 校验触发器入口（`schedule` 须是 5 字段 cron，`event` 须给事件名），不重做事件系统、不真的挂定时/事件触发。

## 账本

- 定义文件：`~/.nyra/workflows/<名字>.yaml|json`（DSL 文本本身，Git 友好；全中文名时文件名用名字哈希前缀）。
- 注册表：`~/.nyra/workflows.json`（名字 → 状态 `draft` / `trial_passed` / `active` + 试跑记录，原子写 0600，损坏先备份再抛错）。
- 运行账本：`~/.nyra/workflow-runs.json`（运行记录 + 定义快照，原子写 0600，上限 200 条，超了丢最老的）。每节点输入（渲染后，截断到 4000 字）/输出/耗时/花费都在里面的 `nodes` 数组里，逐节点回看直接读账本；`nyra workflow show <名字>` 只列最近运行的 id 与状态。
- 运行事件：`runs/<运行>/events.jsonl` 里有 `workflow_started` / `workflow_node` / `workflow_awaiting_approval` / `workflow_completed` / `workflow_failed` 五种事件（只记元数据与 id，不记节点输入/输出原文、不记绝对路径），`nyra timeline <运行 id>` 能看到。

## CLI

```sh
nyra workflow import <文件.yaml|json>              # 导入（校验 DSL 与工具名，状态 draft）
nyra workflow list                                 # 列出已导入的工作流与状态
nyra workflow show <名字>                          # 定义摘要（触发器、节点数、最近运行）
nyra workflow run <名字> [--input k=v]...          # 真执行（写/发动作都会真发生）
nyra workflow dry-run <名字> [--input k=v]...      # 只列出会写/会发什么，不执行
nyra workflow resume <运行 id>                     # 审批后从挂起的节点续跑
nyra workflow trial <名字> --yes [--input k=v]...  # 真实数据试跑，跑通才记 trial_passed
nyra workflow activate <名字> --yes                # 试跑通过后激活
nyra workflow remove <名字> --yes                  # 删除定义与注册（运行记录保留）
nyra workflow verify <运行 id>                     # 用定义快照重算 dry-run 计划、比哈希
```

`--input k=v` 覆盖 `inputs` 的默认值（`k` 须是已声明的输入名；`true`/`false`/数字自动认类型）。`--max-cost N` 设本次运行的成本上限（美元），不给则用定义里的 `max_cost_usd`。

## YAML 子集

DSL 用自写的确定性 YAML 子集解析器（无依赖），只认 block 风格：映射、序列、嵌套、纯量（plain / 单引号 / 双引号）、块标量 `|` 与 `>`（支持 `+`/`-` chomping 指示；`>` 的折叠在子集里简化：换行变空格，空行分段不支持）。以下一律拒绝并报明原因：Tab 缩进、flow 风格（`{}` / `[]`）、锚点与别名（`&` / `*`）、标签（`!`）、重复键、缩进不一致、超过 2000 行或嵌套超过 10 层。`.json` 文件走 `JSON.parse`。

## 三种执行形态（只做了第一种）

| 形态 | 状态 |
| --- | --- |
| 固定图 | 本批已做：步骤按 DSL 里的顺序跑，分支/循环/并行是控制结构 |
| 协调者 | 后续批次：一个协调者 agent 动态决定下一步 |
| 动态 | 后续批次：执行图本身在运行中改写 |

`mode` 写 `coordinator` / `dynamic` 会直接拒绝并提示后续批次，不要假装全做了。

## 诚实边界

- dry-run 只能枚举确定性节点的动作；模型节点的动作无法枚举。
- 成本只对报了 usage 的调用计价；没报的记未知，硬顶只对已知部分生效。
- 技能节点是“按技能正文带路的 delegate 子 agent 单次任务”，不是完整 agent 会话。
- 知识节点是 BM25 检索（缺口 1 的同一套），不是向量检索。
- `for_each` 的列表来自上游节点输出的 JSON 数组文本（inputs 只认标量）。
- 审批节点只认顶层步骤；触发器本批只声明不执行；协调者与动态形态是后续批次。
- 真实多 agent 场景只在假 provider 上验过；Windows/macOS 真机未验证。
