/**
 * 服务端导入任务管理。
 *
 * 微仓助手只负责选择 NAS 备份并调用开始接口;真正的解析、媒体读取和上传
 * 由服务端在 worker_threads 中执行。同一时间只允许一个服务端导入任务。
 * 任务状态会持久化到 data/import-job.json,服务器重启后显示为已中断,
 * 已写入的数据仍保留,可再次导入同一备份继续补传。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { DATA_DIR, db } = require('./db');
const { SECRET } = require('./auth');
const { resolveBackupSource, getBackupRoot } = require('./backup-sources');

const STATE_FILE = path.join(DATA_DIR, 'import-job.json');
const IMPORT_TEMP_ROOT = String(process.env.WEPO_IMPORT_TEMP_DIR || '').trim();
const MAX_LOGS = 40;
const ACTIVE_STATUSES = new Set(['starting', 'running']);

// 导入进度按阶段加权,避免“上传聊天记录 100%”后在完整性校验、媒体补传、
// 头像补齐或统计阶段仍显示 100% 却迟迟没有完成。
const STAGE_RANGES = {
  starting: [0, 0],
  parse: [0, 25],
  meta: [25, 28],
  resume: [28, 30],
  'user-avatars': [30, 34],
  contacts: [34, 44],
  tags: [44, 46],
  'contact-avatars': [46, 56],
  messages: [56, 84],
  verify: [84, 86],
  repair: [86, 92],
  avatars: [92, 97],
  complete: [97, 99],
};

let worker = null;
let activeTempDir = null;
let saveTimer = null;
let state = loadState();

/** 为一次导入创建独立临时目录(优先放在配置的数据盘,避免容器 /tmp 被大数据库撑满) */
function createJobTempDir() {
  cleanupJobTempDir();
  if (!IMPORT_TEMP_ROOT) return null;
  try {
    fs.mkdirSync(IMPORT_TEMP_ROOT, { recursive: true });
    activeTempDir = fs.mkdtempSync(path.join(IMPORT_TEMP_ROOT, 'job-'));
  } catch (err) {
    console.warn(`[import] 创建导入临时目录失败: ${err.message}`);
    activeTempDir = null;
  }
  return activeTempDir;
}

