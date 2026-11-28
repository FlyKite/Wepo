# Wepo 微仓服务端镜像(含服务端 NAS 备份导入所需的解析核心与导入执行器)
# 使用 Debian 基础镜像自行安装 Node 18,避免官方 node 镜像携带
# NODE_VERSION/YARN_VERSION 等只读环境变量出现在群晖图形界面。
FROM debian:bookworm-slim

# 向群晖图形界面暴露端口、Secret、数据目录和备份目录;其余内部路径由 docker-entrypoint.sh 注入。
ENV WEPO_PORT=3800 \
    WEPO_SECRET= \
    WEPO_DATA_DIR=/data \
    WEPO_BACKUP_DIR=/backups

# better-sqlite3 在无预编译包时需要编译;python3/venv 用于 wxgf 图片转换。
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    nodejs npm python3 python3-venv build-essential tzdata ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先安装依赖，利用 Docker 层缓存
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/importer/package.json packages/importer/package.json
COPY packages/desktop/package.json packages/desktop/package.json
RUN npm ci --omit=dev

COPY packages/server/package.json packages/server/package-lock.json packages/server/
WORKDIR /app/packages/server
RUN npm ci --omit=dev

WORKDIR /app
COPY packages/core ./packages/core
COPY packages/importer ./packages/importer
COPY packages/server ./packages/server

RUN python3 -m venv /opt/wxgf-venv \
  && /opt/wxgf-venv/bin/pip install --no-cache-dir -r packages/server/scripts/requirements-wxgf.txt

COPY scripts/docker-entrypoint.sh /usr/local/bin/wepo-entrypoint
RUN chmod +x /usr/local/bin/wepo-entrypoint \
  && mkdir -p /data /backups /data/tmp/import /data/tmp/uploads

EXPOSE 3800
VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/wepo-entrypoint"]
CMD ["node", "packages/server/src/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEPO_PORT||3800)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
