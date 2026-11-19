# 竞品调研笔记：Nyra 该从别家 Agent 学什么

> 调研日期 2026-11-19。**方法说明**：本文主要以一份 30 家选型指南（见文末来源）为骨架，加上 Codex CLI 与 Claude Code 扩展文档两份一手资料做的归纳，**不是逐家实操调研**。所有"长处"都标明它解决的具体问题，不做功能堆砌式对比；涉及具体数字的结论都已标注来源与日期。

---

## 一、先定坐标：Nyra 现在站在哪

代码事实（`src/`，66 文件 / 22,662 行，含空行；非空 20,188 行，2026-11-19 实测）：

| 层 | Nyra 现状 | 落点 |
|---|---|---|
| 模型适配 | 多 provider、流式、`--json` 事件 | `providers.ts` `multiModel.ts` |
| 上下文 | 自动压缩、记忆浏览、会话恢复、checkpoints | `compact.ts` `memory*.ts` `checkpoints.ts` |
| 工具 | shell/文件/浏览器(CDP)/MCP/`apply_patch` | `tools.ts` `mcp.ts` `cdpBrowser.ts` |
| 权限 | 审批 UI、计划模式、写入范围限制 | `approvalUi.ts` `planMode.ts` |
| 执行循环 | `max_turns` 预算、断点续跑、`--verify` | `agent.ts` `runs.ts` |
| 协作 | `groups.ts`（多机器人）、gateway 多渠道 | `groups.ts` `gateway.ts` |
| 沙箱 | **仅 Linux bwrap**，macOS/Windows 退化为工具级 | `sandbox.ts` |
| 验证 | `evidence.ts` `artifacts.ts` | 部分 |
| 交互 | CLI / TUI / Tauri 桌面 / Web | `cli.ts` `desktop/` |

**一句话**：Nyra 的「可靠性层」（压缩、恢复、验证、预算）已经不弱于多数开源 harness；**真正落后的三块是 OS 沙箱跨平台、子 Agent、扩展面（hooks/skills/permission 表达力）**。

---

## 二、别家最值得抄的七个设计

### 1. Codex：两层安全模型（sandbox × approval 正交）

Codex CLI 把「技术上能碰什么」和「什么时候要问人」拆成两个正交维度：

| Sandbox 模式 | 含义 |
|---|---|
| `workspace-write`（VCS 目录默认） | 只能写工作区，无网络 |
| `read-only` | 只读 |
| `danger-full-access` | 不限制 |

| Approval 策略 | 含义 |
|---|---|
| `on-request`（默认） | 需要时问 |
| `untrusted` | 只自动跑已知安全操作 |
| `auto_review` | 交自动审查器 |
| `never` | 不问 |

