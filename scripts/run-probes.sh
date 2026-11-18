#!/usr/bin/env bash
# Bun API 兼容性探针总跑脚本（第 1 阶段保留条件）。
# 用法：bash scripts/run-probes.sh [--node]
#   默认用 bun 跑 6 个探针；--node 时再用 node 24 复核其中 5 个
#   （websocket 探针的服务端用 Bun.serve，Node 下跳过，见探针内注释）。
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
pass=0; fail=0
for p in scripts/probes/probe-*.ts; do
    if bun run "$p" >/tmp/nyra-probe-out.txt 2>&1; then
        pass=$((pass+1)); tail -1 /tmp/nyra-probe-out.txt
    else
        fail=$((fail+1)); echo "FAIL $p"; cat /tmp/nyra-probe-out.txt | tail -5
    fi
done
if [ "${1:-}" = "--node" ]; then
    for p in probe-mcp-stdio probe-mcp-http probe-subprocess probe-sqlite probe-crypto; do
        if node --experimental-strip-types "scripts/probes/$p.ts" >/tmp/nyra-probe-out.txt 2>&1; then
            pass=$((pass+1)); echo "[node] $(tail -1 /tmp/nyra-probe-out.txt)"
        else
            fail=$((fail+1)); echo "[node] FAIL $p"; tail -5 /tmp/nyra-probe-out.txt
        fi
    done
fi
echo "探针：通过 $pass，失败 $fail"
[ "$fail" -eq 0 ]
