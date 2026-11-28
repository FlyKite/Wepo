/**
 * 发送私有媒体文件(头像/聊天媒体)。
 *
 * 这些文件的 URL 以数据库行 id 或联系人 hash 命名,重新导入后同一个 URL 可能
 * 指向不同内容。因此不使用 max-age 长期缓存,而是返回 ETag 让浏览器每次复用前
 * 校验;内容变化时立即拿到新文件,未变化时只返回 304。
 */

const fs = require('fs');

/**
 * 根据文件头识别图片类型。微信头像源文件常以 .pic/.jpg 命名,但内容可能是
 * PNG(例如从 wx.qlogo.cn 下载的头像),不能只按扩展名返回 Content-Type。
 * @returns {{ext: string, contentType: string}}
 */
function detectImageType(file) {
  const header = Buffer.alloc(12);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, header, 0, header.length, 0);
  } catch (err) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  if (header.length >= 8
    && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
    && header[4] === 0x0d && header[5] === 0x0a && header[6] === 0x1a && header[7] === 0x0a) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (header.length >= 6 && header.subarray(0, 4).toString('ascii') === 'GIF8') {
    return { ext: 'gif', contentType: 'image/gif' };
  }
  if (header.length >= 12
    && header.subarray(0, 4).toString('ascii') === 'RIFF'
    && header.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  return { ext: 'jpg', contentType: 'image/jpeg' };
}

function etagMatches(header, etag) {
  if (!header) return false;
  return String(header)
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === etag || value === `W/${etag}`);
}

/** @returns {boolean} 是否已响应(404/304),false 表示已开始发送文件 */
function sendFileWithValidation(req, res, file, contentType, cacheControl = 'private, no-cache') {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    res.status(404).end();
    return true;
  }
  if (!stat.isFile()) {
    res.status(404).end();
    return true;
  }

  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Accept-Ranges', 'bytes');
  if (contentType) res.setHeader('Content-Type', contentType);

  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.status(304).end();
    return true;
  }
  if (!req.headers['if-none-match'] && req.headers['if-modified-since']) {
    const since = Date.parse(req.headers['if-modified-since']);
    if (!Number.isNaN(since) && Math.floor(stat.mtimeMs / 1000) <= Math.floor(since / 1000)) {
      res.status(304).end();
      return true;
    }
  }

  // Safari/WebKit 的媒体栈要求音频/视频支持 HTTP Range(含 bytes=0-1 探测),
  // 否则即使 WAV 内容合法也会直接报错。这里对单段 Range 返回 206。
  const rangeHeader = String(req.headers.range || '').trim();
  let range = null;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader);
    if (match && (match[1] !== '' || match[2] !== '')) {
      let start;
      let end;
      if (match[1] === '') {
        const suffix = Number(match[2]);
        start = Math.max(0, stat.size - suffix);
        end = stat.size - 1;
      } else {
        start = Number(match[1]);
        end = match[2] === '' ? stat.size - 1 : Math.min(Number(match[2]), stat.size - 1);
      }
      if (Number.isInteger(start) && Number.isInteger(end)
        && stat.size > 0 && start >= 0 && start < stat.size && start <= end) {
        range = { start, end };
      }
    }
    if (!range) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      res.end();
      return true;
    }
  }

  if (range) {
    const length = range.end - range.start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
    res.setHeader('Content-Length', length);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    const stream = fs.createReadStream(file, { start: range.start, end: range.end });
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).end();
      else res.end();
    });
    stream.pipe(res);
    return false;
  }

  res.setHeader('Content-Length', stat.size);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => {
    if (!res.headersSent) res.status(404).end();
    else res.end();
  });
  stream.pipe(res);
  return false;
}

module.exports = { sendFileWithValidation, detectImageType };
