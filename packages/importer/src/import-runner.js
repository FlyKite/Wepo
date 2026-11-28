/**
 * 导入执行器:解析 iOS 备份中的微信数据并分步上传到服务端。
 * 客户端本地导入与服务端 NAS 目录导入共用此模块,运行于 worker_threads。
 */

const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const { WechatBackupParser, ZipBackupExtractor, warmupWcdbZstd } = require('@wepo/core');
const { fetchAvatar, isAllowedAvatarUrl } = require('./avatar-downloader');

const CONTACT_CHUNK = 300;
const MESSAGE_CHUNK = 1000;
// 媒体文件主要来自 SMB/外接盘,小文件随机读取延迟高;并发 8 可明显提高吞吐。
// 可通过 WEPO_MEDIA_CONCURRENCY 调整,最高限制 32 避免占用过多内存。
const MEDIA_CONCURRENCY = Math.min(
  32,
  Math.max(1, Number(process.env.WEPO_MEDIA_CONCURRENCY) || 8)
);
const AVATAR_DOWNLOAD_CONCURRENCY = 4;
const AVATAR_DOWNLOAD_RETRIES = 2;

/**
 * 服务端联系人按 (backup_id, hash) 唯一,但同一 wxid 可能同时出现在多个
 * 微信账号下。若直接上传全部联系人,后上传的“0 消息”账号记录会覆盖先上传的
 * 有消息记录(包括 owner/messageCount/dbPath),造成消息和合并归属错乱。
 * 上传前按 hash 去重,优先选择有聊天表、消息数更多、最近消息更新的记录。
 */
function isBetterContact(candidate, current) {
  const cHasChat = candidate.dbPath ? 1 : 0;
  const eHasChat = current.dbPath ? 1 : 0;
  if (cHasChat !== eHasChat) return cHasChat > eHasChat;
  const cCount = Number(candidate.messageCount) || 0;
  const eCount = Number(current.messageCount) || 0;
  if (cCount !== eCount) return cCount > eCount;
  const cTime = Number(candidate.lastMessageTime) || 0;
  const eTime = Number(current.lastMessageTime) || 0;
  return cTime > eTime;
}

function dedupeContactsByHash(contacts) {
  const groups = new Map();
  for (const contact of contacts) {
    if (!contact.hash) continue;
    if (!groups.has(contact.hash)) groups.set(contact.hash, []);
    groups.get(contact.hash).push(contact);
  }
  const unique = [];
  let duplicateHashes = 0;
  let multiMessageHashes = 0;
  for (const group of groups.values()) {
    let chosen = group[0];
    for (let i = 1; i < group.length; i += 1) {
      if (isBetterContact(group[i], chosen)) chosen = group[i];
    }
    unique.push(chosen);
    if (group.length > 1) {
      duplicateHashes += 1;
      if (group.filter((item) => (Number(item.messageCount) || 0) > 0).length > 1) {
        multiMessageHashes += 1;
      }
    }
  }
  unique.sort((a, b) => (
    (Number(b.lastMessageTime) || 0) - (Number(a.lastMessageTime) || 0)
    || (Number(b.messageCount) || 0) - (Number(a.messageCount) || 0)
  ));
  return { contacts: unique, duplicateHashes, multiMessageHashes };
}

function post(payload) {
  if (parentPort) parentPort.postMessage(payload);
  else if (payload.event === 'log' || payload.event === 'stage' || payload.event === 'summary') {
    console.log(`[${payload.event}] ${payload.text || JSON.stringify(payload)}`);
  }
}

function log(text) {
  post({ event: 'log', text });
}

/** 上传/调用服务端接口,自动携带鉴权 Secret */
function authHeaders(secret, extra) {
  const headers = Object.assign({}, extra);
  if (secret) headers['X-WEPO-Secret'] = secret;
  return headers;
}

/** 把 fetch 的 cause(ECONNRESET/UND_ERR_SOCKET 等)也带进错误信息 */
function describeError(err) {
  const parts = [];
  if (err && err.message) parts.push(err.message);
  const cause = err && err.cause;
  if (cause) {
    const code = cause.code || cause.name;
    if (code) parts.push(`[${code}]`);
    if (cause.message && cause.message !== err.message) parts.push(cause.message);
  }
  return parts.join(' ') || String(err);
}

