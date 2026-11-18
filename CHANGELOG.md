# Nyra 变更记录

## 未发布（电脑操作 + 视觉模型看屏 + 多模型调研 + 群聊多 Key）

- 电脑操作：新增 `nyra/computer.py`（`ComputerControl`，标准库 only，三后端：Linux xdotool、Windows ctypes 直调 user32/gdi32、macOS osascript + screencapture；`screenshot` / `click` / `move` / `type_text` / `press` / `windows` / `screen_size`，坐标校验、按键归一化；DISPLAY 未设或 xdotool 缺失时报清错，不自启 X 服务、不装东西、不联网）与 `nyra/tools.py` 的 5 个新工具（`computer_screenshot` / `computer_click` / `computer_type` / `computer_key` / `computer_windows`，全部进 `MUTATING_TOOLS`，照 `browser_*` 规矩走 `_check_approval` + `wrap_untrusted` + 证据目录）。`nyra/webui.py` 的 `NEEDS_APPROVAL_TOOLS` 与 `/api/info` 工具数同步补到 24（`tests/test_webui.py` 断言 18→24）。新增 `tests/test_computer.py`（44 项，全 mock）。如实说明：本机无桌面，`sudo apt-get install -y xdotool` 一次尝试即失败（源里没有这个包），没跑成 Xvfb 真冒烟；Windows/macOS 后端只在 mock 上验过，没在真机上跑过；Nyra 本身不“看图找按钮”，坐标须来自用户、窗口几何，或视觉模型看了截屏后报的点。
- 视觉模型看屏：新增 `nyra/vision.py`（`image_part` / `supports_vision` / `build_image_message`：OpenAI 兼容 image part、视觉模型判断表 + `NYRA_VISION_MODELS` 环境变量覆盖）与 `nyra/providers.py` 的 `_normalize_messages`（`str` 照旧、part 列表原样透传进 HTTP payload，Codex CLI 路径扁平化 part 不炸）。`computer_screenshot` 的工具描述已改成“已配置视觉模型时，模型可直接看这张截屏定位元素、再报坐标点”。新增 `tests/test_vision.py`（26 项，全 mock）。还差一步：`agent.py` 主循环在工具结果处把截屏 PNG 挂进下一次模型请求——该文件冻结，等 A–E 合并后接线，接线点已写进 `vision.py` 的模块 docstring；在那之前截屏只存证据、不进模型视野。
- 多模型调研：新增 `nyra/multi_model.py`（`research(models, prompt, system, timeout, synthesizer)`：同一问题并行问多个模型——`provider` 或 `provider:model`，最多 5 个，线程并行、共用一个超时；挂掉或超时的模型只记录、不兜底、不拖垮其他模型；可选一个综合模型把各家回答按模型署名合成共识/分歧/独特观点三节；入口 `python3 -m nyra.multi_model research --models a,b --prompt ... [--synthesizer x] [--json]`，`--list` 列 14 个 provider）与 `tools.py` 的 `multi_model_research` 工具（不进 `MUTATING_TOOLS`，与 `delegate` 同例：只花模型调用、不写文件不跑命令）。新增 `tests/test_multi_model.py`（20 项，含 3 项工具接线测试，全 mock）。只做纯文本调研 v1，图片输入走 `vision.py`。
- 群聊多 Key：每个机器人可配各自独立的多个 API Key（`nyra/groups.py` 的 `Bot.api_keys`，最多 5 把，空 Key 与超数都报清错，旧房间无此字段照常解析；不同机器人之间不共享 Key 池）；新增 `nyra/providers.py` 的 `KeyRotatingProvider`（同一 provider+模型、多把 Key 轮换：401/403 也轮换——换 Key 能治认证问题，换模型不能，这是与 `FallbackProvider` 故意不同的语义；每把 Key 失败都记进 `switches`，全挂时报错只写“第几把 Key”绝不带 Key 值；每次调用从第一把 Key 重新开始）。`GroupStore._provider` 在有 `api_keys` 时用 `dataclasses.replace` 逐 Key 生成配置并包进 `KeyRotatingProvider`，无 Key 时走原来的兜底链不变；CLI 认证的机器人（Codex）配 Key 时报清错。展示数据已脱敏（发给网页端的机器人信息不含 Key）。新增测试在 `tests/test_group_chat.py`（轮换、401/402/429 全轮换、全挂不泄 Key、单 Key 路径、旧房间兼容等）。`FallbackProvider` 与 `build_provider_chain` 未改。
- 测试 860 → 964 项，全部通过（skipped=11）。

## 未发布（五端安装包：Linux 复核 + Windows + macOS + 手机 PWA）

- Linux 打包复核：`bash scripts/build_package.sh` 重跑成功，tarball（261,901 字节）与 .deb（201,358 字节）均含全部 46 个 `nyra/*.py`（7 个新模块全在内），不含 `__pycache__` / `.venv` / `.git`；tarball 解压后 `python3 -m nyra --version` 出 `Nyra 0.3.0`，新模块 import 全过；.deb 的 control 字段与解包后 payload 同样验证通过。本轮 .deb 未做真实 `sudo dpkg -i` 系统安装（此前真实安装验证时的模块集比现在少，本轮只是多了 .py 文件），构建脚本无需改（glob 自动包含新模块）。
- Windows：`scripts/install.ps1` 逐行审过并修了 4 个真问题（`git pull` / `git clone` 失败时查 `$LASTEXITCODE` 停下、不再装半截；识别微软商店 python 占位程序并报错指去 python.org；只有 `py` 启动器时也能用；图标下载失败先删半截文件）；新增 `.github/workflows/build-windows.yml`（windows-latest + Python 3.12：先跑全量测试，再用 PyInstaller 打单文件 exe，跑 `nyra.exe --version` 冒烟，上传为 workflow artifact 保留 90 天；只有 `v*` 标签才走 release job 挂到 Release，普通 main 推送绝不发布；`webui.py` 运行时要读的 4 个非代码文件已 `--add-data` 进包）。新增 `docs/windows-install.md`，README 快速开始处加指向。如实说明：exe 与脚本都没在真 Windows 上跑过（本机无 PowerShell、无 Wine，装 PowerShell 的一次尝试也被运行时重启打断、未装上，脚本只做了括号平衡弱检查），CI 是第一次真正的语法与运行验证；`branding/nyra.ico` 尚未推送，脚本装的快捷方式暂时是默认图标，图标推上去后重跑脚本可换上。
- macOS：新增 `scripts/install-macos.sh`（镜像 Linux `install.sh`：装到 `~/.local/share/nyra`、启动器 `~/.local/bin/nyra`、`~/.nyra` 0700、`--source` 支持本地目录或 git URL、重复跑即升级、`--uninstall` 保留数据；开头验 Darwin、python < 3.10 拒绝并指 `brew install python`、PATH 不在时给 zsh 的 `~/.zshrc` 追加命令，只写 `$HOME`、零 pip 依赖）与 `launchd/ai.nyra.scheduler.plist`（`Label` 为 `ai.nyra.scheduler`，跑 `python3 -m nyra schedule daemon`，`RunAtLoad=true` + `KeepAlive`（`SuccessfulExit=false`，即 systemd `Restart=on-failure` 的镜像），日志进 `~/.nyra/logs/`），新增 `docs/macos-install.md`。验证：`bash -n` 通过、plist 解析通过、占位替换后无残留、Linux 上跑以 exit 1 拒绝并说明去向；如实说明：没在真 Mac 上跑过，`launchctl load` 用的是老式命令。
- 手机 PWA（Android / iOS 的安装方式）：`nyra/webui.py` 新增 `GET /manifest.json`（name/short_name "Nyra"、display standalone、背景 `#F3F5F4`、主题 `#5F7D5C`、图标 `/nyra-mark.svg`）与 `GET /nyra-mark.svg` 两个路由，均走与页面一样的 token 鉴权（浏览器拉 manifest 不带请求头，只能走查询串 token），CSP 补 `manifest-src 'self'`；`nyra/webui_page.py` 的 head 加 manifest 链接、theme-color、apple-touch-icon 等 7 个标签与移动端 CSS（≤760px 时主要按钮最小 44px 触摸高度、顶栏收紧、防 360px 宽横向溢出）。新增 `docs/mobile-pwa.md`（安卓 Chrome 与 iPhone Safari 的“添加到主屏幕”步骤、局域网访问要 `python3 -m nyra ui --host 0.0.0.0` 并把链接里的 `127.0.0.1` 换成电脑局域网 IP、安全警告：只在信任的家庭 Wi-Fi 下用、绝不映射到公网）。新增 `tests/test_webui.py` 的 `PWATests`（6 项）并收窄 `test_page_has_no_external_resources` 的 blanket `<link>` 断言为只禁外部 href。如实说明：没在真手机上装过；token 每次启动随机、写不进静态 manifest，点主屏幕图标会先看到 token 门页（须先在浏览器打开带 token 的链接再添加）；无 Service Worker、不支持离线；图标只有 SVG。
- 测试 854 → 860 项，全部通过（skipped=11）。

## 未发布（架构解耦第 1 批：API 服务器 + Artifacts + sqlite 对话记忆 + CDP 浏览器）

