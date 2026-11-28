/**
 * 聊天记录查询接口:分页 + 搜索 + 时间范围 + 日期窗口。
 *   GET /api/contacts/:id/messages  分页(默认从最新往回翻页)
 *   GET /api/contacts/:id/messages?anchorDate=YYYY-MM-DD&offset=&before=50&after=49
 *       某天最早消息及其前后窗口;anchorId=<消息id> 以指定消息为中心;
 *       beforeId/afterId 用于窗口上下继续翻页
 *   GET /api/messages/:id/media     消息媒体文件
 */

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { normalizeRefer } = require('@wepo/core');
const { db, MEDIA_DIR, escapeLike } = require('../db');
const { getOwnerBackupCount } = require('../merged');
const { sendFileWithValidation, detectImageType } = require('../file-response');
const { ensureEmojiAsset } = require('../emoji-cache');
const { ensureWxgfJpeg, isWxgfFile } = require('../wxgf');
const { ensureVoiceWav } = require('../voice-convert');

const router = express.Router();

const MEDIA_CONTENT_TYPE = { jpg: 'image/jpeg', aud: 'audio/amr', mp4: 'video/mp4' };
const LINK_THUMB_DOMAIN = 'AppDomain-com.tencent.xin';

/** 发送本地图片;文件不存在返回 false,由调用方继续尝试其他来源 */
async function serveImageFile(req, res, file) {
  if (!file) return false;
  try {
    await fs.promises.access(file, fs.constants.R_OK);
  } catch (err) {
    return false;
  }
  sendFileWithValidation(
    req,
    res,
    file,
    detectImageType(file).contentType,
    'private, max-age=31536000, immutable'
  );
  return true;
}

/**
 * 聊天内快速搜索分类。日期不在这里处理,由前端按本地时区传入 from/to。
 * extra 始终是导入时写入的 JSON(或 NULL),因此可直接使用 json_extract。
 */
const MESSAGE_CATEGORY_FILTERS = {
  image_video: "media_kind IN ('image', 'video')",
  file: "type = 49 AND CAST(json_extract(extra, '$.appType') AS INTEGER) IN (6, 74)",
  // appType 4 是“视频”应用消息,但展示与链接卡一致,也纳入链接列表。
  link: "type = 49 AND CAST(json_extract(extra, '$.appType') AS INTEGER) IN (2, 4, 5)",
  music_audio: "(type = 34 OR (type = 49 AND CAST(json_extract(extra, '$.appType') AS INTEGER) IN (3, 76, 92, 996)))",
  transaction: "type = 49 AND CAST(json_extract(extra, '$.appType') AS INTEGER) IN (21, 2000, 2001, 2002, 2003)",
  miniapp: "type = 49 AND (CAST(json_extract(extra, '$.appType') AS INTEGER) IN (33, 36) OR json_extract(extra, '$.weapp') IS NOT NULL)",
  channels: "type = 49 AND (CAST(json_extract(extra, '$.appType') AS INTEGER) = 51 OR json_extract(extra, '$.url') LIKE '%finder%' OR json_extract(extra, '$.url') LIKE '%channels.weixin.qq.com%' OR json_extract(extra, '$.url') LIKE '%wxv_%' OR json_extract(extra, '$.title') LIKE '%视频号%')",
  contact: 'type IN (42, 66)',
  location: "(type = 48 OR (type = 49 AND CAST(json_extract(extra, '$.appType') AS INTEGER) = 17))",
  note: "type = 49 AND CAST(json_extract(extra, '$.appType') AS INTEGER) = 24",
  product_shop: "type = 49 AND (json_extract(extra, '$.url') LIKE '%//item.jd.com/%' OR json_extract(extra, '$.url') LIKE '%//item.m.jd.com/%' OR json_extract(extra, '$.url') LIKE '%//item.taobao.com/%' OR json_extract(extra, '$.url') LIKE '%//detail.tmall.com/%' OR json_extract(extra, '$.url') LIKE '%//mobile.yangkeduo.com/%' OR json_extract(extra, '$.url') LIKE '%//pinduoduo.com/%' OR json_extract(extra, '$.url') LIKE '%//yangkeduo.com/%' OR json_extract(extra, '$.url') LIKE '%//store.weixin.qq.com/%' OR json_extract(extra, '$.url') LIKE '%//shop.weixin.qq.com/%')",
  gift: "type = 49 AND (json_extract(extra, '$.title') LIKE '%礼物%' OR json_extract(extra, '$.des') LIKE '%礼物%' OR json_extract(extra, '$.url') LIKE '%gift%')",
  emoji: 'type = 47',
};

const stickerUrlStmt = db.prepare('SELECT cdnurl FROM sticker_urls WHERE md5 = ?');

/** 新版表情消息可能只保存 md5;从其他消息/备份补出的 URL 表里找地址 */
function stickerUrlFor(md5) {
  if (!md5 || !/^[a-f0-9]{32}$/i.test(md5)) return '';
  const row = stickerUrlStmt.get(md5.toLowerCase());
  return row && typeof row.cdnurl === 'string' ? row.cdnurl : '';
}

