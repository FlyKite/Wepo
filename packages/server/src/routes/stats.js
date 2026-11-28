/**
 * 统计、备份管理与健康检查接口。
 *   GET /api/health
 *   GET /api/stats         备份列表与汇总
 *   GET /api/backups       备份列表
 *   DELETE /api/backups/:id 删除一次导入的全部数据
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, MEDIA_DIR } = require('../db');
const { getStatsCache, setStatsCache, clearStatsCache } = require('../stats-cache');
const {
  getStoredOwnerStats,
  setStoredOwnerStats,
  computeOwnerStatsAsync,
  clearOwnerStats,
  hasIncompleteImports,
} = require('../owner-stats');
const { removeBackupFromIndex } = require('../search-index');
const { invalidateSearchDataCache } = require('./search');
const {
  getOwnerBackupCount,
  getMergedContactCount,
  getMergedMessageCount,
  getMergedMediaCount,
  getMergedMessageTypeCounts,
} = require('../merged');

const router = express.Router();

/** Express 4 不会自动捕获 async 处理器的 Promise 异常 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.get('/health', (req, res) => {
  res.json({ ok: true, name: 'wepo-server', time: new Date().toISOString() });
});

// 仅供导出客户端取消导入时清理未完成数据;网页查看器不提供删除入口。
router.delete('/backups/:id', (req, res) => {
  const { id } = req.params;
  const exists = db.prepare('SELECT id FROM backups WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: '备份不存在' });
  removeBackupFromIndex(id);
  db.prepare('DELETE FROM backups WHERE id = ?').run(id); // 外键级联删除联系人/消息
  fs.rmSync(path.join(MEDIA_DIR, id), { recursive: true, force: true });
  clearStatsCache();
  clearOwnerStats();
  invalidateSearchDataCache();
  res.json({ ok: true });
});

router.get('/stats', asyncHandler(async (req, res) => {
  const owner = (req.query.owner || '').trim();
  const backups = db
    .prepare(
      `SELECT id, device_name, product_type, ios_version, serial_number,
              backup_date, created_at, user_count, contact_count, message_count, media_count
       FROM backups ORDER BY created_at DESC, id DESC`
    )
    .all()
    .map((b) => ({
      id: b.id,
      deviceName: b.device_name,
      productType: b.product_type,
      iosVersion: b.ios_version,
      serialNumber: b.serial_number,
      backupDate: b.backup_date,
      createdAt: b.created_at,
      userCount: b.user_count,
      contactCount: b.contact_count,
      messageCount: b.message_count,
      mediaCount: b.media_count,
    }));

  const summaryOnly = req.query.summary === '1';
  const cacheKey = `${owner || '__all__'}|${summaryOnly ? 'summary' : 'full'}`;
  const cached = getStatsCache(cacheKey);
  if (cached) {
    return res.json({
      backups,
      totals: { backups: backups.length, ...cached.totals },
      messageTypeCounts: cached.messageTypeCounts,
      merged: cached.merged,
      owner: owner || null,
    });
  }

  // 单次导入快速路径:直接使用 contacts 的预计算消息数,避免对百万级消息做窗口去重
  if (owner) {
    const ownerBackupCount = getOwnerBackupCount(owner);
    if (ownerBackupCount <= 1) {
      let totals = { backups: backups.length, contacts: 0, messages: 0, media: 0 };
      let messageTypeCounts = [];
      if (ownerBackupCount === 1) {
        const contactStats = db
          .prepare('SELECT COUNT(*) AS contacts, COALESCE(SUM(message_count), 0) AS messages FROM contacts WHERE owner = ?')
          .get(owner);
        const mediaCount = db
          .prepare(`
            SELECT COUNT(*) AS n
            FROM messages m
            JOIN contacts c ON c.id = m.contact_id
            WHERE c.owner = ? AND m.media_path <> ''
          `)
          .get(owner).n;
        totals = {
          backups: backups.length,
          contacts: contactStats.contacts,
          messages: contactStats.messages,
          media: mediaCount,
        };
        if (!summaryOnly) {
          messageTypeCounts = db
            .prepare(`
              SELECT m.type, COUNT(*) AS n
              FROM messages m
              JOIN contacts c ON c.id = m.contact_id
              WHERE c.owner = ?
              GROUP BY m.type
              ORDER BY n DESC
              LIMIT 20
            `)
            .all(owner);
        }
      }
      setStatsCache(cacheKey, {
        totals: { contacts: totals.contacts, messages: totals.messages, media: totals.media },
        messageTypeCounts,
        merged: false,
      });
      return res.json({
        backups,
        totals,
        messageTypeCounts,
        merged: false,
        owner,
      });
    }

    // 多次导入:优先使用持久化账号统计;缺失时在 worker 线程计算,
    // 避免千万级消息 GROUP BY 阻塞服务端主线程和健康检查。
    const dirty = hasIncompleteImports();
    let mergedTotals = dirty ? null : getStoredOwnerStats(owner);
    if (!mergedTotals) {
      try {
        mergedTotals = await computeOwnerStatsAsync(owner);
      } catch (err) {
        console.warn(`[stats] 账号统计计算失败: ${err.message}`);
        return res.status(500).json({ error: `账号统计计算失败: ${err.message}` });
      }
      if (!dirty) setStoredOwnerStats(owner, mergedTotals);
    }
    const totals = { backups: backups.length, ...mergedTotals };
    const messageTypeCounts = summaryOnly ? [] : getMergedMessageTypeCounts(owner);
    setStatsCache(cacheKey, {
      totals: mergedTotals,
      messageTypeCounts,
      merged: true,
    });
    return res.json({
      backups,
      totals,
      messageTypeCounts,
      merged: true,
      owner,
    });
  }

  // totals 为跨导入合并去重后的数据;backups 为导入记录
  const totals = {
    backups: backups.length,
    contacts: getMergedContactCount(owner),
    messages: getMergedMessageCount(owner),
    media: getMergedMediaCount(owner),
  };

  const messageTypeCounts = summaryOnly ? [] : getMergedMessageTypeCounts(owner);
  setStatsCache(cacheKey, {
    totals: { contacts: totals.contacts, messages: totals.messages, media: totals.media },
    messageTypeCounts,
    merged: true,
  });

  res.json({ backups, totals, messageTypeCounts, merged: true, owner: owner || null });
}));

router.get('/backups', (req, res) => {
  const backups = db
    .prepare(
      `SELECT id, device_name, ios_version, created_at, contact_count, message_count, media_count
       FROM backups ORDER BY created_at DESC, id DESC`
    )
    .all();
  res.json({ items: backups });
});

module.exports = router;
