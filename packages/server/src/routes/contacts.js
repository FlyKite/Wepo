/**
 * 联系人/会话查询接口:分页 + 搜索 + 拼音分组 + 跨导入合并。
 *
 *   GET /api/contacts            合并后的联系人/会话分页列表
 *   GET /api/contacts/grouped    合并后的全量联系人,按拼音排序、首字母分组(含无消息联系人)
 *   GET /api/contacts/tags       标签名称/好友人数与未设置标签人数
 *   GET /api/contacts/:id        合并后的联系人详情
 *   GET /api/contacts/:id/tags   联系人所属标签
 *   GET /api/contacts/:id/avatar 头像(跨导入查找可用的最新头像)
 *
 * 每次导入的数据仍独立存储(用于导入记录与取消导入清理),但查询时按
 * (owner, hash) 合并联系人、按 (owner, contact_hash, mes_local_id) 去重消息。
 */

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, MEDIA_DIR } = require('../db');
const {
  getMergedContactRows,
  getMergedContactSummaries,
  getOwnerBackupCount,
} = require('../merged');
const { sendFileWithValidation, detectImageType } = require('../file-response');

let pinyinPro = null;
try {
  pinyinPro = require('../../vendor/pinyin-pro.js');
} catch (err) {
  console.warn(`[contacts] 拼音库加载失败,分组接口将退化为按原字符排序: ${err.message}`);
}

const router = express.Router();

/**
 * 微信 Friend.type 是位标记:bit0(1)=好友关系,bit2(4)=同群但非好友。
 * 因此 type & 1 为好友;同时排除群聊、公众号(gh_)和空 username 的残留会话。
 * 说明:这些 type 语义来自社区逆向,不同微信版本可能有差异。
 */
function isFriendContact(contact) {
  return Boolean(Number(contact.type) & 1)
    && !contact.isChatroom
    && Boolean(contact.username)
    && !/^gh_/.test(contact.username);
}

function contactAvatarUrl(row) {
  // v 用于让浏览器在重新导入后丢弃以旧 id 缓存下来的头像;v 的值本身不参与查询。
  const version = row.avatar || row.hash || row.id || '';
  return `/api/contacts/${row.id}/avatar?v=${encodeURIComponent(version)}`;
}

/** 展示名:备注优先,没有备注时用微信昵称 */
function contactDisplayName(contact) {
  return String(contact.remark || contact.nickname || contact.username || contact.hash || '');
}

function toContactDto(row) {
  return {
    id: row.id,
    backupId: row.backup_id,
    username: row.username,
    hash: row.hash,
    nickname: row.nickname || '',
    remark: row.remark,
    wxName: row.wx_name,
    region: row.region || '',
    phone: row.phone || '',
    type: row.type,
    isChatroom: Boolean(row.is_chatroom),
    avatar: (row.avatar || row.has_avatar) ? contactAvatarUrl(row) : '',
    createTime: row.create_time,
    unreadCount: row.unread_count,
    lastMessageTime: row.last_message_time,
    lastMessage: row.last_message,
    lastMessageType: row.last_message_type,
    messageCount: row.message_count,
    owner: row.owner,
    isDeleted: Boolean(row.is_deleted),
    isFriend: isFriendContact({
      type: row.type,
      isChatroom: Boolean(row.is_chatroom),
      username: row.username,
    }),
  };
}

/** 合并联系人行 → DTO;群聊最后一条消息补上发送者前缀 */
function toMergedContactDto(row) {
  const content = row.last_message || '';
  const lastMessage = row.last_sender && content ? `${row.last_sender}: ${content}` : content;
  return toContactDto({ ...row, last_message: lastMessage });
}

/** 全量合并联系人(已去重,含无消息联系人;可按 owner 过滤) */
function getAllMergedContacts(owner) {
  return getMergedContactRows(owner).map(toMergedContactDto);
}

/**
 * 联系人列表快速路径:一个账号只导入过一次时,contacts 表本身没有跨导入重复,
 * 直接读 contacts 可避免对百万级 messages 做窗口函数去重。
 */
