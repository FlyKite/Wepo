/**
 * 会话列表全局搜索:
 *   GET /api/search?owner=&q=               三类摘要各前 3 条
 *   GET /api/search?owner=&q=&section=contacts|groups|messages&page=&pageSize=
 *
 * 联系人/群聊复用联系人的合并与好友判定;聊天记录走 messages_fts
 * (正文相邻双字索引),避免在千万级消息上做 LIKE 全表扫描。
 */

const crypto = require('crypto');
const express = require('express');
const { db, escapeLike } = require('../db');
const contactRoutes = require('./contacts');
const {
  compactSearchText,
  ftsMatchForQuery,
  isSearchIndexReady,
} = require('../search-index');

const {
  createContactSearch,
  contactMatchesSearch,
  contactSearchScore,
  pinyinNameMatchScore,
} = contactRoutes;

const router = express.Router();

const SUMMARY_LIMIT = 3;
const DEFAULT_SECTION_PAGE_SIZE = 20;
const MAX_SECTION_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 100;
// 先扫最近插入的 N 条消息;常见词能快速命中,命中不足再回退到 FTS 全量索引
const RECENT_WINDOW = 500000;
// 会话列表首屏只展示 3 条聊天记录,使用更小的窗口降低每次输入后的等待;
// 展开“更多聊天记录”时仍使用完整窗口。
const SUMMARY_RECENT_WINDOW = 200000;
const RECENT_MAX_FETCH = 5000;

function normalizeQuery(value) {
  return String(value || '').trim().slice(0, MAX_QUERY_LENGTH);
}

/** 名称文本/拼音命中;排序:文本完全匹配 > 前缀 > 包含 > 拼音,同分按最近聊天时间 */
function searchContactsFrom(allContacts, query, kind) {
  const search = createContactSearch(query);
  if (!search) return [];
  const items = (allContacts || []).filter((contact) => {
    if (kind === 'contacts' && !contact.isFriend) return false;
    if (kind === 'groups' && !contact.isChatroom) return false;
    return contactMatchesSearch(contact, search);
  });
  return items.sort((a, b) => (
    contactSearchScore(b, search) - contactSearchScore(a, search)
    || (Number(b.lastMessageTime) || 0) - (Number(a.lastMessageTime) || 0)
    || Number(b.id) - Number(a.id)
  ));
}

function searchContacts(owner, query, kind) {
  if (!owner) return [];
  return searchContactsFrom(getSearchContacts(owner), query, kind);
}

// 账号联系人列表/群成员索引在导入完成后基本不变,缓存可避免每次输入都重新
// 合并并构造数万个联系人 DTO。导入、头像更新、完成和删除备份时显式失效。
const searchContactsCache = new Map();
const searchGroupMembersCache = new Map();

function getSearchContacts(owner) {
  if (!owner) return [];
  if (searchContactsCache.has(owner)) return searchContactsCache.get(owner);
  const contacts = contactRoutes.getContactsForOwnerCached(owner);
  searchContactsCache.set(owner, contacts);
  return contacts;
}

function getSearchGroupMemberIndex(owner) {
  if (!owner) return new Map();
  if (searchGroupMembersCache.has(owner)) return searchGroupMembersCache.get(owner);
  const index = getGroupMemberIndex(owner);
  searchGroupMembersCache.set(owner, index);
  return index;
}

function invalidateSearchDataCache() {
  searchContactsCache.clear();
  searchGroupMembersCache.clear();
  contactRoutes.invalidateContactsCache();
}

/** 后台预热账号联系人/群成员缓存,避免服务启动或导入完成后的首次搜索变慢 */
function warmSearchCacheForOwners(owners) {
  for (const owner of Array.isArray(owners) ? owners : []) {
    if (!owner) continue;
    getSearchContacts(owner);
    getSearchGroupMemberIndex(owner);
  }
}

function warmSearchCacheForAllOwners() {
  const owners = db
    .prepare("SELECT DISTINCT owner FROM contacts WHERE owner <> ''")
    .all()
    .map((row) => row.owner);
  warmSearchCacheForOwners(owners);
}

/** 群成员 JSON 单独读取:联系人摘要接口不返回 members,避免列表响应过大 */
function getGroupMemberIndex(owner) {
  if (!owner) return new Map();
  const rows = db.prepare(`
    SELECT c.hash, c.members
    FROM contacts c
    JOIN (
      SELECT hash, MAX(id) AS id
      FROM contacts
      WHERE owner = ? AND is_chatroom = 1
      GROUP BY hash
    ) latest ON latest.id = c.id
  `).all(owner);
  const index = new Map();
  for (const row of rows) {
    let members = [];
    try {
      const parsed = JSON.parse(row.members || '[]');
      if (Array.isArray(parsed)) members = parsed;
    } catch (err) {
      /* 忽略损坏的群成员 JSON */
    }
    index.set(row.hash, members);
  }
  return index;
}

