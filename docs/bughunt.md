# 授权漏洞挖掘技能包（候选提案 1）

> 学 Claude-BugHunter 的 7-Question Gate + 范围卡先行 + 证据卫生，合
> src-hunter 的证伪验证器（falsify.py，三态结论）——但不照抄：Nyra 的门
> 管“拦得可审计”，每道门的结论与审查结论都进审计日志。
> 机器人市场的首批上架旗舰内容：技能包与缺口 11 沉淀出的技能同格式
> （单文件 `.md` + frontmatter），可直接上架。

## 红线（写进技能正文与代码校验，缺一不可）

- 只测授权目标；禁批量扫描、自动提交、凭据攻击、社工钓鱼与针对真人的信息收集。
- 提交前须人工验证、可复现 PoC；平台规则高于技能包。
- 范围卡的 `forbidden_techniques` 必须一字不差包含五条红线手法，少一条卡就无效。

## 三件套

| 件 | 内容 | 落点 |
|---|---|---|
| 范围卡 | 授权目标、允许/禁止的手法、速率上限、到期日 | `src/bughunt.ts`（校验 + 账本 `~/.nyra/bughunt-scopes.json`，原子写 0600，损坏先备份再抛错） |
| 提交前七问 | 授权范围、平台影响清单、已验证、已证伪、已脱敏、无越界、人工复核 | `evaluateSevenQuestions`（全 yes 才过，不知道也算没过） |
| 证据卫生 | PII/凭证扫描（只报模式与行号，不报原文）+ 报告必填段 | `checkEvidenceHygiene` |

## 证伪验证（学 falsify.py）

- 六种尝试：`independent-reproduction`（独立复现）、`different-input`（换一个输入）、`cross-user`（换一个用户）、`negative-control`（阴性对照）、`header-check`（响应头检查）、`browser-execution`（浏览器执行）。
- 三态结论：`confirmed`（每次尝试都没推翻，且无缺失的决定性事实）、`pending`（没被推翻，但有一个确切的决定性事实未解决，附 blocker 与验证计划）、`rejected`（某次尝试主动推翻了发现，或核心要求不成立）。
- 反射型发现（XSS 这类）只看回显不算数：浏览器执行是决定性事实，没观察到时结论只能是 pending。
- 判定是纯函数（`evaluateFalsification`）：探测由 agent/人按技能做，这里只算结论；一次尝试都没做按 pending 算（尚未证伪，不许提交）；未知检查名直接抛错。

## 提交前核对（五道门，按顺序）

`nyra bughunt check --finding <发现.json> [--report <报告.md>]`：

1. 范围门：目标在范围卡内、范围卡未过期、没命中禁区（禁区优先）。
2. 证伪门：结论必须是 confirmed（pending/rejected 都拦截）。
3. 七问门：七问全 yes。
4. 卫生门：报告无未脱敏内容、必填段齐全（目标、复现步骤、影响、严重度、证伪）；没提供报告文本直接拦截。
5. 严重度门：声明严重度须与 VRT 映射一致；类别不在映射表里时必须声明（写“未映射、由平台定”也算声明），不要自己编档位。

有一道不过就拦截（退出码 3），并写明哪道门、为什么。五道全过后，审查层开启时再过一遍独立审查（`submit_bughunt_report` 虚拟敏感动作，见下）；审查层未开启时写明“已跳过，只走了五道确定性门”。

## 独立审查接线（缺口 10）

- `reviewSubmitReport` 调 `reviewToolCall`，tool 名 `submit_bughunt_report`（已加进 `DEFAULT_REVIEWED_TOOLS`；它不是 `tools.ts` 里的工具，`executeTool` 不会遇到这个名字）。
- 审查模型不可用 / 无有效结论 → BLOCK（fail-closed，复用 `reviewToolCall` 的既有语义）。
- 审查层默认关闭（显式 opt-in），关闭时零打扰，五道确定性门仍是主防线。

## CLI

```sh
nyra bughunt install [--force]        # 安装技能包到 ~/.nyra/skills/（已装时拒绝覆盖，--force 才覆盖）
nyra bughunt status                   # 技能装没装、几张范围卡、审查层开没开
nyra bughunt scope list               # 列出范围卡
nyra bughunt scope add <范围卡.json>   # 建范围卡（先 template scope 取模板）
nyra bughunt scope remove <名>        # 删范围卡
nyra bughunt scope show <名>          # 看一张范围卡
nyra bughunt scope check <URL> [--scope <名>]   # 动手前查目标在不在范围内（0 = 在，3 = 不在）
nyra bughunt template <scope|finding|report>    # 打印模板
nyra bughunt check --finding <发现.json> [--report <报告.md>]   # 提交前核对（0 = 可提交，3 = 拦截）
```

`scope check` 没给 `--scope` 时：只有一张卡就用它，多张必须指定，没有卡先建卡。

## 审计日志

每次 `check` 都写一条进 `~/.nyra/bughunt-audit.jsonl`（0600 追加，只记元数据）：范围卡名、目标主机名（不是完整 URL——查询串里可能带 token）、结论、失败的门、严重度、证伪结论、审查来源（skipped / deterministic / model / unavailable）。不记报告原文。

## 技能包正文

`src/skills/authorized-bughunt.md` 是正文（Bun 文本导入进包，`src/text-imports.d.ts` 声明 `*.md` 导入类型；`nyra bughunt install` 先过 `parseSkillText` 再原样写进 `~/.nyra/skills/`）。正文里的方法论与模板和 `src/bughunt.ts` 的模板函数同内容；改一处时两处一起改，测试钉住了关键字段（范围卡模板的 `max_requests_per_second`、发现模板的 `seven` 与 `attempts`、报告模板的必填段标题）。

## 已知局限

- 证伪判定只算结论，不真的去测目标：探测步骤由 agent/人按技能执行，尝试记录（check/outcome/detail）由人如实填；填假的，门也看不出来——最后的人工复核（七问 q7）就是防这一手的。
- 目标匹配是主机名/URL 前缀比对：裸主机名只匹配它自己，子域名要写 `*.example.com`；路径型目标只认前缀，不解析查询串。
- VRT 映射是 Nyra 本地简化表，仅作初定；最终以平台的 VRT 为准。
- 卫生扫描是正则模式：能抓常见 PII 与凭证字样，抓不全、也可能误报（误报时改报告措辞再核对）；扫描输出只报模式与行号，不报匹配原文。
- 网关没有 bughunt 入口（CLI 先行；市场那批再接网关 `GET /api/skill-drafts` 同类接口时一并考虑）。
- PWA/真机未验证（本批无 PWA 改动）。
