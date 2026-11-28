/**
 * Wepo 微仓服务端入口。
 * 启动: node src/index.js
 * 端口/监听地址可用环境变量 WEPO_PORT、WEPO_HOST 覆盖;
 * 默认监听所有网卡的 IPv4 + IPv6(Node 双栈,外部可达性取决于防火墙/路由器)。
 */

const express = require('express');
const cors = require('cors');
const os = require('os');
const path = require('path');
const { DB_PATH, MEDIA_DIR } = require('./db');
const { SECRET, ENV_SECRET, CONFIG_PATH, authMiddleware, authRoutes } = require('./auth');
const { getBackupRoot } = require('./backup-sources');
const { clearStatsCache } = require('./stats-cache');

const importRoutes = require('./routes/import');
const contactRoutes = require('./routes/contacts');
const messageRoutes = require('./routes/messages');
const statsRoutes = require('./routes/stats');
const userRoutes = require('./routes/users');
const searchRoutes = require('./routes/search');
const { startSearchIndexBuild } = require('./search-index');

const app = express();
const PORT = Number(process.env.WEPO_PORT) || 3800;
// 未设置 WEPO_HOST 时交给 Node 默认双栈监听(::,同时接受 IPv4)
const HOST = process.env.WEPO_HOST || null;

/** 列出本机非回环地址,用于启动日志 */
function localAddresses() {
  const ipv4 = new Set();
  const ipv6 = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.internal) continue;
      if (info.family === 'IPv4' || info.family === 4) ipv4.add(info.address);
      else if ((info.family === 'IPv6' || info.family === 6) && !info.address.toLowerCase().startsWith('fe80')) {
        ipv6.add(info.address);
      }
    }
  }
  return { ipv4: [...ipv4], ipv6: [...ipv6] };
}

app.use(cors());
app.use(express.json({ limit: '512mb' }));
app.use(express.urlencoded({ extended: true, limit: '16mb' }));

// 接口数据动态变化,禁止浏览器 HTTP 缓存(媒体/头像路由会自行覆盖为 public)
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// 简单请求日志(本地工具,便于调试;隐藏查询参数中的 Secret)
const QUIET_POLL_PATHS = new Set(['/api/import/current', '/api/import/sources']);
app.use((req, res, next) => {
  res.on('finish', () => {
    // 微仓助手和网页会持续轮询这两个接口;成功的轮询不写日志,避免长期运行把日志刷满。
    const requestPath = String(req.originalUrl || '').split('?')[0];
    if (req.method === 'GET' && res.statusCode === 200 && QUIET_POLL_PATHS.has(requestPath)) return;
    const url = req.originalUrl.replace(/([?&]secret=)[^&]*/gi, '$1***');
    console.log(`${new Date().toISOString()} ${req.method} ${url} ${res.statusCode}`);
  });
  next();
});

// 鉴权:auth/verify 与 health 公开,其余 /api 需 Secret
app.use('/api/auth', authRoutes);
app.use('/api', authMiddleware);

// 注意挂载顺序:stats/health 需先于 contacts 的 /:id 通配路由
app.use('/api', statsRoutes);
// 导入过程会改变统计结果,清除「我」页统计缓存
app.use('/api/import', (req, res, next) => {
  clearStatsCache();
  next();
}, importRoutes);
app.use('/api', messageRoutes);
app.use('/api', userRoutes);
app.use('/api', searchRoutes);
app.use('/api', contactRoutes);

// 网页查看器(静态资源 + 首页兜底;不影响 /api 路由)
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// PWA manifest 使用正确的 MIME
app.get('/manifest.webmanifest', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'manifest.webmanifest'));
});

app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      // Service Worker、入口页面与前端脚本禁用强缓存,保证更新及时生效
      if (/(?:sw\.js|index\.html|app\.js|styles\.css|theme-init\.js)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Service-Worker-Allowed', '/');
      }
    },
  })
);
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

function onListening() {
  const addresses = localAddresses();
  const hostLabel = HOST || '所有网卡(IPv4 + IPv6)';
  console.log('==============================================');
  console.log('  Wepo 微仓 - 服务端已启动');
  console.log(`  监听地址: ${hostLabel}:${PORT}`);
  if (HOST) {
    const hostForUrl = HOST.includes(':') ? `[${HOST}]` : HOST;
    console.log(`  查看页面: http://${hostForUrl}:${PORT}/`);
  } else {
    for (const ip of addresses.ipv4) console.log(`  IPv4 访问: http://${ip}:${PORT}/`);
    for (const ip of addresses.ipv6) console.log(`  IPv6 访问: http://[${ip}]:${PORT}/`);
    if (addresses.ipv4.length === 0 && addresses.ipv6.length === 0) {
      console.log(`  查看页面: http://<本机IP>:${PORT}/`);
    }
  }
  console.log(`  数据库:   ${DB_PATH}`);
  console.log(`  媒体目录: ${MEDIA_DIR}`);
  console.log(`  NAS 备份: ${getBackupRoot()}`);
  console.log('----------------------------------------------');
  if (ENV_SECRET) {
    console.log('  访问 Secret: 已配置(WEPO_SECRET 环境变量,不在日志中显示)');
  } else {
    // 未设置环境变量时输出实际 Secret,便于在群晖 Container Manager 日志中查看。
    console.log(`  访问 Secret: ${SECRET} (未设置 WEPO_SECRET,读取/生成自 ${CONFIG_PATH})`);
    console.log('  以上 Secret 仅用于本机/局域网访问,请勿公开分享容器日志');
  }
  console.log('  微仓网页版与微仓助手都需要此 Secret');
  console.log('  警告: 已监听所有网卡;若暴露到公网,请使用强 Secret 并配置 HTTPS/防火墙');
  console.log('==============================================');
  // 首次启动/新增消息后后台构建聊天记录双字索引,不阻塞接口
  startSearchIndexBuild();
  // 预热全局搜索使用的联系人/群成员缓存,避免第一次搜索重新合并数万联系人
  setTimeout(() => {
    try {
      searchRoutes.warmSearchCacheForAllOwners();
    } catch (err) {
      console.warn(`[search] 搜索缓存预热失败: ${err.message}`);
    }
  }, 1200);
}

/** 避免大批量导入时 keep-alive 连接在客户端复用瞬间被关闭 */
function tuneServer(server) {
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
}

if (HOST) {
  tuneServer(app.listen(PORT, HOST, onListening));
} else {
  // 不指定 host:Node 在支持 IPv6 时监听 :: 并同时接受 IPv4
  tuneServer(app.listen(PORT, onListening));
}
