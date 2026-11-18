# Nyra 桌面端（macOS / Windows）

Nyra 桌面端是一个原生窗口：用系统自带的 WebView（macOS 的 WKWebView、Windows 的 WebView2）显示本机的 Nyra 网页界面，外壳用 [Tauri 2](https://tauri.app)（Rust）写，源码在 `desktop/`。安装包只有几 MB，不内置浏览器内核，也**不内置 Python**。

> 状态：预览版。安装包由 GitHub Actions 构建（工作流 “Build desktop app”，`.github/workflows/desktop.yml`），**没有代码签名**，也还没有正式发布到 Release。macOS 与 Windows 的安装包都没有在真机上手动装过，见文末“已知限制”。

## 它怎么工作

1. 打开 Nyra 后，外壳在本机找一个能运行 Nyra 的程序（顺序见下），在后台启动：
   `nyra ui --host 127.0.0.1 --port 0 --print-url-json --exit-on-stdin-close --workdir ~/Nyra`
2. Nyra 只监听 `127.0.0.1` 的随机端口，每次启动生成新的随机 token，把地址和 token 作为一行 JSON 打到标准输出；外壳读到后让窗口打开这个地址。
3. 关闭窗口 / 退出 App 时，外壳关闭子进程的标准输入，Nyra 自行退出；3 秒内没退就强制结束。
4. 找不到合适的 Python 或 Nyra 时，窗口显示引导页（怎么装 Python、怎么装 Nyra），并有“重新检测”按钮，不会崩溃。

查找顺序：

1. 环境变量 `NYRA_PYTHON` 指定的 Python（设了它就跳过第 2 步）；
2. `PATH` 上的 `nyra` 命令（安装脚本放的启动器，或 Windows 单文件 `nyra.exe`）；
3. Python 3.10+（Windows：`py -3`、`python`、`%LOCALAPPDATA%\Programs\Python\*`；macOS：`python3`、`python3.1x`，并补上 Homebrew、python.org 安装包、`~/.local/bin`、pyenv 的常见目录），能直接 `import nyra` 就用它；否则依次带上这些源码目录再试：`NYRA_SOURCE`、`~/.local/share/nyra`（macOS / Linux 安装脚本的位置）、`~/nyra`（Windows 安装脚本或在主目录 `git clone` 的位置）。

工作目录默认是 `~/Nyra`（没有就新建），可用环境变量 `NYRA_DESKTOP_WORKDIR` 改。

macOS 上从程序坞 / 访达打开的 App 拿不到终端里 `~/.zshrc` 设置的 `PATH` 与 API Key。外壳启动时会读一次登录 shell 的环境（`$SHELL -ilc env`，10 秒超时），补上缺的变量（不覆盖已有的），所以在 `~/.zshrc` 里 `export DEEPSEEK_API_KEY=...` 这类设置对桌面端同样有效。Windows 上用“系统属性 → 环境变量”设置的用户变量会直接生效。

## 安装

### 先决条件：本机 Python 与 Nyra

- **Python 3.10 或更高**。macOS 系统自带的 python3 是 3.9，不够，用 [python.org](https://www.python.org/downloads/macos/) 安装包或 `brew install python`；Windows 用 [python.org](https://www.python.org/downloads/windows/)（勾选 “Add python.exe to PATH”）或 `winget install Python.Python.3.12`。Windows 也可以不装 Python，直接把单文件 `nyra.exe` 放进 `PATH`（见 [windows-install.md](windows-install.md)）。
- **Nyra 本体**：macOS 见 [macos-install.md](macos-install.md)（`bash scripts/install-macos.sh --source .`），Windows 见 [windows-install.md](windows-install.md)（`irm …/install.ps1 | iex`）。已经 `git clone` 在别处的，设 `NYRA_SOURCE=<仓库目录>` 即可。
- 模型 Key 和命令行一样只从环境变量读（见 GUIDE“配置模型”）。

### 下载安装包

目前只有 GitHub Actions 的构建产物（需要登录 GitHub）：打开仓库的 **Actions → Build desktop app**，选一次成功的运行，在页面底部 **Artifacts** 下载：

| 产物 | 内容 |
| --- | --- |
| `Nyra-macos-universal` | `Nyra_<版本>_universal.dmg`（Apple 芯片与 Intel 通用） |
| `Nyra-windows-x64` | `Nyra_<版本>_x64_en-US.msi` 与 `Nyra_<版本>_x64-setup.exe`（NSIS，装到当前用户，不需要管理员） |

下载下来是 zip，先解压。

### macOS：打开未签名的 App

安装包**没有 Apple 开发者签名、没有公证**（只有 macOS 要求的 ad-hoc 签名，不代表任何开发者身份）。第一次打开会被 Gatekeeper 拦下：

1. 打开 `.dmg`，把 Nyra 拖进“应用程序”；
2. 在“应用程序”里**右键（或按住 Control 点按）Nyra → 打开**，在弹窗里再点“打开”；
3. macOS 15 及以后右键可能不再给“打开”按钮：先双击一次让它被拦，然后到 **系统设置 → 隐私与安全性**，在页面下方点“仍要打开”。

也可以在终端里去掉下载隔离标记（只对你信任的文件这样做）：

```bash
xattr -dr com.apple.quarantine /Applications/Nyra.app
```

### Windows：SmartScreen 提示

安装包**没有代码签名证书**，运行 `.msi` 或 `-setup.exe` 时 SmartScreen 会显示“Windows 已保护你的电脑”：点 **更多信息 → 仍要运行**。Windows 10/11 自带 WebView2；极少数精简系统缺少时，NSIS 安装程序会自动下载安装 WebView2 运行时。

## 安全

- 网页界面的 CSP、token 鉴权、`Host` 头校验都**原样保留**，桌面端没有放宽任何一项；地址只绑 `127.0.0.1`，端口随机，token 每次启动随机生成，只经由子进程的标准输出管道交给外壳。
- 窗口只允许显示内置引导页与这次启动的 `http://127.0.0.1:<端口>`；其他任何网址（包括别的本机端口）都不会在窗口里打开，`http(s)` / `mailto` 链接交给系统默认浏览器。
- 网页界面拿不到任何 Tauri 原生接口（`capabilities` 里没有放行远程地址）；只有内置引导页能调用一个“重新检测”命令。
- 桌面端不播入场动画（入场动画只在手机主屏幕 App 上播放）。

## 从源码构建

需要 Rust（stable）、Node.js 18+，以及各平台的 Tauri 依赖（见 Tauri 文档 “Prerequisites”）。

```bash
cd desktop
npm ci
npx tauri dev                                   # 开发运行
npx tauri build --bundles app,dmg               # macOS（本机架构）
npx tauri build --target universal-apple-darwin --bundles app,dmg   # macOS 通用包
npx tauri build --bundles msi,nsis              # Windows
cd src-tauri && cargo test                      # 外壳的单元测试
```

图标由 `docs/assets/nyra-mark.svg` 生成：`npm run icons`（生成后删掉不用的 android / ios / Square* 文件）。

## 已知限制 / 待办

- **未签名**：没有 Apple Developer ID 签名与公证、没有 Windows 代码签名证书，所以有上面的 Gatekeeper / SmartScreen 提示。
- **不内置 Python**：需要本机 Python 3.10+ 和 Nyra（或 Windows 的 `nyra.exe`）。
- **没有自动更新**：新版本需要重新下载安装。
- **没有在真机上手动验证**：只在 CI 上构建通过、在 Linux 上编译并跑过外壳单元测试；macOS / Windows 上的实际启动、Python 查找、退出清理还没在真机上点过。
- 没有菜单栏 / 托盘、没有多窗口；网页界面里 `target="_blank"` 的同源链接不会打开新窗口。