function toMessageDto(row) {
  let extra = row.extra ? safeJson(row.extra) : null;
  if (extra && extra.refer && typeof extra.refer === 'object') {
    extra = { ...extra, refer: normalizeRefer(extra.refer) };
  }
  const emojiMd5 = row.type === 47 && extra && typeof extra.md5 === 'string'
    ? extra.md5
    : '';
  const directEmojiUrl = extra
    ? (typeof extra.cdnurl === 'string' && extra.cdnurl)
      || (typeof extra.thumburl === 'string' && extra.thumburl)
      || ''
    : '';
  const emojiUrl = directEmojiUrl || stickerUrlFor(emojiMd5);
  return {
    id: row.id,
    mesLocalId: row.mes_local_id,
    mesSvrId: row.mes_svr_id,
    type: row.type,
    isSent: Boolean(row.is_sent),
    sender: row.sender,
    content: row.content,
    extra,
    createTime: row.create_time,
    mediaKind: row.media_kind,
    mediaPath: row.media_path
      ? `/api/messages/${row.id}/media?v=${encodeURIComponent(row.media_path)}`
      : '',
    emojiMd5,
    emojiPath: emojiMd5 && emojiUrl
      ? `/api/messages/${row.id}/emoji?v=${encodeURIComponent(emojiMd5)}`
      : '',
  };
}

function safeJson(str) {
  try {
    return JSON.parse(str);
  } catch (err) {
    return null;
  }
}

