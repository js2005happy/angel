# Nyra Node 迁移第 1 阶段：安装与第一次使用（实测报告）

- 日期：2026-11-18
- 基线：远端 main `d2eb6d9`（本地工作树内容与之一致；`nyra/cli.py` 1285 行、GUIDE.md 650 行）
- 方案：[nyra-node-runtime-migration-plan-20261118.md](nyra-node-runtime-migration-plan-20261118.md) 第 4 节第 1 阶段
- 工作目录：`~/workspace/angel-node-phase1/`（基线完整复制；最终要推的文件都在这里）
- 状态：**已完成**（见下验收摘要；未完成项见第 6 节）

## 1. 做了什么

| # | 任务书事项 | 落地 |
|---|---|---|
| 1 | 单文件可执行 `nyra`（Bun `--compile`，5 目标） | `scripts/build-binaries.sh`；`dist/` 下 5 个产物（Linux x64/arm64、Windows x64、macOS arm64/x64），`file` 格式全部验证；二进制不进 git，走 GitHub Releases（`.github/workflows/node-binaries.yml`，v* 标签发 Release，prerelease） |
| 2 | `nyra doctor` 中文自检 | `src/doctor.ts`：运行时、配置目录（0700）、配置文件、模型配置与 Key、网络、磁盘空间、写权限、vault.json 权限（存在时）；每项中文说明，故障给中文修复步骤 |
| 3 | 首次启动向导（中文，三步到第一个任务） | `src/wizard.ts`：选模型来源 → 填 Key 或选本地 → 跑本地示例任务；示例任务不调模型（`src/exampleTask.ts`：读文件前 200 字 + SQLite 插 100 行查计数）；Key 绝不写进 config.json，只问要不要把 export 行追加进 shell rc（默认不追加） |
| 4 | 无 Key 模式原样保留 | `src/noKey.ts`：只打印中文设置说明、退出码 1、不发任何请求；并修了 Python 版的小毛病——提示按当前 provider 给环境变量名（qwen 给 `DASHSCOPE_API_KEY`，不是永远 `DEEPSEEK_API_KEY`） |
| 5 | 五端安装包改版 | 新增 Node 版脚本：`scripts/install-node.sh`（Linux）、`scripts/install-node.ps1`（Windows）、`scripts/install-node-macos.sh`（macOS）、`scripts/build-package-node.sh`（Linux tarball/.deb，Depends: libc6）；PWA 不变，只补了真机验证待办。Python 版脚本（`install.sh` / `install.ps1` / `install-macos.sh` / `build_package.sh`）**故意没动**：`tests/test_install_script.py` 与 `tests/test_packaging.py` 钉死了它们的行为（例如 deb 的 `Depends: python3 (>= 3.10)`），改了会弄红现有测试；文档已把 Node 版写成默认、Python 版写成“仍可用” |
| 6 | README/GUIDE 快速开始改成“下载、运行”两步 | README 与 GUIDE 均已改；旧方式（`python3 -m nyra`）保留在同一节，写明不强制切 |

骨架（方案 2.4 节）：`src/cli.ts`（入口：doctor、向导、`--help`/`--version`、无 Key 退出）、`src/config.ts`（读 `~/.nyra/config.json`，与 Python 版同格式；14 个 provider 预置一一对应）、`src/noKey.ts`、`src/doctor.ts`、`src/exampleTask.ts`、`src/wizard.ts`；`src/agent/`、`src/providers/`、`src/tools/`、`src/gateway/`、`src/mcp/`、`src/vault/`、`src/memory/`、`src/pairing/`、`src/skills/` 九个目录先放占位并注明第 2 阶段移植（`vault/` 另有只读元数据函数供 doctor 用，不解密）。

兼容性（方案第 5 节）：`~/.nyra/` 目录与文件名、文件格式全部不动；`NYRA_*` 环境变量同名同义，`ANGEL_*` 回退保留；`vault.json` 0600、目录 0700 的权限语义保留（doctor 检查这两项）；模型兜底默认关闭（`fallback_enabled: false`），第 1 阶段不做任何兜底切换。

## 2. Bun API 兼容性探针（保留条件，逐项实测）

探针在 `scripts/probes/`，总跑脚本 `scripts/run-probes.sh`。Bun 1.4.4 下 **6/6 通过**；其中 5 个在 Node 24 下复核也通过（websocket 探针的服务端用 `Bun.serve`，Node 下跳过，见探针内注释）。

