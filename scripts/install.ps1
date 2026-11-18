# Nyra Windows 一键安装脚本（不需要管理员权限）
# 用法：在 PowerShell 里运行：
#   irm https://raw.githubusercontent.com/js2005happy/nyra/main/scripts/install.ps1 | iex
# 或下载后双击 / 右键“使用 PowerShell 运行”。
# 作用：检查 Python 3.10+ 与 git，克隆仓库到 ~/nyra，在桌面建两个快捷方式
# （Nyra 终端 / Nyra 网页界面，带 Nyra 图标），不写注册表、不装服务。
param(
    [string]$InstallDir = "$env:USERPROFILE\nyra"
)

$ErrorActionPreference = "Stop"

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# 1. 检查 Python 3.10+（优先 python，退到 py 启动器）
$pythonExe = $null
$pythonPrefixArgs = @()
if (Test-Command python) {
    $pythonExe = (Get-Command python).Source
} elseif (Test-Command py) {
    $pythonExe = (Get-Command py).Source
    $pythonPrefixArgs = @("-3")
}
if (-not $pythonExe) {
    Write-Host "未找到 Python。请先安装 Python 3.10 或更高版本（安装时勾选 Add Python to PATH）：" -ForegroundColor Red
    Write-Host "https://www.python.org/downloads/windows/"
    exit 1
}
# 微软商店占位 python.exe 只会打开商店，跑不了代码；必须装真正的 Python
if ($pythonExe -like "*\WindowsApps\*") {
    Write-Host "找到的 python 是微软商店占位程序（$pythonExe），它打不开真正的 Python。" -ForegroundColor Red
    Write-Host "请从 python.org 安装 Python 3.10+，安装时勾选 Add Python to PATH："
    Write-Host "https://www.python.org/downloads/windows/"
    exit 1
}
$pyVersion = (& $pythonExe @pythonPrefixArgs --version) 2>&1
if ($pyVersion -match "Python (\d+)\.(\d+)") {
    if ([int]$Matches[1] -lt 3 -or ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -lt 10)) {
        Write-Host "Python 版本太低：$pyVersion，需要 3.10 或更高版本。" -ForegroundColor Red
        Write-Host "https://www.python.org/downloads/windows/"
        exit 1
    }
} else {
    Write-Host "无法确认 Python 版本（$pythonExe --version 输出：$pyVersion）。" -ForegroundColor Red
    exit 1
}
Write-Host "Python：$pyVersion"

# 2. 检查 git
if (-not (Test-Command git)) {
    Write-Host "未找到 git。请先安装 Git for Windows：" -ForegroundColor Red
    Write-Host "https://git-scm.com/download/win"
    exit 1
}

# 3. 克隆或更新仓库（注意：$ErrorActionPreference 管不到 git 这类原生命令的退出码，必须自己查 $LASTEXITCODE）
if (Test-Path "$InstallDir\.git") {
    Write-Host "目录已存在，更新代码..."
    git -C $InstallDir pull --ff-only
    if ($LASTEXITCODE -ne 0) {
        Write-Host "git pull 失败：如果本地改了文件，先处理冲突（或删掉 $InstallDir 重装）。" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "克隆 Nyra 到 $InstallDir ..."
    git clone https://github.com/js2005happy/nyra.git $InstallDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "git clone 失败：检查网络，或确认 $InstallDir 不存在且父目录可写。" -ForegroundColor Red
        exit 1
    }
}

# 4. 取图标（仓库里的 branding/nyra.ico；还没推上去时会下载失败，跳过即可）
$iconPath = "$InstallDir\branding\nyra.ico"
if (-not (Test-Path $iconPath)) {
    try {
        New-Item -ItemType Directory -Force -Path "$InstallDir\branding" | Out-Null
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/js2005happy/nyra/main/branding/nyra.ico" -OutFile $iconPath -UseBasicParsing
        Write-Host "图标已下载。"
    } catch {
        # 下载失败可能留下一个损坏的半截文件，下次跑会误以为图标已存在，先删掉
        Remove-Item $iconPath -ErrorAction SilentlyContinue
        Write-Host "图标还没在仓库里（branding/nyra.ico 未推送），快捷方式先用默认图标，图标推上去后重跑一次本脚本即可换上。"
        $iconPath = $null
    }
}

# 5. 建桌面快捷方式
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
function New-NyraShortcut($name, $arguments) {
    $lnk = $shell.CreateShortcut("$desktop\$name.lnk")
    $lnk.TargetPath = $pythonExe
    $lnk.Arguments = (($pythonPrefixArgs + $arguments) -join " ")
    $lnk.WorkingDirectory = $InstallDir
    if ($iconPath) { $lnk.IconLocation = $iconPath }
    $lnk.Save()
    Write-Host "已创建桌面快捷方式：$name"
}
New-NyraShortcut "Nyra 终端" "-m nyra"
New-NyraShortcut "Nyra 网页界面" "-m nyra ui"

Write-Host ""
Write-Host "装好了。下一步："
Write-Host "1. 设一个模型 Key（以 DeepSeek 为例，关掉窗口就失效；要长期有效请在系统环境变量里加）："
Write-Host '   $env:DEEPSEEK_API_KEY="<redacted>"'
Write-Host "2. 双击桌面上的 Nyra 终端 或 Nyra 网页界面 开始用。"
Write-Host "3. 验证安装：`"$pythonExe`" -m nyra --version"