router.get('/contacts/:id/messages', (req, res) => {
  // 任意一次导入中的联系人 id 都可用于定位 owner + hash
  const contactId = Number(req.params.id);
  const contact = db
    .prepare('SELECT owner, hash, members, is_chatroom, username, nickname, remark FROM contacts WHERE id = ?')
    .get(contactId);
  if (!contact) return res.status(404).json({ error: '联系人不存在' });

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
  const search = (req.query.search || '').trim();
  const category = String(req.query.category || '').trim();
  const sender = String(req.query.sender || '').trim();
  const from = Number(req.query.from) || 0; // 起始时间(秒)
  const to = Number(req.query.to) || 0; // 结束时间(秒)
  if (category && !MESSAGE_CATEGORY_FILTERS[category]) {
    return res.status(400).json({ error: '未知的消息分类' });
  }

  // 群聊发送者:群昵称优先,没有群昵称时用联系人微信昵称;同时解析发送者头像
  const groupNicknames = new Map();
  if (contact.is_chatroom && contact.members) {
    try {
      const members = JSON.parse(contact.members);
      for (const member of Array.isArray(members) ? members : []) {
        const username = String(member.username || '').trim();
        const displayName = String(member.displayName || '').trim();
        if (username && displayName) groupNicknames.set(username, displayName);
      }
    } catch (err) {
      /* 忽略损坏的 members JSON */
    }
  }
  const senderInfoStmt = db.prepare(`
    SELECT id, nickname, remark, avatar FROM contacts
    WHERE owner = ? AND hash = ?
    ORDER BY id DESC
  `);
  const senderInfoCache = new Map();
  const senderInfoFor = (sender) => {
    if (!sender) return { name: '', avatar: '' };
    if (senderInfoCache.has(sender)) return senderInfoCache.get(sender);
    const hash = crypto.createHash('md5').update(sender, 'utf8').digest('hex');
    const rows = senderInfoStmt.all(contact.owner, hash);
    const groupName = groupNicknames.get(sender) || '';
    let remark = '';
    let nickname = '';
    let avatarRow = null;
    for (const row of rows) {
      if (!remark && row.remark) remark = row.remark;
      if (!nickname && row.nickname) nickname = row.nickname;
      if (!avatarRow && row.avatar) avatarRow = row;
    }
    const contactName = remark || nickname || '';
    const info = {
      name: groupName || contactName || sender,
      avatar: avatarRow
        ? `/api/contacts/${avatarRow.id}/avatar?v=${encodeURIComponent(avatarRow.avatar)}`
        : '',
    };
    senderInfoCache.set(sender, info);
    return info;
  };
  // 转账付款人/收款人:优先联系人备注,其次微信昵称,再次群昵称。
  // 找不到可靠姓名时留空,避免把 wxid 直接显示成收款人。
  const transferInfoStmt = db.prepare(`
    SELECT nickname, remark FROM contacts
    WHERE owner = ? AND hash = ?
    ORDER BY
      CASE WHEN remark IS NOT NULL AND remark <> '' THEN 1 ELSE 0 END DESC,
      CASE WHEN nickname IS NOT NULL AND nickname <> '' THEN 1 ELSE 0 END DESC,
      id DESC
    LIMIT 1
  `);
  const transferNameCache = new Map();
  const transferNameFor = (username) => {
    const raw = String(username || '').trim();
    if (!raw) return '';
    if (transferNameCache.has(raw)) return transferNameCache.get(raw);
    const hash = crypto.createHash('md5').update(raw, 'utf8').digest('hex');
    const row = transferInfoStmt.get(contact.owner, hash);
    const name = String(row && row.remark ? row.remark : '').trim()
      || String(row && row.nickname ? row.nickname : '').trim()
      || groupNicknames.get(raw)
      || '';
    transferNameCache.set(raw, name);
    return name;
  };
  const chatPeerName = String(contact.remark || '').trim()
    || String(contact.nickname || '').trim();
  const ownerUsername = String(contact.owner || '').trim().toLowerCase();
  const isSelfUsername = (username) => (
    Boolean(ownerUsername)
    && String(username || '').trim().toLowerCase() === ownerUsername
  );
  const enrichTransferNames = (dto, row) => {
    const extra = dto.extra;
    if (!extra || dto.type !== 49 || Number(extra.appType) !== 2000) return dto;
    const pay = extra.pay && typeof extra.pay === 'object' ? extra.pay : {};
    const payerUsername = String(pay.payerUsername || '').trim();
    const receiverUsername = String(pay.receiverUsername || '').trim();
    let payerName = payerUsername && !isSelfUsername(payerUsername)
      ? transferNameFor(payerUsername)
      : '';
    let receiverName = receiverUsername && !isSelfUsername(receiverUsername)
      ? transferNameFor(receiverUsername)
      : '';
    if (!contact.is_chatroom) {
      // 单聊的付款人/收款人至少有一方就是聊天对象
      if (!dto.isSent && !payerName) payerName = chatPeerName;
      if (dto.isSent && !receiverName) receiverName = chatPeerName;
    } else if (!dto.isSent && !payerName && row.sender) {
      // 群聊收到的转账:付款人通常就是消息发送者
      payerName = transferNameFor(row.sender);
    }
    if (!payerName && !receiverName) return dto;
    return {
      ...dto,
      extra: { ...extra, pay: { ...pay, payerName, receiverName } },
    };
  };
  const toDto = (row) => {
    const info = senderInfoFor(row.sender);
    const dto = {
      ...toMessageDto(row),
      senderName: info.name,
      senderAvatar: info.avatar,
    };
    return enrichTransferNames(dto, row);
  };

  const filters = [];
  const filterParams = [];
  if (search) {
    filters.push("content LIKE ? ESCAPE '\\'");
    filterParams.push(`%${escapeLike(search)}%`);
  }
  if (from > 0) {
    filters.push('create_time >= ?');
    filterParams.push(from);
  }
  if (to > 0) {
    filters.push('create_time <= ?');
    filterParams.push(to);
  }
  if (sender) {
    filters.push('sender = ?');
    filterParams.push(sender);
  }
  if (category) filters.push(MESSAGE_CATEGORY_FILTERS[category]);

  // 以某天最早消息/指定消息为中心加载窗口;beforeId/afterId 用于在该窗口上下继续翻页。
  // 这条分支只服务于聊天内跳转,不与其他过滤条件混用。
  const anchorDate = String(req.query.anchorDate || '').trim();
  const anchorId = Number(req.query.anchorId) || 0;
  const beforeId = Number(req.query.beforeId) || 0;
  const afterId = Number(req.query.afterId) || 0;
  const windowLimit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const beforeCount = Math.min(500, Math.max(0, Number(req.query.before) || 0));
  const afterCount = Math.min(500, Math.max(0, Number(req.query.after) || 0));
  const tzOffset = Math.max(-14 * 3600, Math.min(14 * 3600, Number(req.query.offset) || 0));
  if (anchorDate || anchorId || beforeId || afterId) {
    if (anchorDate && !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) {
      return res.status(400).json({ error: '日期格式无效' });
    }
    if ([Boolean(anchorDate), Boolean(anchorId), Boolean(beforeId), Boolean(afterId)]
      .filter(Boolean).length > 1) {
      return res.status(400).json({ error: '窗口参数不能组合使用' });
    }
    if (search || from > 0 || to > 0 || sender || category) {
      return res.status(400).json({ error: '窗口查询不支持其他过滤条件' });
    }

    const singleBackup = getOwnerBackupCount(contact.owner) === 1;
    const dedupCte = `
      WITH msg AS (
        SELECT m.*,
               ROW_NUMBER() OVER (
                 PARTITION BY c.owner, m.contact_hash, m.mes_local_id
                 ORDER BY (CASE WHEN m.media_path <> '' THEN 1 ELSE 0 END) DESC, m.id DESC
               ) AS row_num
        FROM messages m
        JOIN contacts c ON c.id = m.contact_id
        WHERE c.owner = ? AND m.contact_hash = ?
      )`;
    const prefix = singleBackup ? '' : `${dedupCte} `;
    const fromSql = singleBackup ? 'messages' : 'msg';
    const baseWhere = singleBackup ? 'contact_id = ?' : 'row_num = 1';
    const baseParams = singleBackup ? [contactId] : [contact.owner, contact.hash];

    const runWindow = (extraWhere, extraParams, tail, tailParams = []) => db
      .prepare(`${prefix}SELECT * FROM ${fromSql} WHERE ${baseWhere} AND ${extraWhere} ${tail}`)
      .all(...baseParams, ...extraParams, ...tailParams);

    let cursor = null;
    if (beforeId || afterId) {
      cursor = db
        .prepare(`${prefix}SELECT id, create_time FROM ${fromSql} WHERE ${baseWhere} AND id = ?`)
        .get(...baseParams, beforeId || afterId);
      if (!cursor) return res.status(404).json({ error: '消息不存在' });
    }

    let anchor = null;
    if (anchorDate) {
      anchor = db
        .prepare(
          `${prefix}SELECT id, create_time FROM ${fromSql}
           WHERE ${baseWhere} AND date(create_time + ?, 'unixepoch') = ?
           ORDER BY create_time ASC, id ASC LIMIT 1`
        )
        .get(...baseParams, tzOffset, anchorDate);
      if (!anchor) {
        return res.json({
          items: [], anchorId: null, hasOlder: false, hasNewer: false,
          merged: !singleBackup,
        });
      }
    } else if (anchorId) {
      anchor = db
        .prepare(`${prefix}SELECT id, create_time FROM ${fromSql} WHERE ${baseWhere} AND id = ?`)
        .get(...baseParams, anchorId);
      if (!anchor) return res.status(404).json({ error: '消息不存在' });
    }

    const olderCondition = '(create_time < ? OR (create_time = ? AND id < ?))';
    const newerCondition = '(create_time > ? OR (create_time = ? AND id > ?))';
    const keyParams = (row) => [row.create_time, row.create_time, row.id];

    if (anchor) {
      const olderRows = runWindow(
        olderCondition,
        keyParams(anchor),
        'ORDER BY create_time DESC, id DESC LIMIT ?',
        [beforeCount + 1]
      );
      const hasOlder = olderRows.length > beforeCount;
      const olderItems = olderRows.slice(0, beforeCount).reverse();

      // 包含锚点本身 + 之后 N 条,额外多取 1 条判断是否还有更新消息
      const newerRows = runWindow(
        '(create_time > ? OR (create_time = ? AND id >= ?))',
        keyParams(anchor),
        'ORDER BY create_time ASC, id ASC LIMIT ?',
        [afterCount + 2]
      );
      const hasNewer = newerRows.length > afterCount + 1;
      const newerItems = newerRows.slice(0, afterCount + 1);

      return res.json({
        items: olderItems.concat(newerItems).map(toDto),
        anchorId: anchor.id,
        hasOlder,
        hasNewer,
        merged: !singleBackup,
      });
    }

    if (beforeId) {
      const rows = runWindow(
        olderCondition,
        keyParams(cursor),
        'ORDER BY create_time DESC, id DESC LIMIT ?',
        [windowLimit + 1]
      );
      const hasOlder = rows.length > windowLimit;
      return res.json({
        items: rows.slice(0, windowLimit).reverse().map(toDto),
        hasOlder,
        merged: !singleBackup,
      });
    }

    const rows = runWindow(
      newerCondition,
      keyParams(cursor),
      'ORDER BY create_time ASC, id ASC LIMIT ?',
      [windowLimit + 1]
    );
    const hasNewer = rows.length > windowLimit;
    return res.json({
      items: rows.slice(0, windowLimit).map(toDto),
      hasNewer,
      merged: !singleBackup,
    });
  }

  // 单次导入:消息没有跨导入重复,直接按 contact_id 走索引,避免窗口函数排序百万行
  if (getOwnerBackupCount(contact.owner) === 1) {
    const where = ['contact_id = ?', ...filters];
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const params = [contactId, ...filterParams];
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM messages ${whereSql}`)
      .get(...params).n;
    const items = db
      .prepare(`
        SELECT * FROM messages ${whereSql}
        ORDER BY create_time DESC, id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params, pageSize, (page - 1) * pageSize)
      .map(toDto)
      .reverse();
    return res.json({
      items,
      total,
      page,
      pageSize,
      merged: false,
      hasMore: page * pageSize < total,
    });
  }

  // 跨导入合并:同一 (owner, contact_hash, mes_local_id) 只保留一条;
  // 优先保留带媒体文件的行,其次保留最新导入的行。
  // 默认消息列表:按 mes_local_id 分组去重,比 ROW_NUMBER 对全部历史消息
  // 做窗口排序快一个数量级(多个导入时千万级会话可从数秒降到数百毫秒)。
  // 过滤条件来自 messages 表,这里统一加 m. 前缀避免与 contacts 列名冲突。
  const qualifiedFilters = filters.map((filter) => filter.replace(
    /\b(content|create_time|sender|type|media_kind|extra)\b/g,
    'm.$1'
  ));
  const chosenCte = `
    WITH grouped AS (
      SELECT m.mes_local_id,
             MAX(CASE WHEN m.media_path <> '' THEN m.id ELSE 0 END) AS media_id,
             MAX(m.id) AS latest_id
      FROM messages m
      JOIN contacts c ON c.id = m.contact_id
      WHERE c.owner = ? AND m.contact_hash = ?
      GROUP BY m.mes_local_id
    ),
    chosen AS (
      SELECT CASE WHEN grouped.media_id > 0 THEN grouped.media_id ELSE grouped.latest_id END AS chosen_id
      FROM grouped
    )`;
  // 过滤条件必须在选出代表行之后应用:同一条消息在不同备份中的 create_time
  // 可能不同,先过滤再分组会选中另一份副本,和旧版 ROW_NUMBER 语义不一致。
  const filterSql = qualifiedFilters.length
    ? `WHERE ${qualifiedFilters.join(' AND ')}`
    : '';
  const params = [contact.owner, contact.hash, ...filterParams];

  const total = qualifiedFilters.length
    ? db.prepare(`
        ${chosenCte}
        SELECT COUNT(*) AS n
        FROM chosen
        JOIN messages m ON m.id = chosen.chosen_id
        ${filterSql}
      `).get(...params).n
    : db.prepare(`
        SELECT COUNT(DISTINCT m.mes_local_id) AS n
        FROM messages m
        JOIN contacts c ON c.id = m.contact_id
        WHERE c.owner = ? AND m.contact_hash = ?
      `).get(...params).n;

  const items = db
    .prepare(`
      ${chosenCte},
      page_ids AS (
        SELECT chosen.chosen_id, m.create_time, m.id
        FROM chosen
        JOIN messages m ON m.id = chosen.chosen_id
        ${filterSql}
        ORDER BY m.create_time DESC, m.id DESC
        LIMIT ? OFFSET ?
      )
      SELECT m.*
      FROM page_ids
      JOIN messages m ON m.id = page_ids.chosen_id
      ORDER BY page_ids.create_time DESC, page_ids.id DESC
    `)
    .all(...params, pageSize, (page - 1) * pageSize)
    .map(toDto)
    .reverse(); // 返回时间升序,便于客户端直接渲染

  res.json({
    items,
    total,
    page,
    pageSize,
    merged: true,
    // 是否还有更早的消息
    hasMore: page * pageSize < total,
  });
});

