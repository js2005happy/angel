# Angel 变更记录

## 0.2.0（2026-11-16）

- 新增 MCP 客户端（`angel/mcp.py`）：stdio JSON-RPC，加载配置里的服务器，工具以 `mcp_<服务器>_<工具>` 形式调用；默认关闭，需 `mcp_enabled: true` 显式启用。
- 新增内置调度器（`angel/scheduler.py`）：`angel schedule` 子命令（list/add/remove/run/daemon），任务存 `~/.angel/schedule.json`，支持间隔或每天固定时间。
- 新增会话压缩（`angel/compact.py`）：`--compact <会话 id>` 与 REPL `/compact`，模型摘要 + 保留最近消息，模型失败时本地回退。
- 新增证据链（`angel/evidence.py`）：`web_fetch` / `web_search` 抓到的页面原文按会话存档，结论附来源链接。
- 新增工具：`grep_search`、`git_status`（只读）、`http_post`（走审批）。
- `web_search` 改为必应优先、百度兜底的双后端（按 IllusionAgent 的做法），全部失败才报明确错误。
- 新增 provider 档案（`profiles` + `--profile`），显式参数优先于档案。
- 新增核查式调研技能 `verify-research`：搜索→打开官网→逐项核对→存证→附链接交付。
- 浏览器类工具（navigate/click/screenshot）记入路线图，不做假的。
- 测试从 21 个增至 53 个，全部通过；真实 DeepSeek flash 端到端跑通。

## 0.1.0（2026-11-15）

- 首版：Python 标准库 only 的全能 agent CLI。
- 6 个 provider（deepseek/xai/openrouter/ollama/openai/custom），OpenAI 兼容协议。
- 11 个工具（读写改列文件、shell、web_fetch/web_search、记忆、技能、delegate、plan）+ 审批三档 + shell 黑名单。
- 技能系统（Markdown + frontmatter）、长期记忆、会话 jsonl 存储与恢复。
- 21 个 mock 测试通过；真实 DeepSeek API 端到端跑通。
