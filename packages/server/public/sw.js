/**
 * PWA Service Worker:缓存应用外壳,支持离线打开。
 * - 静态资源与页面:网络优先,失败时回退缓存
 * - /api/*(含媒体):直接走网络,不缓存(鉴权数据与隐私)
 * - 新版本:skipWaiting + 清理旧缓存
 */

const CACHE_NAME = 'wepo-shell-v116';

const SHELL = [
  '/',
  '/index.html',
  '/styles.css?v=20261128g',
  '/app.js?v=20261128g',
  '/theme-init.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png?v=20261128g',
  '/icons/icon-512.png?v=20261128g',
  '/icons/icon-maskable-512.png?v=20261128g',
  '/icons/apple-touch-icon.png?v=20261128g',
  '/icons/favicon-32.png?v=20261128g',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => (
              key.startsWith('wepo-shell-')
              && key !== CACHE_NAME
            ))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

/** 网络失败且无缓存时的兜底响应 */
function offlineFallback() {
  return new Response('离线状态,请连接服务器后重试。', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 接口与媒体不缓存(涉及 Secret、动态数据)
  if (url.pathname.startsWith('/api/')) return;

  // 页面导航:网络优先,离线回退到缓存的应用外壳
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          }
          return response;
        })
        .catch(() =>
          caches
            .match('/index.html')
            .then((cached) => cached || offlineFallback())
        )
    );
    return;
  }

  // 静态资源:网络优先,成功后更新缓存,失败回退缓存
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(request)
          .then((cached) => cached || offlineFallback())
      )
  );
});
