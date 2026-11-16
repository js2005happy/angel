# Angel 变更记录

## 未发布（网页界面、终端打磨、项目官网）

- 新增本地网页界面 `python3 -m angel ui`（`angel/webui.py` + 内嵌单页 `angel/webui_page.py`）：纯标准库 `http.server`，无 CDN。左栏会话列表（读现有会话存储，可新建/恢复），中栏对话 + 可折叠工具调用卡片（auto 模式下卡片内批准/拒绝），右栏 provider/模型、证据来源链接、plan 步骤；设置面板只显示 Key 是否已配置，从不回显值。
- 网页界面安全：默认只监听 `127.0.0.1`，绑定非本机地址时打印警告；每次启动随机生成访问 token（页面经 `?token=` 带入，API 必须用 `X-Angel-Token` 请求头），本机监听时校验 `Host` 头，不回应跨域预检，页面带 CSP。
- `Agent` 新增可选 `on_event` 观察回调（工具开始/结果、助手消息），`ToolContext` 新增可选 `approve_fn`，让网页界面复用同一个审批门；不传时行为与之前完全一致，子 agent 继承同一审批回调。
- 终端 REPL 打磨：启动横幅、`angel[模式] ›` 提示符、工具调用分组显示（`┌ 工具 参数` / `└ ✓/✗ 结果`）、`/help` 对齐排版；颜色尊重 `NO_COLOR`、`TERM=dumb` 与非 TTY；一次性任务输出不变。
- 新增项目官网 `docs/`（GitHub Pages，纯静态、中英双语、暗色模式、无外部资源），地址 https://js2005happy.github.io/angel/ 。
- 新增测试 `tests/test_webui.py`（23 个，mock provider + 随机端口）、`tests/test_repl_ui.py`（12 个）、`tests/test_docs_site.py`（5 个）；`unittest discover` 共 127 个通过。

## 未发布（MCP 环境变量最小权限）

- MCP 子进程默认只继承启动所需的基础环境变量，不再复制宿主进程全部环境变量，避免自动暴露 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 等无关凭证。
- MCP 配置新增可选的 `inherit_env`（精确变量名列表），与现有 `env` 合并；`env` 显式值覆盖继承值。非法变量名和非列表配置被拒绝。
- 新增跨平台模拟及真实 Python MCP 子进程的环境隔离回归测试；MCP 可执行程序仍以本机用户身份运行，此改动不是进程沙箱。

## 未发布（本机请求绕过代理）

- 修复：设置了 `HTTP_PROXY` / `HTTPS_PROXY` 但没设 `NO_PROXY` 时，发往本机（`localhost`、`127.0.0.0/8`、`::1`）的请求也被转发到代理，导致本地 Ollama provider、`web_fetch` / `http_post` 访问本机服务失败（代理返回 404/502），两个 mock 测试也因此在代理环境里失败。
- 新增 `angel/net.py`：本机地址的请求一律直连，其余地址照常遵守环境代理设置；provider 客户端、`web_fetch`、`web_search`、`http_post` 统一走它。
- 新增回归测试 `tests/test_net_proxy.py`（本机地址识别、代理指向不可用端口时本机服务仍可访问、远程地址仍使用代理）。

## 未发布（MCP 权限安全）

- MCP 工具调用统一接入工具层审批：`readonly` 禁止、`auto` 每次确认、`auto` 非交互拒绝、`full` 允许；不信任服务端提供的工具名称/描述来判断是否只读。
- 新增 MCP 审批回归测试：拒绝、授权、逐次确认、后台拒绝与审批提示敏感参数保护。

## 未发布（证据文件可靠性）

- 证据存档使用独占创建模式，遇到文件名冲突自动尝试下一个序号，避免覆盖已存在的证据；证据类型字段用于文件名时先进行安全字符过滤。
- 新增证据文件冲突、非法类型和连续保存的回归测试（`tests/test_evidence_files.py`）。

## 未发布（Windows 兼容性）

- MCP stdio 从不兼容 Windows 匿名管道的 `select` 改为后台读取线程 + 队列，保留响应超时和进程退出处理。
- 启动 Python MCP 子进程时默认配置 UTF-8 标准输出（保留显式环境变量覆盖），避免非 UTF-8 Windows 代码页导致服务器退出。
- E2B 沙盒路径始终使用 POSIX 规则解析，修复 Windows 客户端将 `/home/user` 转为反斜杠路径的问题。
- CLI 和调度器对旧终端编码使用 `backslashreplace` 安全降级，避免中文日志触发 `UnicodeEncodeError`。
- 新增 Windows/MCP 相关回归测试，并建立 Linux、Windows 多版本 Python 的 GitHub Actions CI。

## 0.3.0（2026-11-16）

- 新增 E2B 沙盒执行后端（`angel/e2b_backend.py`）：`--sandbox e2b` 让文件读写与 shell 命令在 E2B 沙盒里执行，不在本机上；`--sandbox-id` 可连回已有沙盒，不给则新建（默认 base 模板、1 小时超时）。沙盒模式下工作目录默认 `/home/user`。
- 执行后端是 tools.py 里的一道缝：`read_file` / `write_file` / `edit_file` / `list_dir` / `shell` / `plan` / `grep_search` / `git_status` 走后端，其余工具（联网、记忆、技能、delegate、http_post）仍在本地；审批三档与 shell 黑名单在两种后端下都生效；子 agent 继承同一后端。
- 核心仍是标准库 only：E2B 后端是可选依赖（`pip install e2b`），缺 SDK 时报明确安装提示；凭证优先用 `E2B_API_KEY`，否则走已保存的 Muse 连接器凭证替身，真实 key 不落盘、不进沙盒。
- 测试从 53 个增至 62 个，全部通过；真实 DeepSeek + 真实 E2B 沙盒端到端跑通（沙盒里写文件、读回、列目录，本地无任何写入）。

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
