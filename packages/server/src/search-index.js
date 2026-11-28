/**
 * 聊天记录搜索索引。
 *
 * SQLite 的普通索引无法加速 `content LIKE '%关键词%'`,而 1000 万条消息上
 * 全表扫描一次需要数秒。这里把正文规范化为连续字母/数字后切成相邻双字
 * (bigram),写入 contentless FTS5:
 *   - 两字查询直接命中一个 bigram;
 *   - 三字及以上查询用多个 bigram 的 AND 取候选,再用完整子串校验;
 *   - 索引只保存倒排表,不重复保存正文(currentless + detail=none)。
 *
 * 首次启动会按消息 id 分块构建,可中断续建;导入新消息时同步增量写入。
 */

const { db } = require('./db');

// v2:在双字索引之外加入单字 token,支持一个汉字的聊天记录搜索
const STATE_NAME = 'messages:v2';
const CHUNK_SIZE = 5000;
const RETRY_DELAY = 5000;

let building = false;
let insertFts = null;
let stateStmt = null;
let updateStateStmt = null;

function ensureStateStmt() {
  if (!stateStmt) {
    stateStmt = db.prepare('SELECT last_rowid, ready FROM search_index_state WHERE name = ?');
    updateStateStmt = db.prepare(`
      UPDATE search_index_state
      SET last_rowid = ?, ready = ?
      WHERE name = ?
    `);
  }
  let state = stateStmt.get(STATE_NAME);
  if (!state) {
    // 新版本索引(或首次运行):清空旧索引后从头构建
    db.transaction(() => {
      db.prepare('DELETE FROM messages_fts').run();
      db.prepare('DELETE FROM search_index_state WHERE name <> ?').run(STATE_NAME);
      db.prepare('INSERT INTO search_index_state (name) VALUES (?)').run(STATE_NAME);
    })();
    state = stateStmt.get(STATE_NAME);
  }
  return state;
}

function getSearchIndexState() {
  return ensureStateStmt();
}

/** 是否已完成全量索引;未完成时聊天记录搜索暂不返回结果 */
function isSearchIndexReady() {
  const state = ensureStateStmt();
  return Boolean(state && state.ready);
}

/** 统一搜索文本:转小写并移除空白/标点,使“明灯，指路”和“明灯指路”等价 */
function compactSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 正文 → 单字 + 相邻双字 token,供 FTS5 unicode61 分词。
 * 单字支持一个汉字的搜索;双字用于更精确的候选定位。
 */
function gramsForContent(content) {
  const chars = Array.from(compactSearchText(content));
  if (chars.length === 0) return '';
  const tokens = chars.slice();
  for (let i = 0; i < chars.length - 1; i += 1) {
    tokens.push(`${chars[i]}${chars[i + 1]}`);
  }
  return tokens.join(' ');
}

/**
 * 查询词 → FTS5 MATCH 表达式。单字查询用单字 token;
 * 两字及以上用相邻双字 AND 取候选,再由调用方校验完整子串。
 * 所有 token 只包含字母/数字,不需要额外转义。
 */
function ftsMatchForQuery(query) {
  const chars = Array.from(compactSearchText(query));
  if (chars.length === 0) return null;
  if (chars.length === 1) return `"${chars[0]}"`;
  const terms = [];
  for (let i = 0; i < chars.length - 1; i += 1) {
    terms.push(`"${chars[i]}${chars[i + 1]}"`);
  }
  return terms.join(' AND ');
}

function getFtsInsert() {
  if (!insertFts) {
    insertFts = db.prepare('INSERT OR REPLACE INTO messages_fts (rowid, grams) VALUES (?, ?)');
  }
  return insertFts;
}

/**
 * 增量写入一批已插入的消息(仅在索引已 ready 时调用)。
 * 与消息插入放在同一事务中,保证消息和索引同时提交。
 */
function indexMessages(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || !isSearchIndexReady()) return false;
  const indexed = [];
  let maxId = 0;
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (id > maxId) maxId = id;
    const grams = gramsForContent(row.content);
    if (grams) indexed.push({ id, grams });
  }
  const insert = getFtsInsert();
  const tx = db.transaction((list) => {
    for (const row of list) insert.run(row.id, row.grams);
    if (maxId > 0) {
      db.prepare(`
        UPDATE search_index_state
        SET last_rowid = MAX(last_rowid, ?)
        WHERE name = ?
      `).run(maxId, STATE_NAME);
    }
  });
  tx(indexed);
  return true;
}

/** 删除某次备份的消息前,先移除对应索引行 */
function removeBackupFromIndex(backupId) {
  if (!backupId) return;
  db.prepare(`
    DELETE FROM messages_fts
    WHERE rowid IN (SELECT id FROM messages WHERE backup_id = ?)
  `).run(backupId);
}

/** 后台分块构建/续建索引;每块提交后让出事件循环,避免阻塞查询接口 */
function startSearchIndexBuild() {
  if (building) return;
  let state;
  try {
    state = ensureStateStmt();
    const maxId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').get().id) || 0;
    const lastId = Number(state.last_rowid) || 0;
    if (state.ready && lastId >= maxId) return;
    // 已 ready 但存在新消息时先标记未完成,避免搜索返回缺数据的“完整”结果
    if (state.ready && lastId < maxId) {
      updateStateStmt.run(lastId, 0, STATE_NAME);
      state = ensureStateStmt();
    }
  } catch (err) {
    console.error(`[search-index] 初始化失败: ${err.message}`);
    return;
  }

  building = true;
  let lastId = Number(state.last_rowid) || 0;
  let processed = 0;
  const startedAt = Date.now();

  const step = () => {
    try {
      const rows = db.prepare(`
        SELECT id, content FROM messages
        WHERE id > ?
        ORDER BY id
        LIMIT ?
      `).all(lastId, CHUNK_SIZE);
      if (rows.length === 0) {
        updateStateStmt.run(lastId, 1, STATE_NAME);
        building = false;
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[search-index] 索引完成: ${processed} 条新增,耗时 ${seconds}s`);
        return;
      }

      const insert = getFtsInsert();
      const tx = db.transaction((list) => {
        for (const row of list) {
          const grams = gramsForContent(row.content);
          if (grams) insert.run(row.id, grams);
        }
        lastId = Number(list[list.length - 1].id);
        updateStateStmt.run(lastId, 0, STATE_NAME);
      });
      tx(rows);
      processed += rows.length;
      if (processed % 500000 < CHUNK_SIZE) {
        console.log(`[search-index] 已处理 ${processed} 条,last_id=${lastId}`);
      }
      setImmediate(step);
    } catch (err) {
      building = false;
      console.error(`[search-index] 构建失败: ${err.message}; ${RETRY_DELAY / 1000}s 后重试`);
      setTimeout(startSearchIndexBuild, RETRY_DELAY);
    }
  };

  setImmediate(step);
}

module.exports = {
  compactSearchText,
  gramsForContent,
  ftsMatchForQuery,
  indexMessages,
  removeBackupFromIndex,
  isSearchIndexReady,
  getSearchIndexState,
  startSearchIndexBuild,
};
