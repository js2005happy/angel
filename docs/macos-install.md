# 在 macOS 上安装 Nyra（一键脚本）

> 状态：Node 版与 Python 版脚本都是在 Linux 上写好、只做了语法与占位替换检查，
> **尚未在真 Mac 上跑通过**。在 Mac 上第一次跑时若有报错，请把报错贴
> 回来，脚本会跟着修。Linux 安装见
> [docs/linux-install.md](linux-install.md)，Windows 见
> [docs/windows-install.md](windows-install.md)。

## 方式一（推荐）：Node 单文件二进制

`scripts/install-node-macos.sh` 从 GitHub Releases 下载对应架构的二进制
（arm64 用 `nyra-macos-arm64`，Intel 用 `nyra-macos-x64`），**不需要 root，
不需要 Python，也不需要 Node/Bun**（运行时自带）。

```bash
bash scripts/install-node-macos.sh
bash scripts/install-node-macos.sh --version v0.3.0 --with-launchd
```

注意：二进制未签名、未公证，macOS Gatekeeper 首次运行会拦，需右键点
二进制选“打开”放行一次。`.dmg` / `.pkg` 安装包本机做不了，是待办
（见下），不要假装已提供。

> 第 1 阶段说明：二进制是预览版，只含安装、doctor、向导与本地示例任务；
> 模型任务在第 2 阶段移植，现阶段请用下面的 Python 方式。`--with-launchd`
> 在第 1 阶段只装 plist 文件、不 `launchctl load`（`schedule daemon` 要到
> 第 2–3 阶段才有，现在启动只会反复失败）；带 schedule 的版本发布后，再跑
> `launchctl load ~/Library/LaunchAgents/ai.nyra.scheduler.plist`。

## 方式二：Python 版（功能完整）

`scripts/install-macos.sh` 把 Nyra 装到你的 home 目录里，**不需要 root**，
也不往系统目录写东西。装完直接在终端跑 `nyra` 就行。

### .dmg / .pkg（待办，未做）

- 现状：只有上面的二进制直装脚本，没有 `.dmg`（拖放安装）与 `.pkg`
  （安装器包）。本机是 Linux，做不出 macOS 安装包，也没法验证。
- 待办：找一台 Mac（或 macOS CI）用 `create-dmg` / `pkgbuild` 做包，
  并在真机上跑一次完整安装；做出来之前不要在文档里写“已提供”。

## 它会做什么

- 把 Nyra 复制到 `~/.local/share/nyra`（`--prefix` 可改）；
- 在 `~/.local/bin/nyra` 放一个启动器（其实就是 `python3 -m nyra`）；
- 建 `~/.nyra`（权限 0700，配置与数据目录）；
- 装完跑 `nyra --version` 自检，通不过就报错；
- 加 `--with-launchd` 时，再把调度器装成 launchd 用户 agent 并启动
  （开机自启，崩了自动重启；见下文“调度器”一节）。

重复跑就是升级：旧安装整个被替换，`~/.nyra` 里的数据不动。

## 前置条件

- macOS（本脚本会在非 macOS 系统上直接拒绝，不装一半）；
- Python 3.10 或更高版本（`python3 --version` 看一下）。注意：macOS
  系统自带的 python3 是 3.9，版本不够，须用 Homebrew 装一个：

  ```bash
  brew install python
  ```

  装好后 `python3 --version` 应为 3.10 或更高；
- 从 GitHub 装时需要 `git`（macOS 上跑 `xcode-select --install` 装
  命令行工具就有）；从本地目录装时不需要；
- 可选：`launchctl`（只要 `--with-launchd` 时用到；macOS 自带）。

Nyra 是零 pip 依赖，脚本不联网装任何东西（除了 `git clone` 那一步）。

## 安装

```bash
# 方式一：还没 clone 仓库，让脚本自己从 GitHub 拉
bash scripts/install-macos.sh

# 方式二：已经 clone 好了，从当前检出安装（不用再下一遍）
git clone https://github.com/js2005happy/nyra.git
cd nyra
bash scripts/install-macos.sh --source .

# 方式三：顺手把调度器装成 launchd 用户 agent，开机自启、崩了自动重启
bash scripts/install-macos.sh --source . --with-launchd
```

装完如果提示 `~/.local/bin 不在 PATH 里`，按提示加一行。macOS 默认
shell 是 zsh，永久生效这样加到 `~/.zshrc`：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

然后新开一个终端，跑 `nyra --version`，看到 `Nyra 0.3.0` 就装好了。
第一次用先配 Key（以 DeepSeek 为例）：

```bash
export DEEPSEEK_API_KEY=你的key
nyra "解释一下这个项目的结构"
```