| 探针 | 结果 | 说明 |
|---|---|---|
| MCP stdio（JSON-RPC initialize 往返） | PASS | 子进程 stdio 回显，protocolVersion 2026-07-28 |
| MCP HTTP（fetch POST tools/list） | PASS | 本地 HTTP 服务往返 |
| 子进程 spawn/exec（stdout/stderr 分离、超时 SIGKILL、退出码） | PASS | 退出码 3 正确返回 |
| WebSocket（全局 WebSocket 客户端 + Bun.serve 服务端） | PASS | 往返 `echo:ping-nyra`；**注意**：服务端用了 Bun 专属 `Bun.serve`，若改走 Node SEA 需换 `ws` 包或手写升级——探针结论里已写明 |
| 加密 crypto（PBKDF2 200k + AES-256-CTR） | PASS | PBKDF2 与 Python 向量逐字节一致（`d8583695…49773`，53ms）；AES-256-CTR 往返 OK。vault 字节级兼容的前提已验证 |
| SQLite（`node:sqlite` 在 Bun 下） | PASS | 100 行事务插入+计数 0.33ms；结论：两条路线可共用 `node:sqlite`，不用 `bun:sqlite` 分支 |

**不兼容项：无。** 6 项全部跑通，无需替代方案；唯一要记的是 WebSocket 服务端那一处 Bun 专属 API。

## 3. 验收（全部实测）

| 验收项 | 实测结果 |
|---|---|
| 干净环境 3 分钟到首个任务 | 隔离 `NYRA_HOME` + 全新目录：从调用二进制到示例任务成功 **32ms**（二进制已在本地；下载一步是文件获取，未计入）。冷启动 `--help` 5 次：18–22ms（对照第 0 阶段 Python 基线 0.180 秒、mini-agent Bun 144.8ms）。Windows/macOS 步骤已写清，标注“待真机/CI 验证” |
| doctor 三种故障 | 无 Key：✗ 模型配置 + `export DEEPSEEK_API_KEY=...` 指引，退出 1；配置目录 755：✗ + `chmod 700` 指引，修后复查 ✓；网络不通（custom provider 指到 127.0.0.1:9 未监听端口）：✗ `ECONNREFUSED` + 4 步指引，退出 1。对照（本机 HTTP 服务 + custom provider）：7 项全 ✓，退出 0。注：本沙箱直连 api.deepseek.com 会 TLS 握手失败（出口代理限制），真实外网检查用本地服务对照证明逻辑正确，见第 6 节 |
| 向导三步全程中文 | 无 Key 全默认：三步跑通，示例任务 `sqlite rows=100`，退出 0；选 ollama：配置写入 `~/.nyra/config.json`（provider ollama / model qwen2.5:7b），退出 0；填 Key 后拒绝写 rc：Key 未进 config.json（grep 0 处）；填 Key 后同意写 rc：export 行追加进隔离 HOME 的 `.bashrc`，config.json 仍不含 Key。修过一个真 bug：管道输入时 `rl.question()` 会丢后几行，改成 'line' 事件 + 队列（`createAsker`）后 4 行输入全部按序送达 |
| Bun API 探针 | 见第 2 节，6/6 |
| 无 Key 跑任务 | `--provider qwen`：打印中文设置说明（正确给 `DASHSCOPE_API_KEY`），退出码 1；strace 网络调用计数 0（`strace -f -e trace=network`，无 connect/sendto/socket 记录——注：strace 本身在本机返回 exit=1，见第 6 节说明） |
| 旧安装方式回归 | `python3 -m nyra --help` 仍可用，退出 0；Python 全量 1111 项全过（skipped=11，84.2 秒，见第 4 节） |
| Linux 二进制冷启动 | `--help` 18–22ms；产物 109,156,528 字节（105M，与第 0 阶段一致） |

## 4. 回归：Python 全量与 Node 测试

- Python 全量（d2eb6d9 内容，`python3 -m unittest discover -s tests -t .`）：**1111 项全过，skipped=11，84–86 秒**。中间出过一次真事故：最终回归曾 FAILED（failures=4，全在 `tests/test_install_script.py`），原因是 5 个二进制共 497MB 把 /tmp（512M tmpfs）塞满了——安装测试会把整个仓库树复制到 /tmp，`cp` 报 No space left on device。根因是构建产物，不是我改的代码；处理：删掉 `dist/`，只重编 linux-x64 一个（105M）留作抽查，其余 4 个由 CI 重编；重跑后 Python 1111 项全过、Node 23 项全过、探针 6/6。教训：构建产物不要长期堆在工作树里，`dist/` 已进 `.gitignore`，但测试复制整树时仍会被带上。
- Node 测试（`bun test tests/node`）：**23 项全过**（config 9、doctor 5、example-task 1、wizard 4、cli 4 黑盒）。
- 探针：`bash scripts/run-probes.sh` → 通过 6，失败 0。

## 5. 产物清单（5 个二进制，格式已验）

5 个产物在验收时全部编出并用 `file` 验证过格式（见下表）；验证后为防
`dist/` 塞满 /tmp（见第 4 节的事故），已删掉其余 4 个，工作树里现只留
linux-x64 一个供抽查——其余 4 个由 CI（`node-binaries` 工作流）重编，
不是丢了。

