/**
 * iOS 未加密 iTunes/Finder 备份目录读取。
 *
 * - 新版备份(iOS 10+)目录结构:
 *     <backup>/Manifest.db   SQLite,表 Files(fileID, domain, relativePath, flags, file)
 *     <backup>/Manifest.plist 备份元信息(设备名、iOS 版本等)
 *     <backup>/xx/<40位sha1文件名>  文件内容,xx 为 fileID 前两位
 * - 旧版备份(iOS 10 以前):
 *     <backup>/Manifest.mbdb 二进制索引,文件直接以 sha1 文件名存放在根目录
 *
 * fileID = sha1(domain + "-" + relativePath) 的十六进制小写。
 * 微信相关域:
 *   AppDomain-com.tencent.xin            主程序沙盒
 *   AppDomainGroup-group.com.tencent.xin App Group 共享目录
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const plist = require('plist');
const bplistParser = require('bplist-parser');

const WECHAT_DOMAINS = ['AppDomain-com.tencent.xin', 'AppDomainGroup-group.com.tencent.xin'];

class BackupError extends Error {}

/** 字节数转可读文本 */
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

/** 计算 fileID */
function sha1FileId(domain, relativePath) {
  return crypto.createHash('sha1').update(`${domain}-${relativePath}`, 'utf8').digest('hex');
}

/** 二进制 plist 或 XML plist 通用解析(Manifest.plist 在新系统上是二进制格式) */
function parsePlist(buffer) {
  try {
    if (Buffer.isBuffer(buffer) && buffer.subarray(0, 6).toString('ascii') === 'bplist') {
      const parsed = bplistParser.parseBuffer(buffer);
      return Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
    }
    return plist.parse(buffer.toString('utf8'));
  } catch (err) {
    throw new BackupError(`解析 plist 失败: ${err.message}`);
  }
}

/**
 * Manifest.mbdb 二进制格式读取(旧版备份)。
 * 格式: 6 字节 magic "mbdb\05\00",随后每条记录:
 *   domain, path, linkTarget, dataHash, unknown, mode(u16), unknown(u32)*2,
 *   uid(u32), gid(u32), mtime(u32), atime(u32), ctime(u32), len(u64),
 *   flag(u8), propCount(u8), props...
 * 字符串 = uint16 大端长度 + utf8 内容。
 */
class MbdbReader {
  constructor(buf) {
    this.buf = buf;
    this.offset = 0;
  }

  readString() {
    if (this.offset + 2 > this.buf.length) return null;
    const len = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    if (len === 0xffff || len === 0) return '';
    if (this.offset + len > this.buf.length) return null;
    const str = this.buf.subarray(this.offset, this.offset + len).toString('utf8');
    this.offset += len;
    return str;
  }

  /** 读取定长字段的原始字节 */
  readBytes(count) {
    if (this.offset + count > this.buf.length) return null;
    const slice = this.buf.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }
}

/** 解析 Manifest.mbdb,返回 relativePath → { domain, fileId, flags } 索引 */
function parseMbdb(buffer) {
  const magic = buffer.subarray(0, 6).toString('latin1');
  if (magic !== 'mbdb\x05\x00' && magic !== 'mbdb\x05\x02') {
    throw new BackupError('Manifest.mbdb 格式不正确');
  }
  const reader = new MbdbReader(buffer);
  reader.readBytes(6); // 跳过 magic
  const index = new Map();
  while (reader.offset < buffer.length - 1) {
    const domain = reader.readString();
    if (domain === null) break;
    const relPath = reader.readString();
    if (relPath === null) break;
    // linkTarget, dataHash, unknown 三个字符串跳过
    for (let i = 0; i < 3; i++) {
      if (reader.readString() === null) return index;
    }
    // mode u16, unknown u32 * 2, uid u32, gid u32,
    // mtime u32, atime u32, ctime u32, fileLen u64, flag u8
    const fixed = reader.readBytes(2 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 8 + 1);
    if (!fixed) break;
    const propCount = reader.readBytes(1);
    if (!propCount) break;
    for (let i = 0; i < propCount[0]; i++) {
      if (reader.readString() === null) return index; // name
      if (reader.readString() === null) return index; // value
    }
    if (relPath === '' || domain === '') continue;
    const fileId = sha1FileId(domain, relPath);
    if (!index.has(relPath)) {
      index.set(relPath, { domain, fileId, flags: 1 });
    }
  }
  return index;
}

/**
 * iOS 备份目录封装。惰性加载微信文件索引。
 */
