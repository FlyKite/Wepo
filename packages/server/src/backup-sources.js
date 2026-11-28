/**
 * NAS / 服务器备份目录扫描。
 *
 * 根目录由 WEPO_BACKUP_DIR 指定,默认 /backups。
 * 支持两种布局:
 *   /backups/00008130-.../Manifest.plist        (推荐:每个备份一个子目录)
 *   /backups/Manifest.plist                     (根目录本身就是一份备份)
 *
 * 只读取 Manifest.plist/Info.plist 元信息和数据库导入记录,不解析聊天库,
 * 因此列表接口在 NAS 上也很轻量。
 */

const fs = require('fs');
const path = require('path');
const { ITunesBackup } = require('@wepo/core');
const { db } = require('./db');

const BACKUP_ROOT = path.resolve(
  process.env.WEPO_BACKUP_DIR || '/backups'
);

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function realPathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch (err) {
    return null;
  }
}

function isInsideRoot(target) {
  const rootReal = realPathOrNull(BACKUP_ROOT);
  const targetReal = realPathOrNull(target);
  if (!rootReal || !targetReal) return false;
  return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep);
}

function isBackupDir(dir) {
  return fs.existsSync(path.join(dir, 'Manifest.plist'))
    && (fs.existsSync(path.join(dir, 'Manifest.db')) || fs.existsSync(path.join(dir, 'Manifest.mbdb')));
}

/** 读取单个备份目录的元信息(不加载微信文件索引) */
function readBackupMeta(dir, key) {
  if (!isInsideRoot(dir) || !isBackupDir(dir)) return null;
  const backup = new ITunesBackup(dir);
  try {
    const info = backup.getInfo();
    return {
      key,
      folderName: key === '.' ? path.basename(dir) : key,
      path: dir,
      deviceName: info.deviceName || '',
      productType: info.productType || '',
      iosVersion: info.iosVersion || '',
      serialNumber: info.serialNumber || '',
      backupDate: isoDate(info.backupDate),
      parseError: info.parseError || '',
    };
  } catch (err) {
    return {
      key,
      folderName: key === '.' ? path.basename(dir) : key,
      path: dir,
      deviceName: '',
      productType: '',
      iosVersion: '',
      serialNumber: '',
      backupDate: null,
      parseError: err.message || String(err),
    };
  } finally {
    backup.close();
  }
}

/** 找出与服务器备份对应的最近一次导入记录 */
function importStateFor(meta, rows) {
  const metaTime = meta.backupDate ? new Date(meta.backupDate).getTime() : NaN;
  const identityMatch = rows.find((row) => {
    const rowTime = row.backup_date ? new Date(row.backup_date).getTime() : NaN;
    return meta.serialNumber
      && row.serial_number
      && meta.serialNumber === row.serial_number
      && Number.isFinite(metaTime)
      && Number.isFinite(rowTime)
      && metaTime === rowTime;
  });
  const pathMatch = rows.find((row) => row.source_path === meta.path);
  const row = identityMatch || pathMatch;
  if (!row) return null;
  return {
    backupId: row.id,
    sourcePath: row.source_path,
    completedAt: row.completed_at || null,
    incomplete: !row.completed_at,
    createdAt: row.created_at,
    contactCount: Number(row.contact_count) || 0,
    messageCount: Number(row.message_count) || 0,
    mediaCount: Number(row.media_count) || 0,
  };
}

function importRows() {
  return db.prepare(`
    SELECT id, serial_number, backup_date, source_path, created_at, completed_at,
           contact_count, message_count, media_count
    FROM backups
    ORDER BY created_at DESC, rowid DESC
  `).all();
}

function sortBackups(a, b) {
  const at = a.backupDate ? new Date(a.backupDate).getTime() : 0;
  const bt = b.backupDate ? new Date(b.backupDate).getTime() : 0;
  return bt - at || a.folderName.localeCompare(b.folderName, 'zh-CN');
}

function enrichWithImportState(meta, rows) {
  return {
    ...meta,
    import: importStateFor(meta, rows),
  };
}

/**
 * 扫描配置的备份根目录。
 * @returns {{root:string, exists:boolean, items:Array, error:string}}
 */
function listBackupSources() {
  if (!fs.existsSync(BACKUP_ROOT)) {
    return {
      root: BACKUP_ROOT,
      exists: false,
      items: [],
      error: `服务器备份目录不存在: ${BACKUP_ROOT}`,
    };
  }

  const rows = importRows();
  const items = [];

  if (isBackupDir(BACKUP_ROOT)) {
    const meta = readBackupMeta(BACKUP_ROOT, '.');
    if (meta) items.push(meta);
  } else {
    let entries;
    try {
      entries = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true });
    } catch (err) {
      return {
        root: BACKUP_ROOT,
        exists: true,
        items: [],
        error: `无法读取服务器备份目录: ${err.message}`,
      };
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = path.join(BACKUP_ROOT, entry.name);
      const meta = readBackupMeta(dir, entry.name);
      if (meta) items.push(meta);
    }
  }

  items.sort(sortBackups);
  return {
    root: BACKUP_ROOT,
    exists: true,
    items: items.map((meta) => enrichWithImportState(meta, rows)),
    error: '',
  };
}

/**
 * 根据列表中的 key 定位备份目录。key 只允许根目录下的单个目录名,
 * 或 "." 表示根目录本身,避免客户端传入任意服务器路径。
 */
function resolveBackupSource(key) {
  const value = String(key || '');
  if (!value || value.includes('/') || value.includes('\\') || value === '..') {
    throw Object.assign(new Error('备份标识无效'), { status: 400 });
  }
  const dir = value === '.' ? BACKUP_ROOT : path.join(BACKUP_ROOT, value);
  const meta = readBackupMeta(dir, value);
  if (!meta) {
    throw Object.assign(new Error('备份不存在或不是有效的 iOS 备份目录'), { status: 404 });
  }
  return enrichWithImportState(meta, importRows());
}

/**
 * 判断某个来源路径是否位于服务器备份根目录内。
 * 使用路径前缀而不是 realpath:备份被移走后,未完成导入仍应归为服务端来源。
 */
function isServerBackupPath(sourcePath) {
  if (!sourcePath) return false;
  const root = path.resolve(BACKUP_ROOT);
  const target = path.resolve(String(sourcePath));
  return target === root || target.startsWith(root + path.sep);
}

/** 供启动日志显示 */
function getBackupRoot() {
  return BACKUP_ROOT;
}

module.exports = {
  BACKUP_ROOT,
  listBackupSources,
  resolveBackupSource,
  isServerBackupPath,
  getBackupRoot,
};