function getContactsForOwner(owner) {
  if (!owner) return getAllMergedContacts();
  const backupCount = getOwnerBackupCount(owner);
  if (backupCount === 0) return [];
  if (backupCount === 1) {
    return db
      .prepare('SELECT * FROM contacts WHERE owner = ?')
      .all(owner)
      .map((row) => toContactDto(row));
  }
  // 多次导入的账号:列表只需要联系人摘要,不对 messages 做窗口去重
  return getMergedContactSummaries(owner).map((row) => toContactDto(row));
}

// 同一账号的联系人数据在导入/头像更新前不会变化;列表、通讯录和全局搜索
// 共用这份缓存,避免每次刷新页面都重新做多备份合并(大型库约数百毫秒)。
const contactsForOwnerCache = new Map();

function getContactsForOwnerCached(owner) {
  if (!owner) return getAllMergedContacts();
  if (contactsForOwnerCache.has(owner)) return contactsForOwnerCache.get(owner);
  const contacts = getContactsForOwner(owner);
  contactsForOwnerCache.set(owner, contacts);
  return contacts;
}

/** 导入、头像更新、删除备份后清除联系人列表缓存 */
function invalidateContactsCache(owner) {
  if (owner) contactsForOwnerCache.delete(owner);
  else contactsForOwnerCache.clear();
}

/** 群聊最后一条消息的发送者:群昵称优先,回退微信昵称/备注/username */
const lastSenderStmt = db.prepare(`
  SELECT nickname, remark FROM contacts
  WHERE owner = ? AND hash = ?
  ORDER BY
    CASE WHEN remark IS NOT NULL AND remark <> '' THEN 1 ELSE 0 END DESC,
    CASE WHEN nickname IS NOT NULL AND nickname <> '' THEN 1 ELSE 0 END DESC,
    id DESC
  LIMIT 1
`);
const groupMembersStmt = db.prepare('SELECT members FROM contacts WHERE id = ?');

function resolveLastSender(owner, membersJson, sender, cache) {
  if (!sender) return sender;
  const key = `${owner}\u0000${sender}`;
  if (cache.has(key)) return cache.get(key);

  // 发送人展示优先级:联系人备注 > 微信昵称 > 群昵称 > 原始 username。
  // 备注是用户自己设置的称呼,应覆盖群昵称。
  let name = '';
  const hash = crypto.createHash('md5').update(sender, 'utf8').digest('hex');
  const row = lastSenderStmt.get(owner, hash);
  if (row) name = String(row.remark || '').trim() || String(row.nickname || '').trim();
  if (!name) {
    try {
      const members = JSON.parse(membersJson || '[]');
      const member = (Array.isArray(members) ? members : []).find((m) => m.username === sender);
      if (member && member.displayName) name = String(member.displayName).trim();
    } catch (err) {
      /* 忽略损坏的 members JSON */
    }
  }
  const resolved = name || sender;
  cache.set(key, resolved);
  return resolved;
}

/**
 * 会话列表只返回当前页;这里只对当前页的群聊预览做发送者昵称替换,
 * 避免为全部联系人解析 members / 查昵称。
 */
function enrichContactPreviews(items) {
  const cache = new Map();
  return items.map((item) => {
    if (!item.isChatroom || !item.lastMessage) return item;
    const match = /^([^:\n]{1,128}):\s([\s\S]*)$/.exec(item.lastMessage);
    if (!match) return item;
    const sender = match[1];
    let membersJson = '';
    try {
      const row = groupMembersStmt.get(item.id);
      membersJson = row ? row.members : '';
    } catch (err) {
      /* ignore */
    }
    const name = resolveLastSender(item.owner, membersJson, sender, cache);
    return { ...item, lastMessage: `${name}: ${match[2]}` };
  });
}

/** 搜索过滤(昵称/备注/账号/微信号/拼音/最后消息) */
function filterContacts(items, search) {
  const query = createContactSearch(search);
  if (!query) return items;
  return items.filter((contact) => (
    contactMatchesSearch(contact, query)
    || String(contact.lastMessage || '').toLowerCase().includes(query.needle)
  ));
}

// ---------- 联系人标签 ----------

/**
 * 标签成员索引。按账号查询时只用 username 作键;不限定账号时把 owner
 * 一并放进键里,避免不同微信账号下的同名联系人互相串标签。
 */
function contactTagKey(contact, ownerScoped) {
  const username = String(contact.username || '');
  return ownerScoped ? username : `${contact.owner || ''}\u0000${username}`;
}