- 新增 `nyra/server.py`：独立 API 服务器（标准库 `http.server` + `threading`，默认只绑 `127.0.0.1:8766`，网页界面仍用 8765），持有自己的 `UIState`，入口 `python3 -m nyra.server`：`POST /api/sessions` 建会话、`GET /api/sessions/{id}/messages` 读会话、`POST /api/sessions/{id}/send` 发任务（202 立即返回，后台跑）、`GET /api/sessions/{id}/events?since=N` 用 SSE 推事件（断线重连按 `since` 游标补发漏掉的事件，15 秒心跳，跑完以 `run_finished` 结束）、`POST /api/approvals/{id}/decide` 批/拒工具、`GET /api/health` 健康检查（唯一免 token）。鉴权与网页界面同一套：每次启动随机 token，`X-Nyra-Token` 请求头、常量时间比较，查询串 token 一律不认；loopback 绑定时验 Host 头、不开 CORS；未知会话 404、空文本/坏 JSON 400、运行中重复发送 409，错误一律 JSON、不炸服务。新增 `tests/test_server.py`（22 项，全离线：假 provider、随机本地端口）。
- 新增 `nyra/artifacts.py`：Artifacts（富文本产物）存储与检测——`create_artifact` / `get_artifact` / `list_artifacts`（JSON 文件存 `~/.nyra/artifacts/<会话>/`，0700 目录、单件 1 MB 上限截断并标记、每会话 50 件上限删最旧的）、`detect_artifacts` 从 agent 输出里拆围栏代码块与裸 HTML 块（未闭合的围栏与正文里的 `<` 不动，拆出的位置留一行 `[产物：标题]` 标记，不丢文本）、`markdown_to_html`（先转义 HTML 再做标题/粗斜体/代码/列表/链接子集）。网页端 `nyra/webui_page.py` 加“产物”侧栏：从已轮询的会话消息里派生产物列表（全量加载与实时事件都接），代码用 `textContent` 显示、Markdown 用 DOM 拼（`createElement`/`textContent`，不用 `innerHTML`）、HTML 只进 `sandbox="allow-scripts"` 的 iframe `srcdoc`。新增 `tests/test_artifacts.py`（21 项，全离线；页面 JS 另过 `node --check`）。
- 新增 `nyra/conversations.py`：sqlite 对话记忆——`NYRA_HOME/conversations.db`（0600 文件、0700 目录，schema 版本表 + 开库迁移），`messages` 表（会话/角色/文本/工具名/时间）+ FTS5 全文索引（trigram 分词，中文子串能查；短于 3 字符的词自动走 LIKE 兜底，按关键词重叠数打分；无 FTS5 的环境只走 LIKE）。`record` / `history` / `search` / `retrieve_context`（拼给 prompt 用，单条 300 字、上限 2000 字）/ `sessions` / `prune`（删 90 天前的，FTS 触发器同步）。存前先过 `memory_exchange.py` 的 `scrub_secrets`（只剩凭据的行不存），SQL 全参数化。暂未接 agent 主循环与 server（冻结文件，等 A–E 后接线）。新增 `tests/test_conversations.py`（18 项，全离线，临时 NYRA_HOME）。
- 新增 `nyra/websocket.py` + `nyra/cdp_browser.py`：agent 自己的浏览器（CDP）——最小 WebSocket 客户端（标准库 `socket` + `http.client`，握手验 `Sec-WebSocket-Accept`、客户端掩码、分片重组、126/127 扩展长度、ping 自动回 pong、close 握手、10 MB 上限）；CDP 客户端只连本机 Chrome（`http://127.0.0.1:9222/json` 取 page 目标，非 loopback 拒绝、绝不自动启动 Chrome），`navigate`（只 http/https，最多等 10 秒加载事件，慢页不挂住 agent）、`evaluate`（返回值，JS 异常报详情）、`click`（`querySelector` 点元素，找不到报错）、`screenshot`（PNG 字节）、`title` / `current_url` / `visible_text`、`close`；失败一律报清楚的 `CDPError`，不挂起。`nyra/tools.py` 只加三个工具（`browser_navigate` / `browser_click` / `browser_screenshot`，走原有 `_check_approval` 与 `wrap_untrusted`，截图写证据目录），`nyra/webui.py` 的 `NEEDS_APPROVAL_TOOLS` 与 `/api/info` 工具数同步补到 18。新增 `tests/test_websocket.py`（13 项）与 `tests/test_cdp_browser.py`（29 项），全 mock，不启动真 Chrome。已知缺口：会话结束时没有统一 teardown hook 调 `disconnect_browser`（`cli.py` / `agent.py` / `webui.py` 均冻结），连接随进程退出关闭。
- 终端横幅改成 NYRA 四字母字标：11 行 × 42 列纯 `#` 粗体（`nyra/banner.py` 的 `WORDMARK` / `wordmark_lines`，`tests/test_banner.py` 改写为字标测试 10 项：N 斜线/Y 叉/R 碗/A 横杠、全行非空、只含 `#` 与空格）；此前线条画天使与照片密度画两版均已否决，不再使用。标志定为光标 01（`docs/assets/nyra-mark.svg`、Windows 图标 `branding/nyra.ico`），Windows 一键安装脚本 `scripts/install.ps1` 已写（未在真 Windows 上试过）。
- 测试 741 → 860 项，全部通过（skipped=11）。

## 未发布（配对码协作 + 本地密码箱 + 本地知识库 + CI 去位）

- 新增 `nyra/knowledge.py`：本地 AI 知识库——建库、收录文本/文件/网页正文、分块存成本地笔记（`NYRA_HOME/knowledge/<库名>/kb.json` + `notes.jsonl`，每条带标题、来源、日期）、BM25 本地检索、`ask` 提问时把相关笔记交给模型回答并注明依据的笔记标题，库里没有就直说不知道、不编造。标准库 only，不依赖第三方服务。模块入口 `python3 -m nyra.knowledge create|list|add|search|ask|remove`（`add` 支持 `--file` / `--dir` / `--text` / `--url`；`remove` 需输入 yes 确认）。说明边界：抖音视频链接本身拉不到完整文稿（JS 渲染的页面只能拿到标题与描述），视频内容须先把文稿贴进来；跟 agent 主循环的自动调用等 A–E 合并后再接。新增 `tests/test_knowledge.py`（13 项，全离线）。
- 新增 `nyra/pairing.py`：配对码协作——两个 Nyra 用 6 位数字码配对后一起工作。宿主显示配对码（10 分钟过期、一次性、错 5 次作废），客人输入码配对，拿到会话 token（只存内存）后可发任务；任务只在宿主以只读模式执行（不写文件、不跑 shell、不发网络请求），会话只传任务文本与结果，绝不传凭据；只在可信网络配对。宿主是本机 HTTP（0.0.0.0 临时端口，POST /pair、POST /task 须 Bearer token、GET /ping）+ UDP 47831 发现广播；客人有 discover（UDP 广播，5 秒）/pair/run_task/ping。模块入口 `python3 -m nyra.pairing host|join CODE`。新增 `tests/test_pairing.py`（19 项，全离线：错码/过期/5 次作废/无 token 401/发现走 127.0.0.1 单播）。
- 新增 `nyra/vault.py`：本地加密密码箱——provider API Key / 账号密码加密存在本机 `NYRA_HOME/vault.json`（0600 文件、0700 目录），agent 用的时候读出来，绝不在聊天记录、日志里暴露明文。标准库 only：PBKDF2-HMAC-SHA256 200_000 次、64 字节密钥分加密/认证各 32、HMAC-CTR 异或加密、HMAC 验 MAC 后才解密、verifier 验主密码；解密失败统一报错，不区分密码错与文件被改。`config.py` 的 `resolve_provider` 加回退：环境变量里没 Key 且认证方式是 env（无连接器）时读密码箱，文件不存在、未设 `NYRA_VAULT_PASSWORD`、解锁失败时静默跳过、保持原报错，绝不弹 getpass。模块入口 `python3 -m nyra.vault init|add|get|list|remove|change-password`，密钥一律 getpass、拒绝 argv 传密钥。威胁模型写在模块 docstring 里：防读文件，不防机器被入侵/内存/弱主密码，未审计，高价值密钥用专业密码管理器。新增 `tests/test_vault.py`（35 项，全离线）。
- CI 不再依赖 `.sh` 可执行位：快照式推送会丢文件模式（GitHub 上常为 644），测试与文档里原来直接跑 `./scripts/install.sh` / `./scripts/build_package.sh` 的地方全改成 `bash` 显式调用；两个静态测试改断言 shebang（不测模式位）；`docs/linux-install.md` 与 `docs/linux-packaging.md` 里的示例命令同步改成 `bash scripts/...`。去位验证：安装与打包测试 24 项全过。
- 新增 `skills/deep-thinking.md`：深度思考十问（来源：X @Khazix0918“数字生命卡兹克”2026-11-18 的帖子，用户要求写入 Nyra）——第一性原理、对齐喜好出 3 版方案、质疑问题定义、二阶三阶影响、跨领域类比、反方证伪、Git 历史包袱、新人认知成本、慢 PR 分析、Bug 复盘沉淀；按任务挑相关的几条用，不必十条全走一遍。`--list-skills` 与网页端技能列表同步更新为 4 个。新增 `tests/test_skill_deep_thinking.py`（4 项：解析、十条齐全、关键词匹配、自带技能全加载）。
- 新增 `nyra/memory_exchange.py`：记忆模式，照 Muse 的记忆导入做——快照导入/导出（固定五章：身份 / 事实 / 偏好 / 目标与承诺 / 关系，第三人称、只写确切信息、无可靠信息的章节省略；`export-prompt` 打印提示词贴到别的 AI 聊天里让对方输出快照；`import` 去重合并进 MEMORY.md，只追加不覆盖）、配对读记忆（宿主加 GET /memory，须 Bearer token，返回脱敏后的快照；客人加 read_peer_memory，复用带 auth 的请求）、本地读取（Codex 只读打开 `~/.codex/memories_1.sqlite`，本机版本没有 memories 表、记忆在 stage1_outputs.raw_memory 里，两种结构都支持；Claude 读 `~/.claude/CLAUDE.md` 与 MEMORY.md；指定目录读 MEMORY.md / AGENTS.md / CLAUDE.md；找不到或库里没内容报“未找到”）、聊天 .zip 导入（ChatGPT / Claude 的 conversations.json：解析对话清单、原文存 `~/.nyra/memory-imports/<日期>-<来源>/`、MEMORY.md 只记一行导入记录，不做自动事实提炼）。导出与导入两端都先过 scrub_secrets（含凭据的行删掉并计数）；配对原有安全规则不变。模块入口 `python3 -m nyra.memory_exchange export|export-prompt|import|peer|local|import-zip`（cli.py 冻结未碰）。`nyra/pairing.py` 只加 GET /memory 与 `PairingClient.read_peer_memory()`。新增 `tests/test_memory_exchange.py`（34 项，全离线）。
- 新增 `nyra/untrusted.py`：提示词注入防御——`web_fetch` / `web_search` 抓到的网页内容在进模型前先打首尾标记（不可信外部数据，附来源 URL，标记在截断之后、原文同款标记先中性化防冒充），并按句拦截中英文指令型文字（无视指令、改写身份/系统提示、要求执行命令或删文件、泄露密钥等），被拦句改占位行不进上下文；证据文件仍存原文备查。`nyra/tools.py` 只改接入点与两处 tool schema 描述。新增 `tests/test_untrusted.py`（14 项，全离线）。
- 测试 727 → 741 项，全部通过。
- 文档补齐与小修：GUIDE“项目结构”补 19 个模块、工具数 15 改 18（加 3 个 Poppy opt-in 工具说明）、“路线图”一节换成待开发项集中清单、“测试”一节测试数 472 改 727；README“它能做什么”加配对码、密码箱、知识库、MCP 预置四项，快速开始补 Python 3.10+ 要求与 Windows `python -m nyra` 命令；修 `--provider ollama` 不带 `--model` 时错传 deepseek-flash 的问题（config.py 的 resolve_provider：配置默认值漏到新 provider 时改用新 provider 的预置默认模型）、load_config 新建 `~/.nyra` 时用 0700（已有目录不动）。新增 `tests/test_generic_providers.py` 回归测试 8 项。

