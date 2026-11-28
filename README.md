# Wepo 微仓

## 简介

Wepo(中文名「微仓」)用于从 **未加密的 iOS 备份** 中解析微信聊天记录，导入自建服务端，并通过微信 PC 风格的网页查看。

主要组成：

- **微仓助手**：Tauri 桌面客户端，支持本机目录/zip 导入，也可以把 NAS 备份交给服务端导入。
- **服务端**：Node.js + Express + SQLite，提供导入 API、数据查询和网页查看器。
- **解析核心**：定位 iOS 备份文件、按需解压、解析微信联系人和聊天记录。

支持文字、图片、语音、视频、文件、链接、引用、表情等消息类型；支持多账号、多备份合并去重、断点续传、全局搜索、移动端和平板布局及 PWA。

> 本项目仅用于个人备份数据的查看。请遵守相关法律法规，并妥善保管自己的备份和服务端 Secret。

## 安装

### Docker(推荐)

服务端镜像支持 `linux/amd64` 和 `linux/arm64`。新建 `docker-compose.yml`：

```yaml
services:
  wepo:
    image: flykite/wepo:1.0.7
    container_name: wepo
    restart: unless-stopped
    ports:
      - "3800:3800"
    environment:
      WEPO_SECRET: ""
      TZ: Asia/Shanghai
    volumes:
      - ./data:/data
      - /volume1/backups/iphone:/backups:ro
```

```bash
docker compose pull
docker compose up -d
```

- `/data` 用于保存 SQLite、媒体、导入状态和 `config.json`，必须持久化。
- `/backups` 挂载 iOS 备份根目录，只读即可。
- `WEPO_SECRET` 留空时会在 `/data/config.json` 自动生成，并在容器启动日志中显示；也可以自行设置。
- 千万级消息或大量媒体建议至少分配 2GB 内存。

生产环境建议固定版本号，例如 `flykite/wepo:1.0.7`。

### 源码运行

需要 Node.js 18.x（推荐 18.19.1，仓库已提供 `.nvmrc`）。构建微仓助手还需要 Rust stable、Xcode Command Line Tools 和 macOS。

```bash
git clone https://github.com/FlyKite/Wepo.git
cd Wepo

npm install
npm --prefix packages/server install

# 可选：支持新版微信 wxgf 图片
python3 -m venv packages/server/.wxgf-venv
packages/server/.wxgf-venv/bin/pip install -r packages/server/scripts/requirements-wxgf.txt

npm run server
# 另开终端
npm run desktop:dev
```

`npm run server` 默认监听 `3800` 端口；`npm run desktop:dev` 会自动准备内置 Node sidecar 和导入器资源。

打包微仓助手：

```bash
npm run desktop:package
```

产物位于 `packages/desktop/src-tauri/target/release/bundle/macos/` 和 `release/`。macOS 包使用 ad-hoc 签名，未公证，首次打开可能需要在系统设置中手动允许。

## 使用方式

1. 使用 Finder/iTunes 创建 iPhone 本地备份，**不要勾选“加密本地备份”**。较新版本微信若单独启用了聊天记录加密，相关数据库无法读取。

2. **服务端导入 NAS 备份(推荐)**：把备份文件夹放进 `WEPO_BACKUP_DIR`，文件夹中需要包含 `Manifest.plist` 和 `Manifest.db`/`Manifest.mbdb`。然后：
   - 浏览器打开查看器，进入「我 → 数据源」，选择备份并点击「导入」；或
   - 在微仓助手的「NAS 备份目录」中选择备份并导入。

   导入过程中会显示阶段和进度；已导入的备份会标记为「已导入」，未完成的备份可以「继续导入」，不会重复生成记录。

3. **本机导入**：打开微仓助手，填写服务端地址和 Secret，选择备份目录或 zip 压缩包，点击「开始解析并导入」。支持断点续传和按需上传媒体文件。

4. **查看数据**：浏览器访问 `http://<服务器地址>:3800/`，首次输入 Secret。支持电脑、手机和平板；可在「我」页切换账号和外观，并安装为 PWA。

5. **多备份与安全**：
   - 多次导入同一账号时，联系人和消息会跨备份合并去重。
   - 备份中没有的媒体文件会显示占位，不影响文字记录查看。
   - 不要将服务端直接暴露到公网；如需外网访问，请配置 HTTPS、强 Secret 和防火墙。

## 鸣谢

本项目基于以下开源项目和服务构建，感谢作者与社区：

- [Node.js](https://nodejs.org/)、[Express](https://expressjs.com/)、[SQLite](https://www.sqlite.org/)、[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [Tauri](https://tauri.app/)、[Rust](https://www.rust-lang.org/)
- [yauzl](https://github.com/thejoshwolfe/yauzl)、[plist](https://github.com/TooTallNate/plist.js)、[bplist-parser](https://github.com/nearinfinity/node-bplist-parser)、[fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)
- [@bokuweb/zstd-wasm](https://github.com/bokuweb/zstd-wasm)、[pinyin-pro](https://github.com/zh-lx/pinyin-pro)
- [silk-wasm](https://www.npmjs.com/package/silk-wasm)、[@audio/decode-amr](https://www.npmjs.com/package/@audio/decode-amr)
- [PyAV](https://github.com/PyAV-Org/PyAV)、[Pillow](https://python-pillow.org/)

微信 WCDB zstd 字典及第三方许可说明保留在源码中；本项目自身以 MIT 许可开源。
