/**
 * 「我」页统计的进程内缓存。
 * 数据量很大时统计汇总需要扫描百万级消息;导入期间会清理缓存,
 * 平时同一账号重复进入「我」页可直接命中。
 */
const TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function getStatsCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setStatsCache(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 100) {
    const now = Date.now();
    for (const [k, entry] of cache) {
      if (now - entry.at > TTL_MS) cache.delete(k);
    }
  }
}

function clearStatsCache() {
  cache.clear();
}

module.exports = { getStatsCache, setStatsCache, clearStatsCache };