## 未发布（MCP 内置预置）

- 新增 `nyra/mcp_presets.py`：内置 10 个 MCP 服务器预置，开箱即用，无需手写 `mcp_servers`。默认开启的 4 个（无需密钥、无需路径）：memory（知识图谱记忆）、sequential-thinking（结构化思考）、fetch（抓网页转 Markdown）、time（时间与时区）。按名启用的：github（需 GITHUB_PERSONAL_ACCESS_TOKEN）、brave-search（需 BRAVE_API_KEY）、filesystem / git / sqlite（需在 `mcp_preset_args` 里给路径）、puppeteer（首次使用下载 Chromium）。预置只给配置，不自动启动：MCP 默认关闭，`auto` 模式下每个服务器启动前仍逐一确认。
- 配置新增 `mcp_presets`（默认 4 个即用型）与 `mcp_preset_args`（预置名 -> 追加参数，如 `{"filesystem": ["D:/docs"]}`）；`load_mcp_servers` 先合入预置，再叠加用户 `mcp_servers`（同名覆盖）；密钥缺失或路径未给时跳过并在 stderr 说明原因，密钥只通过 `inherit_env` 按名转发。`--list-mcp` 不变。
- 新增 `tests/test_mcp_presets.py`（单元测试离线跑；真实服务器测试需 `NYRA_LIVE_MCP_TESTS=1`）：预置表结构、默认集与默认配置一致、解析（密钥缺失跳过/路径追加/同名覆盖/未知名跳过）、`load_mcp_servers` 合并行为；真实服务器逐个实测通过（见下）。
- 实测（2026-11-18，本机，真实 npx/uvx 服务器）：memory、sequential-thinking、fetch、time、filesystem（临时目录）、git（临时仓库）、sqlite（临时数据库文件）、github 与 brave-search（假密钥，只验启动与工具列表）均能启动并列出工具；puppeteer 也已实测通过（旧版 2024-11-05，7 个工具：navigate/screenshot/click/fill/select/hover/evaluate，首次下载 Chromium 约 79 秒）。10 个预置至此全部实测通过。只收录 npm/PyPI 上确认存在的包：fetch、git、time 走 PyPI（`uvx mcp-server-*`，需装 uv），其余走 npm（`npx -y @modelcontextprotocol/server-*`，需装 Node.js）；github、brave-search、sqlite、puppeteer 为官方已归档服务器，已在预置说明里注明。
- 实测中修了三个真问题：① 探测超时 5 秒不够（npx/uvx 首次下载要二三十秒，超时后回退握手会被现代服务器拒绝），`PROBE_TIMEOUT` 改到 60 秒，并加慢启动回归测试（假服务器 7 秒后才回探测，须走现代版）；② 子进程环境不传代理与 CA 变量，沙箱/公司出口代理下首次下载连不上：`_subprocess_env` 现透传代理变量（HTTP(S)_PROXY、ALL_PROXY、NO_PROXY、NODE_USE_ENV_PROXY）与受信 CA 变量（NODE_EXTRA_CA_CERTS、SSL_CERT_FILE、CURL_CA_BUNDLE、REQUESTS_CA_BUNDLE、GIT_SSL_CAINFO、AWS_CA_BUNDLE），代理 URL 里嵌的密码去掉再传，用户在 `inherit_env` / `env` 里显式声明的优先；③ sqlite 预置缺 `--db-path` 参数（服务器直接报错退出），且已归档的 sqlite 服务器与新版 MCP SDK 不兼容（`Server` 没有 `list_resources`），现用 `uvx --with mcp==1.30.0` 固定跑 1.x。memory 预置默认把知识图谱写到 `~/.nyra/memory.jsonl`（不在 npx 缓存里，缓存清了也不丢）。

## 未发布（MCP 协议升级到 2026-07-28）

- MCP 客户端从 2024-11-05 升级到 2026-07-28：双时代协商——先用 `server/discover` 探测现代版（每次请求在 `_meta` 里自带 `io.modelcontextprotocol/protocolVersion`、`clientCapabilities`、`clientInfo`），探测失败（非现代错误或超时，最多等 60 秒）时回退旧版握手 `initialize`（最新握手版 2025-11-25）；旧版服务器返回的协议版本须在已知列表里（2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05），未知版本直接报错。只做 stdio，HTTP 传输不在本客户端范围。
- `-32022 UnsupportedProtocolVersionError`：按服务器列出的 `supported` 重试现代版，没有共同版本时回退握手；迟到响应按已放弃的请求 id 丢弃，不冲掉握手的 id 匹配。
- `tools/list` 跟随 `nextCursor` 分页；`tools/call` 返回 `resultType: input_required`（多轮往返）时直接报错，Nyra 暂不支持交互式追问；`clientInfo` 版本改成跟包版本（0.3.0），不再写死 0.2.0。
- 新增 `tests/test_mcp_protocol_2026.py`（12 项）：现代/旧版/旧版低版本/空发现结果/`-32022` 回退/未知旧版拒绝/沉默探测超时回退/分页/多轮往返报错/`-32022` 重试；原有三个假服务器对未知方法改回 `-32601`（更贴近真实旧版服务器）。
- 测试 573 → 585 项，全部通过；未做的：HTTP（Streamable HTTP）传输、MRTR 交互式追问。

## 未发布（Linux 打包）

- 新增 `scripts/build_package.sh`：从当前检出产出 `dist/nyra-<版本>.tar.gz`（解压即用，顶层目录 `nyra-<版本>/`）与 `dist/nyra_<版本>_all.deb`（装到 `/usr/share/nyra`，启动器 `/usr/bin/nyra`，只声明 `Depends: python3 (>= 3.10)`）；版本号只从 `nyra/__init__.py` 读；只打包白名单文件（`nyra/*.py`、`scripts/install.sh`、systemd unit、README/GUIDE/CHANGELOG/LICENSE、`docs/linux-*.md`），`.git`/`.venv`/`__pycache__`/`dist/` 不进包；没有 `dpkg-deb` 时只产出 tarball 并警告；无 maintainer 脚本，不碰用户 systemd 与 `~/.nyra`。
- 新增 `docs/linux-packaging.md`：构建、核对（`tar -tzf` / `dpkg-deb --info`）、.deb 与 tarball 两种安装方式、卸载、安全说明；README 快速开始处加一行指向该文档。
- 新增 `tests/test_packaging.py`（11 项）：`bash -n`、--help、未知选项失败、tarball 命名与白名单内容、解压后 `python3 -m nyra --version` 跑出版本、`--no-deb` 只产 tarball、.deb 的 control 字段与内容、解包后 payload 可运行；执行类测试只在 POSIX + bash/tar 环境跑。
- 测试 562 → 573 项，全部通过；本机实测 tarball 与 .deb 均已产出并冒烟通过（`Nyra 0.3.0`）。
- 本轮只做打包；Linux 平台部署三项（systemd 服务、安装脚本、打包）至此全部落地（另两项提交仍在本地未推，见下）。

## 未发布（Linux 安装脚本）

