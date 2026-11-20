# 技能自沉淀闭环（缺口 11）

> 做完 → 沉淀为技能 → 下次复用。学 OpenClaw Skill Workshop（从工作中自动起草
> workspace 技能）、Hermes 自写技能（用着用着再改进、归档）、MiniMax Skills 演化、
> Grok Bot Teach by showing（看一遍录成技能草稿），但不照抄。

## Nyra 怎么做得更好的三点

1. **起草零成本**：别家起草要调模型（OpenClaw、Hermes 都要模型写技能）；Nyra 的起草
是确定性的——只从运行记录提取任务原文、工具顺序、改动文件、验证结果，不调模型、
不花 token、不联网。代价是草稿是骨架、不是成品：工具参数原文不在运行记录里
（只存单向指纹），步骤只列工具顺序，具体参数、判断条件与例外情况须批准前补齐，
正文里写明了这一点，不假装可复现。
2. **安装永远要人批准**：自动起草 ≠ 自动安装。`enabled` 默认关闭（显式 opt-in）；
队列与定时任务里同样只起草、不自动批准——批准只走 `nyra skills approve`。
与创造模式“先验证、确认后安装”同规则。
3. **低质自动归档，不污染技能库**：两条线——起草时质量分不够，草稿出生即归档，
不进待批准；已装技能超过 `auto_archive_days` 天没人用，`nyra skills sweep`
把它移出技能库、进归档（文件 + 审计日志都留着，可手动装回）。

## 配置（config.json 的 `skill_sedimentation` 一节）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关：开后成功运行收尾时自动起草草稿 |
| `min_steps` | `3` | 起草门槛：一次运行至少这么多次工具调用才值得沉淀 |
| `auto_archive_days` | `30` | 已装技能多久没人用就归档（sweep 用） |
| `require_verified` | `false` | 为 `true` 时只有 verified 的运行才能沉淀（默认 completed_unverified 也能沉淀，但质量分更低） |

## 质量分（确定性、可复现）

| 规则 | 分 |
|---|---|
| 运行已验证（verified） | +2 |
| 运行未验证（completed_unverified） | +1 |
| 工具调用 ≥ 5 次 | +1 |
| 改过文件 | +1 |
| 每次失败调用 | −1（最多 −2） |

低于 2 分的草稿出生即归档（状态 `archived`，原因写进账本与草稿事件）。

不合资格的运行不起草（不写盘、不留痕）：状态不是成功（failed / verify_failed /
interrupted 等）；工具调用少于 `min_steps` 次；`require_verified` 开启时未验证。
`nyra skills draft <运行 ID>` 手动起草时同样按这套规则，并在终端写明原因。

## 草稿长什么样

- 账本 `~/.nyra/skill-drafts.json`（原子写 0600；损坏先备份再抛错，不静默重建）：
每条含名字、状态（pending / approved / rejected / archived / installed）、
来源运行 id、任务原文、工具名清单、调用数、失败数、改动文件、质量分与原因、
创建/更新时间、归档原因、安装路径。
- 草稿文件 `~/.nyra/skill-drafts/<名>.md`（Markdown + frontmatter，与普通技能同格式，
可直接用编辑器改——批准时以文件内容为准，包括改名）。
- 名字：任务文本里的 ASCII 词拼成 slug（中文任务取不到词时用运行 id 后缀兜底，
如 `run-a1b2c3`）；与已装技能或已有草稿重名时加 `-2`、`-3` 后缀。
- frontmatter 字段经过清洗（去换行、防任务文本里的 `name:` 之类行注入 frontmatter、
截断），描述取任务原文前 120 字，关键词取用过的工具名（最多 8 个）。

## CLI

```sh
nyra skills status                 # 开关、门槛、草稿数（待批准/已安装/已归档）、用量账本规模
nyra skills enable | disable       # 开/关自动起草（安装永远要人批准，不受开关影响）
nyra skills draft <运行 ID>        # 手动从一次已完成的运行起草（开关关着也能用）
nyra skills drafts                 # 列出全部草稿（状态、质量分、来源运行）
nyra skills show <草稿名>          # 看草稿全文（批准前通读一遍）
nyra skills approve <草稿名>       # 验证（frontmatter 解析 + 做法非空）→ 安装到 ~/.nyra/skills/
nyra skills reject <草稿名>        # 拒绝（文件保留备查）
nyra skills archive <草稿名> [原因] # 手动归档草稿
nyra skills sweep [--dry-run]      # 归档长期没人用的已装技能（只动 ~/.nyra/skills/）
```

