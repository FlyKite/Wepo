#!/bin/sh
set -eu

# 容器内部默认值通过 entrypoint 注入,不出现在群晖 Container Manager 的
# 环境变量表单里;对外只暴露端口、Secret、数据目录和备份目录。
export WEPO_DATA_DIR="${WEPO_DATA_DIR:-/data}"
export WEPO_BACKUP_DIR="${WEPO_BACKUP_DIR:-/backups}"
# config/临时目录跟随 WEPO_DATA_DIR,方便自定义数据卷路径。
export WEPO_CONFIG_PATH="${WEPO_CONFIG_PATH:-${WEPO_DATA_DIR}/config.json}"
export WEPO_IMPORT_TEMP_DIR="${WEPO_IMPORT_TEMP_DIR:-${WEPO_DATA_DIR}/tmp/import}"
export WEPO_UPLOAD_TEMP_DIR="${WEPO_UPLOAD_TEMP_DIR:-${WEPO_DATA_DIR}/tmp/uploads}"
export WEPO_WXGF_PYTHON="${WEPO_WXGF_PYTHON:-/opt/wxgf-venv/bin/python}"
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-16}"
# SQLite 统计排序的临时文件也放到数据盘,避免容器 /tmp 空间不足
export SQLITE_TMPDIR="${SQLITE_TMPDIR:-${WEPO_DATA_DIR}/tmp}"

mkdir -p "$WEPO_DATA_DIR" "$WEPO_IMPORT_TEMP_DIR" "$WEPO_UPLOAD_TEMP_DIR" "$SQLITE_TMPDIR"

exec "$@"
