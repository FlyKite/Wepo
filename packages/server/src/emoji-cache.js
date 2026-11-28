/**
 * 微信表情/贴纸按需缓存。
 *
 * 消息表 extra 中保存了表情的 md5 和 cdnurl。表情文件通常不在 iOS 备份里
 * (或只有 Emoticon 元数据),因此第一次查看时从微信 CDN 下载,并按 md5 缓存到
 * data/media/<backupId>/emojis/。之后所有引用同一 md5 的消息直接读本地文件。
 *
 * cdnurl 来自备份(不可信输入),所以这里限制固定微信 CDN 主机、协议、端口、
 * 重定向、超时和大小,并校验图片文件头,避免 SSRF/任意文件读取。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_EMOJI_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15000;
const FAILURE_TTL_MS = 60 * 1000;
const ALLOWED_HOSTS = new Set([
  'wxapp.tc.qq.com',
  'vweixinf.tc.qq.com',
  'snsvideo.c2c.wechat.com',
  'snsvideo.hk.wechat.com',
  'mmbiz.qpic.cn',
  'emoji.qpic.cn',
]);
const EXTENSIONS = ['gif', 'png', 'jpg', 'jpeg', 'webp'];

const inFlight = new Map();
const failedUntil = new Map();

function normalizeEmojiUrl(value) {
  if (!value || typeof value !== 'string' || value.length > 4096) return null;
  let url;
  try {
    url = new URL(value.replace(/&amp;/g, '&'));
  } catch (err) {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && !((url.protocol === 'http:' && url.port === '80')
    || (url.protocol === 'https:' && url.port === '443'))) {
    return null;
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
  return url.toString();
}

function isAllowedEmojiUrl(value) {
  return Boolean(normalizeEmojiUrl(value));
}

function detectImageExt(buffer) {
  if (!buffer || buffer.length < 3) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return 'png';
  }
  if (buffer.length >= 6 && buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  return '';
}

function findExistingEmoji(dir, md5) {
  for (const ext of EXTENSIONS) {
    const file = path.join(dir, `${md5}.${ext}`);
    try {
      if (fs.statSync(file).size > 0) return file;
    } catch (err) {
      /* not found */
    }
  }
  return '';
}

function normalizeBackupId(value) {
  const id = String(value || '');
  return /^[A-Za-z0-9._-]+$/.test(id) ? id : '';
}

async function fetchOnce(rawUrl) {
  let current = normalizeEmojiUrl(rawUrl);
  if (!current) throw new Error('emoji url not allowed');

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'image/*' },
      });
    } catch (err) {
      const e = new Error(`emoji fetch failed: ${err.message || err.name}`);
      e.retryable = true;
      e.cause = err;
      throw e;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (res.body) await res.body.cancel().catch(() => {});
      if (!location) throw new Error('emoji redirect without location');
      current = normalizeEmojiUrl(new URL(location, current).toString());
      if (!current) throw new Error('emoji redirect not allowed');
      continue;
    }

    if (!res.ok) {
      if (res.body) await res.body.cancel().catch(() => {});
      const e = new Error(`emoji HTTP ${res.status}`);
      e.retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      throw e;
    }

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_EMOJI_BYTES) {
      if (res.body) await res.body.cancel().catch(() => {});
      throw new Error('emoji too large');
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_EMOJI_BYTES) {
      throw new Error('emoji empty or too large');
    }
    const ext = detectImageExt(buffer);
    if (!ext) throw new Error('emoji is not a supported image');
    return { buffer, ext };
  }
  throw new Error('emoji too many redirects');
}

async function fetchEmoji(rawUrl) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchOnce(rawUrl);
    } catch (err) {
      lastError = err;
      if (!err.retryable || attempt === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastError || new Error('emoji fetch failed');
}

/**
 * 查找或创建表情缓存文件。
 * @param {string} mediaDir 服务端 MEDIA_DIR
 * @param {string} backupId
 * @param {string} md5
 * @param {string} cdnurl
 * @returns {Promise<string>} 本地文件绝对路径;失败返回空字符串
 */
async function ensureEmojiAsset(mediaDir, backupId, md5, cdnurl) {
  const id = normalizeBackupId(backupId);
  const hash = String(md5 || '').toLowerCase();
  if (!id || !/^[a-f0-9]{32}$/.test(hash)) return '';

  const dir = path.join(mediaDir, id, 'emojis');
  const existing = findExistingEmoji(dir, hash);
  if (existing) return existing;

  const key = `${id}:${hash}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const failedAt = failedUntil.get(key);
  if (failedAt && Date.now() - failedAt < FAILURE_TTL_MS) return '';

  const task = (async () => {
    try {
      const image = await fetchEmoji(cdnurl);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${hash}.${image.ext}`);
      const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(temp, image.buffer);
      fs.renameSync(temp, file);
      failedUntil.delete(key);
      return file;
    } catch (err) {
      failedUntil.set(key, Date.now());
      return '';
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return task;
}

module.exports = {
  ensureEmojiAsset,
  normalizeEmojiUrl,
  isAllowedEmojiUrl,
  detectImageExt,
};
