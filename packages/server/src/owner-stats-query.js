/**
 * 账号统计查询(不依赖服务端全局数据库连接)。
 * 由 owner-stats-worker 在独立线程中调用,避免在 Node 主线程执行
 * 千万级消息的 GROUP BY 阻塞所有 HTTP 请求。
 */

function getMergedContactCount(db, owner) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM contacts WHERE owner = ? GROUP BY owner, hash
    )
  `).get(owner).n;
}

/**
 * 精确计算一次账号级合并汇总。
 * 消息/媒体在同一个去重扫描里完成,避免分别扫描两遍消息表。
 */
function computeOwnerStatsWithDb(db, owner) {
  const contacts = getMergedContactCount(db, owner);
  const row = db.prepare(`
    SELECT
      COUNT(*) AS messages,
      COALESCE(SUM(has_media), 0) AS media
    FROM (
      SELECT MAX(CASE WHEN m.media_path <> '' THEN 1 ELSE 0 END) AS has_media
      FROM messages m
      JOIN contacts c ON c.id = m.contact_id
      WHERE c.owner = ?
      GROUP BY m.contact_hash, m.mes_local_id
    )
  `).get(owner);
  return {
    contacts,
    messages: Number(row.messages) || 0,
    media: Number(row.media) || 0,
  };
}

module.exports = { computeOwnerStatsWithDb };
