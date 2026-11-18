#!/usr/bin/env bash
# Nyra macOS 安装脚本（只写 $HOME，不需要 root）。
#
# 做什么：
#   - 把 Nyra 装到 ~/.local/share/nyra（可用 --prefix 改位置）；
#   - 在 ~/.local/bin/nyra 放一个启动器（exec python3 -m nyra）；
#   - 建 ~/.nyra（0700，Nyra 的配置与数据目录）；
#   - 装完跑 `nyra --version` 自检；
#   - 加 --with-launchd 时，再把 launchd/ai.nyra.scheduler.plist 装到
#     ~/Library/LaunchAgents/ 并 launchctl load（见 docs/macos-install.md）。
#
# 用法：
#   ./scripts/install-macos.sh [--source DIR|URL] [--prefix DIR] [--bin-dir DIR]
#                        [--with-launchd] [--uninstall] [--help]
#   默认 --source 是 GitHub 仓库（git clone --depth 1）；已 clone 好仓库时
#   用 --source . 从当前检出安装。重复跑就是升级：旧安装会被整个替换，
#   ~/.nyra 里的数据不动。
#
# 要求：macOS；python3 >= 3.10（系统自带的是 3.9，须 brew install python）。
# 从 URL 安装时还要 git；不联网装依赖（除 git clone 外），不写 $HOME 以外。

set -euo pipefail

REPO_URL="https://github.com/js2005happy/nyra.git"
REQUIRED_MAJOR=3
REQUIRED_MINOR=10
LABEL="ai.nyra.scheduler"
PLIST_NAME="ai.nyra.scheduler.plist"

PREFIX="${HOME}/.local/share/nyra"
BIN_DIR="${HOME}/.local/bin"
SOURCE="$REPO_URL"
WITH_LAUNCHD=0
UNINSTALL=0

log()  { printf '%s\n' "nyra-install: $*"; }
die()  { printf '%s\n' "nyra-install: 错误：$*" >&2; exit 1; }

usage() {
    sed -n '2,20p' "$0"
    cat <<'EOF'

选项：
  --source DIR|URL   安装来源：本地目录，或 git 仓库地址
                     （默认 https://github.com/js2005happy/nyra.git）
  --prefix DIR       安装位置（默认 ~/.local/share/nyra）
  --bin-dir DIR      启动器位置（默认 ~/.local/bin）
  --with-launchd     再装 launchd 用户 agent 并 launchctl load
                     （只在 macOS 上有效；开机自启，崩了自动重启）
  --uninstall        卸载：停掉并删掉 agent、安装目录与启动器；
                     ~/.nyra（你的数据）会保留
  --help             显示本帮助
EOF
}

# 把一段文字转成 sed 替换串可用的形式（转义 & | \）。
sed_escape() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }

# 本脚本只在 macOS 上跑：在别的系统上直接拒绝，别装一半。
check_darwin() {
    local os
    os="$(uname -s 2>/dev/null || echo "?")"
    [ "$os" = "Darwin" ] || die "这个脚本只在 macOS 上运行（当前系统：$os）。Linux 请用 scripts/install.sh，Windows 请用 scripts/install.ps1。"
}

# 拒绝危险的 --prefix：空、根目录、$HOME 本身、已存在的文件。
check_prefix() {
    local p="$1"
    [ -n "$p" ] || die "--prefix 不能为空"
    [ "$p" != "/" ] || die "--prefix 不能是 /"
    [ "$p" != "$HOME" ] || die "--prefix 不能就是 \$HOME（会删掉你的 home）"
    if [ -e "$p" ] && [ ! -d "$p" ]; then
        die "--prefix 已存在且不是目录：$p"
    fi
    case "$p" in
        *' '*) die "--prefix 不能含空格：$p（启动器与 plist 的路径替换不好写）" ;;
    esac
}