- 新增 `scripts/install.sh`：Linux 一键安装，只写 `$HOME`、不需要 root；把 Nyra 装到 `~/.local/share/nyra`（`--prefix` 可改），在 `~/.local/bin/nyra` 放启动器（`PYTHONPATH` 指到安装位置，cwd 无关），建 `~/.nyra`（0700），装完跑 `nyra --version` 自检；`--source` 支持本地目录（直接复制，去掉 `.git`/`.venv`/`__pycache__`）与仓库 URL（`git clone --depth 1`）；重复跑就是升级，`~/.nyra` 数据不动；`--uninstall` 删安装目录、启动器与服务文件，但保留 `~/.nyra`。
- `--with-systemd`：把 `systemd/nyra-scheduler.service` 装到 `~/.config/systemd/user/`，按本次安装替换 `WorkingDirectory` 与 `ExecStart` 的 python 路径，再 `daemon-reload` + `enable --now`；没有用户 systemd 总线时只装文件并警告，不报错。
- 安装脚本拒绝危险输入：python3 < 3.10、来源不存在、`--prefix` 为 `/`、`$HOME` 或含空格时报错退出；不装任何 pip 依赖、不联网（除 `git clone` 一步）、不用 sudo。
- 新增 `docs/linux-install.md`：安装三种方式、选项表、升级、卸载、排错、安全说明；`docs/linux-systemd.md` 前置条件与 README 快速开始加指向安装脚本的说明；README 测试徽标 518 → 562。
- 新增 `tests/test_install_script.py`（13 项）：`bash -n` 语法检查、`--help`、临时 HOME 真实安装（启动器在无关 cwd 下跑出 `Nyra 0.3.0`、`~/.nyra` 0700、默认不装服务）、重复安装幂等、`--with-systemd` 的 unit 路径替换与 systemctl 调用记录、`--uninstall` 删安装留数据、桩 python3 3.9 拒绝、来源不存在与危险 `--prefix` 拒绝；执行类测试只在 POSIX + bash 环境跑（安装脚本本身是 Linux 专用的）。
- 测试 549 → 562 项，全部通过。
- 本轮只做安装脚本；打包（.deb / 归档分发）仍未做；网页界面（`nyra ui`）的服务未做。

## 未发布（systemd 用户服务：调度器 daemon）

- 新增 `systemd/nyra-scheduler.service`：systemd `--user` 单元，`Type=simple`，跑 `python3 -m nyra schedule daemon`；`WorkingDirectory=%h/nyra`（默认检出位置 `~/nyra`，可改）、`Restart=on-failure`，加固 `NoNewPrivileges=true`、`PrivateTmp=true`、`ProtectSystem=true`；不需要 root、不写系统目录、不含密钥（Key 按文档用 drop-in 的 `Environment=` 补）。
- 新增 `docs/linux-systemd.md`：安装、启动、`enable --now`、状态/日志查看、`loginctl enable-linger` 开机自启、改检查间隔、卸载、排错；README 快速开始处加一行指向该文档。
- 新增 `tests/test_systemd_unit.py`（9 项）：解析 unit 断言关键字段、ExecStart 可执行文件真实存在且指向调度器 daemon、临时 HOME 空 schedule 下 daemon 短超时冒烟（`--interval 0.1 --rounds 1`，无任务、无模型调用）、`systemd-analyze verify` 通过。
- 测试 540 → 549 项，全部通过；`systemd-analyze verify` 退出 0（本机无用户 systemd 总线，`systemd-analyze security` 跑不起来，改为人工复核：见上）。
- 本轮只做调度器服务；网页界面（`nyra ui`）的服务、安装脚本与打包未做；调度器仍是 naive 本地时间（见 VERIFICATION.md 已知限制）。

## 未发布（官网重做 + 安装面板）

- 官网 `docs/` 重做：新增常见问题、服务条款、隐私政策、可接受使用政策四个页面；首页加入可翻转的功能卡片、滚动显现、交互式审批示意和终端示意，遵守系统的减少动态效果设置，关闭 JavaScript 时内容仍完整可见。
- 新增安装面板：点击“安装”从右侧滑出，按 macOS / Linux / Windows（PowerShell）给出五步命令，每条命令可一键复制，带进度指示；无 JavaScript 时跳到首页的安装区块。
- 首页、FAQ 与安装面板支持 10 种语言；法律页提供中文与英文。
- 修复 Windows CI：进程组超时测试只在支持 `os.killpg` 的系统上运行。

## 未发布（worker 协议 + Python worker 入口，混合 Go 迁移第 1 批）

- 新增 `nyra/worker_protocol.py`：协议 v1（`PROTOCOL_VERSION = 1`），子进程 + stdio JSONL；请求 `run` / `approval_decision` / `stop` / `ping`，事件 `run_started` / `run_completed` / `run_incomplete` / `run_failed` / `tool_start` / `tool_result` / `assistant` / `final` / `usage` / `approval_request` / `approval_result` / `model_switch` / `turn_limit` / `pong` / `error`；`APPROVAL_TIMEOUT = 600.0`（与 webui 一致）；`new_id`、`encode_line`、`decode_line`、`ensure_request_id`、`validate_run_request`、`validate_approval_decision`。
- 新增 `nyra/worker.py`：`WorkerEmitter` 线程安全 stdout JSONL、`WorkerIO` 读线程 + 队列、reader 线程内直接回 `pong`、`Worker` 含 `approve_fn` / `on_agent_event` / `run_request` / `serve`、`build_agent` 用 `build_provider_chain` 传单元素链、永不兜底；`main()` 用 argparse；Agent 以 `interactive=True` 构造，审批才能到达 `approve_fn`。
- 新增 `tests/test_worker_protocol.py`（22 项，见 DESIGN.md 的 Worker 协议一节）；端到端冒烟：真实子进程 + 真实管道 + 本地桩 HTTP 模型，`run_completed` 输出 `smoke-ok`，usage total 13，零付费调用。
- 入口为模块形式 `python3 -m nyra.worker`（设计文档的空格形式 `python3 -m nyra worker` 须改 `nyra/__main__.py` 或 `nyra/cli.py`，第 1 批只新增文件、不改现有入口与冻结文件；行为一致，空格形式等冻结解除后补，协议不变）。
- 审批决定权永远在 Python 的 `tools.py`：worker 的 `approve_fn` 只传话；审批超时、无匹配的决定、协议异常、stdin 关闭一律按拒绝处理。worker 不进兜底链、不进定时任务。
- 测试 518 → 540 项，全部通过。

## 未发布（统一更名 Nyra + 官网新设计）

- 全面使用 Nyra 名称：包目录 `nyra/`，命令 `python3 -m nyra`（子命令 `nyra schedule` / `nyra ui` / `nyra permissions` / `nyra eigenflux`），交互提示符 `nyra[auto] ›`，网页界面与文档同步。
- 数据目录改为 `~/.nyra`；已有旧数据目录时继续沿用，不丢数据。项目级命令目录改为 `<工作目录>/.nyra/commands/`（旧目录仍可读取）。
- 环境变量改为 `NYRA_*`（`NYRA_API_KEY`、`NYRA_BASE_URL`、`NYRA_MODEL`、`NYRA_FALLBACK`、`NYRA_SANDBOX` 等），旧前缀仍作为兜底读取。
- README 重写为简明首页，完整说明移到 `GUIDE.md`。
- 官网 `docs/` 换成新设计：黑白极简、深色自适应、移动端适配，右上角 10 种语言切换；新标志为实心圆里刻出的光标（`docs/assets/nyra-mark.svg`）。开场动画只用于手机端，网页与官网不播放。
- 测试 518 项全部通过。

## 未发布（Codex CLI provider，不用 API Key）

- 新增 `codex` provider 预设（`config.py`）：`base_url` 为 `cli://codex` 标记（无 HTTP 端点）、`auth` 为 `"cli"`、`env_key` 为空、默认模型 `codex-default`。`resolve_provider` 在模型解析后加 CLI 分支：auth 为 CLI 时跳过 base_url 的 http/https 校验与明文检查，直接返回 `ProviderConfig(auth="cli", api_key=None)`；`resolve_fallback_chain` 加两条 CLI 排除（主 provider 是 CLI 时只返回 `[primary]`；链里出现 CLI 名字时跳过并记日志）。
- 新增 `CliProvider`（`providers.py`，`Provider` 子类）：用子进程跑本机 `codex` CLI（`codex exec` 非交互方式），复用它自己的登录态与 ChatGPT 订阅，不调模型 API。固定 argv：`codex exec --json -o <临时文件> -s read-only -C <空临时工作目录> --ephemeral --skip-git-repo-check -c features.browser_use=false -c features.computer_use=false -c features.plugins=false`（默认模型时不加 `-m`）；prompt 走 stdin（不在 argv 里，`ps` 看不到）；成功时优先读 `-o` 文件，文件为空时回退解析 `--json` 的 JSONL 事件流；用量能解析到就附进返回的 `"usage"`；超时由 Nyra 的 subprocess 侧强制并杀掉整个进程组（`codex exec` 没有 `--timeout` 参数）。
- 固定提示前缀（缓存命中）：`CODEX_PROMPT_PREFIX` 是字节级固定的英文前缀，拼在每次请求的最开头，再接按 `[role]` 标记序列化的消息；前缀内容是身份与边界声明（只作文字模型，不调工具、不跑命令、不浏览网页、不改文件，只回文字）。因为它在每个请求里一字不变、又始终在最前面，提供商侧的提示缓存能直接命中这段公共前缀。工具 schema 绝不传入。
- 默认模型 `codex-default` 的含义是不传 `-m`，让 CLI 用自己的默认模型。实测：ChatGPT 订阅登录时 `-m gpt-5` 与 `-m gpt-5-codex` 都会被服务端以 `model_not_found` 拒绝，唯有不传 `-m` 能跑通；显式 `--model` 会原样传 `-m`，被服务端拒绝时按配置错误分类（`_classify_codex_error` 新增 `model_not_found` / “model is not supported” → `"config"`），不兜底、不重试。
- 四个安全条件（代码强制 + 测试覆盖 + README 写明）：① CLI 只用固定路径调用（固定已知位置优先，`shutil.which` 只是最后兜底，绝不从配置、环境变量或用户输入取路径）；② 不读取、不复制、不记录登录凭证（登录检查只跑 `codex login status`，只读退出码与 “Logged in” 标记——实测该标记走 stderr；子进程环境删掉全部 `*_API_KEY` 变量）；③ 不用跳过审批的参数（`--dangerously-bypass-approvals-and-sandbox`、`--approve-for-me`、`--dangerously-bypass-hook-trust`、`-y`、`--full-auto` 均禁用，argv 建好后自检；始终 `-s read-only` + 空临时工作目录，用后删除）；④ 不进兜底链（只能被显式选中；`Provider` 的直接构造在 auth 为 CLI 时直接拒绝，全仓库唯一的直接构造点正是定时任务的 `_make_task_agent`，所以定时任务与队列里绝不用）。
- `build_provider_chain` 新增 `cli_provider_cls` 关键字参数（默认 `CliProvider`）：主 provider 是 CLI 时直接返回该类的实例，不进任何链；链内条目 auth 为 CLI 时跳过并记日志。`cli.py`、`groups.py`、`json_mode.py`、`webui.py` 的调用点均未改（默认值即够用），`--provider codex` 与 `POST /api/provider` 选中 codex 时走正常校验。
- 本机核查：`codex` 在 `/opt/hatch-image/bin/codex`（`codex-cli 0.164.0-alpha.9`），`codex login status` 为 `Logged in using ChatGPT`；版本低于 0.164.0、未登录或无法解析版本时直接拒绝。`claude` 本机未装，本轮不做，须先在用户电脑（Windows）上核查 `claude --version` 与登录情况再接。
- 新增 35 个测试（`tests/test_cli_providers.py`）：固定路径解析、版本与登录检查（含登录标记走 stderr）、固定前缀、chat 成功与 OpenAI 形状、argv 固定只读且无禁用参数、prompt 走 stdin、空临时工作目录、tools 被忽略、子进程环境不含 `*_API_KEY`、不打开凭据文件、JSONL 回退与用量、空输出与非零退出分类（含 `model_not_found` → config）、超时杀进程组、兜底排除（codex 作主时链只有自身、不当兜底目标、直接构造被拒、定时任务 `_make_task_agent` 用 codex 被拒）、预设解析。另更新 `tests/test_generic_providers.py`（CLI 预设豁免 http base_url 断言）与 `tests/test_webui.py`（`/api/info` 的 provider 数 13 → 14，自定义 provider 场景 14 → 15）；`nyra/group-ui.js` 的兜底 provider 列表补 codex；README、DESIGN.md、`docs/index.html`、`webui_page.py` 的 provider 预设数 13 → 14。测试总数 483 → 518，全部通过；本地冒烟检查通过（`--list-providers` 见 codex、真实短调用一次回 `smoke-ok` 且 usage 有记录、Web UI 页面 200 且 `/api/info` 的 provider_count 为 14）。

