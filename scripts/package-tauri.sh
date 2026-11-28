#!/usr/bin/env bash
# 构建 Tauri 微仓助手，并把 .app 打成便于分发的 zip。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/packages/desktop"
APP="$DESKTOP/src-tauri/target/release/bundle/macos/微仓助手.app"
VERSION="$(node -p "require('$DESKTOP/src-tauri/tauri.conf.json').version")"

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="x64" ;;
  *) echo "暂不支持当前架构: $(uname -m)" >&2; exit 1 ;;
esac

export PATH="$HOME/.cargo/bin:$PATH"
cd "$ROOT"
npm run build -w @wepo/desktop

if [[ ! -d "$APP" ]]; then
  echo "未找到构建产物: $APP" >&2
  exit 1
fi

mkdir -p "$ROOT/release"
ZIP="$ROOT/release/Wepo-Assistant-Tauri-$VERSION-$ARCH.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

echo "微仓助手已构建:"
echo "  应用: $APP ($(du -sh "$APP" | awk '{print $1}'))"
echo "  压缩: $ZIP ($(du -sh "$ZIP" | awk '{print $1}'))"