function getContactTagIndex(owner) {
  const scoped = Boolean(owner);
  const where = scoped ? 'WHERE owner = ?' : '';
  const params = scoped ? [owner] : [];
  const tagRows = db
    .prepare(`SELECT id, owner, name, tag_index FROM contact_tags ${where} ORDER BY tag_index ASC, id ASC`)
    .all(...params);
  const memberRows = db
    .prepare(`
      SELECT t.id AS tag_id, t.owner, t.name, m.username
      FROM contact_tags t
      JOIN contact_tag_members m ON m.tag_id = t.id
      ${scoped ? 'WHERE t.owner = ?' : ''}
    `)
    .all(...params);

  const definitions = new Map();
  for (const row of tagRows) {
    const name = String(row.name || '');
    if (!name) continue;
    const existing = definitions.get(name);
    if (!existing
      || Number(row.tag_index) < existing.tagIndex
      || (Number(row.tag_index) === existing.tagIndex && Number(row.id) < existing.id)) {
      definitions.set(name, { name, tagIndex: Number(row.tag_index) || 0, id: Number(row.id) });
    }
  }

  const membership = new Map();
  for (const row of memberRows) {
    const username = String(row.username || '');
    if (!username) continue;
    const key = scoped ? username : `${row.owner || ''}\u0000${username}`;
    if (!membership.has(key)) membership.set(key, new Set());
    membership.get(key).add(String(row.name || ''));
  }

  const tags = [...definitions.values()].sort((a, b) => (
    a.tagIndex - b.tagIndex || a.name.localeCompare(b.name, 'zh-Hans-CN')
  ));
  return { tags, membership };
}

/** 标签成员预览按拼音排序,与联系人列表顺序保持一致 */
function sortTagMemberNames(names) {
  return [...names]
    .map((name) => ({
      name,
      pinyin: contactPinyinKey(name),
    }))
    .sort((a, b) => (
      a.pinyin.localeCompare(b.pinyin, 'en', { numeric: true, sensitivity: 'base' })
      || a.name.localeCompare(b.name, 'zh-Hans-CN')
    ))
    .map((item) => item.name);
}

/** 标签页汇总:所有标签(含暂无人数的标签)、好友人数与成员名预览 */
function getTagSummary(owner) {
  const { tags, membership } = getContactTagIndex(owner);
  const counts = new Map(tags.map((tag) => [tag.name, 0]));
  const membersByTag = new Map(tags.map((tag) => [tag.name, new Set()]));
  const untaggedMembers = new Set();
  const scoped = Boolean(owner);
  let totalFriends = 0;
  let untaggedCount = 0;

  for (const contact of getContactsForOwnerCached(owner)) {
    if (!contact.isFriend) continue;
    totalFriends += 1;
    const displayName = contactDisplayName(contact);
    const names = membership.get(contactTagKey(contact, scoped));
    if (!names || names.size === 0) {
      untaggedCount += 1;
      untaggedMembers.add(displayName);
      continue;
    }
    for (const name of names) {
      if (!counts.has(name)) continue;
      counts.set(name, counts.get(name) + 1);
      membersByTag.get(name).add(displayName);
    }
  }

  return {
    totalFriends,
    untaggedCount,
    untaggedMembers: sortTagMemberNames(untaggedMembers),
    tags: tags.map((tag) => ({
      name: tag.name,
      count: counts.get(tag.name) || 0,
      members: sortTagMemberNames(membersByTag.get(tag.name)),
    })),
  };
}

// ---------- 拼音 ----------

/** 名称转拼音数组(无音调,姓氏多音字按姓氏读音) */
function contactPinyinParts(name) {
  if (!pinyinPro || typeof pinyinPro.pinyin !== 'function') return [String(name || '')];
  try {
    const parts = pinyinPro.pinyin(String(name || ''), {
      toneType: 'none',
      type: 'array',
      surname: 'all',
      nonZh: 'consecutive',
      v: true,
    });
    return Array.isArray(parts) ? parts : [String(parts)];
  } catch (err) {
    return [String(name || '')];
  }
}

/** 拼音排序键 */
function contactPinyinKey(name) {
  return contactPinyinParts(name).join(' ').toLowerCase();
}