## 未发布（断点续跑）

- 新增 `--resume-run`，普通单次与 JSON 模式沿用原运行、会话、目录和权限模式；未知工具结果先落盘提示，不自动重试，审批重新确认，轮次与改动记录连续累计。

## 未发布（运行记录）

- 单次 CLI 与 JSON 模式保存私有运行日志：原子状态、精简事件、真实审批和中断状态、检查点文件列表；敏感文本脱敏，JSON 新增运行 ID 与最终状态事件。

## 未发布（会话原子写）

- 会话通过同目录临时文件、flush/fsync 与原子替换保存，失败保留旧会话并清理临时文件；新增会话目录和文件使用私有权限，并校验会话 ID 防止路径越界。
- 工具调用执行前及每个工具结果追加后立即保存会话，工具中断时保留完整调用与已有结果；新增原子写、中断、权限和非法 ID 回归测试。

## 未发布（兜底默认关闭 + 网页切换可见 + 网页端新建定时任务暂缓）

- **模型自动兜底改默认关闭**（用户 2026-11-17 安全事项第 1 条）：`config.py` 的 `DEFAULT_CONFIG["fallback_enabled"]` 与 `resolve_fallback_chain` 的默认值由 True 改 False；开启只由用户自己做——`~/.nyra/config.json` 里设 `"fallback_enabled": true`、环境变量 `NYRA_FALLBACK=1`，或 CLI 新增 `--fallback`（`--no-fallback` 保留作显式关闭；两者同时给时以关闭为准，`cli.py` 新增 `_fallback_enabled()` 统一优先级，`json_mode.py` 同样处理）。网页端设置里没有兜底开关控件（只有一行状态说明），不存在默认开启或静默开启的路径。
- **兜底链只认允许列表**：允许列表就是用户配置的 `fallback_providers`；`resolve_fallback_chain` 只在 key 缺失时才用内置默认链，显式写空列表表示不允许任何备用（不再静默补默认链）；未知名字跳过并写 stderr 日志；`build_provider_chain` 跳过未配置 Key 的备用（同样记日志），不静默补别的。`POST /api/provider` 的 `resolve_provider` 校验不变。
- **网页端切换可见**：`webui.py` 的 `UIState` 新增 `_on_switch` 回调——切换时除写服务端日志外，还向当前运行中的会话追加一条 `model_switch` 事件（from/to/error/kind/status，复用 `--json` 的事件结构）；前端 `applyEvent` 渲染一行“模型已切换：deepseek → xai（402 …）”并刷新模型卡。群聊同样：`groups.py` 的 `_bot_response` 记录本次调用的 `switches`，`send()` 附加到机器人回复条目上（`model_switches` 字段），`group-ui.js` 在回复下方渲染切换提示；无切换时不附加字段。
- **队列与定时任务不切换**（只读核查，未改 `scheduler.py`）：`cli.py` 的 `_make_task_agent` 仍直接构造单个 `Provider`，定时任务执行时用任务指定的 provider/model 原样跑、不包兜底链；`/api/schedule` 存下来的 provider/model 执行时同样不兜底。`runs.py` 在 main 上不存在，未新建。
- **网页端新建定时任务暂缓开放**（用户安全事项第 2 条，E 合并前）：定时任务视图的添加表单已彻底撤下（不是置灰），换成一行说明“网页端新建定时任务暂缓开放，等任务队列合并（E）后恢复；请用 `nyra schedule add` 命令添加”；后端 `POST /api/schedule` 的 action=add 返回 409 并写明原因（现在 main 上的任务默认用 full 模式，E 合并后会拒绝这种情况）。列表、开关、删除保持可用。
- 新增 11 个测试：`tests/test_fallback.py`（默认关闭、配置显式开启、空允许列表只留主模型、环境变量开启、链里无 Key 的备用被跳过、CLI `--fallback`/`--no-fallback` 优先级、定时任务 agent 用单个 provider）、`tests/test_json_mode.py`（`--fallback` 开启切换、默认关闭不切换）、`tests/test_webui.py`（默认关闭不切换、会话轮询里出现 `model_switch` 事件、add 返回 409 且其余操作可用、表单已撤下）、`tests/test_group_chat.py`（机器人回复条目带 `model_switches`）。测试总数 472 → 483，全部通过；本地 Web UI 冒烟检查通过（见下）。

## 未发布（调度器健壮性）

- `save_schedule` 改为原子写（同目录临时文件 + fsync + `os.replace`），崩溃或并发写入不再留下半截 JSON；失败时清理临时文件、旧文件保持不变。
- `load_schedule` 遇到损坏（非 JSON / 编码错误 / 顶层不是对象）时，先把原文件备份为 `schedule.json.corrupt-<时间戳>` 再报错，避免下次保存覆盖丢失。
- 新增 4 个测试（`tests/test_scheduler_robust.py`）。测试总数 468 → 472，unittest 与 smoke 均通过。

## 未发布（网页界面 UI v2 面板补完）

- 设置视图的 provider 下拉真正可用（此前是 `disabled` 占位）：新增 `POST /api/provider {provider, model?}`（`webui.py` 的 `UIState.set_provider`，用 `resolve_provider` 校验，未知 provider / 明文 http 外网地址直接报 400，不触发兜底），前端启用下拉 + 模型输入（datalist 用该 provider 的 `models`，允许自定义填）+“应用”按钮 + 状态提示。切换只改运行状态：重置缓存的 provider 链，新会话用新 provider，已有会话保持原 provider，不写配置文件，重启后恢复配置。设置副标题“只读视图”改为准确描述。
- `/api/info` 的 provider 列表每项增加 `models` 字段；新增 `fallback_chain` 字段（当前链的 provider 名，主模型排第一；单 provider 时为 `[name]`），模型卡加一行“兜底链：deepseek → xai → ollama”。Keys 表改用 `get_provider_presets`（失败回退内置），自定义 provider 不再被藏起来。
- 群聊“打开”直达具体群：主站群聊视图的链接带 `?room=<id>`，`group-ui.js` 启动时读 `room` 参数并选中该群（不存在回退第一个）。
- 定时任务行补上“上次运行：<时间>”与摘要（截断 80 字），API 早已返回 `last_run` / `last_status` / `last_summary`，此前行里只显示了 `last_status`。添加表单补 provider / model 两个可选字段（provider 下拉取 `/api/info`，不填则用当前 provider；POST 时只在填了才带），“执行时间”输入框按“每天 / 每隔一段时间”切换 placeholder（`08:30` / `分钟数，如 30`）。
- 顶栏模式下拉与模式分段切换失败时不再错位显示：`api` 失败后调 `loadInfo()` 回滚到实际值。
- 仍缺后端、如实留空（未编造数据）：守护进程运行状态（`scheduler.py` 无 pidfile/状态机制，且按分工归 GrokBot，面板上已写“执行仍需 daemon 在运行”）；费用看板（usage 只统计 token 数，无任何成本统计接口）。
- 新增 7 个测试（`tests/test_webui.py`）：`/api/provider` 切换与拒绝、切换后链重排（新主模型排第一）、`models` / `fallback_chain` / 自定义 provider 进 Keys 表、设置与定时任务表单控件存在且 provider 下拉未禁用、群聊 JS 读 `room` 参数、定时任务添加带 provider/model。测试总数 461 → 468，全部通过；本地 Web UI 冒烟检查通过（页面 200、六视图齐全、`/api/info` 13 预设 / 15 工具 / 兜底链如实、`/api/provider` 切换后 info() 显示新 provider 与重排后的链、`/api/schedule` 添加带 provider 正常、群聊页 200、内联与群聊 JS 均过 `node --check`、无外部资源、暗色 CSS 存在，未真实调用模型）。

