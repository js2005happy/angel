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

> 已知不一致（留给总协调）：`nyra --list-skills`（`src/cli.ts`）与网关的技能列表仍用旧顺序（工作目录 `skills` → 全局 `skills` → 插件），未纳入本项改动范围；列表展示用的顺序与 Agent 实际加载顺序以 Agent 为准。

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
