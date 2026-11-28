#!/usr/bin/env bash
# 为 Tauri 微仓助手准备本机导入 sidecar:
#   - 复制当前 Node 运行时到 src-tauri/binaries/node-<target-triple>
#   - 安装 importer/core 的运行时依赖(含 Node ABI 的 better-sqlite3)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DESKTOP="$ROOT/packages/desktop"
IMPORTER="$DESKTOP/src-tauri/resources/importer"
BIN_DIR="$DESKTOP/src-tauri/binaries"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "未找到 node,请先安装 Node.js 18+" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64|aarch64) TARGET="aarch64-apple-darwin" ;;
  x86_64|amd64) TARGET="x86_64-apple-darwin" ;;
  *) echo "暂不支持当前 macOS 架构: $(uname -m)" >&2; exit 1 ;;
esac

NODE_ABI="$(node -p 'process.versions.modules')"
NATIVE="$ROOT/packages/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [[ ! -f "$NATIVE" ]]; then
  echo "未找到服务端 better-sqlite3 原生模块，请先执行 npm --prefix packages/server install。" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$IMPORTER"
cp "$NODE_BIN" "$BIN_DIR/node-$TARGET"
chmod 755 "$BIN_DIR/node-$TARGET"

# 保留 Node 的许可证，供分发时附带。
NODE_PREFIX="$(cd "$(dirname "$NODE_BIN")/.." && pwd)"
if [[ -f "$NODE_PREFIX/LICENSE" ]]; then
  cp "$NODE_PREFIX/LICENSE" "$IMPORTER/NODE-LICENSE"
fi

rm -rf "$IMPORTER/node_modules"
cat > "$IMPORTER/package.json" <<'JSON'
{
  "name": "wepo-importer-sidecar",
  "private": true,
  "dependencies": {
    "@bokuweb/zstd-wasm": "0.0.27",
    "better-sqlite3": "11.10.0",
    "bindings": "1.5.0",
    "bplist-parser": "0.3.2",
    "fast-xml-parser": "4.5.7",
    "plist": "3.1.1",
    "yauzl": "3.4.0"
  }
}
JSON
(cd "$IMPORTER" && npm install --omit=dev --ignore-scripts --package-lock=false >/dev/null)

mkdir -p "$IMPORTER/node_modules/@wepo/core" "$IMPORTER/node_modules/@wepo/importer"
cp "$ROOT/packages/core/package.json" "$IMPORTER/node_modules/@wepo/core/"
cp -R "$ROOT/packages/core/src" "$ROOT/packages/core/dicts" "$IMPORTER/node_modules/@wepo/core/"
cp "$ROOT/packages/importer/package.json" "$ROOT/packages/importer/worker.js" "$IMPORTER/node_modules/@wepo/importer/"
cp -R "$ROOT/packages/importer/src" "$IMPORTER/node_modules/@wepo/importer/"

mkdir -p "$IMPORTER/node_modules/better-sqlite3/build/Release"
cp "$NATIVE" "$IMPORTER/node_modules/better-sqlite3/build/Release/"

# 删除运行时不用的源码和浏览器入口。
rm -rf \
  "$IMPORTER/node_modules/better-sqlite3/deps" \
  "$IMPORTER/node_modules/better-sqlite3/src" \
  "$IMPORTER/node_modules/better-sqlite3/binding.gyp" \
  "$IMPORTER/node_modules/better-sqlite3/README.md" \
  "$IMPORTER/node_modules/@bokuweb/zstd-wasm/dist/esm" \
  "$IMPORTER/node_modules/@bokuweb/zstd-wasm/dist/web" \
  "$IMPORTER/node_modules/@bokuweb/zstd-wasm/README.md" \
  "$IMPORTER/node_modules/.bin"
rm -f "$IMPORTER/package.json"

# 用真正要打包的 Node 二进制验证 Node ABI 和模块解析。
(cd "$IMPORTER" && "$NODE_BIN" -e "
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.prepare('SELECT 1').get();
  db.close();
  require('@wepo/core');
  require('@wepo/importer');
" ) || {
  echo "sidecar 校验失败: 当前 Node($NODE_ABI) 与 better-sqlite3 原生模块 ABI 不匹配。" >&2
  echo "请用同一个 Node 版本重新安装 packages/server 依赖后重试。" >&2
  exit 1
}

echo "Tauri sidecar 已准备:"
echo "  Node:   $BIN_DIR/node-$TARGET ($(du -sh "$BIN_DIR/node-$TARGET" | awk '{print $1}'))"
echo "  资源:   $IMPORTER ($(du -sh "$IMPORTER" | awk '{print $1}'), Node ABI $NODE_ABI)"
