/**
 * 跨导入的合并数据查询。
 *
 * 每次导入仍写入独立的 contacts/messages 行(带 backup_id),用于保留导入记录与
 * 取消导入清理;但查询时按以下维度合并:
 *   - 联系人:(owner, hash) —— 微信账号 + 联系人用户名哈希
 *   - 消息:  (owner, contact_hash, mes_local_id) —— 同一条消息在多次备份中只保留一份
 *
 * 合并后的联系人使用最新导入行的资料(昵称/备注/群成员等),消息数、最后一条消息
 * 与时间从所有导入的去重消息中计算。完全没有消息记录的联系人也会返回。
 */

const { db } = require('./db');

/**
 * 合并后的联系人行。
 * 字段与 contacts 表基本一致,另含:
 *   message_count(去重后)、last_message_time、last_message、last_message_type、
 *   last_sender、has_avatar。
 */
function mergedContactsSql(ownerScoped) {
  const contactOwnerWhere = ownerScoped ? 'WHERE c.owner = @owner' : '';
  const messageOwnerWhere = ownerScoped ? 'WHERE c.owner = @owner' : '';
  const avatarOwnerWhere = ownerScoped ? 'WHERE owner = @owner AND avatar <> \'\'' : "WHERE avatar <> ''";
  return `
WITH contact_rows AS (
  SELECT c.*,
         ROW_NUMBER() OVER (PARTITION BY c.owner, c.hash ORDER BY c.id DESC) AS row_num
  FROM contacts c
  ${contactOwnerWhere}
),
base AS (
  SELECT * FROM contact_rows WHERE row_num = 1
),
msg_rows AS (
  SELECT m.*, c.owner,
         ROW_NUMBER() OVER (
           PARTITION BY c.owner, m.contact_hash, m.mes_local_id
           ORDER BY (CASE WHEN m.media_path <> '' THEN 1 ELSE 0 END) DESC, m.id DESC
         ) AS row_num
  FROM messages m
  JOIN contacts c ON c.id = m.contact_id
  ${messageOwnerWhere}
),
dedup AS (
  SELECT * FROM msg_rows WHERE row_num = 1
),
stats AS (
  SELECT owner, contact_hash, COUNT(*) AS msg_count, MAX(create_time) AS last_time
  FROM dedup
  GROUP BY owner, contact_hash
),
last_rows AS (
  SELECT d.*,
         ROW_NUMBER() OVER (
           PARTITION BY d.owner, d.contact_hash
           ORDER BY d.create_time DESC, d.id DESC
         ) AS last_num
  FROM dedup d
),
last_msg AS (
  SELECT * FROM last_rows WHERE last_num = 1
),
avatar_best AS (
  SELECT owner, hash, MAX(id) AS avatar_contact_id
  FROM contacts
  ${avatarOwnerWhere}
  GROUP BY owner, hash
)
SELECT
  base.id,
  base.backup_id,
  base.owner,
  base.username,
  base.hash,
  base.nickname,
  base.remark,
  base.wx_name,
  base.region,
  base.phone,
  base.type,
  base.is_chatroom,
  base.members,
  base.avatar,
  base.create_time,
  base.unread_count,
  base.is_deleted,
  COALESCE(stats.msg_count, 0) AS message_count,
  COALESCE(stats.last_time, base.last_message_time, 0) AS last_message_time,
  COALESCE(last_msg.content, base.last_message) AS last_message,
  COALESCE(last_msg.type, base.last_message_type) AS last_message_type,
  last_msg.sender AS last_sender,
  CASE WHEN avatar_best.avatar_contact_id IS NOT NULL THEN 1 ELSE 0 END AS has_avatar
FROM base
LEFT JOIN stats
  ON stats.owner = base.owner AND stats.contact_hash = base.hash
LEFT JOIN last_msg
  ON last_msg.owner = base.owner AND last_msg.contact_hash = base.hash
LEFT JOIN avatar_best
  ON avatar_best.owner = base.owner AND avatar_best.hash = base.hash
`;
}

const MERGED_CONTACTS_SQL = mergedContactsSql(false);
const MERGED_CONTACTS_OWNER_SQL = mergedContactsSql(true);

/**
 * 会话列表快速路径:只读 contacts 表,不对 messages 做跨导入窗口去重。
 * 用于账号存在多次导入时的列表/通讯录,避免在首屏扫描数百万条消息。
 * - 资料/群成员取最新导入行
 * - 最后消息/时间取各次导入中 last_message_time 最大的行
 * - 消息数取各次导入 contacts.message_count 的最大值;打开会话后前端会用
 *   /messages 返回的精确去重 total 覆盖标题显示
 */
