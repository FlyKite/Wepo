/**
 * 数据导入接口:
 *   GET  /api/import/sources     服务器备份目录中的可用 iOS 备份
 *   POST /api/import/server      由服务端从 NAS 备份目录开始导入
 *   GET  /api/import/current     当前/最近一次服务端导入任务状态
 *   POST /api/import/server/cancel 停止服务端导入
 *
 * 以下为微仓助手本机导入(或服务端导入 worker 内部调用)的分步上传接口:
 *   POST /api/import/meta      备份与账号元信息
 *   POST /api/import/contacts  联系人(可分批)
 *   POST /api/import/tags      联系人标签(全量快照)
 *   POST /api/import/messages  聊天记录(可分批,幂等)
 *   POST /api/import/media     媒体文件(multipart: 图片/语音/视频/联系人头像)
 *   POST /api/import/user-avatar 账号头像(multipart)
 *   POST /api/import/complete  完成导入,统计汇总
 *   DELETE /api/backups/:id    删除一次导入的全部数据
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { db, MEDIA_DIR } = require('../db');
const { detectImageType } = require('../file-response');
const { clearOwnerStats } = require('../owner-stats');
const { clearStatsCache } = require('../stats-cache');
const { indexMessages } = require('../search-index');
const { invalidateSearchDataCache } = require('./search');
const {
  listBackupSources,
  isServerBackupPath,
} = require('../backup-sources');
const {
  startImport: startServerImport,
  cancelImport: cancelServerImport,
  getCurrentJob,
} = require('../import-job');

const router = express.Router();

const KIND_EXT = { image: 'jpg', voice: 'aud', video: 'mp4', avatar: 'jpg' };
const MIN_FREE_BYTES = 512 * 1024 * 1024;

// 媒体文件先落到临时目录再移动,避免大文件占用内存。
// Docker 中把 WEPO_UPLOAD_TEMP_DIR 指到 /data 下,避免容器 /tmp 被大媒体撑满。
const UPLOAD_TEMP_DIR = process.env.WEPO_UPLOAD_TEMP_DIR
  || path.join(os.tmpdir(), 'wepo-upload');
fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
const upload = multer({
  dest: UPLOAD_TEMP_DIR,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
});

/** 磁盘写满时阻止新的媒体写入,避免 multer/临时文件错误导致进程退出 */
function requireFreeSpace(req, res, next) {
  try {
    const stat = fs.statfsSync(MEDIA_DIR);
    const free = Number(stat.bavail) * Number(stat.bsize);
    if (Number.isFinite(free) && free < MIN_FREE_BYTES) {
      return res.status(507).json({
        error: `服务器磁盘空间不足(剩余 ${(free / 1024 / 1024).toFixed(0)} MB),请清理后继续导入`,
        freeBytes: free,
      });
    }
  } catch (err) {
    /* statfs 不可用时不影响导入 */
  }
  return next();
}

// ---------- 服务端 NAS 备份导入 ----------

/** 扫描服务器配置的备份目录,返回可导入的 iOS 备份 */
router.get('/sources', (req, res) => {
  try {
    const result = listBackupSources();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '扫描备份目录失败' });
  }
});

/** 当前(或最近一次)服务端导入任务状态,供微仓助手/网页轮询 */
router.get('/current', (req, res) => {
  try {
    res.json({ ok: true, job: getCurrentJob() });
  } catch (err) {
    res.status(500).json({ error: err.message || '读取导入状态失败' });
  }
});

/** 由服务端从指定 NAS 备份目录开始导入 */
router.post('/server', (req, res) => {
  try {
    const job = startServerImport({
      key: req.body && req.body.key,
      includeMedia: !(req.body && req.body.includeMedia === false),
    });
    res.status(202).json({ ok: true, job });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '启动服务端导入失败' });
  }
});

/** 停止服务端导入;已写入的数据保留 */
router.post('/server/cancel', (req, res) => {
  try {
    res.json({ ok: true, job: cancelServerImport() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '停止服务端导入失败' });
  }
});

// ---------- 客户端上传导入 ----------