function cleanupJobTempDir() {
  if (!activeTempDir) return;
  try {
    fs.rmSync(activeTempDir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[import] 清理导入临时目录失败: ${err.message}`);
  }
  activeTempDir = null;
}

/** 服务重启后清理上次异常退出遗留的 job-* 临时目录 */
function cleanupStaleJobTempDirs() {
  if (!IMPORT_TEMP_ROOT) return;
  try {
    if (!fs.existsSync(IMPORT_TEMP_ROOT)) return;
    for (const entry of fs.readdirSync(IMPORT_TEMP_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('job-')) continue;
      fs.rmSync(path.join(IMPORT_TEMP_ROOT, entry.name), { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`[import] 清理遗留临时目录失败: ${err.message}`);
  }
}

cleanupStaleJobTempDirs();

function emptyState() {
  return {
    id: '',
    status: 'idle',
    backupId: '',
    sourceKey: '',
    sourcePath: '',
    deviceName: '',
    iosVersion: '',
    includeMedia: true,
    stage: '',
    text: '',
    done: 0,
    total: 0,
    stagePercent: null,
    summary: null,
    stats: null,
    error: '',
    logs: [],
    startedAt: null,
    updatedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const loaded = {
      ...emptyState(),
      ...parsed,
      logs: Array.isArray(parsed.logs) ? parsed.logs.slice(-MAX_LOGS) : [],
    };
    if (ACTIVE_STATUSES.has(loaded.status)) {
      loaded.status = 'interrupted';
      loaded.error = '服务端在导入过程中重启,任务已中断;已写入的数据会保留,可重新导入同一备份继续。';
      loaded.text = loaded.error;
      loaded.finishedAt = new Date().toISOString();
      loaded.updatedAt = loaded.finishedAt;
      saveStateNow(loaded);
    }
    return loaded;
  } catch (err) {
    return emptyState();
  }
}

function saveStateNow(target = state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, STATE_FILE);
  } catch (err) {
    console.warn(`[import] 保存任务状态失败: ${err.message}`);
  }
}

/** 进度事件可能很密集,合并写盘 */
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStateNow();
  }, 500);
  if (saveTimer.unref) saveTimer.unref();
}

function touch(extra = {}) {
  state.updatedAt = new Date().toISOString();
  Object.assign(state, extra);
  scheduleSave();
}

function appendLog(text) {
  const message = String(text || '').trim();
  if (!message) return;
  state.logs.push(message.slice(0, 1000));
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
}

function isActiveJob(jobId) {
  return Boolean(jobId && state.id === jobId && ACTIVE_STATUSES.has(state.status));
}

function internalServerUrl() {
  const configured = String(
    process.env.WEPO_INTERNAL_URL || ''
  ).trim().replace(/\/+$/, '');
  if (configured) return configured;
  const port = Number(process.env.WEPO_PORT) || 3800;
  const host = String(process.env.WEPO_HOST || '').trim();
  let target = '127.0.0.1';
  if (host && host !== '0.0.0.0' && host !== '::' && host !== '[::]') {
    target = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  }
  return `http://${target}:${port}`;
}

function findResumeBackupId(meta) {
  const rows = db.prepare(`
    SELECT id, serial_number, backup_date, source_path
    FROM backups
    WHERE completed_at IS NULL
    ORDER BY created_at DESC, rowid DESC
  `).all();
  const metaTime = meta.backupDate ? new Date(meta.backupDate).getTime() : NaN;
  const identity = rows.find((row) => {
    const rowTime = row.backup_date ? new Date(row.backup_date).getTime() : NaN;
    return meta.serialNumber
      && row.serial_number
      && meta.serialNumber === row.serial_number
      && Number.isFinite(metaTime)
      && Number.isFinite(rowTime)
      && metaTime === rowTime;
  });
  const pathMatch = rows.find((row) => row.source_path === meta.path);
  return (identity || pathMatch || {}).id || crypto.randomUUID();
}

function workerPath() {
  return path.join(__dirname, '..', '..', 'importer', 'worker.js');
}

function markFailed(jobId, message) {
  if (state.id !== jobId || !ACTIVE_STATUSES.has(state.status)) return;
  state.status = 'failed';
  state.error = String(message || '导入失败');
  state.text = `导入失败: ${state.error}`;
  state.finishedAt = new Date().toISOString();
  touch();
  saveStateNow();
}

function markCompleted(jobId, payload) {
  if (state.id !== jobId || !ACTIVE_STATUSES.has(state.status)) return;
  state.status = 'completed';
  state.stats = payload.stats || null;
  state.done = state.total || state.done;
  state.text = '导入完成';
  state.error = '';
  state.finishedAt = new Date().toISOString();
  touch();
  saveStateNow();
  try {
    worker = null;
  } catch (err) {
    /* ignore */
  }
}

/**
 * 启动服务端导入。如果存在同设备、同备份时间(或同来源路径)的未完成任务,
 * 复用原 backupId 续传;否则创建新的导入记录。
 */
function startImport({ key, includeMedia = true } = {}) {
  if (ACTIVE_STATUSES.has(state.status)) {
    throw Object.assign(new Error('已有服务端导入任务正在进行'), { status: 409 });
  }
  const meta = resolveBackupSource(key);
  if (meta.parseError) {
    throw Object.assign(new Error(`无法读取备份信息: ${meta.parseError}`), { status: 422 });
  }
  if (worker) {
    try { worker.terminate(); } catch (err) { /* ignore */ }
    worker = null;
  }

  const backupId = findResumeBackupId(meta);
  const jobId = crypto.randomUUID();
  state = {
    ...emptyState(),
    id: jobId,
    status: 'starting',
    backupId,
    sourceKey: meta.key,
    sourcePath: meta.path,
    deviceName: meta.deviceName || meta.folderName,
    iosVersion: meta.iosVersion || '',
    includeMedia: includeMedia !== false,
    stage: 'starting',
    text: '正在启动服务端导入...',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveStateNow();

  const dbTempDir = createJobTempDir();
  let nextWorker;
  try {
    nextWorker = new Worker(workerPath(), {
      workerData: {
        backupDir: meta.path,
        backupZip: null,
        serverUrl: internalServerUrl(),
        secret: SECRET,
        includeMedia: state.includeMedia,
        backupId,
        dbTempDir,
        databaseModule: require.resolve('better-sqlite3'),
      },
    });
  } catch (err) {
    cleanupJobTempDir();
    markFailed(jobId, `无法启动导入进程: ${err.message}`);
    throw Object.assign(new Error(state.error), { status: 500 });
  }
  worker = nextWorker;
  state.status = 'running';
  touch({ status: 'running' });

  nextWorker.on('message', (payload) => {
    if (!payload || state.id !== jobId) return;
    switch (payload.event) {
      case 'started':
        touch({ backupId: payload.backupId || state.backupId });
        break;
      case 'stage':
        touch({
          stage: String(payload.stage || state.stage || ''),
          text: String(payload.text || ''),
          done: 0,
          total: 0,
          stagePercent: null,
        });
        break;
      case 'summary':
        touch({
          deviceName: payload.deviceName || state.deviceName,
          iosVersion: payload.iosVersion || state.iosVersion,
          summary: {
            userCount: Number(payload.userCount) || 0,
            contactCount: Number(payload.contactCount) || 0,
            messageCount: Number(payload.messageCount) || 0,
          },
        });
        break;
      case 'progress': {
        const reportedPercent = payload.stagePercent === null || payload.stagePercent === undefined
          ? null
          : Number(payload.stagePercent);
        touch({
          stage: String(payload.stage || state.stage || ''),
          text: String(payload.text || ''),
          done: Number(payload.done) || 0,
          total: Number(payload.total) || 0,
          stagePercent: Number.isFinite(reportedPercent)
            ? Math.max(0, Math.min(100, reportedPercent))
            : null,
        });
        break;
      }
      case 'log':
        appendLog(payload.text);
        scheduleSave();
        break;
      case 'done':
        markCompleted(jobId, payload);
        break;
      case 'error':
        appendLog(`错误: ${payload.message || '未知错误'}`);
        markFailed(jobId, payload.message || '导入失败');
        break;
      default:
        break;
    }
  });
  nextWorker.on('error', (err) => {
    markFailed(jobId, err.message || String(err));
  });
  nextWorker.on('exit', (code) => {
    cleanupJobTempDir();
    if (state.id === jobId && ACTIVE_STATUSES.has(state.status)) {
      markFailed(jobId, `导入进程已退出(code ${code}),任务未完成`);
    }
  });

  return snapshot();
}

/** 停止当前服务端导入,已写入数据保留 */
function cancelImport() {
  if (!ACTIVE_STATUSES.has(state.status)) {
    throw Object.assign(new Error('当前没有正在执行的服务端导入'), { status: 409 });
  }
  if (worker) {
    try { worker.terminate(); } catch (err) { /* ignore */ }
    worker = null;
  }
  state.status = 'cancelled';
  state.error = '已停止导入,已写入的数据会保留';
  state.text = state.error;
  state.finishedAt = new Date().toISOString();
  touch();
  saveStateNow();
  return snapshot();
}

/** 把当前阶段进度映射为整体进度;运行中最多 99,完成时才回到 100。 */
function overallProgressPercent() {
  const total = Number(state.total) || 0;
  const done = Number(state.done) || 0;
  const reportedRaw = state.stagePercent;
  const reported = reportedRaw === null || reportedRaw === undefined
    ? NaN
    : Number(reportedRaw);
  const within = Number.isFinite(reported)
    ? reported
    : (total > 0 ? (done / total) * 100 : 0);
  const clamped = Math.max(0, Math.min(100, within));
  const range = STAGE_RANGES[state.stage];
  if (!range) {
    return total > 0 ? Math.min(99, Math.round(clamped)) : null;
  }
  const percent = range[0] + (range[1] - range[0]) * (clamped / 100);
  return Math.max(0, Math.min(99, Math.round(percent)));
}

function snapshot() {
  const active = ACTIVE_STATUSES.has(state.status);
  const percent = state.status === 'completed'
    ? 100
    : overallProgressPercent();
  return {
    ...state,
    logs: state.logs.slice(-MAX_LOGS),
    active,
    percent,
    configuredRoot: getBackupRoot(),
  };
}

function getCurrentJob() {
  return snapshot();
}

process.once('exit', cleanupJobTempDir);

module.exports = {
  startImport,
  cancelImport,
  getCurrentJob,
};