// ---------- 拼音搜索 ----------

const PINYIN_SEARCH_MIN_LENGTH = 2;
const PINYIN_SEARCH_CACHE_LIMIT = 50000;
const pinyinSearchCache = new Map();

/** 名称的紧凑全拼与首字母(按名称缓存,避免每次搜索重复转换) */
function contactPinyinSearchForms(name) {
  const text = String(name || '').trim();
  if (!text) return null;
  if (pinyinSearchCache.has(text)) return pinyinSearchCache.get(text);
  const parts = contactPinyinParts(text)
    .map((part) => String(part || '').toLowerCase().replace(/\s+/g, ''))
    .filter(Boolean);
  const forms = parts.length > 0
    ? { full: parts.join(''), initials: parts.map((part) => part.charAt(0)).join('') }
    : null;
  if (pinyinSearchCache.size >= PINYIN_SEARCH_CACHE_LIMIT) pinyinSearchCache.clear();
  pinyinSearchCache.set(text, forms);
  return forms;
}

/** 单个名称的拼音匹配:全拼完全 > 全拼前缀/首字母完全 > 全拼包含/首字母前缀 > 首字母包含 */
function pinyinNameMatchScore(name, compactNeedle) {
  if (!compactNeedle
    || compactNeedle.length < PINYIN_SEARCH_MIN_LENGTH
    || !/^[a-z]+$/.test(compactNeedle)) return 0;
  const forms = contactPinyinSearchForms(name);
  if (!forms || !forms.full) return 0;
  if (forms.full === compactNeedle) return 4;
  if (forms.full.startsWith(compactNeedle)) return 3;
  if (forms.full.includes(compactNeedle)) return 2;
  if (forms.initials === compactNeedle) return 3;
  if (forms.initials.startsWith(compactNeedle)) return 2;
  if (forms.initials.includes(compactNeedle)) return 1;
  return 0;
}