## 选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `--source DIR\|URL` | GitHub 仓库地址 | 本地目录直接复制；URL 则 `git clone --depth 1` |
| `--prefix DIR` | `~/.local/share/nyra` | 安装位置（不能是 `/`、不能就是 `$HOME`、不能含空格） |
| `--bin-dir DIR` | `~/.local/bin` | 启动器位置 |
| `--with-launchd` | 关 | 再装 launchd 用户 agent 并 `launchctl load` |
| `--uninstall` | — | 卸载（见下） |
| `--help` | — | 显示帮助 |

## 升级

再跑一遍安装命令就行，例如：

```bash
bash scripts/install-macos.sh --source .
```

## 卸载

```bash
bash scripts/install-macos.sh --uninstall
```

这会停掉并删掉 launchd agent、删掉安装目录与启动器。**`~/.nyra` 会保留**，
里面的会话、任务与配置都在；想连数据一起清掉，自己删 `~/.nyra`。

## 调度器（launchd 用户 agent）

`--with-launchd` 会把 `launchd/ai.nyra.scheduler.plist` 装到
`~/Library/LaunchAgents/ai.nyra.scheduler.plist`，并 `launchctl load`
启动它。它是 Linux 上 `systemd/nyra-scheduler.service` 的 macOS 等价物：

| systemd（Linux） | launchd（macOS） |
| --- | --- |
| `WantedBy=default.target`（登录时启动） | `RunAtLoad=true` |
| `Restart=on-failure`（崩了重启） | `KeepAlive` + `SuccessfulExit=false`（非 0 退出才重启） |
| `Environment=PYTHONUNBUFFERED=1` | `EnvironmentVariables` 里 `PYTHONUNBUFFERED=1` |
| `WorkingDirectory=%h/nyra` | `WorkingDirectory` = 安装目录 |

它只负责让 `python3 -m nyra schedule daemon` 一直跑着；daemon 自己
每 60 秒查一次日程，到点的任务才执行（见 `nyra schedule list` /
`nyra schedule add`）。日志在 `~/.nyra/logs/scheduler.out.log` 与
`scheduler.err.log`。

常用命令：

```bash
launchctl list ai.nyra.scheduler   # 看 agent 是否在跑（有输出就是在跑）
launchctl start ai.nyra.scheduler  # 手动启动一次
launchctl stop ai.nyra.scheduler   # 停掉（开机还会再起，除非 unload）
launchctl unload ~/Library/LaunchAgents/ai.nyra.scheduler.plist  # 停用开机自启
launchctl load ~/Library/LaunchAgents/ai.nyra.scheduler.plist    # 重新启用
tail -f ~/.nyra/logs/scheduler.err.log  # 看 daemon 的报错
```

注意：plist 模板里的 `__NYRA_PYTHON__` / `__NYRA_PREFIX__` /
`__NYRA_HOME__` 是占位符，安装脚本会按本次安装的实际路径替换；不要
手改已安装的 plist，重装会被覆盖。

## 排错

- `这个脚本只在 macOS 上运行`：你在 Linux/Windows 上跑了它；Linux 用
  `scripts/install.sh`，Windows 用 `scripts/install.ps1`。
- `python3 版本太低`：macOS 系统自带的 python3 是 3.9，不够；跑
  `brew install python` 再装，`python3 --version` 确认 >= 3.10。
- `找不到 python3`：系统没装 Python，或它叫 `python` 不叫 `python3`；
  同上用 Homebrew 装。
- `git clone 失败`：检查网络与仓库地址；已 clone 好仓库时改用
  `--source .`，不走网络。macOS 上没装过 git 时先跑
  `xcode-select --install`。
- `--with-launchd` 后提示“load 失败”：安装本身已成功，只是 agent
  没启动；按上文“调度器”一节手动跑 `launchctl load` 与 `list` 检查，
  或直接用 `nyra schedule daemon` 在终端里跑。
- 装完 `nyra: command not found`：`~/.local/bin` 不在 PATH 里，见上文
  “安装”一节的 PATH 说明；也可以用完整路径 `~/.local/bin/nyra`。
- `launchctl list` 没有输出：agent 没在跑；先 `launchctl load
  ~/Library/LaunchAgents/ai.nyra.scheduler.plist`，再 `list`；
  仍不行时看 `~/.nyra/logs/scheduler.err.log`。
- `launchctl load` 报 Dubious ownership 之类：plist 文件属主或权限不
  对；删掉重装一次（脚本会写成 644、属主是你自己），不要手动 chmod
  成 777。

## 安全说明

脚本只写 `$HOME` 里的四个地方（安装目录、启动器目录、`~/.nyra`，
`--with-launchd` 时再加 `~/Library/LaunchAgents/`）；不读、不存任何
API Key（Key 仍由你自己用环境变量给）。launchd agent 只跑调度器
daemon，不监听端口、不对外联网（daemon 跑任务时按任务本身的需要
联网，与 Linux 的 systemd 服务一致）。