router.post('/meta', (req, res) => {
  const { id, device = {}, users = [], backupDir = '', sourcePath = '' } = req.body || {};
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: '缺少备份 id' });
  }
  const insertBackup = db.prepare(`
    INSERT INTO backups
      (id, device_name, product_type, ios_version, serial_number, backup_date, source_path, user_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      device_name = CASE WHEN excluded.device_name <> '' THEN excluded.device_name ELSE backups.device_name END,
      product_type = CASE WHEN excluded.product_type <> '' THEN excluded.product_type ELSE backups.product_type END,
      ios_version = CASE WHEN excluded.ios_version <> '' THEN excluded.ios_version ELSE backups.ios_version END,
      serial_number = CASE WHEN excluded.serial_number <> '' THEN excluded.serial_number ELSE backups.serial_number END,
      backup_date = COALESCE(excluded.backup_date, backups.backup_date),
      source_path = CASE WHEN excluded.source_path <> '' THEN excluded.source_path ELSE backups.source_path END,
      user_count = excluded.user_count
  `);
  let backupDate = null;
  if (device.backupDate) {
    const parsed = new Date(device.backupDate);
    if (!Number.isNaN(parsed.getTime())) backupDate = parsed.toISOString();
  }
  const source = String(sourcePath || backupDir || '');
  const existing = db.prepare(`
    SELECT source_path, serial_number, product_type, backup_date, completed_at
    FROM backups WHERE id = ?
  `).get(id);
  if (existing) {
    // 续传时优先核验备份身份(设备序列号 + 备份时间),而不是只比较路径:
    // 备份目录/压缩包可能被移动或换盘;反过来,同一路径也可能被替换成
    // 另一个备份。身份一致才允许更新来源路径,避免把两次备份混在一起。
    const existingSerial = String(existing.serial_number || '').trim();
    const incomingSerial = String(device.serialNumber || '').trim();
    const existingTime = existing.backup_date ? new Date(existing.backup_date).getTime() : NaN;
    const incomingTime = backupDate ? new Date(backupDate).getTime() : NaN;
    const hasIdentity = Boolean(
      existingSerial && incomingSerial
      && Number.isFinite(existingTime) && Number.isFinite(incomingTime)
    );
    const identityMatches = hasIdentity
      && existingSerial === incomingSerial
      && existingTime === incomingTime;
    const identityConflicts = hasIdentity && !identityMatches;
    const samePath = Boolean(existing.source_path && source && existing.source_path === source);
    if (identityConflicts || (existing.source_path && source && !samePath && !identityMatches)) {
      return res.status(409).json({
        error: '所选备份与未完成导入的来源/备份身份不一致，请选择原来的备份；'
          + '如果备份目录已移动，请选择同一设备、同一备份时间的备份',
      });
    }
  }
  insertBackup.run(
    id,
    device.deviceName || '',
    device.productType || '',
    device.iosVersion || '',
    device.serialNumber || '',
    backupDate,
    source,
    Array.isArray(users) ? users.length : 0
  );
  const insertUser = db.prepare(
    'INSERT INTO users (backup_id, username, display_name, wx_name) VALUES (?, ?, ?, ?)'
  );
  const updateUser = db.prepare(`
    UPDATE users SET
      display_name = CASE WHEN ? <> '' THEN ? ELSE display_name END,
      wx_name = CASE WHEN ? <> '' THEN ? ELSE wx_name END
    WHERE backup_id = ? AND username = ?
  `);
  const tx = db.transaction((list) => {
    for (const u of list) {
      const username = String(u.username || '');
      const displayName = String(u.displayName || '');
      const wxName = String(u.wxName || '');
      const updated = updateUser.run(displayName, displayName, wxName, wxName, id, username);
      if (updated.changes === 0) insertUser.run(id, username, displayName, wxName);
    }
  });
  tx(Array.isArray(users) ? users : []);
  // 导入开始后统计数据可能变化,清空持久化汇总和页面缓存。
  clearOwnerStats();
  clearStatsCache();
  res.json({ ok: true, id });
});

const CONTACT_COLUMNS = [
  'username', 'hash', 'nickname', 'remark', 'wx_name', 'region', 'phone', 'type', 'is_chatroom',
  'members', 'create_time', 'unread_count', 'last_message_time', 'last_message',
  'last_message_type', 'message_count', 'owner', 'is_deleted',
];