/** 聊天内“日期”快速搜索:按客户端本地时区返回有消息的日期及数量 */
router.get('/contacts/:id/message-dates', (req, res) => {
  const contactId = Number(req.params.id);
  const contact = db
    .prepare('SELECT owner, hash FROM contacts WHERE id = ?')
    .get(contactId);
  if (!contact) return res.status(404).json({ error: '联系人不存在' });

  // 客户端传入的时区偏移(秒):create_time + offset 后的 UTC 日期即本地日期
  const offset = Math.max(-14 * 3600, Math.min(14 * 3600, Number(req.query.offset) || 0));

  let rows;
  if (getOwnerBackupCount(contact.owner) === 1) {
    rows = db.prepare(`
      SELECT date(create_time + ?, 'unixepoch') AS date, COUNT(*) AS count
      FROM messages
      WHERE contact_id = ? AND date(create_time + ?, 'unixepoch') IS NOT NULL
      GROUP BY date
      ORDER BY date
    `).all(offset, contactId, offset);
  } else {
    const dedupCte = `
      WITH msg AS (
        SELECT m.*,
               ROW_NUMBER() OVER (
                 PARTITION BY c.owner, m.contact_hash, m.mes_local_id
                 ORDER BY (CASE WHEN m.media_path <> '' THEN 1 ELSE 0 END) DESC, m.id DESC
               ) AS row_num
        FROM messages m
        JOIN contacts c ON c.id = m.contact_id
        WHERE c.owner = ? AND m.contact_hash = ?
      )`;
    rows = db.prepare(`
      ${dedupCte}
      SELECT date(create_time + ?, 'unixepoch') AS date, COUNT(*) AS count
      FROM msg
      WHERE row_num = 1 AND date(create_time + ?, 'unixepoch') IS NOT NULL
      GROUP BY date
      ORDER BY date
    `).all(contact.owner, contact.hash, offset, offset);
  }

  const dates = rows.map((row) => ({ date: row.date, count: row.count }));
  const total = dates.reduce((sum, row) => sum + row.count, 0);
  res.json({
    dates,
    total,
    earliest: dates.length ? dates[0].date : '',
    latest: dates.length ? dates[dates.length - 1].date : '',
  });
});

