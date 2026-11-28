/**
 * 微信数据解析编排器:从 iOS 备份中提取用户、联系人、会话与聊天记录。
 * 数据文件路径与表结构:
 *
 *   Documents/LoginInfo2.dat                          登录过的账号列表(protobuf)
 *   Documents/MMappedKV/mmsetting.archive.<username>  账号/联系人设置(MMKV,昵称等)
 *   Documents/<md5(username)>/DB/WCDB_Contact.sqlite  Friend 表:联系人
 *   Documents/<md5(username)>/session/session.db      SessionAbstract 表:会话列表
 *   Documents/<md5(username)>/DB/MM.sqlite            Chat_<md5(对方)> 表:聊天记录
 *   Documents/<md5(username)>/DB/message_<N>.sqlite   聊天记录分库
 *   Documents/<md5(username)>/Img/<md5(对方)>/<msgId>.pic*      图片
 *   Documents/<md5(username)>/Audio/<md5(对方)>/<msgId>.aud     语音
 *   Documents/<md5(username)>/Video/<md5(对方)>/<msgId>.mp4     视频
 *   Documents/<md5(username)>/session/headImg/<md5(对方)>.pic   头像(App Group 域)
 */

const crypto = require('crypto');
const { ITunesBackup } = require('./backup');
const { parseRawMessage, getFieldValue, getFieldBytes, getFieldByPath } = require('./protobuf');
const { parseMmsetting } = require('./mmkv');
const { parseMessageContent, stripSenderPrefix, tryParseXml, nodeText, first } = require('./content');
const { decodeMessageValue } = require('./wcdb-zstd');
const { MSG_TYPE, isChatroom, isOfficialAccount } = require('./types');

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