/** username/hash → 联系人,用于把群成员 wxid 还原成联系人的昵称/备注 */
function buildContactIndex(allContacts) {
  const byUsername = new Map();
  const byHash = new Map();
  for (const contact of allContacts || []) {
    const username = String(contact.username || '').trim();
    if (username) {
      byUsername.set(username, contact);
      byUsername.set(username.toLowerCase(), contact);
    }
    const hash = String(contact.hash || '').trim().toLowerCase();
    if (hash) byHash.set(hash, contact);
  }
  return { byUsername, byHash };
}

function memberDisplayName(member, contact, needle) {
  const groupNick = String(member.displayName || '').trim();
  const nickname = contact ? String(contact.nickname || '').trim() : '';
  const remark = contact ? String(contact.remark || '').trim() : '';
  if (nickname && nickname.toLowerCase().includes(needle)) return nickname;
  if (remark && remark.toLowerCase().includes(needle)) return remark;
  if (groupNick && groupNick.toLowerCase().includes(needle)) return groupNick;
  return groupNick || remark || nickname
    || (contact && String(contact.wxName || '').trim())
    || String(member.username || '').trim();
}

/** 返回群内命中搜索词(文本或拼音)的成员显示名(去重,最多由调用方截断) */
function findMemberMatches(members, contactIndex, search) {
  const names = [];
  const seen = new Set();
  for (const member of members) {
    const username = String(member.username || '').trim();
    if (!username) continue;
    const contact = contactIndex.byUsername.get(username)
      || contactIndex.byUsername.get(username.toLowerCase())
      || contactIndex.byHash.get(crypto.createHash('md5').update(username, 'utf8').digest('hex'));
    const groupNick = String(member.displayName || '').trim();
    // 只匹配展示名称,不匹配 wxid/username;否则搜索单个字母会命中所有成员
    const candidates = [
      groupNick,
      contact && contact.nickname,
      contact && contact.remark,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    if (!candidates.some((value) => (
      value.toLowerCase().includes(search.needle)
      || pinyinNameMatchScore(value, search.compact) > 0
    ))) continue;
    const display = memberDisplayName(member, contact, search.needle);
    if (!display || seen.has(display)) continue;
    seen.add(display);
    names.push(display);
  }
  return names;
}

/**
 * 群聊结果 = 群名/备注命中 + 群成员命中。
 * 成员命中时附带 memberMatches(最多 3 个名字)和 memberMatchCount,
 * 前端在群名本身未命中时显示“包含:xxx”。
 */
function searchGroupsFrom(allContacts, query, memberIndex) {
  const search = createContactSearch(query);
  if (!search) return [];
  // 联系人缓存中的对象会被后续搜索复用;复制一份再写入本次查询的群成员命中信息
  const nameMatches = searchContactsFrom(allContacts, query, 'groups')
    .map((group) => ({ ...group }));
  const nameByHash = new Map(nameMatches.map((group) => [group.hash, group]));
  const contactIndex = buildContactIndex(allContacts);
  const memberOnly = [];

  for (const group of allContacts || []) {
    if (!group.isChatroom) continue;
    const members = memberIndex.get(group.hash);
    if (!members || members.length === 0) continue;
    const names = findMemberMatches(members, contactIndex, search);
    if (names.length === 0) continue;
    const info = {
      memberMatches: names.slice(0, 3),
      memberMatchCount: names.length,
    };
    const existing = nameByHash.get(group.hash);
    if (existing) {
      Object.assign(existing, info);
    } else {
      memberOnly.push({
        ...group,
        ...info,
        matchedByMember: true,
        matchedByName: false,
      });
    }
  }

  for (const group of nameMatches) group.matchedByName = true;
  memberOnly.sort((a, b) => (
    b.memberMatchCount - a.memberMatchCount
    || (Number(b.lastMessageTime) || 0) - (Number(a.lastMessageTime) || 0)
    || Number(b.id) - Number(a.id)
  ));
  return nameMatches.concat(memberOnly);
}

function makeSnippet(content, query) {
  const raw = String(content || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const needle = query.toLowerCase();
  const index = raw.toLowerCase().indexOf(needle);
  if (index < 0) return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
  const start = Math.max(0, index - 24);
  const end = Math.min(raw.length, index + query.length + 80);
  return `${start > 0 ? '…' : ''}${raw.slice(start, end)}${end < raw.length ? '…' : ''}`;
}

function mapMessageRows(rows, query) {
  return rows.map((row) => ({
    id: row.id,
    contactHash: row.contact_hash,
    content: makeSnippet(row.content, query),
    createTime: row.message_time,
    isSent: Boolean(row.is_sent),
    sender: row.sender,
    contact: toMessageContact(row),
  }));
}

function messageContactScopeSql() {
  return `(c.is_chatroom = 1
          OR ((c.type & 1) = 1 AND c.username <> '' AND c.username NOT LIKE 'gh_%'))`;
}

/**
 * 最近消息窗口快速搜索。消息表按 id 插入,最近 50 万条通常覆盖当前活跃会话;
 * LIKE 扫描 50 万行约几十毫秒。常用词在这里就能取够结果,避免 FTS 对
 * 百万级 posting list 排序;冷门词取不够时再走全量 FTS。
 */
function searchMessagesRecent(owner, query, limit, offset, recentWindow = RECENT_WINDOW) {
  if (!owner || offset + limit + 1 > RECENT_MAX_FETCH) return null;
  const windowSize = Math.max(1, Number(recentWindow) || RECENT_WINDOW);
  const maxId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').get().id) || 0;
  const minId = maxId - windowSize;
  if (minId <= 0) return null;

  const fetchLimit = Math.min(offset + limit + 61, RECENT_MAX_FETCH);
  const rows = db.prepare(`
    SELECT m.id, m.contact_hash, m.mes_local_id, m.content,
           m.create_time AS message_time, m.is_sent, m.sender,
           c.id AS contact_id, c.backup_id, c.owner, c.hash, c.nickname,
           c.remark, c.wx_name, c.region, c.phone, c.type AS contact_type, c.is_chatroom,
           c.username, c.avatar, c.create_time AS contact_create_time,
           c.message_count, c.last_message_time
    FROM messages m
    JOIN contacts c ON c.id = m.contact_id
    WHERE c.owner = ?
      AND ${messageContactScopeSql()}
      AND m.content LIKE ? ESCAPE '\\'
      AND m.id > ?
    ORDER BY m.create_time DESC, m.id DESC
    LIMIT ?
  `).all(owner, `%${escapeLike(query)}%`, minId, fetchLimit);

  const seen = new Set();
  const unique = [];
  for (const row of rows) {
    const key = `${row.contact_hash}\u0000${row.mes_local_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  if (unique.length <= offset + limit) return null;
  const page = unique.slice(offset, offset + limit + 1);
  return {
    items: mapMessageRows(page.slice(0, limit), query),
    hasMore: page.length > limit,
    indexing: false,
  };
}

function toMessageContact(row) {
  return contactRoutes.toContactDto({
    id: row.contact_id,
    backup_id: row.backup_id,
    owner: row.owner,
    username: row.username,
    hash: row.hash,
    nickname: row.nickname,
    remark: row.remark,
    wx_name: row.wx_name,
    region: row.region,
    phone: row.phone,
    type: row.contact_type,
    is_chatroom: row.is_chatroom,
    avatar: row.avatar,
    create_time: row.contact_create_time,
    message_count: row.message_count,
    last_message_time: row.last_message_time,
    last_message: '',
    last_message_type: 0,
    is_deleted: 0,
  });
}

function searchMessages(owner, query, limit, offset, options = {}) {
  const indexing = !isSearchIndexReady();
  if (!owner || indexing) return { items: [], hasMore: false, indexing };
  const match = ftsMatchForQuery(query);
  const compact = compactSearchText(query);
  if (!match || !compact) return { items: [], hasMore: false, indexing: false };

  // 常见词优先走最近消息窗口,避免 FTS 对超大 posting list 排序
  const recent = searchMessagesRecent(
    owner,
    query,
    limit,
    offset,
    options.recentWindow || RECENT_WINDOW
  );
  if (recent) return recent;

  // 纯字母/数字查询可再用 LIKE 校验完整子串;含空格/标点的查询在 JS 里
  // 用规范化文本校验,并多取一些候选弥补可能的误命中。
  const simple = /^[\p{L}\p{N}]+$/u.test(query);
  // 含空格/标点时先在 JS 规范化校验,需要从 0 取到 offset 之后的候选
  const fetchLimit = simple
    ? limit + 1
    : Math.min(offset + limit + 1 + 60, RECENT_MAX_FETCH);
  const sql = `
    WITH hit AS (
      SELECT m.id, m.contact_hash, m.mes_local_id, m.content,
             m.create_time AS message_time, m.is_sent, m.sender,
             c.id AS contact_id, c.backup_id, c.owner, c.hash, c.nickname,
             c.remark, c.wx_name, c.region, c.phone, c.type AS contact_type, c.is_chatroom,
             c.username, c.avatar, c.create_time AS contact_create_time,
             c.message_count, c.last_message_time,
             ROW_NUMBER() OVER (
               PARTITION BY m.contact_hash, m.mes_local_id
               ORDER BY (CASE WHEN m.media_path <> '' THEN 1 ELSE 0 END) DESC, m.id DESC
             ) AS rn
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN contacts c ON c.id = m.contact_id
      WHERE messages_fts MATCH ?
        AND c.owner = ?
        AND (c.is_chatroom = 1
             OR ((c.type & 1) = 1 AND c.username <> '' AND c.username NOT LIKE 'gh_%'))
        ${simple ? "AND m.content LIKE ? ESCAPE '\\'" : ''}
    )
    SELECT * FROM hit
    WHERE rn = 1
    ORDER BY message_time DESC, id DESC
    LIMIT ? OFFSET ?
  `;
  const params = [match, owner];
  if (simple) params.push(`%${escapeLike(query)}%`);
  params.push(fetchLimit, simple ? offset : 0);

  let rows = db.prepare(sql).all(...params);
  if (!simple) {
    rows = rows
      .filter((row) => compactSearchText(row.content).includes(compact))
      .slice(offset, offset + limit + 1);
  }

  const hasMore = rows.length > limit;
  return {
    items: mapMessageRows(rows.slice(0, limit), query),
    hasMore,
    indexing: false,
  };
}

function emptyResult(extra = {}) {
  return {
    contacts: { items: [], total: 0, hasMore: false },
    groups: { items: [], total: 0, hasMore: false },
    messages: { items: [], hasMore: false },
    ...extra,
  };
}

router.get('/search', (req, res) => {
  const query = normalizeQuery(req.query.q);
  const owner = String(req.query.owner || '').trim();
  const section = String(req.query.section || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(
    MAX_SECTION_PAGE_SIZE,
    Math.max(1, Number(req.query.pageSize) || DEFAULT_SECTION_PAGE_SIZE)
  );

  if (!query) {
    return res.json(emptyResult({ query: '', ownerRequired: !owner, indexing: !isSearchIndexReady() }));
  }

  if (!section) {
    // 同一次请求只合并/加载一次联系人,再分别筛好友和群聊
    const allContacts = getSearchContacts(owner);
    const contacts = searchContactsFrom(allContacts, query, 'contacts');
    const groups = searchGroupsFrom(allContacts, query, getSearchGroupMemberIndex(owner));
    const messages = searchMessages(owner, query, SUMMARY_LIMIT, 0, {
      recentWindow: SUMMARY_RECENT_WINDOW,
    });
    return res.json({
      query,
      contacts: {
        items: contacts.slice(0, SUMMARY_LIMIT),
        total: contacts.length,
        hasMore: contacts.length > SUMMARY_LIMIT,
      },
      groups: {
        items: contactRoutes.enrichContactPreviews(groups.slice(0, SUMMARY_LIMIT)),
        total: groups.length,
        hasMore: groups.length > SUMMARY_LIMIT,
      },
      messages: { items: messages.items, hasMore: messages.hasMore },
      indexing: messages.indexing,
      ownerRequired: !owner,
    });
  }

  if (section === 'contacts' || section === 'groups') {
    let all;
    if (section === 'groups') {
      const allContacts = getSearchContacts(owner);
      all = searchGroupsFrom(allContacts, query, getSearchGroupMemberIndex(owner));
    } else {
      all = searchContacts(owner, query, section);
    }
    const start = (page - 1) * pageSize;
    const pageItems = all.slice(start, start + pageSize);
    return res.json({
      section,
      items: section === 'groups'
        ? contactRoutes.enrichContactPreviews(pageItems)
        : pageItems,
      total: all.length,
      page,
      pageSize,
      hasMore: start + pageSize < all.length,
      indexing: false,
      ownerRequired: !owner,
    });
  }

  if (section === 'messages') {
    const result = searchMessages(owner, query, pageSize, (page - 1) * pageSize);
    return res.json({
      section,
      ...result,
      page,
      pageSize,
      ownerRequired: !owner,
    });
  }

  return res.status(400).json({ error: '未知搜索类别' });
});

module.exports = router;
module.exports.invalidateSearchDataCache = invalidateSearchDataCache;
module.exports.warmSearchCacheForOwners = warmSearchCacheForOwners;
module.exports.warmSearchCacheForAllOwners = warmSearchCacheForAllOwners;
