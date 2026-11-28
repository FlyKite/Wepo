/**
 * iOS 备份 zip 压缩包提取。
 * 只解压解析微信数据所需的内容,而不是整个压缩包:
 *   1. 定位压缩包中的备份根目录(Manifest.db / Manifest.mbdb 所在目录)
 *   2. 解出索引与元信息文件(Manifest.db、Manifest.plist 等)
 *   3. 读取 Manifest.db 的 Files 表,得到微信域下所有文件的 fileID(sha1)
 *   4. 仅解出这些文件,恢复成标准备份目录布局:
 *        Manifest.db 格式: <backup>/<fileID前2位>/<fileID>
 *        Manifest.mbdb 格式: <backup>/<fileID>
 * 解出的临时目录可直接交给 WechatBackupParser 使用。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yauzl = require('yauzl');
const { ITunesBackup, BackupError } = require('./backup');

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: false, autoClose: false }, (err, zipfile) => {
      if (err) reject(new BackupError(`无法打开压缩包: ${err.message}`));
      else resolve(zipfile);
    });
  });
}

/** 读取压缩包全部条目(lazyEntries=false 时逐条触发 entry 事件) */
function listEntries(zipfile) {
  return new Promise((resolve, reject) => {
    const entries = [];
    zipfile.on('entry', (entry) => entries.push(entry));
    zipfile.on('end', () => resolve(entries));
    zipfile.on('error', (err) => reject(new BackupError(`读取压缩包失败: ${err.message}`)));
  });
}

/** 解压单个条目到目标路径(自动创建父目录) */
function extractEntry(zipfile, entry, destPath) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) return reject(new BackupError(`解压失败 ${entry.fileName}: ${err.message}`));
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const out = fs.createWriteStream(destPath);
      stream.on('error', (e) => {
        out.destroy();
        reject(new BackupError(`解压失败 ${entry.fileName}: ${e.message}`));
      });
      out.on('error', (e) => reject(new BackupError(`写入失败 ${destPath}: ${e.message}`)));
      out.on('finish', () => resolve());
      stream.pipe(out);
    });
  });
}

/** 规范化 zip 条目路径:反斜杠转正斜杠,去掉末尾目录斜杠 */
function normalizeEntryName(fileName) {
  return fileName.replace(/\\/g, '/').replace(/\/+$/, '');
}

class ZipBackupExtractor {
  /**
   * @param {string} zipPath iOS 备份压缩包路径
   */
  constructor(zipPath) {
    this.zipPath = zipPath;
    this.tempDir = null;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  /** 删除解压出的临时目录 */
  cleanup() {
    if (this.tempDir) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
      this.tempDir = null;
    }
  }

  /**
   * 提取备份,返回可直接交给 WechatBackupParser 的备份目录(临时目录)。
   * @param {Object} options
   * @param {Function} [options.onProgress] 进度回调 ({ doneFiles, totalFiles, doneBytes, totalBytes, fileName })
   */
  async extract(options = {}) {
    const { onProgress } = options;
    const zipfile = await openZip(this.zipPath);
    let entries;
    try {
      entries = await listEntries(zipfile);
    } catch (err) {
      zipfile.close();
      throw err;
    }

    // 文件条目(排除目录)
    const files = entries.filter((e) => !normalizeEntryName(e.fileName).endsWith('/'));
    const byBaseName = (name) =>
      files.find((e) => normalizeEntryName(e.fileName).split('/').pop() === name);

    // 1. 定位备份根目录
    const manifestDbEntry = byBaseName('Manifest.db');
    const mbdbEntry = byBaseName('Manifest.mbdb');
    const manifestEntry = manifestDbEntry || mbdbEntry;
    if (!manifestEntry) {
      zipfile.close();
      throw new BackupError('压缩包中未找到 iOS 备份(缺少 Manifest.db / Manifest.mbdb)');
    }
    const manifestPath = normalizeEntryName(manifestEntry.fileName);
    const rootDir = manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/')) : '';
    const prefix = rootDir ? `${rootDir}/` : '';
    const isMbdb = !manifestDbEntry;

    // 2. 解出索引与元信息(只取备份根目录下的,避免 __MACOSX 等干扰)
    const metaNames = ['Manifest.db', 'Manifest.mbdb', 'Manifest.plist', 'Info.plist', 'Status.plist'];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wepo-backup-'));
    this.tempDir = tempDir;
    const metaEntries = files.filter((e) => {
      const rel = normalizeEntryName(e.fileName);
      if (prefix && !rel.startsWith(prefix)) return false;
      const name = rel.slice(prefix.length);
      return metaNames.includes(name) && !name.includes('/');
    });
    for (const entry of metaEntries) {
      const name = normalizeEntryName(entry.fileName).split('/').pop();
      await extractEntry(zipfile, entry, path.join(tempDir, name));
      if (this.cancelled) break;
    }

    // 3. 通过备份索引确定需要解压的微信文件清单
    const backup = new ITunesBackup(tempDir);
    let wanted;
    try {
      backup.validate();
      wanted = new Set([...backup.getIndex().values()].map((v) => v.fileId));
    } finally {
      backup.close();
    }

    // 4. 仅解压清单中的文件,恢复标准布局。
    //    Manifest.db 格式的 zip 条目为 "<前2位>/<完整40位fileID>",fileID 即去掉前缀后的剩余部分
    const targets = files.filter((e) => {
      const rel = normalizeEntryName(e.fileName);
      if (prefix && !rel.startsWith(prefix)) return false;
      const relPath = rel.slice(prefix.length);
      if (/^[0-9a-f]{2}\/[0-9a-f]{40}$/.test(relPath)) {
        return wanted.has(relPath.slice(3));
      }
      if (/^[0-9a-f]{40}$/.test(relPath)) {
        return wanted.has(relPath);
      }
      return false;
    });

    const totalBytes = targets.reduce((s, e) => s + (e.uncompressedSize || 0), 0);
    let doneFiles = 0;
    let doneBytes = 0;
    for (const entry of targets) {
      if (this.cancelled) break;
      const rel = normalizeEntryName(entry.fileName).slice(prefix.length);
      const fileId = rel.length === 40 ? rel : rel.slice(3);
      // Manifest.db 格式的解析器按 <前2位>/<fileID> 定位文件;mbdb 格式放在根目录
      const dest = isMbdb
        ? path.join(tempDir, fileId)
        : path.join(tempDir, fileId.slice(0, 2), fileId);
      await extractEntry(zipfile, entry, dest);
      doneFiles += 1;
      doneBytes += entry.uncompressedSize || 0;
      if (onProgress) {
        onProgress({
          doneFiles,
          totalFiles: targets.length,
          doneBytes,
          totalBytes,
          fileName: entry.fileName,
        });
      }
    }

    zipfile.close();
    if (this.cancelled) {
      this.cleanup();
      throw new BackupError('解压已取消');
    }
    return tempDir;
  }
}

module.exports = { ZipBackupExtractor };