| 文件 | 格式 | 大小 |
|---|---|---|
| `dist/nyra-linux-x64` | ELF 64-bit x86-64 | 109,156,528（105M） |
| `dist/nyra-linux-arm64` | ELF 64-bit aarch64 | 109,235,192 |
| `dist/nyra-windows-x64.exe` | PE32+ x86-64 | 115,308,032（110M） |
| `dist/nyra-macos-arm64` | Mach-O arm64 | 89,192,930（86M） |
| `dist/nyra-macos-x64` | Mach-O x86_64 | 98,201,056（94M） |

Linux tarball（`build-package-node.sh` 实测）：`nyra-node-0.3.0.tar.gz` 50M；deb `nyra-node_0.3.0_amd64.deb` 40M，`Depends: libc6`，`/usr/bin/nyra → /usr/share/nyra/nyra`。修过一个真 bug：`mktemp -d` 的 0700 导致 dpkg-deb 报 control 目录权限错，改成 0755 后通过。

## 6. 未完成 / 待验证项（不要编结果）

1. **Windows/macOS 真机运行**：产物只验证了格式 + CI 冒烟设计（workflow 里有 windows-latest / macos-latest smoke job，跑 `--version` / `--example`）；没在真 Windows/Mac 电脑上跑过；SmartScreen / Gatekeeper 的实际表现、`.dmg`/`.pkg` 均待办。
2. **PWA 真机验证**：PWA 本阶段未改动，真机安装全流程仍待验证（`docs/mobile-pwa.md` 已写明）。
3. **GitHub Release 发布**：workflow 与脚本已备好，但**需要打 v* 标签才能发 Release**，tag 推送由总协调经浏览器处理（本阶段不推任何东西）。
4. **doctor 真实外网检查**：本沙箱直连 api.deepseek.com 失败（TLS 握手失败，出口代理限制，非代码问题）；逻辑正确性由本地 HTTP 服务对照证明，全绿路径待有直连网络的环境重跑。
5. **strace 说明**：`strace -f -e trace=network` 本身在本机返回 exit=1（疑似沙箱 seccomp 限制），但它仍输出了日志文件，日志里网络调用计数为 0——结论以日志为准，不是 exit 码。
6. **CI 状态（d2eb6d9）**：Ubuntu 3.10/3.12 成功，Windows 3.12 失败（python-ci 与 Build nyra.exe 两个 job），deploy 与 report-build-status 成功。本地全量 1111 项全过，失败是 Windows 特有的；job 日志须管理员权限（403 拿不到），annotations 只有“exit code 1”，确切失败用例未定位（见下节）。

## 7. CI 红的定位经过（d2eb6d9，Windows）

- 确认时间：2026-11-18 22:28–22:40 CST；`commits/d2eb6d9/check-runs`：8 项，Ubuntu 成功、Windows 失败（`Build nyra.exe` 与 `windows-latest / Python 3.12`）。
- 本地全量 1111 项全过（Linux），故失败是 Windows 特有的。
- 排查：job 日志接口返回 403（须管理员权限）；annotations 只有“Process completed with exit code 1”，无用例名。逐项审计了 POSIX 权限断言（`test_runs.py`、`test_session_atomic.py`、`test_tasks.py`、`test_verify.py`、`test_vault.py`、`test_conversations.py`、`test_generic_providers.py`、`test_eigenflux_policy.py`、`test_poppy_permissions.py`、`test_trust.py`、`test_memory_browser.py`）——**全部已有 Windows 守卫**（`skipIf(win32)` 或 `if os.name != "nt"`），不是这批。`test_windows_compat.py` 与 `test_computer.py` 的 Windows 后端（mock）也无明显问题。
- 另查：python-ci 当天所有运行均为 failure（包括本地全绿的 d7641612 基线），ebf41f7 时三个 job 全失败（与 d2eb6d9 丢失的 TUI 接线一致），d2eb6d9 时 Ubuntu 已恢复、Windows 仍红。
- **结论：确切失败用例未定位，未擅自“修”任何东西。** 需要总协调在有权限的环境拉一次 Windows job 日志，或等下一轮 CI 看是否复现。不要把本阶段文件与一次没定位的修混在同一个提交里。

## 8. 已知限制（第 1 阶段预览版的诚实边界）

- 有 Key 跑模型任务时明确告知“第 2 阶段移植”、退出码 2，并指到 `python3 -m nyra`；不假装执行。
- 连接器注入的 Key（deepseek/xai 在 Python 版走连接器）Node 版第 1 阶段尚未接：doctor 会如实说“尚未接连接器，请先用环境变量”。
- 密码箱 `vault.json` 第 1 阶段只判存在与权限，不解密（解密在第 2 阶段，PBKDF2 向量已验证一致）。
- `nyra ui` / schedule / REPL 在第 2–3 阶段；`--list-models` 列的是内置已知模型，未联网查询实时列表。