## 未发布（网页界面 UI v2）

- 网页界面按原型「Nyra UI v2」重做：新配色（浅色底 `#F3F5F4`、鼠尾草绿主色 `#5F7D5C`、雾蓝强调 `#6B8CAE`、蜜桃珊瑚 `#E07856` 只小面积点缀，另补一套深炭底 `#1F2420` 暗色变体——原型没有暗色模式），旧墨 `#111A42` / 金 `#EAC45F` / 暖纸白 `#FAF8F4` 已退役；三栏布局（268px 左侧栏 / 自适应主聊天区 / 324px 右侧检查器，52px 顶栏），六视图（对话、技能与工具、定时任务、群聊、品牌与外观、设置）。
- 形象改为毛绒动物：默认奶油白毛绒小兔（`assets/nyra-plush-bunny.png`），备选蜜糖色毛绒小熊，品牌视图可切换（localStorage 记忆）；形象图缩小到 512px 后以 base64 内嵌进 `webui_page.py` 与 `group_ui.html`，保持“无外部资源”、新克隆也能显示，`assets/` 不进 git。旧二次元少女形象 `nyra-character.png` 不删、不覆盖，已在品牌视图标为弃用。顺带修了一个注入 bug：形象 data URI 原先未加引号注入 JS 的 `IMG` 表，导致整段内联脚本语法错误，页面 JS 全灭；现已加引号并用 `node --check` 验过。
- 新增三个视图（单页内切换）：技能与工具（3 个技能 + 15 个工具一览，标明是否需要审批）、定时任务（列表 + 开关 + 添加表单）、品牌与外观（11 色板、形象切换、字体示例、使用规则）；设置由只读对话框升级为完整视图（provider 预设列表、模式三段切换调真实 `/api/mode`）；群聊视图列出群聊并链接到独立的 `/groups` 页。
- `webui.py`：`/api/info` 扩展返回 13 个 provider 预设列表、15 个工具（每个含 `needs_approval`）、技能列表、`tool_count` 15 / `provider_count` 13；新增 `/api/schedule`（GET 列表；POST `add`/`toggle`/`remove`，只调 `scheduler.py` 的公开函数，不改 `scheduler.py`）；`FORBIDDEN_PAGE` 换新色板。`group-ui.js` 的 provider 下拉改为从 `/api/info` 取，失败时回退到完整的 13 个硬编码列表。
- `docs/index.html` 首页数字修正：14 个内置工具 → 15 个，6 个 provider 预设 → 13 个。
- 新增 5 个测试（`tests/test_webui.py` 的 `UIv2Tests`）：`/api/info` 的 provider/tools/skills 列表与审批标志、新色板与内嵌形象（旧色只许出现在品牌视图的“已退役”文案里，不许出现在 CSS 中）、`/api/schedule` 的增删开关、群聊页换肤与 provider 列表。测试总数 456 → 461，全部通过；本地 Web UI 冒烟检查通过（页面 200、`/api/info` 13 预设 / 15 工具、`/api/schedule` 200、群聊页 200 且无外部资源、内联与群聊 JS 均过 `node --check`，未真实调用模型）。

## 未发布（自定义 provider 明文 http 防护）

- 自定义 provider 的 `http://` 只允许本机地址（`localhost`、`127.0.0.1`、`::1`，比如本机 Ollama）；`http://` 配外网地址时直接拒绝，报错写清“API Key 会随请求明文传输，请改用 https://”。外网地址必须用 `https://`。
- 校验做两道：① `nyra/config.py` 的 `plaintext_http_error`，自定义 provider 解析（`custom_providers`）与环境变量方式（`NYRA_BASE_URL`）都在解析时校验，`resolve_provider` 同样校验（覆盖全部 13 个内置预设）；② `nyra/providers.py` 的 `Provider.chat()` / `list_models()` 发请求前再校验一次，防止绕过配置解析直接构造 provider 时仍把 Key 发往明文外网。两处报错文本一致；发请求前的拒绝是 `ProviderError(kind="config")`，不触发兜底切换、不静默降级。
- 内置 13 个预设自查全部合规：Ollama 的 `http://localhost:11434` 是本机、放行；其余 12 个均为 `https://`，无需改动。
- 不影响已有行为：https 自定义与本机 http 正常使用；`--no-fallback` 与兜底链逻辑不动。
- 新增 `tests/test_plaintext_http.py`（14 个）：http 外网在解析与发请求前均被拒（且发请求前拒绝时确认没有发出任何请求）、http localhost / 127.0.0.1 / ::1 / 大小写 / 末尾点号放行、https 外网放行、userinfo 障眼法（`http://127.0.0.1@evil.com`）不绕过、两处报错文本一致、配置错误不触发兜底切换、内置预设全部合规。测试总数 442 → 456，全部通过。

## 未发布（模型兜底接剩余入口）

- `--json` 单次模式接上模型兜底链：与命令行入口同一条链、同一套错误分类（402/429/5xx/超时/网络错误切换，401/403 与配置错误不切换），`--no-fallback` 可关。每次切换在 JSONL 流里发一个 `model_switch` 事件（from/to/error/kind/status）；`run_completed` / `run_incomplete` 增加 `provider` / `model` / `model_switches` 三个字段，如实写清实际答复的模型（`run_started` 仍是起跑的主模型）。失败时的 `run_failed` 错误结构不变。
- 网页界面（`webui.py` 的 `UIState.provider()`）与群聊（`groups.py` 的 `GroupStore._provider()`）接上同一条兜底链：只经过 providers.py / agent 核心，不碰调度器。切换提示写到服务端日志（stderr）；网页界面的信息面板显示实际答复的模型与 `model_switches` 记录。注入的 `provider_factory`（测试用）保持原样、不包链。
- 定时任务**未接兜底**：`cli.py` 的 `_make_task_agent` 仍用单个 provider——调度器（`scheduler.py`）正在 GrokBot 那边开发，按分工本轮不碰。
- 附带修正：`FallbackProvider.has_credentials()` 改为始终看主模型（providers[0]），缓存的链对象在切换前后汇报一致，不再随最后一次答复的模型变化。
- 新增 6 个测试：`tests/test_json_mode.py`（3 个：--json 下 402 切换并上报实际模型、401 不切换、`--no-fallback` 不切换）、`tests/test_webui.py`（默认 provider 走链且 info() 如实上报）、`tests/test_group_chat.py`（机器人默认 provider 走链）、`tests/test_fallback.py`（has_credentials 始终看主模型）。测试总数 436 → 442，全部通过。
- 真实端到端验证（一次 DeepSeek flash 短调用）：`--json --provider ollama`（本地未跑 Ollama）→ 连接拒绝 → `model_switch` 事件 → DeepSeek 返回“好”，`run_completed` 的 provider 为 deepseek。

## 未发布（通用模型接入）

- 新增 7 个内置 provider 预设（只写公开官方 endpoint 与默认模型，不写 Key）：Qwen（DashScope 兼容模式，`qwen-plus`）、Kimi（月之暗面中国区，`kimi-k3`）、GLM（智谱 BigModel，`glm-5.3`）、Gemini（Google OpenAI 兼容端点，`gemini-2.5-flash`）、Mistral（`mistral-small-latest`）、Groq（`llama-3.3-70b-versatile`）、Together（`meta-llama/Llama-3.3-70B-Instruct-Turbo`）；预设的 endpoint 与默认模型均经网页核实。内置预设共 13 个。
- 新增配置项 `custom_providers`：`~/.nyra/config.json` 里可自定义任意 OpenAI 兼容接口（`base_url` + `default_model` 必填，`env_key`/`models`/`allowed_hosts` 可选，未知字段忽略；同名覆盖内置预设；缺 `base_url`/`default_model` 或协议不是 http/https 时解析直接报错并点名）。自定义名字可进 fallback 链；`resolve_provider` 会校验 base_url 协议。
- `Provider` 需要 Key 但环境变量没设时不再静默走无认证请求：`resolve_provider` 保持 `auth="env"` 且 Key 为空，`has_credentials()` 为 False（CLI 会显示配置提示），`chat()`/`list_models()` 直接报“未设置 API Key”的配置错误。无 Key 需求的 provider（如本地 Ollama）不受影响。
- 新增 `Provider.list_models()`（`GET {base_url}/models`，OpenAI 形状，`FallbackProvider` 同样支持）：401/403 不兜底，402/429/5xx/超时/网络错误沿用上一轮的错误分类；无 `data` 列表或条目无字符串 `id` 时为解析错误。CLI 新增 `--list-providers`（列出全部 provider 与默认模型）与 `--list-models`（列出当前 provider 的实时模型 id）。
- `providers.py` 内部整理：认证头逻辑抽为 `_apply_auth`，HTTP 状态到错误种类的映射抽为 `_kind_for_status` / `_http_error`，`chat()` 的报错文本与行为不变。
- 新增 `tests/test_generic_providers.py`（29 个）：预设 endpoint/默认模型核实、自定义解析与容错、fallback 链含自定义名字、`list_models` 的 mock opener 映射、CLI 两个 flag。测试总数 407 → 436，全部通过。

## 未发布（模型自动兜底）