批准时的验证与创造模式同款：frontmatter 解析失败、做法为空、同名技能已存在，
一律拒绝安装（fail-closed，不覆盖别人的技能）。`approve` 用草稿文件里的
frontmatter 安装——批准前人可以直接改草稿文件（包括改名），改完再批。

## 自动起草的触发点

`src/runs.ts` 的 `RunRecorder.run()` 收尾（记录用量摘要之后）：成功运行结束时，
经 `maybeAutoDraft` 起草。CLI 一次性任务、续跑、任务队列（`nyra task worker` /
`approve` 后继续跑）都走 RunRecorder，所以都覆盖；网关会话（`nyra ui`）不走
RunRecorder，本批不自动起草（手动 `nyra skills draft` 可补）。钩子用动态 import、
任何失败都吞掉——起草失败绝不破坏运行本身；只认标准的 runs 目录
（`store.baseDir` 的 basename 是 `runs` 时 home 才是其父目录）。

## 使用量与归档（sweep）

- 技能被注入提示词时记一次使用（`~/.nyra/skill-usage.json`：累计次数 + 最近使用
时间；每会话每技能只记第一次；账本写失败不拦运行）。注入点有两处：
system prompt 里的关键词命中技能、工具结果后的路径触发技能；`/context`
的用量测算不记（那是量尺寸，不是真用）。
- `sweep` 只动用户自己的 `~/.nyra/skills/`：项目技能与插件技能是协作资产，
不动。判定：用量账本有 `last_used_at` 就用它；没记录的技能用文件 mtime 兜底
（用量统计从本批才开始；没记录 + 文件又老，说明它在统计开始前就已经长期
没动过；刚装的技能 mtime 是新的，不会被扫走）。解析失败的技能文件不归档、
只跳过并计数。
- 归档 = 文件移进 `~/.nyra/skills-archive/` + 审计行写进 `~/.nyra/skills-archive.jsonl`
（`{at, name, reason, from, to}`；sweep 没有运行上下文可写事件，jsonl 就是审计账本）。
归档不是删除：文件还在，手动拷回 `~/.nyra/skills/` 即可恢复。

## 证据链

起草、批准、拒绝、手动归档都写进源运行的 `events.jsonl`（审计副本；
源运行已删时只丢副本，不破坏主流程）：

| 事件 | 字段 |
|---|---|
| `skill_draft_created` | `draft_name`, `run_id`, `quality`（质量分）, `status`（出生状态：pending / archived） |
| `skill_draft_approved` | `draft_name`, `run_id`（安装路径是绝对路径、过 redact 会被掩掉，只写账本的 `installed_path` 字段） |
| `skill_draft_rejected` | `draft_name`, `run_id` |
| `skill_archived` | `draft_name`, `reason`, `source`（`manual`；起草时低质自动归档走 `skill_draft_created` 的 `status: archived`，不另记） |

sweep 归档的已装技能没有源运行可写，审计在 `skills-archive.jsonl` 里。
（这四个事件是证据链事件，不走 `--json` 实时流——起草发生在运行收尾、
最终消息之后；见 `docs/json-events.md` 的口径说明。）

## 已知局限

- 草稿是骨架：工具参数、判断条件、例外情况须人补齐；只按工具顺序复现，
复杂任务的草稿可能要大改。模型润色（用便宜模型把骨架写成完整技能）是
后续可选增强，本批不做（保持零成本、可测试）。
- 名字是任务文本拼的 slug：中文任务的名字是 `run-<id 后缀>`，不好看，
批准前建议在草稿文件里改一个好名字。
- 使用量只记“注入提示词”，不记“模型真的按技能做了”——后者无法确定性判定。
- 网关会话不自动起草（见触发点一节）；网关 `GET /api/skill-drafts`（给桌面端
与 PWA 的草稿管理页）留给机器人市场那批一起做。
- `save_skill` 工具（agent 在对话里手动存技能）与本批互补、不冲突：
手动存的直接进技能库（走工具审批），自动起草的先进草稿、批了才进。