/**
 * 聊天内“图片与视频”按月分组:返回有内容的月份及数量,供客户端整月加载。
 * offset 与 message-dates 相同,为客户端本地时区偏移(秒)。
 */
router.get('/contacts/:id/media-months', (req, res) => {
  const contactId = Number(req.params.id);
  const contact = db
    .prepare('SELECT owner, hash FROM contacts WHERE id = ?')
    .get(contactId);
  if (!contact) return res.status(404).json({ error: '联系人不存在' });

  const offset = Math.max(-14 * 3600, Math.min(14 * 3600, Number(req.query.offset) || 0));
  const category = String(req.query.category || 'image_video').trim();
  const filter = MESSAGE_CATEGORY_FILTERS[category];
  if (!filter) return res.status(400).json({ error: '未知的消息分类' });

  let rows;
  if (getOwnerBackupCount(contact.owner) === 1) {
    rows = db.prepare(`
      SELECT strftime('%Y-%m', create_time + ?, 'unixepoch') AS month, COUNT(*) AS count
      FROM messages
      WHERE contact_id = ? AND create_time > 0 AND ${filter}
      GROUP BY month
      ORDER BY month
    `).all(offset, contactId);
  } else {
    const dedupCte = `
      WITH msg AS (
        SELECT m.*,
               ROW_NUMBER() OVER (
                 PARTITION BY c.owner, m.contact_hash, m.mes_local_id
                 ORDER BY (CASE WHEN m.media_path <> '' THEN 1 ELSE 0 END) DESC, m.id DESC
               ) AS row_num
        FROM messages m
        JOIN contacts c ON c.id = m.contact_id
        WHERE c.owner = ? AND m.contact_hash = ?
      )`;
    rows = db.prepare(`
      ${dedupCte}
      SELECT strftime('%Y-%m', create_time + ?, 'unixepoch') AS month, COUNT(*) AS count
      FROM msg
      WHERE row_num = 1 AND create_time > 0 AND ${filter}
      GROUP BY month
      ORDER BY month
    `).all(contact.owner, contact.hash, offset);
  }

  const months = rows
    .filter((row) => row.month)
    .map((row) => ({ month: row.month, count: row.count }));
  const total = months.reduce((sum, row) => sum + row.count, 0);
  res.json({
    months,
    total,
    earliest: months.length ? months[0].month : '',
    latest: months.length ? months[months.length - 1].month : '',
  });
});

