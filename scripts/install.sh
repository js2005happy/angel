#!/usr/bin/env bash
# Nyra Linux 安装脚本（只写 $HOME，不需要 root）。
#
# 做什么：
#   - 把 Nyra 装到 ~/.local/share/nyra（可用 --prefix 改位置）；
#   - 在 ~/.local/bin/nyra 放一个启动器（exec python3 -m nyra）；
#   - 建 ~/.nyra（0700，Nyra 的配置与数据目录）；
#   - 装完跑 `nyra --version` 自检；
#   - 加 --with-systemd 时，再把 systemd/nyra-scheduler.service 装到
#     ~/.config/systemd/user/ 并 enable --now（见 docs/linux-systemd.md）。
#
# 用法：
#   ./scripts/install.sh [--source DIR|URL] [--prefix DIR] [--bin-dir DIR]
#                        [--with-systemd] [--uninstall] [--help]
#   默认 --source 是 GitHub 仓库（git clone --depth 1）；已 clone 好仓库时
#   用 --source . 从当前检出安装。重复跑就是升级：旧安装会被整个替换，
#   ~/.nyra 里的数据不动。
#
# 要求：python3 >= 3.10；从 URL 安装时还要 git。Nyra 是零 pip 依赖，
# 本脚本不联网装任何东西（除了 git clone 那一步），也不写 $HOME 以外。

set -euo pipefail

REPO_URL="https://github.com/js2005happy/nyra.git"
REQUIRED_MAJOR=3
REQUIRED_MINOR=10

PREFIX="${HOME}/.local/share/nyra"
BIN_DIR="${HOME}/.local/bin"
SOURCE="$REPO_URL"
WITH_SYSTEMD=0
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
  --with-systemd     再装 systemd 用户服务并 enable --now
                     （只在带 systemd 的 Linux 上有效）
  --uninstall        卸载：停掉并删掉服务、安装目录与启动器；
                     ~/.nyra（你的数据）会保留
  --help             显示本帮助
EOF
}

# 把一段文字转成 sed 替换串可用的形式（转义 & | \）。
sed_escape() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }

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
        *' '*) die "--prefix 不能含空格：$p（systemd 的 ExecStart 不好写）" ;;
    esac
}

# python3 必须存在且 >= 3.10。版本只从 `python3 --version` 的输出判断，
# 便于测试用桩 python3 覆盖。
check_python() {
    command -v python3 >/dev/null 2>&1 || die "找不到 python3，请先装 Python 3.10 或更高版本"
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
        die "python3 版本太低：$ver，需要 >= 3.10"
    fi
    PYTHON3="$(command -v python3)"
    log "python3：$ver（$PYTHON3）"
}

# 卸载：只删本脚本装的东西，~/.nyra 数据保留。
do_uninstall() {
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now nyra-scheduler.service >/dev/null 2>&1 || true
        rm -f "${HOME}/.config/systemd/user/nyra-scheduler.service"
        systemctl --user daemon-reload >/dev/null 2>&1 || true
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
        --with-systemd) WITH_SYSTEMD=1; shift ;;
        --uninstall)    UNINSTALL=1; shift ;;
        --help|-h)      usage; exit 0 ;;
        *)              die "未知参数：$1（看 --help）" ;;
    esac
done

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
        command -v git >/dev/null 2>&1 || die "从 URL 安装需要 git"
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
    printf '%s\n' '# Nyra 启动器，由 scripts/install.sh 生成；不要手动改，重装会被覆盖。'
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

# 可选：systemd 用户服务。unit 模板里的检出路径与 python 路径按本次
# 安装的实际位置替换；没有用户 systemd 总线时只装文件并警告，不报错。
if [ "$WITH_SYSTEMD" -eq 1 ]; then
    UNIT_SRC="$PREFIX/systemd/nyra-scheduler.service"
    UNIT_DIR="${HOME}/.config/systemd/user"
    [ -f "$UNIT_SRC" ] || die "安装树里没有 systemd/nyra-scheduler.service"
    mkdir -p "$UNIT_DIR"
    sed -e "s|^WorkingDirectory=.*|WorkingDirectory=$(sed_escape "$PREFIX")|" \
        -e "s|^ExecStart=.*|ExecStart=$(sed_escape "$PYTHON3") -m nyra schedule daemon|" \
        "$UNIT_SRC" > "${UNIT_DIR}/nyra-scheduler.service"
    log "systemd 单元已装到 ${UNIT_DIR}/nyra-scheduler.service"
    if command -v systemctl >/dev/null 2>&1 \
        && systemctl --user daemon-reload >/dev/null 2>&1 \
        && systemctl --user enable --now nyra-scheduler.service >/dev/null 2>&1; then
        log "systemd 服务已 enable --now：nyra-scheduler.service"
    else
        log "警告：systemctl --user 不可用或 enable 失败，服务文件已装好但未启动；"
        log "  按 docs/linux-systemd.md 手动跑 daemon-reload 与 enable --now。"
    fi
fi

case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) log "注意：$BIN_DIR 不在 PATH 里，运行 nyra 前先把它加进 PATH，例如：export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

log "装好了。跑一次：nyra --version ；交互模式：nyra"
log "卸载：$0 --uninstall（~/.nyra 数据会保留）"
