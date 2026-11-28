# wxgf 图片转换

iOS 新版微信备份里的部分图片是 `wxgf` 容器，内部为 HEVC 编码，浏览器无法直接显示。服务端在返回这类图片时会转换为 JPEG，并缓存到 `data/wxgf-cache/`。

转换流程：定位 wxgf 中的 HEVC 起始码，使用 PyAV 解码后保存为 JPEG。

## 安装依赖

需要 Python 3.9+。在 `packages/server` 目录执行：

```bash
/usr/bin/python3 -m venv .wxgf-venv
.wxgf-venv/bin/pip install -r scripts/requirements-wxgf.txt
```

服务端默认使用 `.wxgf-venv/bin/python`。如需使用其它 Python，设置：

```bash
WEPO_WXGF_PYTHON=/path/to/python node src/index.js
```

缓存目录可通过 `WEPO_WXGF_CACHE_DIR` 覆盖。磁盘剩余空间不足 512MB 时会改用临时文件，不写入缓存。

转换进程不可用时，wxgf 图片会返回 404，网页仍按原有逻辑显示「图片」占位，不影响其它消息和媒体。
