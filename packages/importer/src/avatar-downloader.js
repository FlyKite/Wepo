/**
 * 从微信头像 CDN 下载备份中没有本地 headImg 缓存的头像。
 *
 * 微信联系人库(WCDB_Contact.sqlite)的 dbContactHeadImage 字段保存了头像 URL;
 * 群成员等非好友通常没有本地 headImg 文件,因此回退到下载该 URL。这里的 URL
 * 来自备份数据(不可信输入),因此只允许微信头像 CDN 的固定主机、只使用 HTTPS、
 * 限制超时/大小/重定向,并校验图片文件头。
 */

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// 备份中实际出现的微信头像 CDN 主机。只允许这些主机,避免把备份里的任意 URL
// 变成客户端的 SSRF 请求。
const ALLOWED_HOSTS = new Set([
  'wx.qlogo.cn',
  'thirdwx.qlogo.cn',
  'wework.qpic.cn',
  'p.qpic.cn',
  'mmbiz.qpic.cn',
  'mmhead.c2c.wechat.com',
  'mmhead.hk.wechat.com',
  'wwcdn.weixin.qq.com',
]);

function isAllowedHost(hostname) {
  return ALLOWED_HOSTS.has(String(hostname || '').toLowerCase());
}

/** http 头像 URL 统一升级到 https;返回 null 表示不在白名单内 */
function normalizeAvatarUrl(value) {
  if (!value || typeof value !== 'string' || value.length > 4096) return null;
  let url;
  try {
    url = new URL(value);
  } catch (err) {
    return null;
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  if (!isAllowedHost(url.hostname)) return null;
  return url.toString();
}

function isAllowedAvatarUrl(value) {
  return Boolean(normalizeAvatarUrl(value));
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

function avatarError(message, retryable) {
  const err = new Error(message);
  err.retryable = Boolean(retryable);
  return err;
}

/**
 * 下载单个头像。
 * @param {string} rawUrl
 * @returns {Promise<{buffer: Buffer, ext: string}>}
 */
async function fetchAvatar(rawUrl) {
  let current = normalizeAvatarUrl(rawUrl);
  if (!current) throw avatarError('头像 URL 不在允许的微信 CDN 列表中', false);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(12000),
        headers: { Accept: 'image/*' },
      });
    } catch (err) {
      const e = avatarError(`头像下载失败: ${err.message || err.name}`, true);
      e.cause = err;
      throw e;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (res.body) await res.body.cancel().catch(() => {});
      if (!location) throw avatarError(`头像下载失败: 重定向缺少地址`, false);
      const next = normalizeAvatarUrl(new URL(location, current).toString());
      if (!next) throw avatarError('头像 URL 重定向到了非微信 CDN', false);
      current = next;
      continue;
    }

    if (!res.ok) {
      if (res.body) await res.body.cancel().catch(() => {});
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      throw avatarError(`头像下载失败: HTTP ${res.status}`, retryable);
    }

    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_AVATAR_BYTES) {
      if (res.body) await res.body.cancel().catch(() => {});
      throw avatarError('头像文件过大', false);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_AVATAR_BYTES) {
      throw avatarError('头像文件为空或过大', false);
    }
    const ext = detectImageExt(buffer);
    if (!ext) throw avatarError('返回内容不是有效图片', false);
    return { buffer, ext };
  }

  throw avatarError('头像下载重定向次数过多', false);
}

module.exports = {
  fetchAvatar,
  isAllowedAvatarUrl,
  normalizeAvatarUrl,
  detectImageExt,
  MAX_AVATAR_BYTES,
};