# python3 必须存在且 >= 3.10。版本只从 `python3 --version` 的输出判断，
# 便于测试用桩 python3 覆盖。注意：macOS 系统自带的 python3 是 3.9，
# 版本不够，须用 Homebrew 装一个（brew install python）。
check_python() {
    command -v python3 >/dev/null 2>&1 || die "找不到 python3：macOS 系统自带的 python3 是 3.9（版本不够），请先跑 brew install python 再装 Nyra"
    local ver major minor rest
    ver="$(python3 --version 2>&1)" || die "跑 python3 --version 失败"
    ver="${ver#Python }"
    major="${ver%%.*}"; rest="${ver#*.}"
    minor="${rest%%.*}"
    case "$major$minor" in
        *[!0-9]*) die "看不懂 python3 版本：$ver" ;;
    esac
    if [ "$major" -lt "$REQUIRED_MAJOR" ] \
        || { [ "$major" -eq "$REQUIRED_MAJOR" ] && [ "$minor" -lt "$REQUIRED_MINOR" ]; }; then
        die "python3 版本太低：$ver，需要 >= 3.10；macOS 系统自带的是 3.9，请跑 brew install python"
    fi
    PYTHON3="$(command -v python3)"
    log "python3：$ver（$PYTHON3）"
}

# 卸载：只删本脚本装的东西，~/.nyra 数据保留。
do_uninstall() {
    if command -v launchctl >/dev/null 2>&1; then
        launchctl remove "$LABEL" >/dev/null 2>&1 || true
        rm -f "${HOME}/Library/LaunchAgents/$PLIST_NAME"
    fi
    rm -rf "$PREFIX"
    rm -f "${BIN_DIR}/nyra"
    log "已卸载：$PREFIX 与 ${BIN_DIR}/nyra 已删；~/.nyra 数据保留在原处"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --prefix)       [ $# -ge 2 ] || die "--prefix 需要一个值"; PREFIX="$2"; shift 2 ;;
        --prefix=*)     PREFIX="${1#--prefix=}"; shift ;;
        --bin-dir)      [ $# -ge 2 ] || die "--bin-dir 需要一个值"; BIN_DIR="$2"; shift 2 ;;
        --bin-dir=*)    BIN_DIR="${1#--bin-dir=}"; shift ;;
        --source)       [ $# -ge 2 ] || die "--source 需要一个值"; SOURCE="$2"; shift 2 ;;
        --source=*)     SOURCE="${1#--source=}"; shift ;;
        --with-launchd) WITH_LAUNCHD=1; shift ;;
        --uninstall)    UNINSTALL=1; shift ;;
        --help|-h)      usage; exit 0 ;;
        *)              die "未知参数：$1（看 --help）" ;;
    esac
done

check_darwin

if [ "$UNINSTALL" -eq 1 ]; then
    check_prefix "$PREFIX"
    do_uninstall
    exit 0
fi

check_prefix "$PREFIX"
check_python

# 先装到临时目录，全部成功后再整个挪过去；旧安装只在新树就绪后才删。
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
TREE="$WORK/tree"
mkdir -p "$TREE"

case "$SOURCE" in
    http://*|https://*|git@*|*.git)
        command -v git >/dev/null 2>&1 || die "从 URL 安装需要 git（macOS 上跑 xcode-select --install 装命令行工具就有）"
        log "从 $SOURCE clone……"
        git clone --depth 1 --quiet "$SOURCE" "$TREE" \
            || die "git clone 失败：$SOURCE"
        ;;
    *)
        [ -d "$SOURCE" ] || die "--source 不是目录也不是仓库地址：$SOURCE"
        log "从本地目录复制：$SOURCE"
        cp -a "$SOURCE/." "$TREE/"
        rm -rf "$TREE/.git" "$TREE/.venv"
        find "$TREE" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
        ;;
esac

[ -f "$TREE/nyra/cli.py" ] || die "来源里没有 nyra/cli.py，不像是 Nyra 仓库：$SOURCE"