/**
 * 引用消息 → 被引用的原消息。
 * 优先用 refermsg.svrid 匹配 mes_svr_id,其次用引用里的 createTime + 发送者,
 * 最后用原文内容就近匹配;始终限定在同一账号、同一会话内。
 */
router.get('/messages/:id/quote-target', (req, res) => {
  const row = db
    .prepare(`
      SELECT m.id, m.type, m.contact_hash, m.extra, c.owner, c.hash
      FROM messages m
      JOIN contacts c ON c.id = m.contact_id
      WHERE m.id = ?
    `)
    .get(Number(req.params.id));
  if (!row || Number(row.type) !== 49) {
    return res.status(404).json({ error: '引用消息不存在' });
  }
  const extra = safeJson(row.extra);
  const refer = extra && extra.refer && typeof extra.refer === 'object'
    ? extra.refer
    : null;
  if (!refer) return res.status(404).json({ error: '没有引用内容' });

  const cte = `
    WITH msg AS (
      SELECT m.*,
             ROW_NUMBER() OVER (
               PARTITION BY c.owner, m.contact_hash, m.mes_local_id
               ORDER BY (CASE WHEN m.media_path <> '' THEN 1 ELSE 0 END) DESC, m.id DESC
             ) AS row_num
      FROM messages m
      JOIN contacts c ON c.id = m.contact_id
      WHERE c.owner = ? AND m.contact_hash = ?
    )`;
  const find = (where, params, order = 'create_time DESC, id DESC') => db
    .prepare(
      `${cte}
       SELECT id, create_time FROM msg
       WHERE row_num = 1 AND id <> ? AND ${where}
       ORDER BY ${order}
       LIMIT 1`
    )
    .get(row.owner, row.contact_hash, row.id, ...params);

  let target = null;
  const svrid = String(refer.svrid || '').trim();
  if (svrid && svrid !== '0') {
    target = find('CAST(mes_svr_id AS TEXT) = ?', [svrid]);
  }
  const referTime = Number(refer.createTime) || 0;
  const fromUser = String(refer.fromusr || '').trim();
  if (!target && referTime && fromUser) {
    target = find('create_time = ? AND sender = ?', [referTime, fromUser]);
  }
  if (!target && referTime) {
    target = find('create_time = ?', [referTime]);
  }
  const content = String(refer.content || '').trim();
  if (!target && referTime && content) {
    target = db
      .prepare(
        `${cte}
         SELECT id, create_time FROM msg
         WHERE row_num = 1 AND id <> ? AND content = ?
         ORDER BY ABS(create_time - ?) ASC, id DESC
         LIMIT 1`
      )
      .get(row.owner, row.contact_hash, row.id, content, referTime);
  }
  if (!target) return res.status(404).json({ error: '未找到引用的原文' });
  res.json({ id: target.id, createTime: target.create_time });
});

