# 技能：渐进披露与分层 / 路径触发加载

> 调研报告第 2 项：技能渐进披露 + 分层 / 路径触发加载（学 Claude Code + OpenHands）。
> 目标：技能平时只占提示词里约 100 字，全文只在命中时才加载；长会话省 token、省钱。

## 渐进披露怎么做

技能分两段进提示词（`src/agent.ts` 的 `buildSystemPrompt`）：

| 段 | 内容 | 成本 |
|---|---|---|
| 常驻段：技能索引 | 全部已加载技能，每技能一行 `name — description`，描述截断到约 100 字（中文按字算，超了加 `…`）。由 `skillIndex()`（`src/skills.ts`）生成，`Agent.skillIndexText()` 缓存——技能集合不变时不再重拼字符串。 | 每技能约 100 字，常驻 |
| 全文段：相关技能 | 只有命中的技能才进全文（`renderSkill`），两类命中见下。未命中的技能全文绝不进提示词。 | 只付命中技能的钱 |

命中分两类（去重，关键词优先）：

1. **关键词命中**：`matchSkills(task, skills, 2)`，沿用旧行为——关键词/技能名/描述词评分取前 2 个，签名与 topN 语义不动。
2. **路径触发命中**：`matchSkillsByPaths(touchedPaths, skills)`——本轮工具调用触碰的文件路径命中某技能的 `paths` glob 时，该技能全文被确定性地追加到**这次工具结果后**（OpenHands 式注入工具结果、零基线成本），不改 system prompt、不破坏提示词缓存不变式；同一技能一轮运行里只注入一次。`buildSystemPrompt(task, touchedPaths)` 也接受调用方已知的触碰路径。

需要索引之外的完整步骤时，模型用只读工具 `read_skill` 按名读取全文（见下）。

## `paths` 字段写法

在技能 `SKILL.md` 的 frontmatter 里加可选的 `paths:`，逗号分隔的 glob：

```yaml
---
name: ts-review
description: TypeScript 代码评审：先跑类型检查再评审。
when: 改 TypeScript 代码时
keywords: 评审, typescript
paths: src/**/*.ts, tests/**/*.test.ts
---
```

也接受 `[a, b]` 的括号写法。glob 规则（`matchGlob`，`src/skills.ts`，30 行内小匹配器，无新依赖）：