/** 备注/昵称/微信号各自的拼音匹配取最高分 */
function contactPinyinMatchScore(contact, compactNeedle) {
  let best = 0;
  const seen = new Set();
  for (const value of [contact.remark, contact.nickname, contact.wxName]) {
    const name = String(value || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const score = pinyinNameMatchScore(name, compactNeedle);
    if (score > best) best = score;
    if (best === 4) break;
  }
  return best;
}

/** 归一化搜索词:原文用于文本匹配,去掉空白/撇号后用于拼音匹配 */
function createContactSearch(search) {
  const needle = String(search || '').trim().toLowerCase();
  if (!needle) return null;
  return {
    needle,
    compact: needle.replace(/[\s'’]+/g, ''),
  };
}

/** 昵称/备注/账号/微信号文本命中,或名称拼音命中 */
function contactMatchesSearch(contact, query) {
  if (!query) return true;
  return [contact.nickname, contact.remark, contact.username, contact.wxName]
    .some((value) => String(value || '').toLowerCase().includes(query.needle))
    || contactPinyinMatchScore(contact, query.compact) > 0;
}

/** 名称文本完全匹配 > 前缀 > 包含 > 拼音 > 备注文本命中 */
function contactSearchScore(contact, query) {
  if (!query) return 0;
  const name = contactDisplayName(contact).toLowerCase();
  if (name === query.needle) return 8;
  if (name.startsWith(query.needle)) return 7;
  if (name.includes(query.needle)) return 6;
  const pinyinScore = contactPinyinMatchScore(contact, query.compact);
  if (pinyinScore === 4) return 5;
  if (pinyinScore === 3) return 4;
  if (pinyinScore === 2) return 3;
  if (String(contact.remark || '').toLowerCase().includes(query.needle)) return 2;
  if (pinyinScore === 1) return 1;
  return 0;
}

/** 首字母分组(A-Z,数字/符号/其它归入 #) */
function contactInitial(name) {
  const trimmed = String(name || '').trim();
  const firstChar = trimmed.charAt(0);
  if (/[A-Za-z]/.test(firstChar)) return firstChar.toUpperCase();
  if (!firstChar || !/[㐀-鿿豈-﫿]/.test(firstChar)) return '#';
  if (!pinyinPro || typeof pinyinPro.pinyin !== 'function') return '#';
  try {
    const initials = pinyinPro.pinyin(trimmed, {
      pattern: 'first',
      toneType: 'none',
      surname: 'all',
      nonZh: 'consecutive',
    });
    const letter = String(initials).trim().charAt(0).toUpperCase();
    return /[A-Z]/.test(letter) ? letter : '#';
  } catch (err) {
    return '#';
  }
}

// ---------- 接口 ----------

/** 合并后的联系人/会话分页列表(聊天视图使用) */
router.get('/contacts', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
  const search = (req.query.search || '').trim();
  const order = req.query.order === 'name' ? 'name' : 'time';
  const owner = (req.query.owner || '').trim();
  const friendsOnly = req.query.friends === '1';
  const chatSearch = req.query.scope === 'chats';

  let items = filterContacts(getContactsForOwnerCached(owner), search);
  // 会话搜索范围:好友 + 群聊,排除同群非好友、公众号、未知会话等
  if (search && chatSearch) {
    items = items.filter((contact) => contact.isFriend || contact.isChatroom);
  }
  if (friendsOnly) items = items.filter((contact) => contact.isFriend);

  if (order === 'name') {
    items.sort((a, b) => (
      contactDisplayName(a).localeCompare(contactDisplayName(b), 'zh-Hans-CN') || a.id - b.id
    ));
  } else {
    items.sort((a, b) => (
      (b.lastMessageTime || 0) - (a.lastMessageTime || 0) || b.id - a.id
    ));
  }

  const total = items.length;
  const start = (page - 1) * pageSize;
  const pageItems = enrichContactPreviews(items.slice(start, start + pageSize));
  res.json({
    items: pageItems,
    total,
    page,
    pageSize,
    hasMore: start + pageSize < total,
    merged: true,
  });
});

/** 标签页:标签名称与好友人数,以及“未设置标签的朋友”人数 */
router.get('/contacts/tags', (req, res) => {
  const owner = (req.query.owner || '').trim();
  res.json(getTagSummary(owner));
});

/**
 * 合并后的全量联系人,按拼音升序、首字母分组。
 * 不依赖消息表,完全没有聊天记录的联系人也会返回。
 * 查询参数:search、tag(标签名)、untagged=1、rooms=1(仅群聊)。
 */
router.get('/contacts/grouped', (req, res) => {
  const search = (req.query.search || '').trim();
  const owner = (req.query.owner || '').trim();
  const friendsOnly = req.query.friends === '1';
  const roomsOnly = req.query.rooms === '1';
  const hasTagFilter = typeof req.query.tag === 'string';
  const tagFilter = hasTagFilter ? req.query.tag.trim() : '';
  const untaggedOnly = req.query.untagged === '1';
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 200));

  let filtered = filterContacts(getContactsForOwnerCached(owner), search);
  if (friendsOnly) filtered = filtered.filter((contact) => contact.isFriend);
  if (roomsOnly) filtered = filtered.filter((contact) => contact.isChatroom);
  if (hasTagFilter || untaggedOnly) {
    const { membership } = getContactTagIndex(owner);
    const scoped = Boolean(owner);
    filtered = filtered.filter((contact) => {
      const names = membership.get(contactTagKey(contact, scoped));
      if (untaggedOnly) return !names || names.size === 0;
      return Boolean(names && names.has(tagFilter));
    });
  }
  const items = filtered.map((contact) => ({
    ...contact,
    pinyin: contactPinyinKey(contactDisplayName(contact)),
    initial: contactInitial(contactDisplayName(contact)),
  }));

  items.sort((a, b) => {
    const byPinyin = a.pinyin.localeCompare(b.pinyin, 'en', {
      numeric: true,
      sensitivity: 'base',
    });
    if (byPinyin !== 0) return byPinyin;
    return contactDisplayName(a).localeCompare(contactDisplayName(b), 'zh-Hans-CN');
  });

  // 先按首字母分组并按 A-Z/# 排好组,再分页;不能直接切拼音排序后的数组,
  // 否则数字/符号开头的 # 组会散落在各页之间,客户端无法正确合并分组。
  const byLetterAll = new Map();
  for (const contact of items) {
    if (!byLetterAll.has(contact.initial)) byLetterAll.set(contact.initial, []);
    byLetterAll.get(contact.initial).push(contact);
  }
  const lettersAll = [...byLetterAll.keys()].sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b, 'en');
  });
  const ordered = lettersAll.flatMap((letter) => byLetterAll.get(letter));

  const total = ordered.length;
  const start = (page - 1) * pageSize;
  const pageItems = ordered.slice(start, start + pageSize);
  const byLetter = new Map();
  for (const contact of pageItems) {
    if (!byLetter.has(contact.initial)) byLetter.set(contact.initial, []);
    byLetter.get(contact.initial).push(contact);
  }

  const backupCount = owner ? getOwnerBackupCount(owner) : 0;
  res.json({
    total,
    page,
    pageSize,
    hasMore: start + pageSize < total,
    merged: backupCount !== 1,
    // 分页切片可能从某个首字母分组的中间开始;客户端按 letter 合并连续页
    groups: lettersAll
      .filter((letter) => byLetter.has(letter))
      .map((letter) => ({
        letter,
        contacts: byLetter.get(letter),
      })),
  });
});

