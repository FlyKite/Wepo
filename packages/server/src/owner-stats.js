/**
 * 「我」页按账号汇总统计的持久化缓存。
 *
 * 多次导入的账号需要按 (owner, contact_hash, mes_local_id) 去重后统计
 * 消息/媒体;在 1000 万级消息上重新计算需要几十秒。这里把结果落到
 * owner_stats,之后即使进程重启或内存缓存过期也能直接读取。
 *
 * 真正的聚合放到 worker_threads 中执行,避免大面积 GROUP BY 阻塞主线程:
 * 导入完成时只标记完成并清理旧缓存,首次查询「我」页时再按需计算。
 */

const path = require('path');
const { Worker } = require('worker_threads');
const { db, DB_PATH } = require('./db');

const WORKER_PATH = path.join(__dirname, 'owner-stats-worker.js');
const inflightStats = new Map();

function getStoredOwnerStats(owner) {
  if (!owner) return null;
  const row = db
    .prepare('SELECT contacts, messages, media FROM owner_stats WHERE owner = ?')
    .get(owner);
  return row ? {
    contacts: Number(row.contacts) || 0,
    messages: Number(row.messages) || 0,
    media: Number(row.media) || 0,
  } : null;
}

function setStoredOwnerStats(owner, totals) {
  if (!owner) return;
  db.prepare(`
    INSERT INTO owner_stats (owner, contacts, messages, media, computed_at)
    VALUES (?, ?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(owner) DO UPDATE SET
      contacts = excluded.contacts,
      messages = excluded.messages,
      media = excluded.media,
      computed_at = excluded.computed_at
  `).run(
    owner,
    Number(totals.contacts) || 0,
    Number(totals.messages) || 0,
    Number(totals.media) || 0
  );
}

function computeOwnerStatsInWorker(owner) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        dbPath: DB_PATH,
        databaseModule: require.resolve('better-sqlite3'),
        owner,
      },
    });
    const finish = (err, totals) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(totals);
      worker.terminate().catch(() => {});
    };
    worker.once('message', (message) => {
      if (!message || message.error) {
        finish(new Error((message && message.error) || '账号统计失败'));
      } else {
        finish(null, message.totals);
      }
    });
    worker.once('error', (err) => finish(err));
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(`账号统计进程已退出(code ${code})`));
    });
  });
}

/** 异步统计;同一账号的并发请求复用同一个 worker 结果。 */
function computeOwnerStatsAsync(owner) {
  if (!owner) return Promise.resolve({ contacts: 0, messages: 0, media: 0 });
  if (inflightStats.has(owner)) return inflightStats.get(owner);
  const promise = computeOwnerStatsInWorker(owner);
  inflightStats.set(owner, promise);
  promise.then(
    () => inflightStats.delete(owner),
    () => inflightStats.delete(owner)
  );
  return promise;
}

function clearOwnerStats() {
  db.prepare('DELETE FROM owner_stats').run();
}

/** 是否存在未完成导入;导入期间数据仍在变化,不写入持久化统计 */
function hasIncompleteImports() {
  return Boolean(db.prepare('SELECT 1 FROM backups WHERE completed_at IS NULL LIMIT 1').get());
}

module.exports = {
  getStoredOwnerStats,
  setStoredOwnerStats,
  computeOwnerStatsAsync,
  clearOwnerStats,
  hasIncompleteImports,
};