router.post('/contacts', (req, res) => {
  const { backupId, contacts } = req.body || {};
  if (!backupId || !Array.isArray(contacts)) {
    return res.status(400).json({ error: '参数错误: 需要 backupId 与 contacts 数组' });
  }
  const upsert = db.prepare(`
    INSERT INTO contacts (backup_id, ${CONTACT_COLUMNS.join(', ')})
    VALUES (?, ${CONTACT_COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT (backup_id, hash) DO UPDATE SET
      username = CASE WHEN excluded.username <> '' THEN excluded.username ELSE contacts.username END,
      nickname = CASE WHEN excluded.nickname <> '' THEN excluded.nickname ELSE contacts.nickname END,
      remark = CASE WHEN excluded.remark <> '' THEN excluded.remark ELSE contacts.remark END,
      wx_name = CASE WHEN excluded.wx_name <> '' THEN excluded.wx_name ELSE contacts.wx_name END,
      region = CASE WHEN excluded.region <> '' THEN excluded.region ELSE contacts.region END,
      phone = CASE WHEN excluded.phone <> '' THEN excluded.phone ELSE contacts.phone END,
      type = excluded.type,
      is_chatroom = excluded.is_chatroom,
      members = CASE WHEN excluded.members <> '' AND excluded.members <> '[]'
                     THEN excluded.members ELSE contacts.members END,
      create_time = excluded.create_time,
      unread_count = excluded.unread_count,
      last_message_time = excluded.last_message_time,
      last_message = excluded.last_message,
      last_message_type = excluded.last_message_type,
      message_count = excluded.message_count,
      owner = excluded.owner,
      is_deleted = excluded.is_deleted
  `);
  const tx = db.transaction((list) => {
    for (const c of list) {
      upsert.run(
        backupId,
        String(c.username || ''),
        String(c.hash || ''),
        String(c.nickname || ''),
        String(c.remark || ''),
        String(c.wxName || ''),
        String(c.region || ''),
        String(c.phone || ''),
        Number(c.type) || 0,
        c.isChatroom ? 1 : 0,
        JSON.stringify(Array.isArray(c.members) ? c.members : []),
        Number(c.createTime) || 0,
        Number(c.unreadCount) || 0,
        Number(c.lastMessageTime) || 0,
        String(c.lastMessage || ''),
        Number(c.lastMessageType) || 0,
        Number(c.messageCount) || 0,
        String(c.owner || ''),
        c.isDeleted ? 1 : 0
      );
    }
  });
  try {
    tx(contacts);
  } catch (err) {
    return res.status(500).json({ error: `联系人写入失败: ${err.message}` });
  }
  invalidateSearchDataCache();
  res.json({ ok: true, count: contacts.length });
});

/**
 * 联系人标签(全量快照)。标签成员存 username,与联系人跨备份合并逻辑解耦。
 * 同一备份重复上传时整体替换,避免已删除的标签残留。
 */
router.post('/tags', (req, res) => {
  const { backupId, tags } = req.body || {};
  if (!backupId || !Array.isArray(tags)) {
    return res.status(400).json({ error: '参数错误: 需要 backupId 与 tags 数组' });
  }
  const upsert = db.prepare(`
    INSERT INTO contact_tags (backup_id, owner, remote_id, tag_index, name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (backup_id, owner, remote_id) DO UPDATE SET
      tag_index = excluded.tag_index,
      name = excluded.name
  `);
  const findTag = db.prepare(
    'SELECT id FROM contact_tags WHERE backup_id = ? AND owner = ? AND remote_id = ?'
  );
  const insertMember = db.prepare(
    'INSERT OR IGNORE INTO contact_tag_members (tag_id, username) VALUES (?, ?)'
  );
  const tx = db.transaction((list) => {
    db.prepare('DELETE FROM contact_tags WHERE backup_id = ?').run(backupId);
    for (const t of list) {
      const name = String((t && t.name) || '').trim();
      if (!name) continue;
      const owner = String(t.owner || '');
      const remoteId = Number(t.remoteId) || 0;
      upsert.run(backupId, owner, remoteId, Number(t.tagIndex) || 0, name);
      const tag = findTag.get(backupId, owner, remoteId);
      if (!tag) continue;
      for (const username of Array.isArray(t.usernames) ? t.usernames : []) {
        const value = String(username || '').trim();
        if (value) insertMember.run(tag.id, value);
      }
    }
  });
  try {
    tx(tags);
  } catch (err) {
    return res.status(500).json({ error: `标签写入失败: ${err.message}` });
  }
  res.json({ ok: true, count: tags.length });
});

