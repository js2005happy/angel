#!/usr/bin/env bash
# 启动/内存预算检查（Linux only，第 4 阶段）。
#
# 预算（2026-11-19 本地实测为基准，留余量，只拦回归）：
#   二进制体积 <= 130MB（实测约 109.8MB，基本是 Bun 运行时本身）
#   gateway 空闲 RSS <= 60MB（实测中位 33.5MB，Python 空闲 26.0MB）
#   gateway 首字节 <= 1000ms（实测中位 33ms）
#   --help 冷启动 <= 2000ms（实测 18-22ms）
# 用法：bash scripts/check-budgets.sh
set -euo pipefail

MAX_BIN_BYTES=$((130 * 1024 * 1024))
MAX_RSS_KB=$((60 * 1024))
MAX_FIRST_BYTE_MS=1000
MAX_HELP_MS=2000

WORK="$(mktemp -d)"
BIN="$WORK/nyra"
trap 'rm -rf "$WORK"; kill "$GW_PID" 2>/dev/null || true' EXIT

echo "== 编译 =="
bun build --compile --target=bun-linux-x64 --outfile "$BIN" src/cli.ts >/dev/null
BIN_BYTES="$(stat -c%s "$BIN")"
echo "二进制体积：$BIN_BYTES 字节（上限 $MAX_BIN_BYTES）"
if [ "$BIN_BYTES" -gt "$MAX_BIN_BYTES" ]; then
  echo "超预算：二进制体积 $BIN_BYTES > $MAX_BIN_BYTES" >&2
  exit 1
fi

echo "== --help 冷启动 =="
HELP_START="$(date +%s%N)"
"$BIN" --help >/dev/null
HELP_MS=$(( ($(date +%s%N) - HELP_START) / 1000000 ))
echo "--help：${HELP_MS}ms（上限 ${MAX_HELP_MS}ms）"
if [ "$HELP_MS" -gt "$MAX_HELP_MS" ]; then
  echo "超预算：--help 冷启动 ${HELP_MS}ms > ${MAX_HELP_MS}ms" >&2
  exit 1
fi

echo "== gateway 空闲 RSS 与首字节 =="
export NYRA_HOME="$WORK/.nyra"
"$BIN" ui --host 127.0.0.1 --port 0 --print-url-json >"$WORK/gw.json" 2>"$WORK/gw.err" &
GW_PID=$!
URL=""
for _ in $(seq 1 50); do
  if [ -s "$WORK/gw.json" ]; then
    # --print-url-json 的 stdout 首行是一行 JSON；不用 python 解析，sed 取 url 字段。
    URL="$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' "$WORK/gw.json" | head -1)"
    [ -n "$URL" ] && break
  fi
  sleep 0.1
done
[ -n "$URL" ] || { echo "gateway 未启动："; cat "$WORK/gw.err"; exit 1; }
BASE="${URL%%\?*}"
TOKEN="${URL##*token=}"
FIRST_START="$(date +%s%N)"
for _ in $(seq 1 100); do
  if curl -fsS -o /dev/null "$BASE/api/health" 2>/dev/null; then break; fi
  sleep 0.1
done
FIRST_MS=$(( ($(date +%s%N) - FIRST_START) / 1000000 ))
echo "首字节：${FIRST_MS}ms（上限 ${MAX_FIRST_BYTE_MS}ms）"
if [ "$FIRST_MS" -gt "$MAX_FIRST_BYTE_MS" ]; then
  echo "超预算：首字节 ${FIRST_MS}ms > ${MAX_FIRST_BYTE_MS}ms" >&2
  exit 1
fi
sleep 1
RSS_KB="$(awk '/VmRSS/ {print $2}' "/proc/$GW_PID/status")"
echo "gateway 空闲 RSS：${RSS_KB}KB（上限 ${MAX_RSS_KB}KB）"
if [ "$RSS_KB" -gt "$MAX_RSS_KB" ]; then
  echo "超预算：gateway RSS ${RSS_KB}KB > ${MAX_RSS_KB}KB" >&2
  exit 1
fi
# 模式列表含 creator（创造模式随二进制走，不依赖磁盘技能）。
MODES="$(curl -fsS -H "X-Nyra-Token: $TOKEN" "$BASE/api/info")"
echo "$MODES" | grep -q '"creator"' || { echo "超预算：/api/info 的 modes 里没有 creator" >&2; exit 1; }
echo "预算全部通过。"
