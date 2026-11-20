#!/usr/bin/env bash
# mobile/scripts/patch-android-manifest.sh — 给 Capacitor 生成的 Android 清单
# 加明文流量许可。
#
# 为什么：启动器页（www/index.html）要跳到电脑上 `nyra ui` 的手机页
# （http://<局域网 IP>:8765/m），那是明文 HTTP；Android 9+ 默认禁明文，
# 不加这一行 WebView 会直接拦掉跳转。Capacitor 8 的 `cap sync` 不会自己
# 加（它的 cleartext 处理只在 Cordova 兼容路径里），所以每次 `cap add`
# / `cap sync` 之后、Gradle 构建之前跑一次本脚本。
#
# 幂等：已存在时不重复加。找不到清单或找不到 <application 标签时直接
# 报错退出（fail-closed，不出一个“看着编好了、装上却连不上”的包）。
set -euo pipefail

MANIFEST="${1:-android/app/src/main/AndroidManifest.xml}"

if [[ ! -f "$MANIFEST" ]]; then
  echo "找不到 Android 清单：$MANIFEST（先跑 bun x cap add android）" >&2
  exit 1
fi

if grep -q 'android:usesCleartextTraffic="true"' "$MANIFEST"; then
  echo "明文许可已在 $MANIFEST，无需重复加"
  exit 0
fi

if ! grep -q '<application' "$MANIFEST"; then
  echo "清单里没有 <application 标签：$MANIFEST" >&2
  exit 1
fi

# 只改 <application 这一行，加 android:usesCleartextTraffic="true"。
sed -i 's|<application|<application\n        android:usesCleartextTraffic="true"|' "$MANIFEST"

grep -q 'android:usesCleartextTraffic="true"' "$MANIFEST" \
  || { echo "补丁没写进去：$MANIFEST" >&2; exit 1; }
echo "已加 android:usesCleartextTraffic=\"true\" 到 $MANIFEST"