rm -rf "$PREFIX"
mkdir -p "$(dirname "$PREFIX")"
mv "$TREE" "$PREFIX"
trap - EXIT
rm -rf "$WORK"
log "已装到 $PREFIX"

# 启动器：PYTHONPATH 指到安装位置，cwd 无关，在哪都能跑。
mkdir -p "$BIN_DIR"
LAUNCHER="${BIN_DIR}/nyra"
{
    printf '%s\n' '#!/bin/sh'
    printf '%s\n' '# Nyra 启动器，由 scripts/install-macos.sh 生成；不要手动改，重装会被覆盖。'
    printf 'PYTHONPATH="%s${PYTHONPATH:+:$PYTHONPATH}"\n' "$PREFIX"
    printf '%s\n' 'export PYTHONPATH'
    printf 'exec "%s" -m nyra "$@"\n' "$PYTHON3"
} > "$LAUNCHER"
chmod +x "$LAUNCHER"
log "启动器：$LAUNCHER"

mkdir -p "${HOME}/.nyra"
chmod 0700 "${HOME}/.nyra"

# 自检：启动器必须能跑出版本号。
VERSION_OUT="$("$LAUNCHER" --version 2>&1)" \
    || die "自检失败：$LAUNCHER --version 跑不起来"
case "$VERSION_OUT" in
    *Nyra*) log "自检通过：$VERSION_OUT" ;;
    *) die "自检失败：$LAUNCHER --version 输出看不懂：$VERSION_OUT" ;;
esac

# 可选：launchd 用户 agent。plist 模板里的占位路径按本次安装的实际
# 位置替换；launchctl 不可用或 load 失败时只装文件并警告，不报错。
if [ "$WITH_LAUNCHD" -eq 1 ]; then
    PLIST_SRC="$PREFIX/launchd/$PLIST_NAME"
    PLIST_DIR="${HOME}/Library/LaunchAgents"
    [ -f "$PLIST_SRC" ] || die "安装树里没有 launchd/$PLIST_NAME"
    mkdir -p "$PLIST_DIR"
    mkdir -p "${HOME}/.nyra/logs"
    chmod 0700 "${HOME}/.nyra/logs"
    sed -e "s|__NYRA_PYTHON__|$(sed_escape "$PYTHON3")|g" \
        -e "s|__NYRA_PREFIX__|$(sed_escape "$PREFIX")|g" \
        -e "s|__NYRA_HOME__|$(sed_escape "$HOME")|g" \
        "$PLIST_SRC" > "${PLIST_DIR}/$PLIST_NAME"
    chmod 644 "${PLIST_DIR}/$PLIST_NAME"
    log "launchd agent 已装到 ${PLIST_DIR}/$PLIST_NAME"
    if command -v launchctl >/dev/null 2>&1; then
        launchctl remove "$LABEL" >/dev/null 2>&1 || true
        if launchctl load "${PLIST_DIR}/$PLIST_NAME" >/dev/null 2>&1 \
            && launchctl list "$LABEL" >/dev/null 2>&1; then
            log "launchd 服务已启动：$LABEL（开机自启，崩了自动重启）"
        else
            log "警告：launchctl load 失败，agent 文件已装好但未启动；"
            log "  按 docs/macos-install.md 手动跑 launchctl load 与 list 检查。"
        fi
    else
        log "警告：找不到 launchctl，agent 文件已装好但未启动；"
        log "  按 docs/macos-install.md 手动跑 launchctl load。"
    fi
fi

case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) log "注意：$BIN_DIR 不在 PATH 里，运行 nyra 前先把它加进 PATH，例如：export PATH=\"\$HOME/.local/bin:\$PATH\""
       log "  永久生效（macOS 默认 shell 是 zsh）：echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc，然后新开一个终端" ;;
esac

log "装好了。跑一次：nyra --version ；交互模式：nyra"
log "卸载：$0 --uninstall（~/.nyra 数据会保留）"