/** 解析 Documents/LoginInfo2.dat(字段 1 内为多个 varint 长度前缀的用户消息) */
function parseLoginInfo2(buffer) {
  const outer = parseRawMessage(buffer);
  const blob = getFieldBytes(outer, 1);
  if (!blob) return [];
  const users = [];
  let offset = 0;
  while (offset < blob.length) {
    // varint 用户消息长度
    let result = 0;
    let shift = 0;
    while (offset < blob.length) {
      const byte = blob[offset++];
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    if (result <= 0 || offset + result > blob.length) break;
    const userFields = parseRawMessage(blob.subarray(offset, offset + result));
    offset += result;
    const username = getFieldValue(userFields, 1);
    if (!username) continue;
    users.push({
      username,
      wxName: getFieldValue(userFields, 2) || '',
      displayName: getFieldValue(userFields, 3) || '',
    });
  }
  return users;
}

/**
 * 解析 dbContactRemark protobuf:字段 1 = 微信昵称,2 = 微信号,
 * 3 = 联系人备注。昵称与备注必须分别保留,不能用其中一个回退另一个。
 */
function parseRemarkBlob(blob) {
  if (!blob) return { nickname: '', remark: '', wxName: '' };
  const fields = parseRawMessage(blob);
  return {
    nickname: getFieldValue(fields, 1) || '',
    remark: getFieldValue(fields, 3) || '',
    wxName: getFieldValue(fields, 2) || '',
  };
}

/** 解析 dbContactChatRoom protobuf:字段 6 = 群成员 XML */
function parseChatroomBlob(blob) {
  if (!blob) return [];
  const fields = parseRawMessage(blob);
  const xml = getFieldValue(fields, 6);
  if (!xml) return [];
  const parsed = tryParseXml(xml);
  if (!parsed) return [];
  const roomData = parsed.RoomData;
  if (!roomData) return [];
  const memberNodes = Array.isArray(roomData.Member) ? roomData.Member : [roomData.Member];
  return memberNodes
    .filter(Boolean)
    .map((m) => ({ username: m.UserName || '', displayName: m.DisplayName || '' }));
}

/** 解析 dbContactHeadImage protobuf:字段 2/3 = 头像 URL */
function parseAvatarBlob(blob) {
  if (!blob) return '';
  const fields = parseRawMessage(blob);
  return getFieldValue(fields, 2) || getFieldValue(fields, 3) || '';
}

/**
 * 解析 dbContactSocial protobuf:字段 11 保存联系人电话号码,
 * 值是“长度前缀 + 数字字符串”的嵌套编码,提取其中的连续数字。
 */
function parsePhoneBlob(blob) {
  if (!blob) return '';
  const fields = parseRawMessage(blob);
  const bytes = getFieldBytes(fields, 11);
  if (!bytes) return '';
  const match = String(bytes.toString('utf8')).match(/\+?\d{6,20}/);
  return match ? match[0] : '';
}

/** 解析 dbContactProfile protobuf:字段 2/3/4 = 国家/省/市 */
function parseProfileBlob(blob) {
  if (!blob) return { country: '', province: '', city: '' };
  const fields = parseRawMessage(blob);
  return {
    country: getFieldValue(fields, 2) || '',
    province: getFieldValue(fields, 3) || '',
    city: getFieldValue(fields, 4) || '',
  };
}

/**
 * 联系人地区展示文本。微信库中的地区通常是英文/国家代码;
 * 中国联系人省略国家代码,只显示省/市,与微信地区展示习惯一致。
 */
function formatContactRegion(country, province, city) {
  const parts = [];
  const seen = new Set();
  const values = [country, province, city];
  for (let i = 0; i < values.length; i += 1) {
    let text = String(values[i] || '').trim();
    if (!text) continue;
    if (i === 0 && /^(CN|CHN|China|中国)$/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(text);
  }
  return parts.join(' ');
}

class WechatBackupParser {
  /**
   * @param {string} backupDir iOS 备份目录
   * @param {Object} options
   * @param {boolean} [options.includeMedia] 是否提取媒体文件(图片/语音/视频)
   * @param {Function} [options.onProgress] 日志回调 (message)
   * @param {Function} [options.onParseProgress] 解析细粒度进度 ({ percent, text, done, total })
   */
  constructor(backupDir, options = {}) {
    this.backup = new ITunesBackup(backupDir, {
      onProgress: options.onProgress,
      tempDir: options.tempDir,
      Database: options.Database,
    });
    this.options = { includeMedia: true, ...options };
    this.summary = null;
    this._avatarOwners = null;
    this._lastParseProgress = '';
    this.contactTags = [];
  }

  _log(message) {
    if (this.options.onProgress) this.options.onProgress(message);
  }

  /** 解析阶段的细粒度进度;不改变原有 onProgress(日志)行为 */
  _parseProgress(percent, text, extra = {}) {
    if (typeof this.options.onParseProgress !== 'function') return;
    const rounded = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    const key = `${rounded}|${text}`;
    if (key === this._lastParseProgress) return;
    this._lastParseProgress = key;
    try {
      this.options.onParseProgress({ percent: rounded, text, ...extra });
    } catch (err) {
      /* 进度回调失败不影响解析 */
    }
  }

  /**
   * 解析备份摘要:设备信息、账号、联系人(含会话统计)与联系人标签。
   * @returns {{info:Object, users:Array, contacts:Array, tags:Array}}
   */
  parseSummary() {
    this._lastParseProgress = '';
    this._parseProgress(1, '正在读取备份信息...', { phase: 'info' });
    this.backup.validate();
    const info = this.backup.getInfo();
    this._log(`备份信息: ${info.deviceName || '未知设备'} iOS ${info.iosVersion || '未知版本'}`);

    this._parseProgress(3, '正在查找微信账号...', { phase: 'users' });
    const users = this.discoverUsers();
    if (users.length === 0) {
      throw new Error('未在备份中找到微信账号数据(Documents/LoginInfo2.dat 与 MMappedKV 均未发现账号)');
    }
    this._log(`发现 ${users.length} 个微信账号: ${users.map((u) => u.displayName || u.username).join(', ')}`);

    const contacts = [];
    this.contactTags = [];
    const userSpan = 95 / users.length;
    for (let index = 0; index < users.length; index += 1) {
      const user = users[index];
      const name = user.displayName || user.username;
      const base = 5 + userSpan * index;
      this._parseProgress(base, `正在解析账号 ${index + 1}/${users.length}: ${name}`, {
        phase: 'account',
      });
      this._log(`解析账号 "${name}" 的数据...`);
      this.collectContacts(user, contacts, { base, span: userSpan });
      this._parseProgress(base + userSpan, `账号 ${index + 1}/${users.length} 解析完成`, {
        phase: 'account',
      });
    }

    contacts.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
    const totalMessages = contacts.reduce((sum, c) => sum + (c.messageCount || 0), 0);
    this._log(
      `解析完成: ${contacts.length} 个联系人/会话,共 ${totalMessages} 条消息,`
      + `${this.contactTags.length} 个联系人标签`
    );
    this._parseProgress(
      100,
      `解析完成: ${contacts.length} 个联系人/会话,共 ${totalMessages} 条消息`,
      { phase: 'done' }
    );

    this.summary = { info, users, contacts, tags: this.contactTags };
    this._avatarOwners = null;
    return this.summary;
  }

  /** 发现微信账号 */
  discoverUsers() {
    const users = [];
    const loginBuf = this.backup.readFile('Documents/LoginInfo2.dat');
    if (loginBuf) {
      for (const u of parseLoginInfo2(loginBuf)) users.push({ ...u, hash: md5(u.username) });
    }

    // 从 MMappedKV 补充昵称/微信号,或作为登录账号的后备发现方式
    const mmkvUsernames = new Map(); // username → mmsetting
    for (const { relativePath } of this.backup.iterateFiles()) {
      const m = relativePath.match(/^Documents\/MMappedKV\/mmsetting\.archive\.(.+?)$/);
      if (!m || m[1].endsWith('.crc')) continue;
      const buf = this.backup.readFile(relativePath);
      if (buf) mmkvUsernames.set(m[1], parseMmsetting(buf));
    }

    for (const u of users) {
      const setting = mmkvUsernames.get(u.username);
      if (setting) {
        if (!u.displayName) u.displayName = setting.displayName;
        if (!u.wxName) u.wxName = setting.wxName;
        if (!u.avatarUrl) u.avatarUrl = setting.portrait || setting.portraitHD || '';
      }
    }
    if (users.length === 0) {
      for (const [username, setting] of mmkvUsernames) {
        users.push({
          username,
          hash: md5(username),
          displayName: setting.displayName || '',
          wxName: setting.wxName || '',
          avatarUrl: setting.portrait || setting.portraitHD || '',
        });
      }
    }
    return users;
  }

  /**
   * 收集一个账号下的联系人(联系人表 + 会话表 + 聊天表合并)。
   * @param {Object} owner 账号 { username, hash }
   * @param {Array} contacts 结果追加到这里
   */
  collectContacts(owner, contacts, progress = null) {
    const ownerName = owner.displayName || owner.username;
    const report = (withinPercent, text, extra = {}) => {
      if (!progress) return;
      const clamped = Math.max(0, Math.min(100, Number(withinPercent) || 0));
      const percent = progress.base + progress.span * (clamped / 100);
      this._parseProgress(percent, text, extra);
    };
    const byHash = new Map();
    const ensure = (hash) => {
      if (!byHash.has(hash)) {
        byHash.set(hash, {
          username: '',
          hash,
          nickname: '',
          remark: '',
          wxName: '',
          region: '',
          phone: '',
          type: 0,
          isChatroom: false,
          members: [],
          createTime: 0,
          unreadCount: 0,
          lastMessageTime: 0,
          lastMessage: '',
          lastMessageType: 0,
          messageCount: 0,
          owner: owner.username,
          isDeleted: false,
        });
      }
      return byHash.get(hash);
    };

    // 1. 联系人表 WCDB_Contact.sqlite → Friend / OpenIMContact
    report(0, `正在读取账号 "${ownerName}" 的联系人...`, { phase: 'contacts' });
    const contactDb = this.backup.openDb(`Documents/${owner.hash}/DB/WCDB_Contact.sqlite`);
    if (contactDb) {
      try {
        // 先收集两个表的数据,得到总数后逐条解析并更新进度。
        const contactRows = [];
        for (const table of ['Friend', 'OpenIMContact']) {
          const exists = contactDb
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
            .get(table);
          if (!exists) continue;
          // 不同微信版本的联系人表列不完全一致(旧备份/精简库可能没有
          // dbContactProfile、dbContactSocial 等可选列)。按实际列生成查询,
          // 缺失列用 NULL 占位,避免整个导入因一个可选字段缺失而失败。
          const available = new Set(
            contactDb.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)
          );
          if (!available.has('userName')) continue;
          const selectColumns = [
            'userName', 'dbContactRemark', 'dbContactChatRoom', 'dbContactHeadImage',
            'dbContactProfile', 'dbContactSocial', 'type',
          ].map((name) => (available.has(name) ? name : `NULL AS ${name}`)).join(', ');
          const rows = contactDb
            .prepare(`SELECT ${selectColumns} FROM ${table}`)
            .all();
          contactRows.push(...rows);
        }

        const totalRows = contactRows.length;
        if (totalRows > 0) {
          report(1, `正在解析联系人 0/${totalRows}`, {
            phase: 'contacts', done: 0, total: totalRows,
          });
        }
        for (let index = 0; index < totalRows; index += 1) {
          const row = contactRows[index];
          const username = typeof row.userName === 'string' ? row.userName : '';
          if (!username || isOfficialAccount(username)) continue; // 跳过公众号
          const hash = md5(username);
          const contact = ensure(hash);
          contact.username = username;
          const { nickname, remark, wxName } = parseRemarkBlob(row.dbContactRemark);
          contact.nickname = nickname || contact.nickname;
          contact.remark = remark || contact.remark;
          contact.wxName = wxName || contact.wxName;
          const profile = parseProfileBlob(row.dbContactProfile);
          const region = formatContactRegion(profile.country, profile.province, profile.city);
          contact.region = region || contact.region;
          contact.phone = parsePhoneBlob(row.dbContactSocial) || contact.phone;
          contact.members = parseChatroomBlob(row.dbContactChatRoom);
          contact.avatarUrl = parseAvatarBlob(row.dbContactHeadImage);
          contact.type = Number(row.type) || 0;
          contact.isChatroom = isChatroom(username) || contact.members.length > 0;
          if (index % 500 === 0 || index === totalRows - 1) {
            report(1 + 19 * ((index + 1) / totalRows), `正在解析联系人 ${index + 1}/${totalRows}`, {
              phase: 'contacts', done: index + 1, total: totalRows,
            });
          }
        }
        report(20, `联系人解析完成 (${totalRows} 条)`, { phase: 'contacts' });
        this.collectContactTags(owner, contactDb);
      } finally {
        contactDb.close();
      }
    }

    // 2. 联系人昵称:Documents/MMappedKV/mmsetting.archive.<username>(MMKV 键 88)
    const settingPaths = [];
    for (const { relativePath } of this.backup.iterateFiles()) {
      const m = relativePath.match(/^Documents\/MMappedKV\/mmsetting\.archive\.(.+?)$/);
      if (!m || m[1].endsWith('.crc')) continue;
      settingPaths.push(relativePath);
    }
    if (settingPaths.length > 0) {
      report(20, `正在读取联系人资料 0/${settingPaths.length}`, {
        phase: 'settings', done: 0, total: settingPaths.length,
      });
      for (let index = 0; index < settingPaths.length; index += 1) {
        const relativePath = settingPaths[index];
        const m = relativePath.match(/^Documents\/MMappedKV\/mmsetting\.archive\.(.+?)$/);
        const hash = md5(m[1]);
        const contact = byHash.get(hash);
        if (contact) {
          const buf = this.backup.readFile(relativePath);
          if (buf) {
            const setting = parseMmsetting(buf);
            if (setting.displayName) contact.nickname = setting.displayName;
            if (setting.wxName) contact.wxName = setting.wxName;
            if (!contact.avatarUrl) contact.avatarUrl = setting.portrait || setting.portraitHD || '';
          }
        }
        if (index % 100 === 0 || index === settingPaths.length - 1) {
          report(20 + 10 * ((index + 1) / settingPaths.length),
            `正在读取联系人资料 ${index + 1}/${settingPaths.length}`, {
              phase: 'settings', done: index + 1, total: settingPaths.length,
            });
        }
      }
    }

    // 3. 会话列表 session/session.db → SessionAbstract
    report(30, `正在读取账号 "${ownerName}" 的会话列表...`, { phase: 'sessions' });
    this.collectSessions(owner, ensure);
    report(40, '会话列表读取完成', { phase: 'sessions' });

    // 4. 聊天表:DB/MM.sqlite 与 DB/message_N.sqlite 中的 Chat_<hash> 表
    report(40, '正在统计聊天记录...', { phase: 'chats' });
    this.collectChatTables(owner, byHash, (done, total) => {
      const fraction = total > 0 ? done / total : 1;
      report(40 + 60 * fraction, `正在统计聊天记录 ${done}/${total} 个会话`, {
        phase: 'chats', done, total,
      });
    });

    // 5. 保留原始昵称/备注字段;没有昵称时不在解析阶段用备注覆盖
    for (const contact of byHash.values()) contacts.push(contact);
    report(100, `账号 "${ownerName}" 解析完成`, { phase: 'done' });
  }

  /**
   * 联系人标签:ContactTagTable(标签定义)+ ContactTagRelationTable(成员关系)。
   * 旧版微信备份没有这两张表,此时忽略;成员按 username 保存,服务端查询时
   * 再与跨备份合并后的联系人关联。
   */
  collectContactTags(owner, contactDb) {
    const hasTagTable = contactDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ContactTagTable'")
      .get();
    const hasRelationTable = contactDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ContactTagRelationTable'")
      .get();
    if (!hasTagTable || !hasRelationTable) return;

    const tagRows = contactDb
      .prepare('SELECT uiID, tagIndex, nsName FROM ContactTagTable ORDER BY tagIndex ASC, uiID ASC')
      .all();
    if (tagRows.length === 0) return;

    const relationRows = contactDb
      .prepare('SELECT uiID, userName FROM ContactTagRelationTable')
      .all();
    const membersByTag = new Map();
    for (const row of relationRows) {
      const tagId = Number(row.uiID);
      const username = typeof row.userName === 'string' ? row.userName.trim() : '';
      if (!tagId || !username) continue;
      if (!membersByTag.has(tagId)) membersByTag.set(tagId, new Set());
      membersByTag.get(tagId).add(username);
    }

    for (const row of tagRows) {
      const name = typeof row.nsName === 'string' ? row.nsName.trim() : '';
      if (!name) continue;
      const remoteId = Number(row.uiID) || 0;
      this.contactTags.push({
        owner: owner.username,
        remoteId,
        tagIndex: Number(row.tagIndex) || 0,
        name,
        usernames: [...(membersByTag.get(remoteId) || [])],
      });
    }
  }

  /** 会话表:session.db(SessionAbstract)与 UniversalSession 下的 session.db(SessionTable) */
  collectSessions(owner, ensure) {
    const sessionDb = this.backup.openDb(`Documents/${owner.hash}/session/session.db`);
    if (sessionDb) {
      try {
        const rows = sessionDb
          .prepare('SELECT ConStrRes1, CreateTime, unreadcount, UsrName FROM SessionAbstract')
          .all();
        for (const row of rows) {
          const username = typeof row.UsrName === 'string' ? row.UsrName : '';
          if (!username) continue;
          const contact = ensure(md5(username));
          contact.username = username;
          contact.createTime = Number(row.CreateTime) || 0;
          contact.unreadCount = Number(row.unreadcount) || 0;
          contact.isChatroom = contact.isChatroom || isChatroom(username);
        }
      } finally {
        sessionDb.close();
      }
    }

    // 服务号/订阅号等特殊会话
    for (const kind of ['BottleSession', 'SubscribeSession', 'SubscribeSessionList', 'WASession']) {
      const db = this.backup.openDb(`Documents/${owner.hash}/UniversalSession/${kind}/session.db`);
      if (!db) continue;
      try {
        const rows = db
          .prepare('SELECT sessionId, lastMsgUpdateTime, unreadCount FROM SessionTable')
          .all();
        for (const row of rows) {
          const username = typeof row.sessionId === 'string' ? row.sessionId : '';
          if (!username) continue;
          const contact = ensure(md5(username));
          contact.username = username;
          contact.createTime = contact.createTime || Number(row.lastMsgUpdateTime) || 0;
          contact.unreadCount = contact.unreadCount || Number(row.unreadCount) || 0;
          contact.isChatroom = contact.isChatroom || isChatroom(username);
        }
      } finally {
        db.close();
      }
    }
  }

  /** 聊天表发现:记录每个会话的消息数、最后一条消息、所在数据库路径 */
  collectChatTables(owner, byHash, onProgress = null) {
    // 本账号消息库:DB/MM.sqlite 主库 + DB/message_N.sqlite 分库
    const userBase = `Documents/${owner.hash}`;
    const dbRelPaths = [`${userBase}/DB/MM.sqlite`];
    const msgDbPattern = new RegExp(`^${userBase}/DB/(message_\\d+\\.sqlite)$`);
    for (const { relativePath } of this.backup.iterateFiles()) {
      const m = relativePath.match(msgDbPattern);
      if (m) dbRelPaths.push(`${userBase}/DB/${m[1]}`);
    }

    // 先枚举所有 Chat_ 表,得到会话总数后再逐个统计消息数。
    // 保持数据库句柄到统计结束,避免网络盘上重复复制同一个数据库。
    const opened = [];
    try {
      for (const relPath of dbRelPaths) {
        const db = this.backup.openDb(relPath);
        if (!db) continue;
        const entry = { db, relPath, tables: [] };
        opened.push(entry);
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Chat\\_%' ESCAPE '\\'")
          .all();
        for (const { name: tableName } of tables) {
          const chatHash = tableName.slice(5);
          if (!/^[0-9a-f]{32}$/.test(chatHash)) continue;
          entry.tables.push({ tableName, chatHash });
        }
      }

      const total = opened.reduce((sum, entry) => sum + entry.tables.length, 0);
      if (total === 0) return;
      if (onProgress) onProgress(0, total);
      const reportEvery = Math.max(1, Math.ceil(total / 100));
      let done = 0;

      for (const { db, relPath, tables } of opened) {
        for (const { tableName, chatHash } of tables) {
          let contact = byHash.get(chatHash);
          if (!contact) {
            // 会话表里没有的会话(已删除联系人的残留),也保留以便完整导出
            const orphan = {
              username: '',
              hash: chatHash,
              nickname: '未知会话',
              remark: '',
              wxName: '',
              region: '',
              phone: '',
              type: 0,
              isChatroom: false,
              members: [],
              createTime: 0,
              unreadCount: 0,
              lastMessageTime: 0,
              lastMessage: '',
              lastMessageType: 0,
              messageCount: 0,
              owner: owner.username,
              isDeleted: true,
            };
            byHash.set(chatHash, orphan);
            contact = orphan;
          }
          contact.dbPath = relPath;
          contact.messageCount += db.prepare(`SELECT COUNT(*) AS n FROM "${tableName}"`).get().n;
          const last = db
            .prepare(`SELECT CreateTime, Des, Message, Type FROM "${tableName}" ORDER BY CreateTime DESC, MesLocalID DESC LIMIT 1`)
            .get();
          if (last && (!contact.lastMessageTime || Number(last.CreateTime) > contact.lastMessageTime)) {
            contact.lastMessageTime = Number(last.CreateTime) || 0;
            contact.lastMessageType = Number(last.Type) || 0;
            const { senderId, content: stripped } = stripSenderPrefix(decodeMessageValue(last.Message));
            const parsed = parseMessageContent(contact.lastMessageType, stripped);
            contact.lastMessage = senderId ? `${senderId}: ${parsed.text}` : parsed.text;
            contact.lastMessageIsSent = Number(last.Des) === 0;
          }
          done += 1;
          if (onProgress && (done % reportEvery === 0 || done === total)) {
            onProgress(done, total);
          }
        }
      }
    } finally {
      for (const { db } of opened) {
        try { db.close(); } catch (err) { /* ignore */ }
      }
    }
  }

  /**
   * 账号/联系人头像文件。
   * 不同 iOS 版本的微信目录不同:iOS 17 实测在 App Group 的
   * `share/<md5(账号)>/session/headImg/<md5(账号或联系人)>.pic`,
   * 旧版本在 `Documents/<md5(账号)>/session/headImg/<hash>.pic`。
   */
  getAvatarFile(hash, owner) {
    if (!this.summary) return null;

    // 先试联系人自己的账号目录;同一个联系人(如同一好友/群)可能存在于多个
    // 微信账号下,但只有部分账号的 headImg 缓存里留有头像文件。
    const ownerHashes = [];
    const addOwner = (ownerHash) => {
      if (ownerHash && !ownerHashes.includes(ownerHash)) ownerHashes.push(ownerHash);
    };
    if (owner) addOwner(md5(owner));
    for (const ownerHash of this._avatarOwnersFor(hash)) addOwner(ownerHash);

    for (const ownerHash of ownerHashes) {
      const candidates = [
        `share/${ownerHash}/session/headImg/${hash}.pic`,
        `Documents/${ownerHash}/session/headImg/${hash}.pic`,
      ];
      for (const relPath of candidates) {
        const buf = this.backup.readFile(relPath);
        if (buf && buf.length > 0) return buf;
      }
    }
    return null;
  }

  /** hash → 可能存有该头像的账号目录(账号自身 + 各账号下的联系人所属账号) */
  _avatarOwnersFor(hash) {
    if (!this._avatarOwners) {
      const owners = new Map();
      const add = (contactHash, ownerHash) => {
        if (!contactHash || !ownerHash) return;
        if (!owners.has(contactHash)) owners.set(contactHash, []);
        const list = owners.get(contactHash);
        if (!list.includes(ownerHash)) list.push(ownerHash);
      };
      for (const user of this.summary.users) add(user.hash, user.hash);
      for (const contact of this.summary.contacts) add(contact.hash, md5(contact.owner));
      this._avatarOwners = owners;
    }
    return this._avatarOwners.get(hash) || [];
  }

  /**
   * 逐条读取会话聊天记录。
   * @param {Object} contact 联系人(来自 parseSummary 结果)
   * @returns {Generator<Object>} 消息对象:
   *   { mesLocalId, mesSvrId, type, isSent, sender, content, extra, createTime, mediaKind }
   */
  *getMessages(contact) {
    if (!contact.dbPath) return;
    const ownerHash = md5(contact.owner);
    const db = this.backup.openDb(contact.dbPath);
    if (!db) return;
    try {
      const tableName = `Chat_${contact.hash}`;
      const rows = db
        .prepare(
          `SELECT CreateTime, Des, MesLocalID, Message, MesSvrID, Status, Type
           FROM "${tableName}" ORDER BY MesLocalID ASC`
        )
        .iterate();
      for (const row of rows) {
        const rawContent = decodeMessageValue(row.Message);
        const isSent = Number(row.Des) === 0;
        const isRoom = contact.isChatroom || (contact.username && isChatroom(contact.username));
        const { senderId, content } = isRoom && !isSent ? stripSenderPrefix(rawContent) : { senderId: '', content: rawContent };
        const parsed = parseMessageContent(Number(row.Type) || 0, content);
        yield {
          mesLocalId: Number(row.MesLocalID),
          mesSvrId: row.MesSvrID !== null && row.MesSvrID !== undefined ? Number(row.MesSvrID) : null,
          type: Number(row.Type) || 0,
          isSent,
          sender: senderId,
          content: parsed.text,
          extra: parsed.extra,
          createTime: Number(row.CreateTime) || 0,
          mediaKind: parsed.mediaKind,
          ownerHash,
        };
      }
    } finally {
      db.close();
    }
  }

  /** 媒体文件候选路径(按优先级) */
  _mediaCandidates(message, contact) {
    const peerHash = contact.hash;
    const ownerHash = message.ownerHash || md5(contact.owner);
    const id = message.mesLocalId;
    const candidates = [];
    if (message.mediaKind === 'image') {
      candidates.push(
        [`Documents/${ownerHash}/Img/${peerHash}/${id}.pic`, 'jpg'],
        [`Documents/${ownerHash}/Img/${peerHash}/${id}.pic_hd`, 'jpg'],
        [`Documents/${ownerHash}/Img/${peerHash}/${id}.pic_thum`, 'jpg']
      );
    } else if (message.mediaKind === 'voice') {
      candidates.push([`Documents/${ownerHash}/Audio/${peerHash}/${id}.aud`, 'aud']);
    } else if (message.mediaKind === 'video') {
      candidates.push(
        [`Documents/${ownerHash}/Video/${peerHash}/${id}.mp4`, 'mp4'],
        [`Documents/${ownerHash}/Video/${peerHash}/${id}_raw.mp4`, 'mp4']
      );
    }
    return candidates;
  }

  /**
   * 读取消息对应的媒体文件(同步版本,兼容旧调用)。
   * @returns {{buffer:Buffer, ext:string}|null}
   */
  getMediaFile(message, contact) {
    if (!this.options.includeMedia || !message.mediaKind) return null;
    for (const [relPath, ext] of this._mediaCandidates(message, contact)) {
      const buf = this.backup.readFile(relPath);
      if (buf && buf.length > 0) return { buffer: buf, ext };
    }
    return null;
  }

  /** 异步读取媒体文件,供 worker 并发上传使用 */
  async getMediaFileAsync(message, contact) {
    if (!this.options.includeMedia || !message.mediaKind) return null;
    for (const [relPath, ext] of this._mediaCandidates(message, contact)) {
      const buf = await this.backup.readFileAsync(relPath);
      if (buf && buf.length > 0) return { buffer: buf, ext };
    }
    return null;
  }

  /**
   * 读取语音转文字 sidecar:Documents/<owner>/Audio/<peer>/<MesLocalID>.txt
   * 该文件是微信“语音转文字”的结果,编码为 UTF-8;没有结果时返回空字符串。
   */
  async getVoiceTextAsync(message, contact) {
    if (!message || message.mediaKind !== 'voice' || !message.mesLocalId) return '';
    const ownerHash = message.ownerHash || md5(contact.owner);
    const relPath = `Documents/${ownerHash}/Audio/${contact.hash}/${message.mesLocalId}.txt`;
    const buf = await this.backup.readFileAsync(relPath);
    if (!buf || buf.length === 0) return '';
    let text;
    try {
      text = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
    } catch (err) {
      return '';
    }
    if (!text || text.includes('\u0000')) return '';
    return text.slice(0, 20000);
  }

  /** 关闭底层资源 */
  close() {
    this.backup.close();
  }
}

module.exports = {
  WechatBackupParser,
  parseLoginInfo2,
  parseRemarkBlob,
  parseChatroomBlob,
  parseAvatarBlob,
  md5,
};
