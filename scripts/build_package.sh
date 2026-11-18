#!/usr/bin/env bash
# Nyra Linux 打包脚本：产出发布 tarball 与 Debian 包。
#
# 产出（默认写到 ./dist/，可用 --out-dir 改）：
#   nyra-<版本>.tar.gz      解压即用的发布归档（顶层目录 nyra-<版本>/）
#   nyra_<版本>_all.deb    Debian 包，装到 /usr/share/nyra，启动器 /usr/bin/nyra
#
# 规则：
#   - 版本号只从 nyra/__init__.py 的 __version__ 读，不手写两份；
#   - 只打包白名单文件：nyra/*.py（不含 __pycache__）、scripts/install.sh、
#     systemd/nyra-scheduler.service、README.md、GUIDE.md、CHANGELOG.md、
#     LICENSE 与 docs/linux-*.md；.git、.venv、dist/ 绝不进包；
#   - 零 pip 依赖，deb 只声明 Depends: python3 (>= 3.10)；
#   - 不写 maintainer 脚本：不碰用户 systemd、不动 ~/.nyra，装完由用户
#     自己按 docs/linux-packaging.md 启用服务；
#   - 只在 Linux 上跑；没有 dpkg-deb 时只产出 tarball 并警告（--no-deb
#     亦然），不报错中断。
#
# 用法：
#   ./scripts/build_package.sh [--out-dir DIR] [--no-deb] [--help]
#   默认 --out-dir 为 ./dist。重复跑会覆盖同名旧包。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist"
BUILD_DEB=1

usage() {
    cat <<'EOF'
用法：scripts/build_package.sh [--out-dir DIR] [--no-deb] [--help]

  --out-dir DIR   产出目录（默认 ./dist）
  --no-deb        只产出 tarball，不产出 .deb
  --help          显示本帮助
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --out-dir)
            [ $# -ge 2 ] || { echo "错误：--out-dir 需要一个目录参数。" >&2; exit 2; }
            OUT_DIR="$2"; shift 2 ;;
        --no-deb) BUILD_DEB=0; shift ;;
        --help) usage; exit 0 ;;
        *) echo "错误：未知选项 $1" >&2; usage >&2; exit 2 ;;
    esac
done

VERSION="$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$ROOT/nyra/__init__.py" | head -n 1)"
[ -n "$VERSION" ] || { echo "错误：读不到 nyra/__init__.py 的 __version__。" >&2; exit 1; }
case "$VERSION" in
    *[^0-9A-Za-z.+-]*) echo "错误：版本号含非法字符：$VERSION" >&2; exit 1 ;;
esac

mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# ---- 准备一份干净的 payload（tarball 与 deb 共用） ----
PKG="$STAGE/nyra-$VERSION"
mkdir -p "$PKG/nyra" "$PKG/scripts" "$PKG/systemd" "$PKG/docs"
cp "$ROOT"/nyra/*.py "$PKG/nyra/"
cp "$ROOT/scripts/install.sh" "$PKG/scripts/"
cp "$ROOT/systemd/nyra-scheduler.service" "$PKG/systemd/"
cp "$ROOT"/README.md "$ROOT"/GUIDE.md "$ROOT"/CHANGELOG.md "$ROOT"/LICENSE "$PKG/"
cp "$ROOT"/docs/linux-*.md "$PKG/docs/"
[ -z "$(find "$PKG" -name '__pycache__' -o -name '.git')" ] \
    || { echo "错误：payload 混入 __pycache__ 或 .git。" >&2; exit 1; }

# ---- tarball ----
TARBALL="$OUT_DIR/nyra-$VERSION.tar.gz"
tar -czf "$TARBALL" -C "$STAGE" "nyra-$VERSION"
echo "已产出：$TARBALL"

# ---- .deb（没有 dpkg-deb 时只警告、不失败） ----
if [ "$BUILD_DEB" -eq 1 ]; then
    if ! command -v dpkg-deb >/dev/null 2>&1; then
        echo "警告：本机没有 dpkg-deb，跳过 .deb，只产出 tarball。" >&2
        exit 0
    fi
    DEB_ROOT="$STAGE/deb"
    mkdir -p "$DEB_ROOT/DEBIAN" "$DEB_ROOT/usr/share/nyra" "$DEB_ROOT/usr/bin"
    cp -r "$PKG/nyra" "$PKG/scripts" "$PKG/systemd" "$PKG/docs" \
        "$PKG/README.md" "$PKG/GUIDE.md" "$PKG/CHANGELOG.md" "$PKG/LICENSE" \
        "$DEB_ROOT/usr/share/nyra/"
    # dpkg-deb 要求 DEBIAN 目录权限在 0755–0775 之间；本机 umask 可能
    # 很严，显式统一：目录 755、文件 644（启动器除外）。
    find "$DEB_ROOT" -type d -exec chmod 755 {} +
    find "$DEB_ROOT" -type f -exec chmod 644 {} +
    cat > "$DEB_ROOT/usr/bin/nyra" <<'EOF'
#!/bin/sh
# Nyra 启动器（由 .deb 安装）。程序本体在 /usr/share/nyra，cwd 无关。
# 不写 __pycache__：/usr/share/nyra 由 dpkg 管理，运行时写入的字节码会
# 让 dpkg -r 卸载后残留空目录；禁写后卸载干净。
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/usr/share/nyra exec /usr/bin/python3 -m nyra "$@"
EOF
    chmod 755 "$DEB_ROOT/usr/bin/nyra"
    cat > "$DEB_ROOT/DEBIAN/control" <<EOF
Package: nyra
Version: $VERSION
Section: utils
Priority: optional
Architecture: all
Depends: python3 (>= 3.10)
Maintainer: Nyra contributors
Description: Nyra — an all-round AI agent CLI
 Nyra runs in the terminal with DeepSeek, Grok, Hermes and Ollama support,
 plus file, command, search, memory, skills and scheduling tools.
 It is standard-library only: no pip dependencies.
Homepage: https://github.com/js2005happy/nyra
EOF
    DEB="$OUT_DIR/nyra_${VERSION}_all.deb"
    dpkg-deb --build --root-owner-group "$DEB_ROOT" "$DEB" >/dev/null
    echo "已产出：$DEB"
fi