const CONTACT_SUMMARIES_OWNER_SQL = `
WITH contact_rows AS (
  SELECT c.*,
         ROW_NUMBER() OVER (PARTITION BY c.owner, c.hash ORDER BY c.id DESC) AS row_num
  FROM contacts c
  WHERE c.owner = @owner
),
base AS (
  SELECT * FROM contact_rows WHERE row_num = 1
),
agg AS (
  SELECT owner, hash, MAX(message_count) AS message_count
  FROM contacts
  WHERE owner = @owner
  GROUP BY owner, hash
),
last_rows AS (
  SELECT c.*,
         ROW_NUMBER() OVER (
           PARTITION BY c.owner, c.hash
           ORDER BY c.last_message_time DESC, c.id DESC
         ) AS last_num
  FROM contacts c
  WHERE c.owner = @owner
),
last_contact AS (
  SELECT * FROM last_rows WHERE last_num = 1
),
avatar_best AS (
  SELECT owner, hash, MAX(id) AS avatar_contact_id
  FROM contacts
  WHERE owner = @owner AND avatar <> ''
  GROUP BY owner, hash
)
SELECT
  base.id,
  base.backup_id,
  base.owner,
  base.username,
  base.hash,
  base.nickname,
  base.remark,
  base.wx_name,
  base.region,
  base.phone,
  base.type,
  base.is_chatroom,
  base.members,
  base.avatar,
  base.create_time,
  base.unread_count,
  base.is_deleted,
  COALESCE(agg.message_count, base.message_count, 0) AS message_count,
  COALESCE(last_contact.last_message_time, base.last_message_time, 0) AS last_message_time,
  COALESCE(last_contact.last_message, base.last_message) AS last_message,
  COALESCE(last_contact.last_message_type, base.last_message_type) AS last_message_type,
  CASE WHEN avatar_best.avatar_contact_id IS NOT NULL THEN 1 ELSE 0 END AS has_avatar
FROM base
LEFT JOIN agg
  ON agg.owner = base.owner AND agg.hash = base.hash
LEFT JOIN last_contact
  ON last_contact.owner = base.owner AND last_contact.hash = base.hash
LEFT JOIN avatar_best
  ON avatar_best.owner = base.owner AND avatar_best.hash = base.hash
`;

/** 某账号导入过几次(按 contacts 表中不同 backup_id 计) */
function getOwnerBackupCount(owner) {
  if (!owner) return 0;
  return db
    .prepare('SELECT COUNT(DISTINCT backup_id) AS n FROM contacts WHERE owner = ?')
    .get(owner).n;
}

/** 全部合并联系人(可按 owner 过滤;未排序/未分组) */
function getMergedContactRows(owner) {
  if (owner) {
    // 账号过滤必须下推到 CTE 内部,否则会对全部导入的消息做窗口去重
    return db.prepare(MERGED_CONTACTS_OWNER_SQL).all({ owner });
  }
  return db.prepare(MERGED_CONTACTS_SQL).all();
}

/** 会话列表/通讯录快速路径:只基于 contacts 表生成合并摘要 */
function getMergedContactSummaries(owner) {
  if (!owner) return [];
  return db.prepare(CONTACT_SUMMARIES_OWNER_SQL).all({ owner });
}

/** 合并后的联系人数量 */
function getMergedContactCount(owner) {
  const where = owner ? 'WHERE owner = ?' : '';
  return db
    .prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT 1 FROM contacts ${where} GROUP BY owner, hash
      )
    `)
    .get(...(owner ? [owner] : [])).n;
}

/** 合并后的消息数量(按 owner + contact_hash + mes_local_id 去重) */
function getMergedMessageCount(owner) {
  const where = owner ? 'WHERE c.owner = ?' : '';
  return db
    .prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT 1
        FROM messages m
        JOIN contacts c ON c.id = m.contact_id
        ${where}
        GROUP BY c.owner, m.contact_hash, m.mes_local_id
      )
    `)
    .get(...(owner ? [owner] : [])).n;
}

/** 合并后的媒体消息数量(同一消息多次导入只算一次) */
function getMergedMediaCount(owner) {
  const where = owner ? "WHERE c.owner = ? AND m.media_path <> ''" : "WHERE m.media_path <> ''";
  return db
    .prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT 1
        FROM messages m
        JOIN contacts c ON c.id = m.contact_id
        ${where}
        GROUP BY c.owner, m.contact_hash, m.mes_local_id
      )
    `)
    .get(...(owner ? [owner] : [])).n;
}

/** 合并后的消息类型分布 */
function getMergedMessageTypeCounts(owner) {
  const where = owner ? 'WHERE c.owner = ?' : '';
  return db
    .prepare(`
      WITH msg_rows AS (
        SELECT m.type,
               ROW_NUMBER() OVER (
                 PARTITION BY c.owner, m.contact_hash, m.mes_local_id
                 ORDER BY (CASE WHEN m.media_path <> '' THEN 1 ELSE 0 END) DESC, m.id DESC
               ) AS row_num
        FROM messages m
        JOIN contacts c ON c.id = m.contact_id
        ${where}
      )
      SELECT type, COUNT(*) AS n
      FROM msg_rows
      WHERE row_num = 1
      GROUP BY type
      ORDER BY n DESC
      LIMIT 20
    `)
    .all(...(owner ? [owner] : []));
}

function getMergedTotals(owner) {
  return {
    contacts: getMergedContactCount(owner),
    messages: getMergedMessageCount(owner),
    media: getMergedMediaCount(owner),
  };
}

module.exports = {
  getOwnerBackupCount,
  getMergedContactRows,
  getMergedContactSummaries,
  getMergedContactCount,
  getMergedMessageCount,
  getMergedMediaCount,
  getMergedMessageTypeCounts,
  getMergedTotals,
};