/** 群聊成员列表:按群昵称/联系人昵称排序并做拼音首字母分组 */
router.get('/contacts/:id/members', (req, res) => {
  const id = Number(req.params.id);
  const source = db
    .prepare('SELECT owner, hash, is_chatroom FROM contacts WHERE id = ?')
    .get(id);
  if (!source) return res.status(404).json({ error: '联系人不存在' });
  if (!source.is_chatroom) return res.json({ total: 0, groups: [] });

  // 成员集合以最新备份为准;昵称从所有备份的同名成员补齐,避免最新备份
  // 的 DisplayName 为空时丢掉旧备份里的名称。
  const groupRows = db
    .prepare('SELECT id, members FROM contacts WHERE owner = ? AND hash = ? ORDER BY id DESC')
    .all(source.owner, source.hash);
  const latest = groupRows.find((row) => row.members && row.members !== '[]');
  let rawMembers = [];
  try {
    const parsed = JSON.parse((latest && latest.members) || '[]');
    rawMembers = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    rawMembers = [];
  }
  const olderNames = new Map();
  for (const row of groupRows) {
    let list = [];
    try {
      const parsed = JSON.parse(row.members || '[]');
      list = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      list = [];
    }
    for (const member of list) {
      const username = String((member && member.username) || '').trim();
      const displayName = String((member && member.displayName) || '').trim();
      if (username && displayName && !olderNames.has(username)) {
        olderNames.set(username, displayName);
      }
    }
  }

  // 同一成员跨多次导入时,备注/昵称/头像分别取各字段最新非空值,
  // 不能只取最新一行,否则旧备份里的头像会被丢掉。
  const rows = db
    .prepare('SELECT id, username, hash, nickname, remark, avatar FROM contacts WHERE owner = ? ORDER BY id DESC')
    .all(source.owner);
  const contactsByUsername = new Map();
  for (const row of rows) {
    if (!row.username) continue;
    let contact = contactsByUsername.get(row.username);
    if (!contact) {
      contact = {
        id: row.id,
        username: row.username,
        hash: row.hash,
        nickname: '',
        remark: '',
        avatar: '',
      };
      contactsByUsername.set(row.username, contact);
    }
    if (!contact.remark && row.remark) contact.remark = row.remark;
    if (!contact.nickname && row.nickname) contact.nickname = row.nickname;
    if (!contact.avatar && row.avatar) contact.avatar = row.avatar;
  }

  const seen = new Set();
  const members = [];
  for (const raw of rawMembers) {
    const username = String((raw && raw.username) || '').trim();
    if (!username || seen.has(username)) continue;
    seen.add(username);
    const contact = contactsByUsername.get(username);
    const groupNickname = String((raw && raw.displayName) || '').trim()
      || olderNames.get(username)
      || '';
    const name = groupNickname
      || (contact && (contact.remark || contact.nickname))
      || username;
    members.push({
      username,
      name,
      hash: contact ? contact.hash : crypto.createHash('md5').update(username, 'utf8').digest('hex'),
      avatar: contact && contact.avatar ? contactAvatarUrl(contact) : '',
      pinyin: contactPinyinKey(name),
      initial: contactInitial(name),
    });
  }

  members.sort((a, b) => {
    const byPinyin = a.pinyin.localeCompare(b.pinyin, 'en', {
      numeric: true,
      sensitivity: 'base',
    });
    if (byPinyin !== 0) return byPinyin;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  const byLetter = new Map();
  for (const member of members) {
    if (!byLetter.has(member.initial)) byLetter.set(member.initial, []);
    byLetter.get(member.initial).push(member);
  }
  const letters = [...byLetter.keys()].sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b, 'en');
  });

  res.json({
    total: members.length,
    groups: letters.map((letter) => ({ letter, members: byLetter.get(letter) })),
  });
});