router.post('/messages', (req, res) => {
  const { backupId, contactHash, messages } = req.body || {};
  if (!backupId || !contactHash || !Array.isArray(messages)) {
    return res.status(400).json({ error: '参数错误: 需要 backupId、contactHash 与 messages 数组' });
  }
  const contact = db
    .prepare('SELECT id FROM contacts WHERE backup_id = ? AND hash = ?')
    .get(backupId, contactHash);
  if (!contact) {
    return res.status(404).json({ error: '联系人不存在,请先上传联系人数据' });
  }
  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages
      (backup_id, contact_id, contact_hash, mes_local_id, mes_svr_id, type, is_sent, sender, content, extra, create_time, media_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertStickerUrl = db.prepare(`
    INSERT INTO sticker_urls (md5, cdnurl) VALUES (?, ?)
    ON CONFLICT(md5) DO UPDATE SET cdnurl = excluded.cdnurl
  `);
  const tx = db.transaction((list) => {
    const inserted = [];
    for (const m of list) {
      if (Number(m.type) === 47 && m.extra && typeof m.extra === 'object') {
        const md5 = typeof m.extra.md5 === 'string' ? m.extra.md5.toLowerCase() : '';
        const url = (typeof m.extra.cdnurl === 'string' && m.extra.cdnurl)
          || (typeof m.extra.thumburl === 'string' && m.extra.thumburl)
          || '';
        if (/^[a-f0-9]{32}$/.test(md5) && url) {
          upsertStickerUrl.run(md5, String(url));
        }
      }
      const info = insert.run(
        backupId,
        contact.id,
        contactHash,
        Number(m.mesLocalId),
        m.mesSvrId === null || m.mesSvrId === undefined ? null : Number(m.mesSvrId),
        Number(m.type) || 0,
        m.isSent ? 1 : 0,
        String(m.sender || ''),
        String(m.content || ''),
        m.extra ? JSON.stringify(m.extra) : null,
        Number(m.createTime) || 0,
        m.mediaKind || null
      );
      if (info.changes > 0) {
        inserted.push({ id: info.lastInsertRowid, content: String(m.content || '') });
      }
    }
    // 搜索索引已就绪时同步写入,保证导入完成后即可搜索新消息
    if (inserted.length) indexMessages(inserted);
  });
  try {
    tx(messages);
  } catch (err) {
    return res.status(500).json({ error: `消息写入失败: ${err.message}` });
  }
  res.json({ ok: true, count: messages.length });
});

/** 媒体文件:backupId, contactHash, mesLocalId, kind;头像 kind=avatar 且 mesLocalId 任意 */
router.post('/media', requireFreeSpace, upload.single('file'), (req, res) => {
  const { backupId, contactHash, mesLocalId, kind } = req.body;
  if (!backupId || !contactHash || !kind || !req.file) {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: '参数错误: 需要 backupId、contactHash、kind 与文件' });
  }
  const ext = kind === 'avatar' ? detectImageType(req.file.path).ext : KIND_EXT[kind];
  if (!ext) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: `不支持的媒体类型: ${kind}` });
  }
  try {
    if (kind === 'avatar') {
      const avatarDir = path.join(MEDIA_DIR, backupId, 'avatars');
      fs.mkdirSync(avatarDir, { recursive: true });
      const fileName = `${contactHash}.${ext}`;
      fs.renameSync(req.file.path, path.join(avatarDir, fileName));
      db.prepare("UPDATE contacts SET avatar = 'avatars/' || ? WHERE backup_id = ? AND hash = ?")
        .run(fileName, backupId, contactHash);
      invalidateSearchDataCache();
      return res.json({ ok: true, kind });
    }
    const mediaDir = path.join(MEDIA_DIR, backupId, contactHash);
    fs.mkdirSync(mediaDir, { recursive: true });
    const fileName = `${mesLocalId}.${ext}`;
    fs.renameSync(req.file.path, path.join(mediaDir, fileName));
    const relPath = `${contactHash}/${fileName}`;
    db.prepare(
      'UPDATE messages SET media_path = ? WHERE backup_id = ? AND contact_hash = ? AND mes_local_id = ?'
    ).run(relPath, backupId, contactHash, Number(mesLocalId));
    res.json({ ok: true, kind });
  } catch (err) {
    fs.rmSync(req.file.path, { force: true });
    res.status(500).json({ error: `媒体保存失败: ${err.message}` });
  }
});