class ITunesBackup {
  /**
   * @param {string} backupDir 备份目录绝对路径(包含 Manifest.db 的目录)
   * @param {Object} [options]
   * @param {Function} [options.Database] 可注入的 better-sqlite3 构造器(区分 Electron/Node ABI)
   */
  constructor(backupDir, options = {}) {
    this.rootDir = backupDir;
    this.manifestPath = path.join(backupDir, 'Manifest.db');
    this.mbdbPath = path.join(backupDir, 'Manifest.mbdb');
    this.plistPath = path.join(backupDir, 'Manifest.plist');
    this.infoPlistPath = path.join(backupDir, 'Info.plist');
    this._index = null; // relativePath → { domain, fileId, flags }
    this._manifestDb = null;
    this._info = null;
    // 允许调用方注入 better-sqlite3:客户端使用 Electron ABI,服务端使用 Node ABI。
    this._Database = options.Database || null;
    // 网络盘/外接盘上的 WAL 数据库无法直接只读打开时,复制到本地临时目录再读
    this._onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    this._providedTempDir = options.tempDir || null;
    this._tempDir = null;
    this._localDbPaths = new Map(); // virtualPath → 本地临时文件路径
  }

  _notify(message) {
    if (this._onProgress) {
      try { this._onProgress(message); } catch (err) { /* ignore */ }
    }
  }

  _ensureTempDir() {
    if (!this._tempDir) {
      this._tempDir = this._providedTempDir || fs.mkdtempSync(path.join(os.tmpdir(), 'wepo-db-'));
      // 调用方(客户端导入 worker)可以预建临时目录,便于取消导入时由主进程清理
      fs.mkdirSync(this._tempDir, { recursive: true });
    }
    return this._tempDir;
  }