/** 某个联系人所属的标签(按标签顺序) */
router.get('/contacts/:id/tags', (req, res) => {
  const id = Number(req.params.id);
  const source = db
    .prepare('SELECT owner, username FROM contacts WHERE id = ?')
    .get(id);
  if (!source) return res.status(404).json({ error: '联系人不存在' });
  if (!source.username) return res.json({ tags: [] });

  const rows = db.prepare(`
    SELECT t.name, MIN(t.tag_index) AS tag_index
    FROM contact_tags t
    JOIN contact_tag_members m ON m.tag_id = t.id
    WHERE t.owner = ? AND m.username = ?
    GROUP BY t.name
    ORDER BY tag_index ASC, t.name ASC
  `).all(source.owner, source.username);
  res.json({ tags: rows.map((row) => row.name) });
});

/** 合并后的联系人详情(支持任意一次导入中的联系人 id) */
router.get('/contacts/:id', (req, res) => {
  const id = Number(req.params.id);
  const source = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!source) return res.status(404).json({ error: '联系人不存在' });

  // 单次导入:直接使用该联系人行,避免扫描全部消息做合并
  if (getOwnerBackupCount(source.owner) === 1) {
    const dto = toContactDto(source);
    try {
      dto.members = JSON.parse(source.members || '[]');
    } catch (err) {
      dto.members = [];
    }
    return res.json(dto);
  }

  const merged = getAllMergedContacts().find(
    (contact) => contact.owner === source.owner && contact.hash === source.hash
  );
  if (!merged) return res.status(404).json({ error: '联系人不存在' });

  const dto = { ...merged, id };
  if (merged.avatar || merged.has_avatar) dto.avatar = contactAvatarUrl({ ...merged, id });

  const latest = db
    .prepare('SELECT members FROM contacts WHERE owner = ? AND hash = ? ORDER BY id DESC LIMIT 1')
    .get(source.owner, source.hash);
  try {
    dto.members = JSON.parse((latest && latest.members) || '[]');
  } catch (err) {
    dto.members = [];
  }
  res.json(dto);
});

/** 头像:从该联系人的所有导入记录中查找可用头像文件 */
router.get('/contacts/:id/avatar', (req, res) => {
  const row = db
    .prepare('SELECT owner, hash FROM contacts WHERE id = ?')
    .get(Number(req.params.id));
  if (!row) return res.status(404).end();

  const candidates = db
    .prepare(`
      SELECT backup_id, avatar
      FROM contacts
      WHERE owner = ? AND hash = ? AND avatar <> ''
      ORDER BY id DESC
    `)
    .all(row.owner, row.hash);

  const found = candidates.find((candidate) => (
    fs.existsSync(path.join(MEDIA_DIR, candidate.backup_id, candidate.avatar))
  ));
  if (!found) return res.status(404).end();

  const file = path.join(MEDIA_DIR, found.backup_id, found.avatar);
  sendFileWithValidation(req, res, file, detectImageType(file).contentType);
});

module.exports = router;
// 供全局搜索接口复用联系人合并/过滤逻辑(路由本身仍作为 Express Router 使用)
module.exports.getContactsForOwner = getContactsForOwner;
module.exports.getContactsForOwnerCached = getContactsForOwnerCached;
module.exports.enrichContactPreviews = enrichContactPreviews;
module.exports.invalidateContactsCache = invalidateContactsCache;
module.exports.toContactDto = toContactDto;
module.exports.createContactSearch = createContactSearch;
module.exports.contactMatchesSearch = contactMatchesSearch;
module.exports.contactSearchScore = contactSearchScore;
module.exports.pinyinNameMatchScore = pinyinNameMatchScore;