router.post('/user-avatar', requireFreeSpace, upload.single('file'), (req, res) => {
  const { backupId, username } = req.body;
  if (!backupId || !username || !req.file) {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: '参数错误: 需要 backupId、username 与文件' });
  }
  try {
    const userRow = db
      .prepare('SELECT id FROM users WHERE backup_id = ? AND username = ? ORDER BY id DESC LIMIT 1')
      .get(backupId, username);
    if (!userRow) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(404).json({ error: '账号不存在,请先上传备份元信息' });
    }

    const avatarDir = path.join(MEDIA_DIR, backupId, 'users');
    fs.mkdirSync(avatarDir, { recursive: true });
    const ext = detectImageType(req.file.path).ext;
    const fileName = `${crypto.createHash('md5').update(username).digest('hex')}.${ext}`;
    fs.renameSync(req.file.path, path.join(avatarDir, fileName));
    const relPath = `users/${fileName}`;
    db.prepare('UPDATE users SET avatar = ? WHERE backup_id = ? AND username = ?')
      .run(relPath, backupId, username);
    res.json({ ok: true, kind: 'user-avatar' });
  } catch (err) {
    fs.rmSync(req.file.path, { force: true });
    res.status(500).json({ error: `账号头像保存失败: ${err.message}` });
  }
});

router.post('/complete', (req, res) => {
  const { backupId } = req.body || {};
  if (!backupId) return res.status(400).json({ error: '缺少 backupId' });
  const contactCount = db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE backup_id = ?').get(backupId).n;
  const messageCount = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE backup_id = ?').get(backupId).n;
  const mediaCount = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE backup_id = ? AND media_path <> ''")
    .get(backupId).n;
  const pendingMedia = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE backup_id = ? AND media_kind IS NOT NULL AND media_path = ''")
    .get(backupId).n;
  db.prepare(`
    UPDATE backups
    SET contact_count = ?, message_count = ?, media_count = ?,
        completed_at = datetime('now','localtime')
    WHERE id = ?
  `).run(contactCount, messageCount, mediaCount, backupId);
  db.prepare(
    `UPDATE contacts SET message_count =
       (SELECT COUNT(*) FROM messages m WHERE m.contact_id = contacts.id)
     WHERE backup_id = ?`
  ).run(backupId);
  // 只清理旧汇总;实际统计在首次查询「我」页时由独立 worker 计算,
  // 避免导入完成接口同步执行千万级 GROUP BY 卡住事件循环。
  clearOwnerStats();
  clearStatsCache();
  invalidateSearchDataCache();
  res.json({ ok: true, contactCount, messageCount, mediaCount, pendingMedia });
});

/**
 * 未完成的导入列表。用于客户端重启后找回中断的 backupId,
 * 继续上传而不是重新生成 UUID。
 */
router.get('/incomplete', (req, res) => {
  const rows = db.prepare(`
    SELECT b.id, b.device_name, b.product_type, b.ios_version, b.serial_number,
           b.backup_date, b.source_path, b.created_at,
           (SELECT COUNT(*) FROM contacts c WHERE c.backup_id = b.id) AS contacts,
           (SELECT COUNT(*) FROM messages m WHERE m.backup_id = b.id) AS messages,
           (SELECT COUNT(*) FROM messages m
             WHERE m.backup_id = b.id AND m.media_kind IS NOT NULL AND m.media_path = '') AS pending_media
    FROM backups b
    WHERE b.completed_at IS NULL
    ORDER BY b.created_at DESC
  `).all();
  res.json({
    items: rows.map((row) => ({
      id: row.id,
      deviceName: row.device_name,
      productType: row.product_type,
      iosVersion: row.ios_version,
      serialNumber: row.serial_number,
      backupDate: row.backup_date,
      sourcePath: row.source_path,
      source: isServerBackupPath(row.source_path) ? 'server' : 'client',
      createdAt: row.created_at,
      contacts: row.contacts,
      messages: row.messages,
      pendingMedia: row.pending_media,
    })),
  });
});

