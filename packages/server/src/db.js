/**
 * SQLite 数据库初始化与访问封装。
 * 数据目录默认 <server>/data,可用环境变量 WEPO_DATA_DIR 覆盖。
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.WEPO_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'wechat.db');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

fs.mkdirSync(MEDIA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// 本地归档工具:减少每次提交的 fsync/检查点频率,显著加快百万级导入
db.pragma('synchronous = NORMAL');
db.pragma('wal_autocheckpoint = 10000');
db.pragma('cache_size = -65536');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL DEFAULT '',
  product_type TEXT NOT NULL DEFAULT '',
  ios_version TEXT NOT NULL DEFAULT '',
  serial_number TEXT NOT NULL DEFAULT '',
  backup_date TEXT,
  source_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  completed_at TEXT,
  user_count INTEGER NOT NULL DEFAULT 0,
  contact_count INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  media_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  wx_name TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  username TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  wx_name TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  type INTEGER NOT NULL DEFAULT 0,
  is_chatroom INTEGER NOT NULL DEFAULT 0,
  members TEXT NOT NULL DEFAULT '[]',
  avatar TEXT NOT NULL DEFAULT '',
  create_time INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_time INTEGER NOT NULL DEFAULT 0,
  last_message TEXT NOT NULL DEFAULT '',
  last_message_type INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  owner TEXT NOT NULL DEFAULT '',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (backup_id, hash)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  contact_hash TEXT NOT NULL,
  mes_local_id INTEGER NOT NULL,
  mes_svr_id INTEGER,
  type INTEGER NOT NULL DEFAULT 0,
  is_sent INTEGER NOT NULL DEFAULT 0,
  sender TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  extra TEXT,
  create_time INTEGER NOT NULL DEFAULT 0,
  media_kind TEXT,
  media_path TEXT NOT NULL DEFAULT '',
  UNIQUE (backup_id, contact_hash, mes_local_id)
);

-- 表情 md5 -> 可下载 URL。部分新版消息只带 md5/productid,没有 cdnurl;
-- 同一条表情在别处出现过 cdnurl 时,用这张表补齐图片地址。
CREATE TABLE IF NOT EXISTS sticker_urls (
  md5 TEXT PRIMARY KEY,
  cdnurl TEXT NOT NULL
);

-- 微信联系人标签。标签定义与成员分开保存:成员存 username 而不是 contact_id,
-- 这样联系人跨备份合并/去重后仍能正确关联。
CREATE TABLE IF NOT EXISTS contact_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  owner TEXT NOT NULL DEFAULT '',
  remote_id INTEGER NOT NULL DEFAULT 0,
  tag_index INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  UNIQUE (backup_id, owner, remote_id)
);

CREATE TABLE IF NOT EXISTS contact_tag_members (
  tag_id INTEGER NOT NULL REFERENCES contact_tags(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  PRIMARY KEY (tag_id, username)
);

CREATE TABLE IF NOT EXISTS owner_stats (
  owner TEXT PRIMARY KEY,
  contacts INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  media INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_backup ON contacts (backup_id, last_message_time DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_search ON contacts (backup_id, nickname);
CREATE INDEX IF NOT EXISTS idx_messages_contact_time ON messages (contact_id, create_time DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_backup_hash ON messages (backup_id, contact_hash);
CREATE INDEX IF NOT EXISTS idx_contacts_owner_hash ON contacts (owner, hash);
CREATE INDEX IF NOT EXISTS idx_messages_contact_hash_local ON messages (contact_hash, mes_local_id);
CREATE INDEX IF NOT EXISTS idx_messages_contact_id ON messages (contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_contact_media ON messages (contact_id, media_path);
CREATE INDEX IF NOT EXISTS idx_messages_pending_media
  ON messages (backup_id, contact_hash, mes_local_id)
  WHERE media_kind IS NOT NULL AND media_path = '';
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
CREATE INDEX IF NOT EXISTS idx_contact_tags_owner ON contact_tags (owner, tag_index);
CREATE INDEX IF NOT EXISTS idx_contact_tag_members_username ON contact_tag_members (username);

-- 聊天记录搜索索引:把每条消息正文拆成相邻双字(bigram)写入 FTS5。
-- contentless + detail=none 只保存倒排索引,不重复保存正文;10M 条约 400MB。
-- 查询时用双字组合定位候选消息,再用 LIKE/JS 校验完整子串。
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  grams,
  tokenize = 'unicode61',
  content = '',
  detail = none,
  contentless_delete = 1
);

-- 搜索索引构建进度:last_rowid 为已处理的最大消息 id,ready=1 表示全量完成
CREATE TABLE IF NOT EXISTS search_index_state (
  name TEXT PRIMARY KEY,
  last_rowid INTEGER NOT NULL DEFAULT 0,
  ready INTEGER NOT NULL DEFAULT 0
);
`);

/** LIKE 转义,防止用户输入中的 % _ 影响匹配 */
function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

module.exports = { db, DATA_DIR, DB_PATH, MEDIA_DIR, escapeLike };