/** 网络错误/5xx 自动重试;其他错误直接抛出 */
async function withNetworkRetry(fn, label, retries = 0) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!err.retryable || attempt >= retries) throw err;
      attempt += 1;
      const delay = 500 * (2 ** (attempt - 1));
      log(`${label}失败,${delay}ms 后重试(${attempt}/${retries}): ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function requestWithAuth(serverUrl, api, options, secret, label) {
  let res;
  try {
    res = await fetch(`${serverUrl}${api}`, Object.assign({}, options, {
      headers: authHeaders(secret, options.headers),
    }));
  } catch (err) {
    const networkError = new Error(`${label}失败: 网络错误(${describeError(err)})`);
    networkError.cause = err;
    networkError.retryable = true;
    throw networkError;
  }
  if (res.status === 401) {
    throw new Error(`鉴权失败(${label}): Secret 无效或未配置,请检查客户端填写的 Secret 与根目录 config.json 是否一致`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error || '';
    } catch (err) {
      /* ignore */
    }
    const httpError = new Error(`${label}失败: HTTP ${res.status} ${detail}`);
    httpError.status = res.status;
    httpError.retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw httpError;
  }
  return res.json();
}

async function postJson(serverUrl, api, body, secret, retries = 0) {
  const payload = JSON.stringify(body);
  return withNetworkRetry(
    () => requestWithAuth(
      serverUrl,
      api,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload },
      secret,
      `上传 ${api}`
    ),
    `上传 ${api}`,
    retries
  );
}

async function getJson(serverUrl, api, secret, retries = 2) {
  return withNetworkRetry(
    () => requestWithAuth(serverUrl, api, { method: 'GET' }, secret, `读取 ${api}`),
    `读取 ${api}`,
    retries
  );
}

async function fetchImportStatus(serverUrl, backupId, secret) {
  return getJson(
    serverUrl,
    `/api/import/status?backupId=${encodeURIComponent(backupId)}`,
    secret
  );
}

async function fetchPendingMedia(serverUrl, backupId, secret) {
  const items = [];
  let page = 1;
  for (;;) {
    const data = await getJson(
      serverUrl,
      `/api/import/pending-media?backupId=${encodeURIComponent(backupId)}`
        + `&page=${page}&pageSize=5000`,
      secret
    );
    items.push(...(data.items || []));
    if (!data.hasMore || !Array.isArray(data.items) || data.items.length === 0) break;
    page += 1;
  }
  return items;
}

async function postMedia(serverUrl, { backupId, contactHash, mesLocalId, kind, buffer, fileName }, secret) {
  return withNetworkRetry(() => {
    const form = new FormData();
    form.append('backupId', backupId);
    form.append('contactHash', contactHash);
    form.append('mesLocalId', String(mesLocalId));
    form.append('kind', kind);
    form.append('file', new Blob([buffer]), fileName);
    return requestWithAuth(serverUrl, '/api/import/media', { method: 'POST', body: form }, secret, '媒体上传');
  }, '媒体上传', 3);
}

async function postUserAvatar(serverUrl, { backupId, username, buffer, fileName }, secret) {
  return withNetworkRetry(() => {
    const form = new FormData();
    form.append('backupId', backupId);
    form.append('username', username);
    form.append('file', new Blob([buffer]), fileName);
    return requestWithAuth(serverUrl, '/api/import/user-avatar', { method: 'POST', body: form }, secret, '账号头像上传');
  }, '账号头像上传', 3);
}

function chunk(list, size) {
  const result = [];
  for (let i = 0; i < list.length; i += size) {
    result.push(list.slice(i, i + size));
  }
  return result;
}

/** 与服务端 friends=1 的判定保持一致 */
function isFriendContact(contact) {
  return Boolean(Number(contact.type) & 1)
    && !contact.isChatroom
    && Boolean(contact.username)
    && !/^gh_/.test(contact.username);
}

/** 进度文本中显示的会话名称,优先备注、昵称 */
function contactLabel(contact) {
  if (!contact) return '';
  return contact.remark || contact.nickname || contact.username || '未知会话';
}

async function fetchAvatarWithRetry(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchAvatar(url);
    } catch (err) {
      if (!err.retryable || attempt >= AVATAR_DOWNLOAD_RETRIES) throw err;
      const delay = 500 * (2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * 下载备份 headImg 中没有、但联系人库保存了远端 URL 的头像。
 * 只处理会出现在界面上的联系人:好友、群聊、有消息的单聊,以及群消息发送者。
 */
async function downloadMissingAvatars(serverUrl, backupId, candidates, log, secret) {
  const list = [...candidates.values()];
  if (list.length === 0) return;

  post({
    event: 'stage',
    stage: 'avatars',
    text: `正在下载缺失头像 (${list.length} 个)...`,
  });

  let next = 0;
  let done = 0;
  let ok = 0;
  let failed = 0;
  let networkFailures = 0;
  let aborted = false;

  async function worker() {
    for (;;) {
      if (aborted) return;
      const index = next++;
      if (index >= list.length) return;
      const contact = list[index];
      try {
        const avatar = await fetchAvatarWithRetry(contact.avatarUrl);
        await postMedia(serverUrl, {
          backupId,
          contactHash: contact.hash,
          mesLocalId: 0,
          kind: 'avatar',
          buffer: avatar.buffer,
          fileName: `${contact.hash}.${avatar.ext}`,
        }, secret);
        ok += 1;
        networkFailures = 0;
      } catch (err) {
        failed += 1;
        if (err.retryable) networkFailures += 1;
        if (failed <= 3) log(`部分联系人头像下载失败: ${err.message}`);
        // 网络整体不可用时,不要为几千个联系人反复超时重试
        if (networkFailures >= 20) {
          aborted = true;
          log('连续多次头像下载失败,已跳过剩余云端头像;无本地头像的联系人继续使用首字母占位');
        }
      }
      done += 1;
      if (done % 50 === 0 || done === list.length) {
        post({
          event: 'progress',
          stage: 'avatars',
          done,
          total: list.length,
          text: `下载缺失头像 ${done}/${list.length}`,
        });
      }
    }
  }

  const workers = Math.min(AVATAR_DOWNLOAD_CONCURRENCY, list.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  log(`云端头像处理完成: 成功 ${ok} 个,失败 ${failed} 个`);
}

async function main(params) {
  const options = params || workerData;
  if (!options || typeof options !== 'object') {
    throw new Error('缺少导入参数');
  }
  const {
    backupDir: rawBackupDir,
    backupZip,
    serverUrl,
    secret,
    includeMedia,
    backupId,
    dbTempDir,
    databaseModule,
  } = options;
  const id = backupId || crypto.randomUUID();
  const resuming = Boolean(backupId);
  let extractor = null;
  let parser = null;
  let backupDir = rawBackupDir;

  try {
    // 压缩包导入:先按需解压到临时目录(只解微信相关文件)
    if (backupZip) {
      post({ event: 'stage', stage: 'extract', text: '正在解压备份压缩包(仅微信相关文件)...' });
      extractor = new ZipBackupExtractor(backupZip);
      backupDir = await extractor.extract({
        onProgress: (p) => {
          if (p.totalBytes > 0) {
            const percent = Math.round((p.doneBytes / p.totalBytes) * 100);
            post({
              event: 'progress',
              stage: 'extract',
              done: p.doneBytes,
              total: p.totalBytes,
              text: `解压中 ${percent}% (${p.doneFiles}/${p.totalFiles} 个文件)`,
            });
          } else {
            post({
              event: 'progress',
              stage: 'extract',
              done: p.doneFiles,
              total: p.totalFiles,
              text: `解压中 ${p.doneFiles}/${p.totalFiles} 个文件`,
            });
          }
        },
      });
      post({ event: 'extracted', tempDir: backupDir });
      log(`解压完成: 临时目录 ${backupDir}`);
    }

    post({ event: 'stage', stage: 'parse', text: '正在准备解析备份...' });
    // 服务端导入时传入服务端自己的 better-sqlite3 路径,避免误用 Electron ABI 版本。
    const databaseOptions = databaseModule
      ? { Database: require(databaseModule) }
      : {};
    parser = new WechatBackupParser(backupDir, {
      includeMedia: includeMedia !== false,
      onProgress: (text) => log(text),
      onParseProgress: (progress) => {
        post({
          event: 'progress',
          stage: 'parse',
          done: Number(progress.done) || 0,
          total: Number(progress.total) || 0,
          stagePercent: Number(progress.percent) || 0,
          text: progress.text || '正在解析备份...',
        });
      },
      tempDir: dbTempDir,
      ...databaseOptions,
    });

    // 新版微信把非文本消息存成 WCDB zstd 字典压缩帧。先加载 MsgDict，
    // 否则 parseSummary / getMessages 只能把表情等消息解析成 [表情]。
    post({ event: 'stage', stage: 'parse', text: '正在加载消息压缩字典...' });
    try {
      const dict = await warmupWcdbZstd();
      log(`WCDB zstd 字典已加载: id=${dict.dictId}, ${dict.size} bytes`);
    } catch (err) {
      log(`WCDB zstd 字典加载失败，压缩消息将无法还原: ${describeError(err)}`);
    }

    let summary;
    try {
      post({ event: 'stage', stage: 'parse', text: '正在扫描账号、联系人与聊天记录...' });
      summary = parser.parseSummary();
    } catch (err) {
      post({ event: 'error', message: `解析失败: ${err.message}` });
      return;
    }
    const { info, users, contacts, tags = [] } = summary;
    const {
      contacts: uploadContacts,
      duplicateHashes,
      multiMessageHashes,
    } = dedupeContactsByHash(contacts);

    // 群消息发送者可能不是好友,但会出现在群聊消息中;后面对需要的发送者补头像
    const contactByUsername = new Map();
    const contactsByHash = new Map();
    for (const contact of uploadContacts) {
      if (contact.hash && !contactsByHash.has(contact.hash)) {
        contactsByHash.set(contact.hash, contact);
      }
      if (!contact.username) continue;
      const existing = contactByUsername.get(contact.username);
      if (!existing || (!existing.avatarUrl && contact.avatarUrl)) {
        contactByUsername.set(contact.username, contact);
      }
    }

    if (duplicateHashes > 0) {
      log(`检测到 ${duplicateHashes} 个跨微信账号重复联系人,已优先保留有消息/消息更多的记录`);
    }
    if (multiMessageHashes > 0) {
      log(`注意:${multiMessageHashes} 个联系人在多个微信账号下都有消息,服务端按 hash 合并,仅保留消息更多的一份`);
    }

    const totalMessages = uploadContacts.reduce((s, c) => s + (c.messageCount || 0), 0);
    post({
      event: 'summary',
      deviceName: info.deviceName || '未知设备',
      iosVersion: info.iosVersion || '',
      userCount: users.length,
      contactCount: uploadContacts.length,
      messageCount: totalMessages,
    });
    if (includeMedia !== false) {
      log(`媒体读取并发: ${MEDIA_CONCURRENCY} (UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE || '默认'})`);
    }

    // 1. 备份元信息
    post({ event: 'stage', stage: 'meta', text: '正在上传备份元信息...' });
    await postJson(serverUrl, '/api/import/meta', {
      id,
      device: {
        deviceName: info.deviceName,
        productType: info.productType,
        iosVersion: info.iosVersion,
        serialNumber: info.serialNumber,
        backupDate: info.backupDate,
      },
      users,
      backupDir: backupDir || '',
      sourcePath: rawBackupDir || backupZip || '',
    }, secret, 3);
    post({ event: 'started', backupId: id });

    // 断点续传:服务端已有进度用于跳过已上传的消息/头像,并只补传缺失媒体
    post({
      event: 'stage',
      stage: 'resume',
      text: resuming ? '检查服务端已上传进度...' : '检查服务端导入状态...',
    });
    const serverStatus = await fetchImportStatus(serverUrl, id, secret);
    const progressByHash = new Map(
      (serverStatus.contacts || []).map((item) => [item.hash, item])
    );
    const serverAvatarHashes = new Set(
      (serverStatus.contacts || []).filter((item) => item.hasAvatar).map((item) => item.hash)
    );
    const existingMessages = Number(serverStatus.totals && serverStatus.totals.messages) || 0;
    log(`服务端已有消息 ${Math.min(existingMessages, totalMessages)}/${totalMessages} 条,`
      + `待补媒体 ${Number(serverStatus.totals && serverStatus.totals.pendingMedia) || 0} 个`);

    // 1.5 账号头像(用于网页“我”页面与账号切换列表)
    if (includeMedia !== false) {
      post({
        event: 'stage',
        stage: 'user-avatars',
        text: `正在上传账号头像 (0/${users.length})...`,
      });
      for (let index = 0; index < users.length; index += 1) {
        const user = users[index];
        try {
          let avatar = parser.getAvatarFile(user.hash, user.username);
          let ext = 'jpg';
          if (!avatar && user.avatarUrl && isAllowedAvatarUrl(user.avatarUrl)) {
            const remote = await fetchAvatarWithRetry(user.avatarUrl);
            avatar = remote.buffer;
            ext = remote.ext;
          }
          if (avatar) {
            await postUserAvatar(serverUrl, {
              backupId: id,
              username: user.username,
              buffer: avatar,
              fileName: `${user.hash}.${ext}`,
            }, secret);
          }
        } catch (err) {
          log(`账号头像上传失败: ${err.message}`);
        }
        post({
          event: 'progress',
          stage: 'user-avatars',
          done: index + 1,
          total: users.length,
          text: `正在上传账号头像 ${index + 1}/${users.length}`,
        });
      }
    }
  
    // 2. 联系人(分批)
    post({
      event: 'stage',
      stage: 'contacts',
      text: `正在上传联系人 (0/${uploadContacts.length})...`,
    });
    const contactChunks = chunk(uploadContacts, CONTACT_CHUNK);
    for (let i = 0; i < contactChunks.length; i++) {
      await postJson(serverUrl, '/api/import/contacts', { backupId: id, contacts: contactChunks[i] }, secret, 3);
      post({
        event: 'progress',
        stage: 'contacts',
        done: Math.min((i + 1) * CONTACT_CHUNK, uploadContacts.length),
        total: uploadContacts.length,
        text: `正在上传联系人 ${Math.min((i + 1) * CONTACT_CHUNK, uploadContacts.length)}/${uploadContacts.length}`,
      });
    }

    // 2.5 联系人标签(旧版备份没有标签表时 tags 为空)
    if (tags.length > 0) {
      post({
        event: 'stage',
        stage: 'tags',
        text: `正在上传联系人标签 (${tags.length} 个)...`,
      });
      await postJson(serverUrl, '/api/import/tags', { backupId: id, tags }, secret, 3);
      log(`已上传 ${tags.length} 个联系人标签`);
    }

    // 3. 本地头像(备份 headImg 中有文件的);续传时跳过服务端已有头像
    const localAvatarHashes = new Set(serverAvatarHashes);
    if (includeMedia !== false) {
      const totalAvatars = uploadContacts.length;
      let scannedAvatars = 0;
      let uploadedAvatars = 0;
      post({
        event: 'stage',
        stage: 'contact-avatars',
        text: `正在检查联系人头像 (0/${totalAvatars})...`,
      });
      for (const contact of uploadContacts) {
        scannedAvatars += 1;
        if (!localAvatarHashes.has(contact.hash)) {
          try {
            const avatar = parser.getAvatarFile(contact.hash, contact.owner);
            if (avatar) {
              await postMedia(serverUrl, {
                backupId: id,
                contactHash: contact.hash,
                mesLocalId: 0,
                kind: 'avatar',
                buffer: avatar,
                fileName: `${contact.hash}.jpg`,
              }, secret);
              localAvatarHashes.add(contact.hash);
              uploadedAvatars += 1;
            }
          } catch (err) {
            log(`联系人头像上传失败: ${err.message}`);
          }
        }
        if (scannedAvatars % 100 === 0 || scannedAvatars === totalAvatars) {
          post({
            event: 'progress',
            stage: 'contact-avatars',
            done: scannedAvatars,
            total: totalAvatars,
            text: `正在检查联系人头像 ${scannedAvatars}/${totalAvatars}`
              + `（已上传 ${uploadedAvatars}）`,
          });
        }
      }
    }

    // 3.5 记录可从微信头像 CDN 补齐的联系人(好友、群聊、有消息的会话)
    const avatarCandidates = new Map();
    const addAvatarCandidate = (contact) => {
      if (!contact || !contact.hash || localAvatarHashes.has(contact.hash)) return;
      if (!contact.avatarUrl || !isAllowedAvatarUrl(contact.avatarUrl)) return;
      if (!avatarCandidates.has(contact.hash)) avatarCandidates.set(contact.hash, contact);
    };
    if (includeMedia !== false) {
      for (const contact of uploadContacts) {
        if (contact.isChatroom || isFriendContact(contact) || Number(contact.messageCount) > 0) {
          addAvatarCandidate(contact);
        }
      }
    }

    // 群成员不一定在本次续传扫描到的消息里(历史发送者、长期潜水成员)。
    // 这里直接遍历所有群聊成员,使头像补齐不依赖消息是否重新扫描。
    const groupMemberUsernames = new Set();
    if (includeMedia !== false) {
      for (const contact of uploadContacts) {
        if (!contact.isChatroom || !Array.isArray(contact.members)) continue;
        for (const member of contact.members) {
          const username = String(member && member.username || '').trim();
          if (username) groupMemberUsernames.add(username);
        }
      }
    }

    // 4. 聊天记录(逐会话、分批);续传时按服务端 maxMesLocalId 跳过已上传前缀
    let doneMessages = Math.min(existingMessages, totalMessages);
    let mediaFailures = 0;
    const groupSenderUsernames = new Set();
    let lastMessageProgressAt = 0;
    const reportMessageProgress = (currentName = '', force = false) => {
      const now = Date.now();
      if (!force && now - lastMessageProgressAt < 500) return;
      lastMessageProgressAt = now;
      const done = Math.min(doneMessages, totalMessages);
      post({
        event: 'progress',
        stage: 'messages',
        done,
        total: totalMessages,
        text: `正在上传聊天记录 ${done}/${totalMessages}`
          + (currentName ? `（当前：${currentName}）` : ''),
      });
    };
    post({
      event: 'stage',
      stage: 'messages',
      text: `正在上传聊天记录 ${Math.min(doneMessages, totalMessages)}/${totalMessages}...`,
    });
    for (const contact of uploadContacts) {
      if (!contact.dbPath) continue;
      const prior = progressByHash.get(contact.hash);
      const localCount = Number(contact.messageCount) || 0;
      if (prior && Number(prior.messages) >= localCount) {
        continue;
      }
      const skipThrough = prior ? Number(prior.maxMesLocalId) || 0 : 0;
      let buffer = [];
      let mediaQueue = [];
      for (const message of parser.getMessages(contact)) {
        if (message.mesLocalId <= skipThrough) continue;
        if (message.mediaKind === 'voice') {
          const voiceText = await parser.getVoiceTextAsync(message, contact);
          if (voiceText) {
            message.extra = Object.assign({}, message.extra || {}, { voiceText });
          }
        }
        buffer.push(message);
        if (includeMedia !== false && contact.isChatroom && !message.isSent && message.sender) {
          groupSenderUsernames.add(message.sender);
        }
        if (includeMedia !== false && message.mediaKind) {
          mediaQueue.push(message);
        }
        if (buffer.length >= MESSAGE_CHUNK) {
          await postJson(serverUrl, '/api/import/messages', {
            backupId: id,
            contactHash: contact.hash,
            messages: buffer,
          }, secret, 3);
          const mediaResult = await uploadMedia(
            serverUrl, id, contact, mediaQueue, parser, log, secret,
            (progress) => post({
              event: 'progress',
              stage: 'messages',
              done: Math.min(doneMessages, totalMessages),
              total: totalMessages,
              text: `正在上传聊天记录中的媒体 ${progress.done}/${progress.total}`
                + `（当前：${contactLabel(contact)}）`,
            })
          );
          mediaFailures += mediaResult ? mediaResult.failed : 0;
          buffer = [];
          mediaQueue = [];
        }
        doneMessages++;
        if (doneMessages % 2000 === 0) {
          reportMessageProgress(contactLabel(contact));
        }
      }
      if (buffer.length > 0) {
        await postJson(serverUrl, '/api/import/messages', {
          backupId: id,
          contactHash: contact.hash,
          messages: buffer,
        }, secret, 3);
        const mediaResult = await uploadMedia(
          serverUrl, id, contact, mediaQueue, parser, log, secret,
          (progress) => post({
            event: 'progress',
            stage: 'messages',
            done: Math.min(doneMessages, totalMessages),
            total: totalMessages,
            text: `正在上传聊天记录中的媒体 ${progress.done}/${progress.total}`
              + `（当前：${contactLabel(contact)}）`,
          })
        );
        mediaFailures += mediaResult ? mediaResult.failed : 0;
      }
      reportMessageProgress(contactLabel(contact));
    }
    reportMessageProgress('', true);

    // 4.1 完整性校验:服务端实际消息数/有消息会话数不足时不能标记完成,
    // 否则会像之前一样把只上传了部分会话的备份显示成“导入完成”。
    post({
      event: 'stage',
      stage: 'verify',
      text: '正在校验聊天记录完整性...',
    });
    const finalStatus = await fetchImportStatus(serverUrl, id, secret);
    const serverMessages = Number(finalStatus.totals && finalStatus.totals.messages) || 0;
    const serverMessageChats = (finalStatus.contacts || [])
      .filter((item) => Number(item.messages) > 0).length;
    const expectedMessageChats = uploadContacts
      .filter((contact) => contact.dbPath && (Number(contact.messageCount) || 0) > 0).length;
    if (serverMessages < totalMessages || serverMessageChats < expectedMessageChats) {
      throw new Error(
        `导入不完整:服务端已有 ${serverMessages}/${totalMessages} 条消息、`
        + `${serverMessageChats}/${expectedMessageChats} 个有消息的会话,请继续导入`
      );
    }
    log(`消息完整性校验通过: ${serverMessages} 条消息,${serverMessageChats} 个有消息的会话`);

    // 4.2 续传或本次有媒体失败时,按服务端缺失列表只补传需要的文件
    let repairResult = null;
    if (includeMedia !== false && (resuming || mediaFailures > 0)) {
      post({
        event: 'stage',
        stage: 'verify',
        text: '正在检查缺失媒体...',
      });
      const pendingMedia = await fetchPendingMedia(serverUrl, id, secret);
      if (pendingMedia.length > 0) {
        repairResult = await repairMissingMedia(
          serverUrl,
          id,
          contactsByHash,
          parser,
          pendingMedia,
          log,
          secret
        );
      } else {
        log('服务端没有缺失媒体,无需补传');
      }
    }
    const unresolvedMediaFailures = repairResult ? repairResult.failed : mediaFailures;
    if (includeMedia !== false && unresolvedMediaFailures > 0) {
      throw new Error(
        `仍有 ${unresolvedMediaFailures} 个媒体上传失败,已保留当前进度,请检查网络/磁盘后继续导入`
      );
    }

    // 4.5 云端头像补齐:群成员通常没有本地 headImg,但联系人库保存了微信头像 URL
    if (includeMedia !== false) {
      for (const username of groupMemberUsernames) {
        addAvatarCandidate(contactByUsername.get(username));
      }
      for (const username of groupSenderUsernames) {
        addAvatarCandidate(contactByUsername.get(username));
      }
      await downloadMissingAvatars(serverUrl, id, avatarCandidates, log, secret);
    }

    // 5. 汇总
    post({ event: 'stage', stage: 'complete', text: '正在生成导入统计...' });
    let stats;
    try {
      stats = await postJson(serverUrl, '/api/import/complete', { backupId: id }, secret, 3);
    } catch (err) {
      // 完成请求可能在服务端已经提交,只是响应丢失。此时不能再报失败并让
      // 用户重新导入,否则会生成第二个 backupId 和重复数据;先查服务端状态。
      log(`完成请求失败(${describeError(err)}),正在确认服务端是否已提交...`);
      let status = null;
      try {
        status = await fetchImportStatus(serverUrl, id, secret);
      } catch (statusErr) {
        log(`确认服务端状态失败: ${describeError(statusErr)}`);
      }
      if (!status || !status.backup || !status.backup.completedAt) throw err;
      stats = {
        contactCount: Number(status.backup.contactCount) || 0,
        messageCount: Number(status.backup.messageCount) || 0,
        mediaCount: Number(status.backup.mediaCount) || 0,
        pendingMedia: Number(status.totals && status.totals.pendingMedia) || 0,
        recoveredCompletion: true,
      };
      log('服务端已完成该备份,按导入成功结束');
    }

    post({ event: 'done', backupId: id, stats });
    return { backupId: id, stats };
  } finally {
    if (parser) parser.close();
    if (extractor) extractor.cleanup();
  }
}

/** 上传媒体任务(并发读取源文件 + 上传),返回统计 */
async function uploadMediaTasks(serverUrl, backupId, tasks, parser, log, secret, onProgress) {
  let next = 0;
  let done = 0;
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      const { contact, message } = tasks[index];
      try {
        const media = await parser.getMediaFileAsync(message, contact);
        if (!media) {
          skipped += 1;
        } else {
          await postMedia(serverUrl, {
            backupId,
            contactHash: contact.hash,
            mesLocalId: message.mesLocalId,
            kind: message.mediaKind,
            buffer: media.buffer,
            fileName: `${message.mesLocalId}.${media.ext}`,
          }, secret);
          uploaded += 1;
        }
      } catch (err) {
        failed += 1;
        if (failed <= 5) {
          log(`媒体上传失败 ${contact.nickname || contact.hash} #${message.mesLocalId}: ${err.message}`);
        }
      }
      done += 1;
      if (onProgress && (done % 50 === 0 || done === tasks.length)) {
        onProgress({ done, total: tasks.length, uploaded, skipped, failed });
      }
    }
  }

  const workers = Math.min(MEDIA_CONCURRENCY, tasks.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { uploaded, skipped, failed };
}