- 新增 `nyra/providers.py` 的 `FallbackProvider`：与 `Provider` 同样的 `chat()` 接口，按链逐个试模型；主模型遇可恢复失败（402 余额不足、429 限流、5xx、超时、网络错误）时自动切换到下一个并重试一次，每次切换记录到 `switches` 并经 `on_switch` 回调通知；认证失败（401/403）与配置问题（没设 Key、响应无法解析等）直接抛出，不兜底；全部模型都失败时报错列出每个模型的失败原因。每次调用都从主模型开始试。
- `ProviderError` 增加结构化分类：`status`（HTTP 状态码）与 `kind`（auth/quota/rate_limit/server/client/timeout/network/config/parse/redirect/unknown），`recoverable` 属性只对 quota/rate_limit/server/timeout/network 为真；原有只传一句话的调用方式不变，消息文本不变。
- 新增 `nyra/config.py` 的 `resolve_fallback_chain` 与配置项 `fallback_enabled`（默认 true）、`fallback_providers`（默认 `["deepseek", "xai", "ollama"]`）；开关优先级：`--no-fallback` > `NYRA_FALLBACK` 环境变量 > 配置 > 默认开启；链顺序：`NYRA_FALLBACK_PROVIDERS` 环境变量 > 配置 > 默认链，主模型始终排第一，未知名字跳过。
- CLI 接入命令行入口（交互 REPL、一次性任务、`--plan`）：`--no-fallback` 关闭单次兜底；切换提示打印到 stderr，一次性任务的 stdout 仍只有答案。`--json` 单次模式、网页界面、群聊和定时任务仍用单个 provider，后续再接。
- 新增 `tests/test_fallback.py`（31 个）：错误分类、402 切备用成功、401/403 不切换、429/超时/5xx/网络错误切换、全部失败报错明确、每次调用从主模型重新开始、链顺序与配置/环境变量读取、真实 `Provider.chat` 的 HTTP/超时/网络错误映射（mock opener）、Agent 循环经 FallbackProvider 拿到备用模型答复。测试总数 376 → 407，全部通过。
- 真实端到端验证（一次 DeepSeek flash 短调用）：`--provider ollama`（本地未跑 Ollama）→ 网络错误 → 切换提示打印到 stderr → DeepSeek 返回答案；`--no-fallback` 下同样场景直接报错退出，无切换。

## 未发布（/init 与自定义命令）

- 新增 `nyra/commands.py`：自定义斜杠命令以 Markdown 文件存放在项目级 `<工作目录>/.nyra/commands/` 或用户级 `~/.nyra/commands/`，文件名即命令名，同名时项目级优先；支持 `description` / `argument-hint` frontmatter，`$ARGUMENTS` 与 `$1`..`$9` 占位符，无占位符时参数追加到正文末尾。
- REPL 新增 `/commands`（列出可用自定义命令及来源）与 `/init`（生成 `AGENTS.md` 起始模板，已存在不覆盖；写入走 `write_file`，过审批、边界与检查点，readonly 下拒绝）；内置命令优先于同名自定义命令，符号链接命令文件会被跳过。
- 新增 `tests/test_commands.py`（19 个）：解析、加载优先级、占位符渲染、模板内容、`/init` 的读写路径与 readonly 拒绝。测试总数 356 → 376（含同步远程新增的 1 个 net scheme 测试），全部通过。
- 附带修正 README/DESIGN：工具数 14 → 15（补上漏记的 `apply_patch`），测试数 247 → 376。

## 未发布（网络请求协议限制）

- `net.open_url` 只允许 http/https，`web_fetch` 等不再能通过 `file://`、`ftp://` 读取本地文件；新增 tests/test_net_scheme.py。

## 未发布（EigenFlux 逐机器人网络权限上限）

- 新增 `nyra eigenflux policy show|allow|deny|audit`，为每个主/群聊 Agent 显式记录固定网络行为的本地意向；默认拒绝，allow 需要 `--confirm`，deny 即时本地撤销，带 SHA-256 并发检查与有界审计。
- 新建群聊获得随机稳定 `instance_id`，删除同名群后重新创建不会继承旧群的 EigenFlux Home/网络行为许可；老群保持旧路径兼容。
- 策略不会安装、登录、广播或启用调度，所有 `effective_network_permission` 保持 false；后续网络执行层仍需遵守 EigenFlux 官方 onboarding 和用户授权。
- 新增身份隔离、撤销、并发冲突、损坏文件/符号链接、CLI 不创建模型/CLI 进程与群聊重建安全的回归测试。

## 未发布（EigenFlux bare-CLI 本地接入准备）

- 新增 `nyra eigenflux doctor [--room ID --bot ID] [--check]`。默认不执行命令、不安装，也不发起网络行动；只计算独立、稳定的 EigenFlux Home 和准备状态。
- 可选 `--check` 对 PATH 中已安装的 CLI 运行 `version` 与 `skills path --host terminal` 两条诊断，最小环境变量、固定参数与超时；绝不在检测期间执行 onboarding、广播、注册或创建定时任务。
- 主 Agent 与各群聊机器人共享 Nyra 项目代码，但拥有互相隔离的 EigenFlux 身份根目录。非法群 ID、非成员 bot、已有符号链接目录会拒绝。
- 新增纯模拟 CLI、凭据环境白名单、路径隔离与零副作用测试。该阶段不能宣称已加入 EigenFlux 网络。

## 未发布（Poppy OAuth issuer 双向元数据核验）

- 新增 `python -m nyra --inspect-poppy-identity SITE`：不需模型凭证，只读核验公司域名的 OAuth protected resource metadata 与发行方 OAuth server metadata 双向绑定，拒绝缺少精确 resource、错配发行方和不合规 metadata。
- `--poppy` 下新增只读 `poppy_identity_check`；发行方验证通过依旧报告 `remote_calls_allowed=false`、`session_ready=false` 和 `oauth_ready=false`，不启动登录、不发送凭证、不调用远端工具。
- 区分合法 404/无 issuer 与服务器错误和网络超时；元数据禁止重定向，继续保持固定公网 IP/TLS 校验及响应大小限制。
- 新增 RFC 8414 issuer path、多 issuer 选择、资源回指、缺少端点、非 HTTPS、授权未完成以及 CLI 机器输出回归测试。

## 未发布（Poppy 站点/身份/scope 授权意向账本）

- 新增默认拒绝的本地 Poppy 授权意向账本，按精确 HTTPS 主机、访客/本地账户别名与单个 scope 隔离，禁止通配授权。`nyra permissions list|check|grant|revoke|audit` 无需模型凭证或网络；用户明确 `grant --confirm` 才会持久化。撤销和有界审计历史随账本原子更新。
- `--poppy` 额外开放仅可读的 `poppy_permission_check`，模型不能变更权限账本。任何本地记录都不等于 OAuth token、Poppy Session 或执行许可；公司声明与实际用户同意严格分离。
- 对 `scope_hints` 的未知变更类型按 `irreversible` 风险处理，缺失个人信息提示保持未知，禁止无依据地显示成低风险。
- 新增 ACL 边界、账户隔离、版本冲突、符号链接、显式确认、模型工具不可提权以及 CLI 的回归测试。

## 未发布（Poppy 1.0 公共发现首阶段）

- 新增 `--discover-poppy SITE` 公共能力诊断：无模型 API Key 可读取并校验 HTTPS `/.well-known/poppy.json`，输出有限 JSON 元数据。新增 `--poppy` 显式启用 Agent 的只读 `poppy_discover` 工具，默认关闭。
- 发现层实施精确 well-known 重定向路径、最终主机和 `organization.domain` 绑定、1.0 版本及同主机备选版本校验、公开 DNS/禁止内网 SSRF 与证书 SNI 验证；不自动启动 MCP、登录或向站点发送令牌。
- 增加版本、重定向、SSL 地址绑定、公开 DNS、权限开关、CLI 无密钥诊断的模拟测试。Poppy Session、签名与 OAuth、远端 HTTP MCP、UCP 尚待完成。

## 未发布（长期记忆浏览与管理）

- Web UI 新增全局 / 群聊机器人长期记忆浏览器，可查看完整 Markdown、手动修改并保存、切换记忆主人。当前完整原文保存在独立 MEMORY.md，聊天压缩不会覆盖该文件。
- 新增 `GET /api/memory/scopes`、`GET /api/memory` 与 `POST /api/memory`，继续复用 token/Host 检查。群聊机器人只允许访问真实存在的成员，拒绝路径穿越与符号链接。
- 写入使用 SHA-256 文件版本校验与原子替换，同进程 `memory_append` 由锁保护；编辑器过期时返回 409，防止覆盖 Agent 新增记忆。
- 新增鉴权、群聊隔离、未保存内容冲突、容量限制与手动/自动压缩保持长期记忆不变的测试。未来继续补费用封顶、长任务恢复和自证、多 Agent 状态板。

## 未发布（apply_patch、/diff 与审批差异预览）

- 新增严格单文件 `apply_patch`，核验 unified diff 头与 hunk 行号、原始上下文，拒绝越界路径、过期文件、格式不正确及跨文件修改；复用本地检查点，支持 `/undo`。
- 本地 `write_file`、`edit_file`、`plan` 和 `apply_patch` 的审批中展示修改前后的差异；Web UI 以多行滚动文本显示；超大差异提示无法预览，E2B 的 Agent 不会看到仅限本地的 apply_patch 工具。
- REPL 新增 `/diff`，查看最近一次未撤销检查点对应的文件变更，外部文件更改显示冲突。
- 增加 CRLF、缺少末尾换行、拒绝不匹配补丁、审批期间竞态与跨平台 CLI 回归测试。

## 未发布（本地任务检查点与 /undo、/rewind）

- 为内置本地 `write_file`、`edit_file`、`plan` 增加任务级检查点：首次写入前保存原始文件字节，后续覆盖更新目标哈希，重启后仍可在相同会话/工作区撤销。
- 增加 REPL `/undo`、`/rewind N`；执行前核查所有目标文件当前哈希/路径，外部修改或符号链接变化时拒绝恢复，防止丢失人工或其他 Agent 编辑；撤销后记录会话通知。
- 限制每文件 2 MiB、每轮 20 文件、最多 20 个未撤销轮；超过范围会拒绝工具写入。远端 E2B、Shell、MCP、HTTP 及 memory/skill 不在撤销范围内。
- 新增持久化、覆盖/创建/二进制、跨轮、外部冲突、不同会话及 CLI 回归测试。


