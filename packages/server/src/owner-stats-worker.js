/**
 * 账号统计 worker:在独立线程中打开只读 SQLite,执行千万级消息去重统计。
 * 主进程只接收两个整数结果,不会因为这条大 SQL 阻塞 HTTP 事件循环。
 */

const { parentPort, workerData } = require('worker_threads');
const Database = require(workerData.databaseModule);
const { computeOwnerStatsWithDb } = require('./owner-stats-query');

let db = null;
try {
  db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  // 统计只需要很小的页缓存;临时 B-tree 落盘,避免 worker 再占用大量内存。
  db.pragma('cache_size = -16384');
  db.pragma('temp_store = FILE');
  db.pragma('busy_timeout = 10000');
  const totals = computeOwnerStatsWithDb(db, workerData.owner);
  parentPort.postMessage({ totals });
} catch (err) {
  parentPort.postMessage({ error: err.message || String(err) });
} finally {
  if (db) {
    try { db.close(); } catch (err) { /* ignore */ }
  }
}