- `**`：跨任意多层目录，含 0 层。`src/**/*.ts` 命中 `src/a.ts` 与 `src/deep/nested/file.ts`。
- `*`：只在单层内匹配任意字符。`docs/*.md` 命中 `docs/guide.md`，不命中 `docs/sub/guide.md`。
- `?`：单层内匹配单个字符。`src/?.ts` 命中 `src/a.ts`，不命中 `src/ab.ts`。
- 路径分隔符统一转 `/` 再匹配，Windows 的 `\` 路径同样能命中。

两个例子：

```yaml
# 例 1：碰到任何 TypeScript 源码就触发评审技能
name: ts-review
paths: src/**/*.ts
```

```yaml
# 例 2：只在改根目录文档时触发，子目录文档不触发
name: docs-guide
paths: docs/*.md
```

注意：`save_skill` 工具创建技能时不写 `paths`（创造模式生成的技能 frontmatter 不动）——新技能默认只有关键词触发；需要路径触发时，手动在技能文件里加一行 `paths:` 即可。边界情况：`save_skill` 用同名覆盖一个已有 `paths` 的技能文件时会丢掉原文件的 `paths`（它只写模型给的字段）；需要路径触发的技能不要用 `save_skill` 同名覆盖，改手动编辑文件。这是已知的小缺口，未改 `saveSkillFile`——按任务要求，`paths` 不进创造模式的生成流程。

## 加载分层顺序

`loadSkills` 是“先加载的赢”：同名技能只保留第一次出现的（`seen` 去重，语义未改）。所以 `skillsDirs` 数组顺序**即优先级顺序**，默认（`src/agent.ts`）：

1. 项目层：`<workdir>/skills`（最高优先）
2. 项目层：`<workdir>/.nyra/skills`
3. 全局层：`~/.nyra/skills`
4. 插件层：已启用插件的 skills 目录（最后）

同名技能项目层覆盖全局层。任务书“全局 → 项目”的写法是优先级由低到高的分层表述，代码里顺序正好反过来——先出现者胜，不要按字面把全局放最前。

> 顺序统一：`--list-skills`（`src/cli.ts`）、网关状态的 `skills`（`src/gateway.ts` 的 `info()`）与 Agent 提示词技能索引（`skillIndex()`）三处都用同一来源——`src/skills.ts` 的 `canonicalSkillDirs()`（目录分层顺序）与 `canonicalSkillOrder()`（同名去重、先出现者胜）。网关此前用 `process.cwd()` 且缺 `<workdir>/.nyra/skills` 一层，现改用网关自身的 `workdir` 与同一目录表，三处输出的技能名序列完全一致。

## `read_skill` 用法

只读工具，不审批（与 `read_file` 同级），不改文件：

```json
{ "name": "read_skill", "arguments": { "name": "debugging" } }
```

返回该技能的全文（`## Skill: debugging` + 描述 + 何时使用 + 完整步骤）。不存在的技能名返回清楚的错误，不抛异常，例如：

```
错误：没有名为 foo 的技能；可用技能：debugging、docs-guide、ts-review
```

模型侧约定：系统提示的技能索引里只有约 100 字描述，不要凭描述猜步骤；需要完整步骤时先调 `read_skill` 再动手。

---

## frontmatter 扩展字段（llowed-tools / model）

```yaml
---
name: pr-summary
allowed-tools: Read, Grep, Bash(git *)   # 也接受 allowed_tools
model: deepseek-v4-flash
---
```

**两个都是"声明式"字段，当前没有强制执行。**

| 字段 | 现在的作用 | 没有做到的事 |
|---|---|---|
| `allowed-tools` | 渲染进技能头部，告诉 agent"这个技能自带哪些能力" | 不会自动放行这些工具的审批，也不会限制技能只能用这些工具 |
| `model` | 渲染进技能头部，作为建议 | 不会真的切换运行时模型 |

强制执留在 **S5（权限规则层 `Tool(specifier)`）**：那时 `allowed-tools` 才会变成真正的放行规则，`model` 才会接到 provider 选择上。在那之前，**不要把它当成安全边界**。

## 内联命令 `!cmd ` 与信任模型

技能正文可以写：

```markdown
- 分支: !git rev-parse --abbrev-ref HEAD
```

渲染时执行命令、把输出替换进去，模型看到的是真实现场而不是它猜的状态。

**这些命令跑在宿主机上、不进沙箱、不经过审批**，所以默认只对"你自己的"技能开放：

| 技能来源 | 是否自动执行内联命令 |
|---|---|
| `~/.nyra/skills/`（用户自己的） | ✅ 执行 |
| `<workdir>/skills/`、`<workdir>/.nyra/skills/`（仓库随带的） | ❌ 只留占位 |
| 插件目录（`plugins/…`） | ❌ 只留占位 |

理由：克隆一个带恶意技能的仓库，技能一匹配上就会跑命令。这条默认必须关死。

放开方式（全进程开关，自担风险）：

```bash
NYRA_ALLOW_UNTRUSTED_SKILL_COMMANDS=1 nyra "<task>"
```

### 三道闸门

1. **默认不执行**：`renderSkill(skill)` 不传 `execute` 时只留占位。因为 `contextUsage()` 也会调它估 token，那里执行命令等于凭空产生副作用。
2. **计划模式不执行**：`skillRenderOptionsFor({ mode })` 在 `plan` 下把 `execute` 置 false。
3. **危险命令黑名单**：sudo / mkfs / 关机 / `rm -rf` / 写磁盘设备 / fork 炸弹 / `del /s` / `rd /s` / `format` / `diskpart` / `bcdedit` / `vssadmin delete` / `Remove-Item -Recurse` / `Stop-Computer` / `reg delete` / `sc delete` / `taskkill /f`。

> 黑名单只能挡"一眼就知道要命"的命令，**挡不住 `curl … | sh` 这类**。真正的边界是上面的信任模型。

### 已知代价

每轮对话都会重拼系统提示词，匹配上的技能命令**每轮重跑一遍**。技能里塞太多 `!cmd ` 会拖慢首字延迟；建议只放 1–2 条最关键的现场信息（如当前分支、当前 diff 概要）。

## 单技能启停（`config.skills.disabled`）

对齐 Codex 的 `[[skills.config]] enabled=false`：不动文件，只按名字从加载结果里剔除。

```json
{ "skills": { "disabled": ["deploy-helper", "legacy-runbook"] } }
```

- 名字**大小写不敏感**（写 `BETA` 也能关掉 `beta`）。
- 被关掉的 skill **仍会被解析**：文件坏了照样报错、照样打印「跳过无效 skill 文件」。
  「关掉」不等于「假装文件不存在」——否则配置里名字写错了，你永远发现不了。
- 空数组或只有空白项时不过滤任何东西。
- CLI 与网关两个入口都读同一份配置（`Agent` 的 `skillsDisabled`），不存在「命令行关了、
  网页没关」这种分叉。