  /**
   * 只读打开 SQLite,并立即读一次 schema。
   * 某些网络文件系统上 WAL 数据库会延迟到 prepare 时才报
   * SQLITE_CANTOPEN("unable to open database file"),因此必须提前探测。
   */
  _openReadonly(filePath) {
    const Database = this._Database || require('better-sqlite3');
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      db.pragma('mmap_size = 268435456');
      db.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
      return db;
    } catch (err) {
      try { db.close(); } catch (closeErr) { /* ignore */ }
      throw err;
    }
  }

  /** 带进度的同步文件复制(用于把网络盘上的数据库缓存到本地) */
  _copyFileWithProgress(src, dest, label) {
    const total = fs.statSync(src).size;
    const showProgress = total >= 32 * 1024 * 1024;
    if (showProgress) {
      this._notify(`正在复制 ${label} 到本地临时目录(${formatBytes(total)})...`);
    }
    const chunkSize = 4 * 1024 * 1024;
    const buffer = Buffer.allocUnsafe(chunkSize);
    const srcFd = fs.openSync(src, 'r');
    let destFd = null;
    let copied = 0;
    let lastReport = Date.now();
    try {
      destFd = fs.openSync(dest, 'w', 0o600);
      while (copied < total) {
        const n = fs.readSync(srcFd, buffer, 0, Math.min(chunkSize, total - copied), copied);
        if (n <= 0) break;
        fs.writeSync(destFd, buffer, 0, n);
        copied += n;
        if (showProgress && Date.now() - lastReport >= 1000) {
          lastReport = Date.now();
          this._notify(`正在复制 ${label} ${Math.round((copied / total) * 100)}%`);
        }
      }
    } finally {
      try { fs.closeSync(srcFd); } catch (err) { /* ignore */ }
      if (destFd !== null) {
        try { fs.closeSync(destFd); } catch (err) { /* ignore */ }
      }
    }
    if (copied !== total) {
      try { fs.rmSync(dest, { force: true }); } catch (err) { /* ignore */ }
      throw new Error(`复制 ${label} 不完整(${copied}/${total} 字节)`);
    }
    if (showProgress) {
      this._notify(`已复制 ${label} (${formatBytes(total)})`);
    }
  }

  /**
   * 把数据库文件(及可用的 -wal/-shm/-journal)复制到本地临时目录。
   * SQLite 的 WAL 辅助文件按主文件名推导,因此必须放在同一目录且同名。
   */
  _copyToTemp(realPath, virtualPath, companions = []) {
    const key = virtualPath || realPath;
    if (this._localDbPaths.has(key)) return this._localDbPaths.get(key);

    const base = path.basename(virtualPath || realPath).replace(/[^A-Za-z0-9._-]/g, '_') || 'database.db';
    const name = `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}-${base}`;
    const dest = path.join(this._ensureTempDir(), name);
    const copiedCompanions = [];

    try {
      this._copyFileWithProgress(realPath, dest, base);
      for (const companion of companions) {
        if (!companion || !companion.path || !fs.existsSync(companion.path)) continue;
        const target = dest + companion.suffix;
        this._copyFileWithProgress(companion.path, target, base + companion.suffix);
        copiedCompanions.push(target);
      }
    } catch (err) {
      try { fs.rmSync(dest, { force: true }); } catch (cleanupErr) { /* ignore */ }
      for (const target of copiedCompanions) {
        try { fs.rmSync(target, { force: true }); } catch (cleanupErr) { /* ignore */ }
      }
      throw err;
    }

    this._localDbPaths.set(key, dest);
    return dest;
  }

  /** 备份根目录下的 Manifest.db 辅助文件(SQLite 自动按主文件名推导) */
  _manifestCompanions() {
    return ['-wal', '-shm', '-journal']
      .map((suffix) => {
        const companionPath = this.manifestPath + suffix;
        return fs.existsSync(companionPath) ? { suffix, path: companionPath } : null;
      })
      .filter(Boolean);
  }

  /** 从 Manifest.db 读取微信域文件索引 */
  _readManifestIndex(db) {
    const index = new Map();
    const placeholders = WECHAT_DOMAINS.map(() => '?').join(',');
    const stmt = db.prepare(
      `SELECT fileID, domain, relativePath, flags FROM Files WHERE domain IN (${placeholders})`
    );
    for (const row of stmt.iterate(...WECHAT_DOMAINS)) {
      if (row.flags !== 1) continue; // 只关心文件,跳过目录/符号链接
      let fileId = row.fileID;
      if (Buffer.isBuffer(fileId)) fileId = fileId.toString('hex');
      else if (fileId && typeof fileId !== 'string') fileId = String(fileId);
      const relPath = typeof row.relativePath === 'string'
        ? row.relativePath
        : Buffer.from(row.relativePath).toString('utf8');
      if (!fileId || relPath === '') continue;
      if (!index.has(relPath)) {
        index.set(relPath, { domain: row.domain, fileId, flags: row.flags });
      }
    }
    return index;
  }

  /** 校验备份目录是否有效 */
  validate() {
    if (!fs.existsSync(this.rootDir)) {
      throw new BackupError(`备份目录不存在: ${this.rootDir}`);
    }
    if (!fs.existsSync(this.plistPath)) {
      throw new BackupError(`目录中缺少 Manifest.plist,不是有效的 iOS 备份目录: ${this.rootDir}`);
    }
    if (!fs.existsSync(this.manifestPath) && !fs.existsSync(this.mbdbPath)) {
      throw new BackupError(`目录中缺少 Manifest.db / Manifest.mbdb,不是有效的 iOS 备份目录: ${this.rootDir}`);
    }
    return true;
  }

  /** 读取备份元信息(Manifest.plist:设备名、iOS 版本、备份时间等) */
  getInfo() {
    if (this._info) return this._info;
    this.validate();
    const info = {};
    try {
      const parsed = parsePlist(fs.readFileSync(this.plistPath));
      info.deviceName = parsed['Device Name'] || '';
      info.productType = parsed['Product Type'] || '';
      info.iosVersion = parsed['Product Version'] || '';
      info.serialNumber = parsed.SerialNumber || parsed['Serial Number'] || '';
      info.buildVersion = parsed['Build Version'] || '';
      info.backupDate = parsed.Date ? new Date(parsed.Date) : null;
      info.itunesVersion = parsed['iTunes Version'] || '';
    } catch (err) {
      // 元信息读取失败不阻塞解析
      info.parseError = err.message;
    }
    // Info.plist 也存了部分信息,作为补充
    try {
      const parsed = parsePlist(fs.readFileSync(this.infoPlistPath));
      info.deviceName = info.deviceName || parsed['Device Name'] || '';
      info.iosVersion = info.iosVersion || parsed['Product Version'] || '';
    } catch (err) {
      /* ignore */
    }
    this._info = info;
    return info;
  }

  /**
   * 加载微信相关文件索引(惰性,一次加载)。
   * @returns {Map<string, {domain:string, fileId:string, flags:number}>}
   */
  getIndex() {
    if (this._index) return this._index;
    this.validate();
    let index;
    if (fs.existsSync(this.manifestPath)) {
      index = this._loadManifestDbIndex();
    } else {
      index = parseMbdb(fs.readFileSync(this.mbdbPath));
    }
    this._index = index;
    return index;
  }

  _loadManifestDbIndex() {
    const readIndex = (filePath) => {
      const db = this._openReadonly(filePath);
      try {
        return this._readManifestIndex(db);
      } finally {
        try { db.close(); } catch (err) { /* ignore */ }
      }
    };

    let directError = null;
    try {
      return readIndex(this.manifestPath);
    } catch (err) {
      directError = err;
    }

    // 备份可能位于 SMB/外接磁盘:WAL 数据库在只读打开时可能报
    // SQLITE_CANTOPEN("unable to open database file")。复制到本地临时目录再读。
    this._notify(`无法直接读取备份索引(${directError.message}),正在复制到本地临时目录后重试...`);
    let copiedPath;
    try {
      copiedPath = this._copyToTemp(this.manifestPath, 'Manifest.db', this._manifestCompanions());
      return readIndex(copiedPath);
    } catch (copyError) {
      throw new BackupError(
        `无法读取备份索引 Manifest.db。\n`
        + `路径: ${this.manifestPath}\n`
        + `直接读取失败: ${directError.message}\n`
        + `复制到本地临时目录后仍失败: ${copyError.message}\n`
        + '请确认备份目录未被移动、磁盘仍已连接且文件可读,并检查本地临时目录磁盘空间是否充足。'
      );
    }
  }

  /**
   * 虚拟路径(如 "Documents/1234abcd.../DB/MM.sqlite")→ 备份中的真实文件路径。
   * @returns {string} 真实绝对路径;未找到返回空字符串
   */
  resolvePath(relativePath) {
    const normalized = relativePath.replace(/\\/g, '/');
    const entry = this.getIndex().get(normalized);
    if (!entry) return '';
    return this.fileIdToRealPath(entry.fileId);
  }

  /** fileID → 备份中的真实路径(Manifest.db 格式有两位前缀子目录) */
  fileIdToRealPath(fileId) {
    if (fs.existsSync(this.manifestPath)) {
      return path.join(this.rootDir, fileId.slice(0, 2), fileId);
    }
    return path.join(this.rootDir, fileId);
  }

  /** 虚拟路径对应的文件是否存在 */
  fileExists(relativePath) {
    const real = this.resolvePath(relativePath);
    return real !== '' && fs.existsSync(real);
  }

  /** 读取虚拟路径文件内容 */
  readFile(relativePath) {
    const real = this.resolvePath(relativePath);
    if (!real || !fs.existsSync(real)) return null;
    return fs.readFileSync(real);
  }

  /** 异步读取虚拟路径文件(用于并发读取网络盘上的媒体,避免串行阻塞) */
  async readFileAsync(relativePath) {
    const real = this.resolvePath(relativePath);
    if (!real) return null;
    try {
      return await fs.promises.readFile(real);
    } catch (err) {
      return null;
    }
  }

  /** 只读打开虚拟路径对应的 SQLite 数据库;失败返回 null */
  openDb(relativePath) {
    const real = this.resolvePath(relativePath);
    if (!real || !fs.existsSync(real)) return null;

    try {
      return this._openReadonly(real);
    } catch (directError) {
      this._notify(`数据库 ${path.basename(relativePath)} 无法直接读取(${directError.message}),尝试复制到本地临时目录...`);
      try {
        const companions = ['-wal', '-shm', '-journal']
          .map((suffix) => {
            const companionPath = this.resolvePath(`${relativePath}${suffix}`);
            return companionPath && fs.existsSync(companionPath)
              ? { suffix, path: companionPath }
              : null;
          })
          .filter(Boolean);
        const localPath = this._copyToTemp(real, relativePath, companions);
        return this._openReadonly(localPath);
      } catch (copyError) {
        this._notify(`无法读取数据库 ${relativePath}: ${copyError.message}`);
        return null;
      }
    }
  }

  /** 遍历微信域下的所有文件(按 relativePath 排序),供解析器使用 */
  * iterateFiles() {
    const entries = [...this.getIndex().entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    for (const [relativePath, entry] of entries) {
      yield { relativePath, ...entry };
    }
  }

  close() {
    if (this._manifestDb) {
      try { this._manifestDb.close(); } catch (err) { /* ignore */ }
      this._manifestDb = null;
    }
    if (this._tempDir) {
      try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
      this._tempDir = null;
    }
    this._localDbPaths.clear();
  }
}

module.exports = { ITunesBackup, BackupError, sha1FileId, WECHAT_DOMAINS };
