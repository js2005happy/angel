# 一条结论：`nyra verdict`

> 四张分散的表（红线 / 省钱 / 回忆 / 运行历史）拼成一句话：**这次跑得值不值。**

## 用法

```bash
nyra verdict                 # 全局判断（不查任务相关历史）
nyra verdict "重构 auth 模块"  # 顺手查这个任务有没有历史可复用
```

输出：

```text
✅ 值：证据与成本两侧都成立

依据：
  · 红线全绿（1 项检查通过）
  · 每轮可确定省 835 token（10 轮共 8350）
  · 辅助模型实测省 $0.0230
  · 2 条历史可复用：同类任务不必从零探索

下一步：
  1. …
```

## 等级规则（顺序即优先级）

| # | 条件 | 等级 | 为什么 |
|---|---|---|---|
| 1 | 红线有 `fail` | **red** | 证据不过关，省再多也不值 |
| 2 | 没跑红线 | yellow | **未知不当作通过** |
| 3 | 红线有 `warn` | yellow | 能跑，但红线未设 |
| 4 | 没有成本上限 | yellow（+ 阻断项） | 长任务可能无限烧钱 |
| 5 | 两侧都成立 | **green** | 证据与成本都过关 |

## 三条纪律

1. **结论必须可解释**：每个等级都给具体依据（哪条红线、哪个机制没开），不输出"感觉"
2. **证据优先于乐观**：红线有 fail 就是 red，不管省了多少钱
3. **缺数据不下结论**：某块没传就写"未知"，不当作"通过"——`unknowns` 段单独列

## 退出码

`red` → 非 0（可以拿来做 CI 门禁）；其余 → 0。

## 单次运行打分：`nyra verdict --run <id>`

配置级 verdict 问「这套设置值不值」；运行级问「**这一次跑成了没有、代价多大**」。

```bash
nyra verdict --run abc123
```

只看三样东西：**验证结果**（有没有证据）、**运行状态**（跑完没跑完）、**花费**（代价多大）。

| # | 条件 | 等级 | 依据 |
|---|---|---|---|
| 1 | `verify_failed` | red | 有证据表明改坏了；下一步给出具体命令让人去复现 |
| 2 | `failed` | red | 没跑完，谈不上值 |
| 3 | `verified` 且退出码 0 | green | 有验证证据 |
| 4 | `completed_unverified` | yellow | 跑完了但没证据 |
| 5 | 状态说 verified 但没退出码 | yellow + unknown | **状态不能替代证据** |
| 6 | `passed=false` | red | 即便状态是 verified |

补充规则：

- 花费未知 → 进 `unknowns`，不当 0
- 总花费 = 主 agent + 子任务（`delegate_spent_usd`）
- **失败且烧了钱** → 明确劝阻「重跑碰运气」：先修根因
- 没有文件改动但有验证 → 说明可能是查询型任务，不误判成"啥也没干"

退出码：`red` → 非 0。

## 批量趋势：`nyra verdict --recent N`

单次结论回答「这一次」，趋势回答「**该修什么**」。

```bash
nyra verdict --recent 10
```

| # | 条件 | 等级 |
|---|---|---|
| 1 | 没有任何记录 | yellow + unknown（不谎报趋势） |
| 2 | 一次都没通过 | **red** + 阻断项 |
| 3 | 通过率 ≥ 70% | **green** |
| 4 | 通过率 < 70% | yellow |

三条额外规则：

- **失败严格过半才点名**（50/50 平分时说"集中在某一类"是误导；两类各占一半 → 不点名）
- **单位成本 = 总花费 / 通过次数**，没有通过运行时不谈（分母为 0 谈它没意义）
- 未验证（`completed_unverified`）既不算通过也不算失败，单独统计

输出示例：

```text
⚠️  勉强：最近 4 次里只通过 1 次

依据：
  · 最近 4 次：验证通过 1、失败 3、未验证 0
  · 通过率 25%
  · 每个通过运行平均花 $0.0800
  · 失败集中在 tool_error（3 次，占 100%）

下一步：
  1. 先修 tool_error：它占失败的 100%，修掉这一类收益最大
  2. 通过率不到 70%：优先处理失败那几次的共性原因
```

失败分类由 CLI 侧算（`classifyFailure`），`verdict.ts` 保持零运行时依赖——这样它仍能在本地单文件自证。

## 机器可读输出：`--json`

```bash
nyra verdict --json                    # 配置级
nyra verdict --run abc123 --json        # 单次
nyra verdict --recent 10 --json         # 趋势
```

字段（**契约：只加不改、不删**，客户端按 `schema_version` 判断兼容）：

```json
{
  "schema_version": 1,
  "kind": "config",
  "grade": "yellow",
  "headline": "勉强：能跑，但两侧数据不全",
  "reasons": [],
  "blockers": [],
  "next_steps": [],
  "unknowns": []
}
```

| 字段 | 用途 |
|---|---|
| `schema_version` | 契约版本（当前 1） |
| `kind` | `config` / `run` / `trend`，同一份结构装三种结论 |
| `grade` | **CI 门禁只看这个**（`red` = 退出码非 0） |
| `reasons` / `blockers` / `next_steps` / `unknowns` | 人看的解释，看板可提取数字 |

配套：`exit code` 与 `grade` 一致（`red` → 非 0），所以 CI 里可以只看退出码，或解析 `grade`。

## 配置级现在也查文档一致性

`nyra verdict` 的配置级结论多了一侧：**文档里的命令索引与代码是否对齐**。

| 情况 | 影响 |
|---|---|
| 文档一致 | 依据里写明「通过（N 个子命令均有记录）」 |
| 有过期引用 / 未记录命令 | 等级降到 **yellow**（不是 red——文档问题不推翻证据），并在下一步点名要修哪条 |
| 没查到（docs 目录不可读） | 进 `unknowns`，不当作通过 |

子命令清单的**单一事实源**是 `src/subcommands.ts`：`cli` 判断参数、`docCheck` 校验文档、
`docs/COMMANDS.md` 索引、测试——四处读同一份数组，加命令时不可能漏改。

## 状态分桶：什么算通过、什么算失败

趋势结论依赖分桶，分错就会**系统性高估通过率**。当前规则（`summarizeTrend`）：

| 状态 | 归入 | 为什么 |
|---|---|---|
| `verified` | 通过 | 校验命令退出码 0 |
| `failed` / `verify_failed` | 失败 | 明确失败 |
| **`incomplete`** | **失败** | 运行没跑完就出错，`classifyRunStatus` 已判 `runtime_error` |
| `completed_unverified` | 未验证 | 跑完了但没验证结论 |
| **`interrupted`** | **未验证** | 被中断：没有结论，但不能从统计里消失 |
| `queued` / `running` / `awaiting_approval` | 其它（进行中） | 还没结果，不该进通过率分母 |

> 曾经的缺陷：除 `verified`/`failed`/`verify_failed`/`completed_unverified` 外**全部落"其它"**，
> 于是 `incomplete`（真实失败）和 `interrupted` 被静默丢弃，通过率被高估。
> 现在有测试锁住"只有进行中状态才允许落其它"——新增状态若没想清楚归属，测试会红。