router.get('/messages/:id/media', async (req, res) => {
  const row = db
    .prepare('SELECT backup_id, media_path FROM messages WHERE id = ?')
    .get(Number(req.params.id));
  if (!row || !row.media_path) return res.status(404).end();
  const file = path.join(MEDIA_DIR, row.backup_id, row.media_path);
  if (!fs.existsSync(file)) return res.status(404).end();

  const ext = path.extname(file).slice(1).toLowerCase();

  // iOS 微信语音是 SILK 或原始 AMR 帧,浏览器不能直接解码;按需转 WAV 并缓存
  if (ext === 'aud' || ext === 'silk' || ext === 'amr') {
    try {
      const wav = await ensureVoiceWav(file, row.backup_id, row.media_path);
      if (wav) {
        sendFileWithValidation(req, res, wav, 'audio/wav', 'private, no-cache');
        return;
      }
    } catch (err) {
      console.warn(`[voice] 语音转换失败 ${row.backup_id}/${row.media_path}: ${err.message}`);
    }
  }

  // iOS 微信的 wxgf 原图内部是 HEVC,浏览器无法解码;按需转成 JPEG 并缓存
  if (isWxgfFile(file)) {
    try {
      const converted = await ensureWxgfJpeg(file, row.backup_id, row.media_path);
      if (!converted || !fs.existsSync(converted.file)) return res.status(404).end();
      if (converted.ephemeral) {
        res.on('close', () => {
          try { fs.unlinkSync(converted.file); } catch (err) { /* ignore */ }
        });
      }
      sendFileWithValidation(
        req,
        res,
        converted.file,
        'image/jpeg',
        'private, max-age=31536000, immutable'
      );
      return;
    } catch (err) {
      console.warn(`[wxgf] 转换失败 ${row.backup_id}/${row.media_path}: ${err.message}`);
      return res.status(404).end();
    }
  }

  sendFileWithValidation(
    req,
    res,
    file,
    MEDIA_CONTENT_TYPE[ext] || 'application/octet-stream'
  );
});

/**
 * 链接卡片缩略图:旧导入数据只保存了 thumburl,大量文章 XML 只有加密的
 * cdnthumburl。微信同时把缩略图放在 OpenData/<会话hash>/<消息id>.pic_thum,
 * 这里按需从原备份读取并缓存到媒体目录;不修改消息表。
 */
router.get('/messages/:id/link-thumb', async (req, res) => {
  try {
    const row = db
      .prepare(`
        SELECT m.backup_id, m.contact_hash, m.mes_local_id, m.media_path,
               c.owner, b.source_path
        FROM messages m
        JOIN contacts c ON c.id = m.contact_id
        JOIN backups b ON b.id = m.backup_id
        WHERE m.id = ?
      `)
      .get(Number(req.params.id));
    if (!row) return res.status(404).end();

    // 已随导入保存的缩略图优先
    if (row.media_path) {
      const stored = path.join(MEDIA_DIR, row.backup_id, row.media_path);
      if (await serveImageFile(req, res, stored)) return undefined;
    }

    const contactHash = String(row.contact_hash || '');
    const mesLocalId = Number(row.mes_local_id);
    if (!/^[0-9a-f]{32}$/.test(contactHash) || !Number.isInteger(mesLocalId) || mesLocalId < 0) {
      return res.status(404).end();
    }

    const cacheDir = path.join(MEDIA_DIR, row.backup_id, contactHash);
    const cacheFile = path.join(cacheDir, `link-thumb-${mesLocalId}`);
    if (await serveImageFile(req, res, cacheFile)) return undefined;

    const sourcePath = String(row.source_path || '');
    if (!sourcePath) return res.status(404).end();
    const ownerHash = crypto
      .createHash('md5')
      .update(String(row.owner || ''), 'utf8')
      .digest('hex');
    const relativePath = `Documents/${ownerHash}/OpenData/${contactHash}/${mesLocalId}.pic_thum`;
    const fileId = crypto
      .createHash('sha1')
      .update(`${LINK_THUMB_DOMAIN}-${relativePath}`, 'utf8')
      .digest('hex');
    const sourceFile = path.join(sourcePath, fileId.slice(0, 2), fileId);
    try {
      await fs.promises.access(sourceFile, fs.constants.R_OK);
    } catch (err) {
      return res.status(404).end();
    }

    try {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      const tempFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.copyFile(sourceFile, tempFile);
      await fs.promises.rename(tempFile, cacheFile);
      if (await serveImageFile(req, res, cacheFile)) return undefined;
    } catch (err) {
      // 缓存不可写时仍直接读取原备份
    }
    await serveImageFile(req, res, sourceFile);
    return undefined;
  } catch (err) {
    if (!res.headersSent) res.status(500).end();
    return undefined;
  }
});

/** 合并转发记录内嵌媒体:按 OpenData/<会话hash>/<消息id>/<dataId> 读取 */
const RECORD_MEDIA_DOMAIN = 'AppDomain-com.tencent.xin';

function sniffMediaContentType(file, ext) {
  let header;
  try {
    header = Buffer.alloc(16);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  } catch (err) {
    header = Buffer.alloc(0);
  }
  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (header.length >= 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) return 'video/webm';
  if (header.length >= 5 && header.subarray(0, 5).toString('ascii') === '#!AMR') return 'audio/amr';
  if (header.length >= 3 && header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) return 'audio/mpeg';
  const lower = String(ext || '').toLowerCase();
  if (lower === '.mp4' || lower === '.m4v') return 'video/mp4';
  if (lower === '.mov') return 'video/quicktime';
  if (lower === '.m4a') return 'audio/mp4';
  if (lower === '.aud' || lower === '.amr') return 'audio/amr';
  return detectImageType(file).contentType;
}