/** 上传一批消息的媒体文件 */
async function uploadMedia(serverUrl, backupId, contact, messages, parser, log, secret, onProgress = null) {
  if (messages.length === 0) return;
  // 网络盘上小文件读取的延迟占主导;并发读取+上传可显著减少总耗时
  const tasks = messages.map((message) => ({ contact, message }));
  return uploadMediaTasks(serverUrl, backupId, tasks, parser, log, secret, onProgress);
}

/**
 * 补传服务端 media_path 仍为空的文件。
 * 先按联系人把缺失的 MesLocalID 收集起来,只扫描对应会话一次,
 * 已上传成功的文件不会重复上传。
 */
async function repairMissingMedia(serverUrl, backupId, contactsByHash, parser, pendingItems, log, secret) {
  if (pendingItems.length === 0) return { uploaded: 0, skipped: 0, failed: 0, missing: 0 };

  post({
    event: 'stage',
    stage: 'repair',
    text: `正在检查缺失媒体 (${pendingItems.length} 个)...`,
  });
  const groups = new Map();
  for (const item of pendingItems) {
    const hash = String(item.contactHash || '');
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash).push(item);
  }

  const tasks = [];
  let missingContact = 0;
  for (const [hash, items] of groups) {
    const contact = contactsByHash.get(hash);
    if (!contact || !contact.dbPath) {
      missingContact += items.length;
      continue;
    }
    const wanted = new Map(items.map((item) => [Number(item.mesLocalId), item]));
    for (const message of parser.getMessages(contact)) {
      const localId = Number(message.mesLocalId);
      if (!wanted.has(localId)) continue;
      tasks.push({ contact, message });
      wanted.delete(localId);
      if (wanted.size === 0) break;
    }
    if (wanted.size > 0) missingContact += wanted.size;
  }

  post({
    event: 'stage',
    stage: 'repair',
    text: `正在补传缺失媒体 (${tasks.length} 个待上传,${missingContact} 个无对应会话)...`,
  });
  const result = await uploadMediaTasks(
    serverUrl,
    backupId,
    tasks,
    parser,
    log,
    secret,
    ({ done, total, uploaded, skipped, failed }) => {
      post({
        event: 'progress',
        stage: 'repair',
        done,
        total,
        text: `补传缺失媒体 ${done}/${total}(成功 ${uploaded},无源文件 ${skipped},失败 ${failed})`,
      });
    }
  );
  log(`缺失媒体补传完成: 成功 ${result.uploaded} 个,本地无源文件 ${result.skipped} 个,失败 ${result.failed} 个,无对应会话 ${missingContact} 个`);
  return { ...result, missing: missingContact };
}

module.exports = { runImport: main };