/**
 * 导入进度:按联系人返回服务端已有的消息数、最大 MesLocalID 与待补媒体数。
 * 客户端据此跳过已完成的联系人和消息块,并只补传缺失媒体。
 */
router.get('/status', (req, res) => {
  const backupId = String(req.query.backupId || '');
  if (!backupId) return res.status(400).json({ error: '缺少 backupId' });
  const backup = db.prepare(`
    SELECT id, device_name, product_type, ios_version, serial_number, backup_date,
           source_path, created_at, completed_at, user_count, contact_count, message_count, media_count
    FROM backups WHERE id = ?
  `).get(backupId);
  if (!backup) return res.status(404).json({ error: '备份不存在' });

  const contactRows = db.prepare(`
    SELECT hash, avatar <> '' AS has_avatar
    FROM contacts WHERE backup_id = ?
  `).all(backupId);
  const progressRows = db.prepare(`
    SELECT contact_hash,
           COUNT(*) AS messages,
           MAX(mes_local_id) AS max_mes_local_id,
           SUM(CASE WHEN media_kind IS NOT NULL AND media_path = '' THEN 1 ELSE 0 END) AS pending_media
    FROM messages
    WHERE backup_id = ?
    GROUP BY contact_hash
  `).all(backupId);
  const progressByHash = new Map(progressRows.map((row) => [row.contact_hash, row]));
  const contacts = contactRows.map((row) => {
    const progress = progressByHash.get(row.hash);
    return {
      hash: row.hash,
      hasAvatar: Boolean(row.has_avatar),
      messages: progress ? Number(progress.messages) : 0,
      maxMesLocalId: progress ? Number(progress.max_mes_local_id) || 0 : 0,
      pendingMedia: progress ? Number(progress.pending_media) || 0 : 0,
    };
  });
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS messages,
      SUM(CASE WHEN media_path <> '' THEN 1 ELSE 0 END) AS media,
      SUM(CASE WHEN media_kind IS NOT NULL AND media_path = '' THEN 1 ELSE 0 END) AS pending_media
    FROM messages WHERE backup_id = ?
  `).get(backupId);
  res.json({
    backup: {
      id: backup.id,
      deviceName: backup.device_name,
      productType: backup.product_type,
      iosVersion: backup.ios_version,
      serialNumber: backup.serial_number,
      backupDate: backup.backup_date,
      sourcePath: backup.source_path,
      createdAt: backup.created_at,
      completedAt: backup.completed_at,
      userCount: backup.user_count,
      contactCount: backup.contact_count,
      messageCount: backup.message_count,
      mediaCount: backup.media_count,
    },
    totals: {
      contacts: contacts.length,
      messages: Number(totals.messages) || 0,
      media: Number(totals.media) || 0,
      pendingMedia: Number(totals.pending_media) || 0,
    },
    contacts,
  });
});

/** 分页读取缺失媒体,供断点续传只补传失败/未上传的文件 */
router.get('/pending-media', (req, res) => {
  const backupId = String(req.query.backupId || '');
  if (!backupId) return res.status(400).json({ error: '缺少 backupId' });
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(10000, Math.max(1, Number(req.query.pageSize) || 2000));
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE backup_id = ? AND media_kind IS NOT NULL AND media_path = ''
  `).get(backupId).n;
  const items = db.prepare(`
    SELECT contact_hash, mes_local_id, media_kind
    FROM messages
    WHERE backup_id = ? AND media_kind IS NOT NULL AND media_path = ''
    ORDER BY contact_hash, mes_local_id
    LIMIT ? OFFSET ?
  `).all(backupId, pageSize, (page - 1) * pageSize).map((row) => ({
    contactHash: row.contact_hash,
    mesLocalId: Number(row.mes_local_id),
    mediaKind: row.media_kind,
  }));
  res.json({
    items,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  });
});

// multer 的临时文件写入错误(如磁盘满)统一返回 507,避免继续写库
router.use((err, req, res, next) => {
  if (err && err.code === 'ENOSPC') {
    return res.status(507).json({ error: '服务器磁盘空间不足,请清理后继续导入' });
  }
  return next(err);
});

module.exports = router;
