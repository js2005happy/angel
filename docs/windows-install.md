# 在 Windows 上安装 Nyra

三种装法：**Node 二进制 exe 单文件**（不用装 Python，推荐，第 1 阶段起默认）、
**Python 版 exe 单文件**（不用装 Python，功能完整）或
**`scripts/install.ps1` 一键脚本**（从源码装，需要 Python 与 git）。
手动一步步装见官网安装面板（Windows · PowerShell 一栏），和下面几种
装法不冲突。

> **先说实话（2026-11-18）**：Node 二进制 exe 是 `node-binaries` 工作流在
> `ubuntu-latest` 上用 Bun 交叉编译出来的，格式已验（PE32+ x86-64），
> 并在 `windows-latest` CI 上跑过 `--version` / `--example` 冒烟；
> 但还没在任何一台真 Windows 电脑上跑过。exe 未签名，SmartScreen 首次
> 运行会弹警告，点“更多信息”→“仍要运行”。Python 版 exe 同样没在真
> Windows 上跑过（见下）。第一台真机就是你的电脑：如果装不上，把报错
> 原文贴到仓库 issue 里。

## 方式一：Node 二进制 exe 单文件（不用装 Python，推荐）

1. 去仓库 [Releases](https://github.com/js2005happy/nyra/releases) 下最新版，
   下载 `nyra-windows-x64.exe`（打了 `v*` 标签时才有；没打标签时去
   Actions → Node binaries → 最近一次运行下载 `nyra-binaries` 附件）。
   或一键安装：

   ```powershell
   irm https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install-node.ps1 | iex
   ```

2. 把 `nyra.exe` 放到一个固定文件夹（比如 `C:\Tools\nyra\`），把这个
   文件夹加进 PATH（设置 → 系统 → 关于 → 高级系统设置 → 环境变量，
   在 Path 里加一行），或每次用完整路径跑它。
3. 配一个模型 Key（以 DeepSeek 为例；只对当前 PowerShell 窗口有效，
   想长期有效请在系统环境变量里加）：

   ```powershell
   $env:DEEPSEEK_API_KEY="sk-..."
   ```

4. 验证：`nyra.exe --version` 应打印 `nyra 0.3.0 (node runtime, phase 1 preview)`，
   再跑 `nyra.exe setup` 走首次启动向导。

Node exe 是 Bun `--compile` 打的单文件控制台程序，自带运行时，不用
管理员权限，不写注册表、不装服务。你的会话、记忆、配置仍存在
`%USERPROFILE%\.nyra`，和 Python 版共用同一位置，两种装法可以混用。

> 第 1 阶段说明：Node 二进制是预览版，只含安装、doctor、向导与本地示例任务；
> 模型任务在第 2 阶段移植，现阶段请用下面的 Python 版 exe，二进制会明确
> 告诉你、不会假装跑成功。

## 方式二：Python 版 exe 单文件（不用装 Python，功能完整）

1. 去仓库 **Actions → Build Windows exe → 最近一次 main 的运行**，
   下载 `nyra-<版本>-windows-x86_64`（90 天内有效）；打了版本标签
   （`v*`）时，exe 会同时挂在那次
   [Release](https://github.com/js2005happy/nyra/releases) 下面。
2. 把 `nyra.exe` 放到一个固定文件夹（比如 `C:\Tools\nyra\`），把这个
   文件夹加进 PATH（设置 → 系统 → 关于 → 高级系统设置 → 环境变量，
   在 Path 里加一行），或每次用完整路径跑它。
3. 配一个模型 Key（以 DeepSeek 为例；只对当前 PowerShell 窗口有效，
   想长期有效请在系统环境变量里加）：
   ```powershell
   $env:DEEPSEEK_API_KEY="<redacted>"
   ```
4. 验证：`nyra.exe --version` 应打印 `Nyra 0.3.0`。

exe 是 PyInstaller 打的单文件控制台程序，自带 Python 解释器，不用
管理员权限，不写注册表、不装服务。它把运行要读的文件（群聊页面、
自带技能、PWA 图标）都打进了包里；你的会话、记忆、配置仍存在
`%USERPROFILE%\.nyra`，和源码安装共用同一位置，两种装法可以混用。

## 方式三：一键脚本（从源码装，需要 Python 与 git）

```powershell
irm https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install.ps1 | iex
```

或把 `scripts/install.ps1` 下载下来，右键“使用 PowerShell 运行”
（如果提示执行策略，先跑一次
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`）。

脚本会做这些事：

- 检查 Python 3.10+ 与 git（没有就告诉你去哪装，不替你装）；
- 克隆仓库到 `~\nyra`（已存在就 `git pull --ff-only` 更新；
  拉取失败会直接报错停下，不会继续往下装半截的）；
- 在桌面建两个快捷方式：**Nyra 终端**（`python -m nyra`）与
  **Nyra 网页界面**（`python -m nyra ui`），带 Nyra 图标；
- 不写注册表、不装服务、不需要管理员权限。

装完先配 Key（同方式一第 3 步），再双击桌面快捷方式开始用；
验证：`python -m nyra --version` 应打印 `Nyra 0.3.0`。

## 前置条件（只针对方式二）

- **Python 3.10 或更高版本**，从 [python.org](https://www.python.org/downloads/windows/)
  安装，安装时勾选 **Add Python to PATH**。**不要用微软商店里的
  Python**：那只是个占位程序，运行时会打开商店而不是跑代码——
  脚本检测到占位程序会直接报错停下。
- 只有 `py` 启动器、没有 `python` 命令时脚本也能用（快捷方式里
  会写成 `py -3 -m nyra`）。
- [Git for Windows](https://git-scm.com/download/win)。

Nyra 是零 pip 依赖，脚本不联网装任何东西（除了 `git clone` 那一步）。

## 常见问题

- **快捷方式是默认图标，没有 Nyra 图标**：正常。图标文件
  `branding/nyra.ico` 还没推送到仓库（2026-11-18），脚本会先跳过
  图标、只建快捷方式；图标推上去后重跑一次脚本即可换上。
- **`python` 找到了但是版本不对**：脚本会报版本太低并停下；去
  python.org 装 3.10+，安装时勾选 Add Python to PATH。
- **`git pull` / `git clone` 失败**：脚本会直接停下并告诉你原因；
  本地改了文件导致 pull 冲突时，先处理冲突，或删掉 `~\nyra` 重装。
- **PowerShell 提示“无法加载文件，因为在此系统上禁止运行脚本”**：
  这是执行策略，跑
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 后重试；
  `irm | iex` 的方式不受执行策略影响。
- **exe 双击后窗口一闪而过**：exe 是控制台程序，请在 PowerShell 或
  终端里跑 `nyra.exe`，不要双击。
- **远程脚本安全吗**：`irm | iex` 会直接执行网上拉下来的代码，只
  从官方仓库地址
  `raw.githubusercontent.com/js2005happy/nyra/main/scripts/install.ps1`
  拉；不放心就先下载下来读一遍再跑，脚本不到 150 行。