router.get('/messages/:id/record-media/:dataId', async (req, res) => {
  try {
    const dataId = String(req.params.dataId || '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(dataId)) return res.status(404).end();
    const row = db.prepare(`
      SELECT m.id, m.backup_id, m.contact_hash, m.mes_local_id,
             c.owner, b.source_path
      FROM messages m
      JOIN contacts c ON c.id = m.contact_id
      JOIN backups b ON b.id = m.backup_id
      WHERE m.id = ?
    `).get(Number(req.params.id));
    if (!row) return res.status(404).end();
    const contactHash = String(row.contact_hash || '');
    const mesLocalId = Number(row.mes_local_id);
    if (!/^[0-9a-f]{32}$/.test(contactHash) || !Number.isInteger(mesLocalId) || mesLocalId < 0) {
      return res.status(404).end();
    }
    const kind = req.query.kind === 'thumb' ? 'thumb' : 'full';
    const cacheDir = path.join(MEDIA_DIR, row.backup_id, 'record-media', String(row.id));
    const cacheBase = path.join(cacheDir, `${dataId}-${kind}`);
    for (const ext of ['', '.jpg', '.png', '.gif', '.webp', '.mp4', '.mov', '.m4a', '.aud', '.record_thumb', '.record_dat', '.record_dat_pre3', '.bin']) {
      const cached = `${cacheBase}${ext}`;
      if (!fs.existsSync(cached)) continue;
      if (await serveImageFile(req, res, cached).catch(() => false)) return undefined;
      if (!res.headersSent && fs.existsSync(cached)) {
        sendFileWithValidation(req, res, cached, sniffMediaContentType(cached, ext),
          'private, max-age=31536000, immutable');
        return undefined;
      }
    }

    const sourcePath = String(row.source_path || '');
    if (!sourcePath) return res.status(404).end();
    const ownerHash = crypto.createHash('md5').update(String(row.owner || ''), 'utf8').digest('hex');
    const suffixes = kind === 'thumb'
      ? ['.record_thumb', '.record_dat_pre3', '.record_dat', '.jpg', '.png', '.gif', '.webp', '']
      : ['.record_dat', '.mp4', '.mov', '.m4a', '.aud', '.jpg', '.png', '.gif', '.webp', '.record_thumb', ''];
    let sourceFile = '';
    let sourceExt = '';
    for (const suffix of suffixes) {
      const relativePath = `Documents/${ownerHash}/OpenData/${contactHash}/${mesLocalId}/${dataId}${suffix}`;
      for (const domain of [RECORD_MEDIA_DOMAIN, 'AppDomainGroup-group.com.tencent.xin']) {
        const fileId = crypto.createHash('sha1').update(`${domain}-${relativePath}`, 'utf8').digest('hex');
        const candidate = path.join(sourcePath, fileId.slice(0, 2), fileId);
        try {
          await fs.promises.access(candidate, fs.constants.R_OK);
          sourceFile = candidate;
          sourceExt = path.extname(suffix);
          break;
        } catch (err) { /* try next */ }
      }
      if (sourceFile) break;
    }
    if (!sourceFile) return res.status(404).end();

    try {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      const cacheExt = sourceExt || '.bin';
      const cacheFile = `${cacheBase}${cacheExt}`;
      const tempFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.copyFile(sourceFile, tempFile);
      await fs.promises.rename(tempFile, cacheFile);
      sendFileWithValidation(req, res, cacheFile, sniffMediaContentType(cacheFile, cacheExt),
        'private, max-age=31536000, immutable');
      return undefined;
    } catch (err) {
      sendFileWithValidation(req, res, sourceFile, sniffMediaContentType(sourceFile, sourceExt),
        'private, no-cache');
      return undefined;
    }
  } catch (err) {
    if (!res.headersSent) res.status(500).end();
    return undefined;
  }
});

/** 表情/贴纸:优先本地缓存;首次请求从微信表情 CDN 下载并按 md5 缓存 */
router.get('/messages/:id/emoji', async (req, res) => {
  try {
    const row = db
      .prepare('SELECT backup_id, type, extra FROM messages WHERE id = ?')
      .get(Number(req.params.id));
    if (!row || row.type !== 47) return res.status(404).end();
    const extra = safeJson(row.extra);
    const md5 = extra && typeof extra.md5 === 'string' ? extra.md5 : '';
    const directUrl = extra
      ? (typeof extra.cdnurl === 'string' && extra.cdnurl)
        || (typeof extra.thumburl === 'string' && extra.thumburl)
        || ''
      : '';
    const cdnurl = directUrl || stickerUrlFor(md5);
    if (!md5) return res.status(404).end();
    const file = await ensureEmojiAsset(MEDIA_DIR, row.backup_id, md5, cdnurl);
    if (!file) return res.status(404).end();
    sendFileWithValidation(
      req,
      res,
      file,
      detectImageType(file).contentType,
      'private, max-age=31536000, immutable'
    );
  } catch (err) {
    if (!res.headersSent) res.status(500).end();
  }
});

module.exports = router;
