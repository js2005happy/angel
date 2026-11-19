# 竞品设置矩阵与采纳清单

> 2026-11-19。来源：[Codex CLI 配置参考](https://developers.openai.com/codex/config-reference)（经 [社区镜像](https://raw.githubusercontent.com/CodeAlive-AI/ai-driven-development/main/skills/settings-management/references/codex-settings.md) 摘录）、[Alma 设置文档](https://alma.now/docs/settings/)、[Grok bot 审批/安全文档](https://docs.x.ai/grok-bot/approvals-security-and-privacy)、[Grok 子代理](https://docs.x.ai/build/features/subagents)、[Hermes Agent 0.9 发布说明](https://huggingface.co/haochengsama/hermes/blob/main/RELEASE_v0.9.0.md)。
>
> 原则：**学概念，自己写实现**。不抄代码，不搬配置键名（除非已经成了事实标准，比如 `sandbox_mode`）。

---

## 一、三家最值得抄的三件事（按对"少花钱多干活"的贡献排序）

| 排序 | 出自 | 机制 | 为什么省钱 |
|---|---|---|---|
| 1 | Alma | **Tool Model**：工具调用/摘要用便宜模型，对话用强模型 | 一轮对话里工具调用占大头；把工具轮的水位降下来，总成本直接砍半 |
| 2 | Codex | **Rules（prefix_rule + 复合命令拆分）** | 规则足够精确，就不用每次都弹窗问人；每次审批都是一轮往返 token |
| 3 | Codex | **model_reasoning_effort / model_verbosity** 分档 | 简单任务用 `low`，省下的是 reasoning token（通常比输出 token 贵好几倍） |

---

## 二、设置项矩阵

图例：✅ 已有 ｜ 🔧 本轮做 ｜ ⬜ 待做 ｜ ❌ 不做（理由）

### 模型与推理

| 设置 | 出处 | Nyra 现状 | 决策 |
|---|---|---|---|
| `model` | 三家都有 | ✅ `config.model` | — |
| `model_reasoning_effort`（minimal/low/medium/high/xhigh） | Codex | ⬜ | **做**：透传给支持的 provider，未知 provider 忽略 |
| `model_verbosity` | Codex | ⬜ | 做（同类透传） |
| `model_reasoning_summary` | Codex | ⬜ | 观察，暂不做 |
| **Tool Model（工具用便宜模型）** | Alma | ⬜ | **优先做**：`tool_model` 配置，工具轮/摘要走它 |
| 多模型 fallback 链 | 三家 | ✅ `fallback_providers` | — |
| `model_auto_compact_token_limit` | Codex | ✅ `auto_compact_threshold`（比例式） | 保留比例式，够用 |

### 审批与沙箱

| 设置 | 出处 | Nyra 现状 | 决策 |
|---|---|---|---|
| `approval_policy`（untrusted/on-request/never/granular） | Codex | 部分（`--approve`/交互式） | **做 granular**：`approval_policy` 字符串 + `[approval_policy.granular]` 等价物 |
| `sandbox_mode`（read-only/workspace-write/danger-full-access） | Codex | ✅ | — |
| `sandbox_workspace_write.writable_roots` | Codex | ⬜ | 做：`--add-dir` 等价物 |
| `network_access` | Codex | ✅ `sandbox_allow_net` | — |
| **`deny_read_globs`** | Codex | 🔧 **本轮已做** | 读侧禁读清单 |
| **Rules（prefix_rule allow/prompt/forbidden）** | Codex | 🔧 权限规则已有，**本轮补复合命令拆分** | 继续补 `prompt` 动作与 `--rules` 文件 |
| `requirements.toml`（管理员不可覆盖） | Codex | ⬜ | 做轻量版：`nyra.json` 里 `enforced` 段 |
| 受保护写入路径 | Codex（.git/.codex） | ✅ #31 | — |

### 子代理

| 设置 | 出处 | Nyra 现状 | 决策 |
|---|---|---|---|
| `max_threads` | Codex | ✅ 委派预算（数量） | — |
| `max_depth` | Codex | ✅ 3 层 | — |
| 每个子代理独立配置（model/tools/sandbox） | Codex `[agents.x]` | ✅ #35（isolation/tools/model） | 补：按名字声明在 config 里，而不是每次调用传参 |
| 子代理专属指令文件 | Codex | ⬜ | 观察 |

### 技能 / 钩子 / 记忆

| 设置 | 出处 | Nyra 现状 | 决策 |
|---|---|---|---|
| 技能搜索路径（项目 → 用户 → 系统） | Codex | ✅ | — |
| 单技能启停（`[[skills.config]] enabled=false`） | Codex | ⬜ | 做：`config.skills.disabled` |
| 钩子事件 + matcher + timeout | Codex | ✅ #32/#36 | — |
| 钩子 `updatedInput` | Codex | ✅ #36 | — |
| 记忆系统开关与检索参数 | Alma | 部分（memory） | 观察 |
| MCP 服务器配置 + 预设 | 三家 | ✅ | — |
| MCP 工具延迟加载 | Codex `tool_search` | ✅ 自动开启（MCP > 8；显式开 `tool_search` 时阈值降到 `top_k`，`NYRA_LAZY_TOOLS=0` 一票否决） | — |

### 界面 / 运维

| 设置 | 出处 | Nyra 现状 | 决策 |
|---|---|---|---|
| **设置导出/导入 JSON** | Alma | ⬜ | 做：`nyra config export/import`（团队可共享一套红线） |
| Feature flags（`[features]` + `--enable`） | Codex | ⬜ | 做轻量版：`config.features` + `--enable/--disable` |
| Profiles（命名预设） | Codex | ✅ `profiles` | 补：`--profile` 覆盖 model/effort/sandbox 一套 |
| 键位自定义 | Alma | ❌ | TUI 键位固定即可，收益低 |
| 主题/字体/Whisper | Alma | ❌ | 桌面端范畴，非核心 |

---

## 三、采纳路线（每项都能独立验证）

1. 🔧 **权限规则精确化**（本轮）：复合命令拆分 + `deny_read_globs`
2. **`tool_model`**：工具轮走便宜模型——**省钱最大的一刀**
3. **`model_reasoning_effort` / `verbosity` 透传**：简单任务降档
4. **`config export/import`**：把红线打包成可分享文件
5. **`features` 开关**：新能力默认关、可灰度
6. **`--add-dir`**：扩展可写根，不退出沙箱
7. 🔧 **工具集量化与裁剪**（本轮）：`nyra tools` 看每轮 schema 成本，`--disable-tool` / `disabled_tools` 裁剪；实测裁掉 computer_use + poppy 省 1,359 token/轮（20 轮 = 27,180）`n8. **MCP 工具延迟加载**：在 7 的基础上把"发全部 schema"换成"1 个检索入口"

---

## 四、明确不做

- 抄 UI：Alma/Grok 的界面细节与 Nyra 的定位无关
- 抄配置键名：除非已成事实标准（`sandbox_mode`、`approval_policy`）
- 自建模型/训练：不是我们的战场

---

## 工具延迟加载：什么时候该开（判断标准）

MCP 工具超过 8 个时**自动开启**（只发最相关的前 8 个，其余靠 `search_tools` 拉回）。显式开启（`config.tool_search.enabled: true` 或 `features.tool_search: true`）时阈值降到 `top_k`（默认 8），即使 MCP 工具不多也会进入延迟加载；`NYRA_LAZY_TOOLS=0` 仍一票否决、切回全量发送。

**工具集臃肿的信号**（任一命中就该注意）：

| 信号 | 阈值 | 怎么看 |
|---|---|---|
| 工具数量多 | ≥ 25 个 | `nyra tools` 第一行 |
| 每轮 schema 成本高 | ≥ 2,500 token/轮 | `nyra tools` |
| 占上下文比例高 | ≥ 5% | `nyra tools` |
| 接了 MCP 且工具用不满 | MCP 工具数 > 实际使用数 | `nyra tools` 最贵名单 |

`nyra redlines` 会对上述情况给出 `tools-bloat` 提醒（**warn，不阻塞**），修法是裁掉用不到的工具（原生工具每轮都会完整发送，体积只能靠裁剪控制）：

```bash
nyra --disable-tool computer_use --disable-tool poppy "<task>"   # 裁掉用不到的
```

**不该用延迟加载的场景**：工具本来就不多（< 15 个）、任务类型单一、或模型明显不太会用 `search_tools`
（表现为反复检索同一个词）——这时用 `NYRA_LAZY_TOOLS=0` 关掉，切回全量发送更省心。