**三个可直接抄的细节**：
1. **受保护路径**：即使在 `workspace-write` 下，`.git` / `.agents` / `.codex` 也是**只读**。防的是"agent 改自己的规则文件给自己放权"。
2. **按仓库形态自动选默认**：VCS 项目 → `workspace-write + on-request`；非 VCS 目录 → `read-only`。用户不用懂这些概念也能拿到安全默认。
3. **headless 与交互同一套语义**：`codex exec --json --sandbox <mode> --ask-for-approval <policy>`，CI 与本地不是两套逻辑（[Codex CLI 分析](https://raw.githubusercontent.com/qte77/ai-agents-research/refs/heads/main/docs/non-cc/coding-agents/codex-cli-analysis.md)）。

> **对 Nyra**：`sandbox.ts` 已有 `workspace-write/read-only/danger-full-access` 与 `allowNet`，语义和 Codex 完全一致——但**缺受保护路径清单**，且 `danger-full-access` 与 bwrap 互斥的处理是抛错（Codex 是允许但不推荐）。补受保护路径是低成本高收益。

### 2. Claude Code：hooks 的四种 handler + 决策控制

28–33 个事件，覆盖 `SessionStart/End`、`InstructionsLoaded`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest/Denied`、`PostToolUse(Failure)`、`SubagentStart/Stop`、`TaskCreated/Completed`、`Stop`、`PreCompact/PostCompact`、`WorktreeCreate/Remove` …

关键在于**handler 不只有 shell**：

| 类型 | 用途 |
|---|---|
| `command` | 跑脚本，stdin 收 JSON，exit 2 = 阻止 |
| `http` | POST 到你的审批系统 |
| `prompt` | 用小模型判定 yes/no |
| `agent` | 起子 Agent 做复杂核验（例如"这条命令安全吗"） |

以及 `PreToolUse` 的决策控制：

```json
{"permissionDecision": "allow|deny|ask|defer", "updatedInput": {...}}
```
冲突优先级 **deny > defer > ask > allow**，还支持 `if: "Bash(git *)"` 这类按权限规则语法过滤的 matcher（[Claude Code 扩展文档](https://raw.githubusercontent.com/a5c-ai/babysitter/d97a2e46a84cbc3ca4589050a9bddbcbf792a785/library/specializations/meta/harnesses/claude-code/README.md)）。

> **对 Nyra**：`hooks.ts` 225 行，事件与 handler 类型都少。**最值得补的不是事件数量，而是 `PreToolUse` 能返回 `updatedInput`**——这让 hook 能"改写参数后放行"，比只能 allow/deny 强一个量级（典型用法：把 `rm -rf /` 改写成被拦截的 dry-run）。

### 3. Claude Code：权限规则语言 `Tool(specifier)`

```text
Bash(npm run *)          # 通配
Edit(/src/**/*.ts)       # gitignore 风格 glob
WebFetch(domain:example.com)
mcp__<server>__<tool>    # MCP 工具精确寻址
Agent(Explore)           # 子 Agent 控制
Skill(commit)            # 技能控制
```
求值顺序 **deny > ask > allow**，多作用域（managed > CLI > local > project > user）。

> **对 Nyra**：目前审批是工具粒度 + 交互式提问，没有**可持久化、可共享、可审查的规则语言**。这块直接决定"能不能放进团队仓库"。建议照抄语法（它是事实标准），只实现 `Read/Write/Edit/Bash/WebFetch/Mcp` 六类。

### 4. Claude Code：子 Agent 是一等公民

内置 `Explore`（Haiku、只读、快速搜索）、`Plan`（只读、给计划模式做研究）、`general-purpose`（全工具）。定义就是带 frontmatter 的 markdown：

```yaml
name: code-reviewer
tools: Read, Glob, Grep      # 工具白名单
model: sonnet                 # 可指定更便宜的模型
maxTurns: 20
isolation: worktree           # 独立 git worktree，互不干扰
memory: project
background: true              # 后台跑
```

设计要点：**子 Agent 有自己的上下文窗口**（所以主 Agent 的上下文不被污染）、**有独立工具白名单**（所以能"只给只读权限"）、**能指定便宜模型**（Explore 用 Haiku 做搜索，成本降一个量级）。

> **对 Nyra**：`tools.ts` 里已经有 `delegate` 工具（子任务 + `max_turns` ≤12 + 最多 8 个子 agent / 3 层嵌套），所以"有子 Agent"这件事已成立。真正缺的是**隔离与瘦身**：没有 `isolation: worktree`（多个子 Agent 会改同一个工作区）、没有按子任务指定便宜模型、没有工具白名单（子 Agent 目前继承全工具）。这三项决定子 Agent 能不能安全并行。

### 5. Skills：SKILL.md 的六个关键字段

Claude Code 的 skill frontmatter 里，真正让它"能落地"的是这几个：

| 字段 | 解决什么 |
|---|---|
| `disable-model-invocation` / `user-invocable` | 控制谁能触发：只给人用 / 只给模型用 |
| `allowed-tools` | 技能激活期间免审批的工具白名单 |
| `context: fork` + `agent:` | 技能在子 Agent 里跑，不污染主上下文 |
| `paths: ["**/*.ts"]` | 按正在编辑的文件自动激活 |
| `model` / `effort` | 技能可要求更强或更便宜的模型 |
| `!`command`` | **动态上下文注入**：skill 正文里写 `!`gh pr diff``，预处理时执行、模型只看到结果 |

> **对 Nyra**：`skills/` 现在是 6 个纯 markdown（creator-mode / debugging / web-research…），没有 frontmatter、没有动态注入、没有工具白名单。**动态注入 `!`cmd`` 是投入产出比最高的一条**——它让技能能拿到真实的仓库状态而不是靠模型猜。

### 6. 插件生态：市场 + 缓存 + 治理三层

Claude Code 的做法值得抄的是**安全默认**：
- 插件安装后**复制到缓存目录**，不允许引用目录外文件（`../shared` 失效）→ 防止插件读到你的 `.env`
- 敏感配置进**系统钥匙串**，不进 settings 文件
- `strictKnownMarketplaces` / `allowManagedMcpServersOnly`：企业可锁死只允许白名单
- CI 用 `PLUGIN_SEED_DIR` 预置，禁自动更新

> **对 Nyra**：`plugins.ts` 已有，但没有"安装即隔离"和"企业可锁"。如果 Nyra 要做团队版，这是必选项。

### 7. DeepSeek Harness：可替换运行时（研究价值 > 生产价值）

九类插件化能力（模型 / 工具 / 技能 / 会话 / 沙箱 / 存储 / 循环 / 调度 / UI）+ 四种运行模式（Standard / Code / Minimal / Creator），官方自标 developer preview（[2026 Harness 选型指南](https://news.qiniu.com/archives/1789468804901)）。

> **对 Nyra**：不用照抄，但**"Session 轨迹可导出、可回放"**这个能力值得借鉴——它直接服务于你的「结果自证」优先级。

---

## 三、横向对照：Nyra 缺什么（按投入产出排序）

| # | 缺口 | 别家做法 | Nyra 落点 | 工作量估计 |
|---|---|---|---|---|
| **1** | **受保护路径**（`.git`/规则文件只读） | Codex：`workspace-write` 下仍只读 | `sandbox.ts` + `tools.ts` | 半天，纯收益 |
| **2** | **`PreToolUse` 可返回 `updatedInput`** | Claude Code | `hooks.ts` | 1 天 |
| **3** | **子 Agent（含 worktree 隔离 + 便宜模型 + 工具白名单）** | Claude Code Explore/Plan | 新 `src/subagent.ts` | 3–5 天 |
| **4** | **权限规则语言 `Tool(specifier)`** | Claude Code | 新 `src/permissionRules.ts` | 2 天 |
| **5** | **Skill frontmatter + `!`cmd`` 动态注入** | Claude Code | `skills/*.md` + 加载器 | 1–2 天 |
| **6** | **macOS/Windows 的 OS 沙箱** | Codex/CC：Seatbelt / bwrap | `sandbox.ts` 加 seatbelt 后端 | 5–8 天（需 mac 机验证） |
| **7** | **MCP 工具延迟加载**（只先给名字） | Claude Code | `mcp.ts` | 1 天，省 context |
| **8** | **费用上限 + 实时成本看板** | 各家都弱，Nyra 自定 P3 | 已在 ROADMAP | — |
| **9** | **插件安装即隔离 + 企业锁定** | Claude Code | `plugins.ts` | 2 天 |

---

## 四、建议的下一步（对齐你 ROADMAP 的「可靠性优先队列」）

你的 ROADMAP 排序是：①记忆可见 ②长任务续跑+自证 ③费用上限 ④多 Agent 状态板。这四条都对，但**上面的 1、2、5 属于"半天到两天就能拿到"的低垂果实，建议插队先做**，因为它们直接减少静默失败：

```text
S1（半天）  受保护路径：.git / .nyra / AGENTS.md / commands/ 在 workspace-write 下强制只读
S2（1 天）  hooks 支持 PreToolUse 返回 updatedInput + if 匹配器
S3（1-2 天）skills 支持 frontmatter（allowed-tools / paths / model）+ !`cmd` 动态注入
S4（3-5 天）子 Agent：只读 Explore + worktree 隔离 + 独立 maxTurns
S5（2 天）  权限规则语言 Tool(specifier)，deny>ask>allow
```

S1 为什么排第一：**agent 能改自己的规则文件，等于所有权限设计都失效**。这不是理论风险——`AGENTS.md`、`commands/*.md`、`skills/*.md` 都在工作区里。

---

## 五、上线红线（来自 2026 Harness 选型指南，Nyra 应逐条自检）

- [ ] 不把生产密钥写进项目规则、会话或插件配置
- [ ] 默认**不**开放仓库外写入、任意 shell、无限制网络（Nyra 默认断网 ✓）
- [ ] 未审查的 MCP Server / Skill / 插件不直接装进生产 profile
- [ ] 不只保留最终答案，必须留 diff、测试与工具错误
- [ ] 长任务必须有预算、超时、取消、人工接管
- [ ] 不把 benchmark 分数换算成真实交付率

---

## 六、来源

| 来源 | 用途 |
|---|---|
| [Codex CLI 分析（2026-11 更新）](https://raw.githubusercontent.com/qte77/ai-agents-research/refs/heads/main/docs/non-cc/coding-agents/codex-cli-analysis.md) | 两层安全模型、受保护路径、headless 语义、`/goal` + Stop hook |
| [Claude Code 扩展文档（plugins/skills/hooks/subagents/permissions）](https://raw.githubusercontent.com/a5c-ai/babysitter/d97a2e46a84cbc3ca4589050a9bddbcbf792a785/library/specializations/meta/harnesses/claude-code/README.md) | 28 事件、4 种 handler、`updatedInput`、规则语法、子 Agent frontmatter、skill 字段 |
| [2026 Coding Agent Harness 选型指南（30 工具）](https://news.qiniu.com/archives/1789468804901) | 八层模型、12 维度评测、6 类测试任务、上线红线、各家定位 |
| [Agentic Security 综述（Claude Code 沙箱：bubblewrap/Seatbelt + 代理管网络）](https://raw.githubusercontent.com/docxology/docxology/refs/heads/main/papers/2026_AgenticSecurityOperating/full_text.md) | OS 级沙箱设计参考 |