## 未发布（会话审批作用域收紧）

- 文件工具 `a` 授权由“全部同类型写入”收紧至“指定规范化文件路径 + 工具 + 工作区 + 后端”；不同文件重新申请。
- shell `a` 授权额外绑定规范化的 `cwd`、timeout 和执行后端，阻止等价路径的伪绕过与切换后端的缓存滥用；在审批前拒绝在工作区外启动 shell。
- Web UI 回调优先于已有缓存，避免跨前端旧授权绕过逐项审批；新增本机/远端的越界 cwd 和变更作用域测试。
- 仍不提供 shell 命令内部的 OS 级隔离；命令可自行改变路径和访问外部资源。


## 未发布（内置文件工作目录边界与会话审批）

- `write_file`、`edit_file`、`plan` 默认拒绝工作目录外的写入，拦截 ../、绝对路径、已有外部符号链接；E2B 写入路径增加词法边界检查。`full` 也不可绕过。
- `auto` 交互式终端增加 `a`（本次会话始终允许）：仅按单个内置文件工具名称或 shell 完全相同命令及 cwd 组合缓存。MCP、HTTP POST、记忆与技能继续逐次确认；新会话、清空会话和权限模式切换会清除缓存。
- 新增本机/E2B 边界、符号链接、会话独立批准、非交互与只读拒绝等测试。
- 这不提供 shell/MCP 沙箱；任意 shell 仍可能产生工作目录之外的副作用，远端 E2B 符号链接和竞态是现阶段限制。


## 未发布（只读计划与校验批准执行）

- 新增 `--plan`，只通过 `read_file` 和 `list_dir` 在工作目录内分析，生成 `plan.md`，不运行 shell/MCP/Agent；规划失败不覆盖原计划。
- 新增 `--execute-plan --approve-plan SHA256`，完整哈希匹配后才执行；默认 auto 工具级审批，禁止隐式升权至 full。
- 测试覆盖危险工具、路径越界、符号链接、计划篡改、失败保留原计划及 CLI 权限分离。


## 未发布（memory_append / save_skill 测试补齐）

- 新增测试 `tests/test_memory_skill_tools.py`（11 个）：`memory_append` 与 `save_skill` 首次有了直接的单元测试（此前只有群聊测试顺带调过一次 `memory_append`，`save_skill` 完全没有覆盖）。覆盖写入/多行折叠/空文本不写、readonly 与 auto 非交互拦截、技能文件可解析回读、非法技能名拒绝、覆盖重写；测试全程只写临时目录，不碰真实 `~/.nyra/MEMORY.md`。
- 附带修正 README：版本号标题仍写 0.2.0、测试数仍写 127，已同步为 0.3.0 / 175。测试总数 164 → 175，全部通过。

## 未发布（Token 用量与上下文状态）

- 新增模型 API 响应 usage 统计，分别累计输入、输出、总 Token 和未报告用量的调用；不使用字符数冒充精确用量。
- CLI 新增 `/status` 和可选 `--context-window`，单次任务结束后将用量报告写入 stderr，保持 stdout 为任务结果。
- Web UI 为每个会话展示模型调用、已报告的 Token、参考上下文余量，未知数据明确标记；配置支持可选的 `context_window_tokens`。
- 新增 usage、CLI、Web UI 回归测试；功能队列记录在 ROADMAP.md。


## 未发布（独立机器人群聊与委派配额）

- 新增 `nyra/groups.py` 多机器人群聊核心：每位机器人拥有自己的身份指令、模型选择、独立会话、记忆与工作目录；群消息可 @ 定向分配任务，多成员讨论有轮次上限和持久化记录。
- 网页界面使用独立的 `nyra/group-ui.html` 与 `nyra/group-ui.js`（HTML/CSS/JavaScript）实现群聊交互；在现有 Web UI 添加群聊入口与令牌保护的群聊 API。
- Agent `delegate` 增加共享子 Agent 数量预算、最大递归深度与子任务轮数检查，避免模型无限嵌套调用；子 Agent 继承所属机器人的独立角色与记忆。
- 对群聊创建、@mention、模型/会话隔离、长期记忆、访问鉴权、嵌套委派边界添加 mock 回归测试，无需真实模型密钥。
- 当前默认 readonly、串行讨论；尚未实现并行自主执行/群成员动态管理/完整操作系统沙箱。


## 未发布（MCP 启动权限与 Web UI 生命周期）

- MCP 服务器进程启动遵循审批模式：readonly 和无人值守 auto 不启动；终端交互 auto 逐项请求同意；full 可直接启动。
- 终端 `/mode` 和 Web UI 模式切换同时管理 MCP 子进程生命周期，防止权限降级后服务继续运行；Web UI 拒绝在任务进行中切换模式。
- 新增模拟真实 MCP stdio 子进程及 Windows CP1252 控制台的启动回归测试、Web UI 模式切换测试；仍需可信 CI 才能合并。


## 未发布（网页界面、终端打磨、项目官网）

- 新增本地网页界面 `python3 -m nyra ui`（`nyra/webui.py` + 内嵌单页 `nyra/webui_page.py`）：纯标准库 `http.server`，无 CDN。左栏会话列表（读现有会话存储，可新建/恢复），中栏对话 + 可折叠工具调用卡片（auto 模式下卡片内批准/拒绝），右栏 provider/模型、证据来源链接、plan 步骤；设置面板只显示 Key 是否已配置，从不回显值。
- 网页界面安全：默认只监听 `127.0.0.1`，绑定非本机地址时打印警告；每次启动随机生成访问 token（页面经 `?token=` 带入，API 必须用 `X-Nyra-Token` 请求头），本机监听时校验 `Host` 头，不回应跨域预检，页面带 CSP。
- `Agent` 新增可选 `on_event` 观察回调（工具开始/结果、助手消息），`ToolContext` 新增可选 `approve_fn`，让网页界面复用同一个审批门；不传时行为与之前完全一致，子 agent 继承同一审批回调。
- 终端 REPL 打磨：启动横幅、`nyra[模式] ›` 提示符、工具调用分组显示（`┌ 工具 参数` / `└ ✓/✗ 结果`）、`/help` 对齐排版；颜色尊重 `NO_COLOR`、`TERM=dumb` 与非 TTY；一次性任务输出不变。
- 新增项目官网 `docs/`（GitHub Pages，纯静态、中英双语、暗色模式、无外部资源），地址 https://js2005happy.github.io/nyra/ 。
- 新增测试 `tests/test_webui.py`（23 个，mock provider + 随机端口）、`tests/test_repl_ui.py`（12 个）、`tests/test_docs_site.py`（5 个）；`unittest discover` 共 127 个通过。

## 未发布（MCP 环境变量最小权限）

- MCP 子进程默认只继承启动所需的基础环境变量，不再复制宿主进程全部环境变量，避免自动暴露 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 等无关凭证。
- MCP 配置新增可选的 `inherit_env`（精确变量名列表），与现有 `env` 合并；`env` 显式值覆盖继承值。非法变量名和非列表配置被拒绝。
- 新增跨平台模拟及真实 Python MCP 子进程的环境隔离回归测试；MCP 可执行程序仍以本机用户身份运行，此改动不是进程沙箱。

## 未发布（本机请求绕过代理）

- 修复：设置了 `HTTP_PROXY` / `HTTPS_PROXY` 但没设 `NO_PROXY` 时，发往本机（`localhost`、`127.0.0.0/8`、`::1`）的请求也被转发到代理，导致本地 Ollama provider、`web_fetch` / `http_post` 访问本机服务失败（代理返回 404/502），两个 mock 测试也因此在代理环境里失败。
- 新增 `nyra/net.py`：本机地址的请求一律直连，其余地址照常遵守环境代理设置；provider 客户端、`web_fetch`、`web_search`、`http_post` 统一走它。
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

- 新增 E2B 沙盒执行后端（`nyra/e2b_backend.py`）：`--sandbox e2b` 让文件读写与 shell 命令在 E2B 沙盒里执行，不在本机上；`--sandbox-id` 可连回已有沙盒，不给则新建（默认 base 模板、1 小时超时）。沙盒模式下工作目录默认 `/home/user`。
- 执行后端是 tools.py 里的一道缝：`read_file` / `write_file` / `edit_file` / `list_dir` / `shell` / `plan` / `grep_search` / `git_status` 走后端，其余工具（联网、记忆、技能、delegate、http_post）仍在本地；审批三档与 shell 黑名单在两种后端下都生效；子 agent 继承同一后端。
- 核心仍是标准库 only：E2B 后端是可选依赖（`pip install e2b`），缺 SDK 时报明确安装提示；凭证优先用 `E2B_API_KEY`，否则走已保存的 Muse 连接器凭证替身，真实 key 不落盘、不进沙盒。
- 测试从 53 个增至 62 个，全部通过；真实 DeepSeek + 真实 E2B 沙盒端到端跑通（沙盒里写文件、读回、列目录，本地无任何写入）。

## 0.2.0（2026-11-16）

- 新增 MCP 客户端（`nyra/mcp.py`）：stdio JSON-RPC，加载配置里的服务器，工具以 `mcp_<服务器>_<工具>` 形式调用；默认关闭，需 `mcp_enabled: true` 显式启用。
- 新增内置调度器（`nyra/scheduler.py`）：`nyra schedule` 子命令（list/add/remove/run/daemon），任务存 `~/.nyra/schedule.json`，支持间隔或每天固定时间。
- 新增会话压缩（`nyra/compact.py`）：`--compact <会话 id>` 与 REPL `/compact`，模型摘要 + 保留最近消息，模型失败时本地回退。
- 新增证据链（`nyra/evidence.py`）：`web_fetch` / `web_search` 抓到的页面原文按会话存档，结论附来源链接。
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
