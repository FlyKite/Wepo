/**
 * 微信 wxgf 图片转 JPEG。
 *
 * iOS 新版微信把部分图片存成 wxgf 容器,内部是 HEVC 图像;浏览器无法直接
 * 解码。转换流程:从 wxgf 中定位 HEVC Annex-B 起始码,交给 PyAV 解码后保存为 JPEG。
 *
 * 转换进程常驻并按顺序处理任务,避免每次图片请求都重新加载 PyAV。转换结果
 * 缓存在 data/wxgf-cache/<backup_id>/<media_path>;没有缓存空间时使用临时
 * 文件,由调用方在响应结束后删除。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DATA_DIR } = require('./db');

const CACHE_DIR = process.env.WEPO_WXGF_CACHE_DIR
  || path.join(DATA_DIR, 'wxgf-cache');
const CACHE_RESERVE_BYTES = 512 * 1024 * 1024;
const TASK_TIMEOUT_MS = 30000;
const VENV_PYTHON = path.join(__dirname, '..', '.wxgf-venv', 'bin', 'python');
const PYTHON = process.env.WEPO_WXGF_PYTHON
  || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');
const WORKER_SCRIPT = path.join(__dirname, '..', 'scripts', 'wxgf_worker.py');

let worker = null;
let workerStderr = '';
let stdoutBuffer = '';
let currentTask = null;
let nextTaskId = 0;
let unavailableReason = '';
const taskQueue = [];
const inflightByPath = new Map();

/** 是否为微信 wxgf 文件(只读取 4 字节文件头) */
function isWxgfFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(4);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    return read === 4 && header.toString('latin1') === 'wxgf';
  } catch (err) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** 缓存路径;确保不会跳出缓存目录 */
function cacheFileFor(backupId, mediaPath) {
  const root = path.resolve(CACHE_DIR);
  const file = path.resolve(root, backupId, mediaPath);
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new Error('wxgf 缓存路径非法');
  }
  return file;
}

function cachedFileIfFresh(sourceFile, backupId, mediaPath) {
  let target;
  try {
    target = cacheFileFor(backupId, mediaPath);
    const source = fs.statSync(sourceFile);
    const cached = fs.statSync(target);
    return cached.isFile() && cached.size > 0 && cached.mtimeMs >= source.mtimeMs
      ? target
      : null;
  } catch (err) {
    return null;
  }
}

function hasCacheSpace() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const stats = fs.statfsSync(DATA_DIR);
    return stats.bavail * stats.bsize > CACHE_RESERVE_BYTES;
  } catch (err) {
    return true;
  }
}

function tempFileFor(mediaPath) {
  const base = path.basename(mediaPath || 'image.jpg').replace(/[^\w.-]/g, '_');
  return path.join(os.tmpdir(), `wepo-wxgf-${process.pid}-${++nextTaskId}-${base}`);
}

function rejectQueued(error) {
  while (taskQueue.length > 0) {
    const task = taskQueue.shift();
    task.reject(error);
  }
}

function failCurrent(error) {
  if (!currentTask) return;
  const task = currentTask;
  currentTask = null;
  clearTimeout(task.timer);
  task.reject(error);
}

function handleWorkerExit(reason) {
  const child = worker;
  worker = null;
  stdoutBuffer = '';
  if (child) {
    try { child.kill(); } catch (err) { /* ignore */ }
  }
  failCurrent(reason);
  if (unavailableReason) rejectQueued(new Error(unavailableReason));
  else pump();
}

function handleWorkerOutput(chunk) {
  stdoutBuffer += chunk;
  let index = stdoutBuffer.indexOf('\n');
  while (index >= 0) {
    const line = stdoutBuffer.slice(0, index).trim();
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (line) {
      let message = null;
      try {
        message = JSON.parse(line);
      } catch (err) {
        console.warn(`[wxgf] 无法解析转换进程输出: ${line.slice(0, 200)}`);
      }
      if (message && currentTask && message.id === currentTask.id) {
        const task = currentTask;
        currentTask = null;
        clearTimeout(task.timer);
        if (message.ok) task.resolve();
        else task.reject(new Error(message.error || 'wxgf 转换失败'));
        pump();
      }
    }
    index = stdoutBuffer.indexOf('\n');
  }
}

function startWorker() {
  if (worker || unavailableReason) return worker;
  if (!fs.existsSync(WORKER_SCRIPT)) {
    unavailableReason = `wxgf 转换脚本不存在: ${WORKER_SCRIPT}`;
    console.warn(`[wxgf] ${unavailableReason}`);
    return null;
  }

  const child = spawn(PYTHON, ['-I', WORKER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  worker = child;
  workerStderr = '';
  child.stdin.on('error', (error) => handleWorkerExit(error));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', handleWorkerOutput);
  child.stdout.on('error', (error) => handleWorkerExit(error));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    workerStderr = `${workerStderr}${chunk}`.slice(-4096);
    if (workerStderr.includes('ModuleNotFoundError') && !unavailableReason) {
      unavailableReason = `wxgf 转换依赖缺失(${PYTHON})，请按 scripts/README-wxgf.md 安装 PyAV/Pillow`;
      console.warn(`[wxgf] ${unavailableReason}`);
    }
  });
  child.on('error', (error) => {
    if (error.code === 'ENOENT' && !unavailableReason) {
      unavailableReason = `未找到 wxgf 转换用的 Python: ${PYTHON}`;
      console.warn(`[wxgf] ${unavailableReason}`);
    }
    handleWorkerExit(error);
  });
  child.on('exit', (code, signal) => {
    if (worker !== child) return;
    const detail = workerStderr.trim().split('\n').slice(-3).join(' | ');
    const firstFailure = !unavailableReason;
    const reason = unavailableReason || `wxgf 转换进程退出(code=${code}, signal=${signal})`;
    // 非正常退出通常意味着依赖缺失或解码器崩溃,避免每个请求都重启进程
    if (firstFailure && (code !== 0 || signal)) {
      unavailableReason = reason;
    }
    if (firstFailure) console.warn(`[wxgf] ${reason}${detail ? `: ${detail}` : ''}`);
    handleWorkerExit(new Error(reason));
  });
  return child;
}

function pump() {
  if (currentTask || taskQueue.length === 0) return;
  if (unavailableReason) {
    rejectQueued(new Error(unavailableReason));
    return;
  }
  if (!startWorker()) {
    rejectQueued(new Error(unavailableReason || 'wxgf 转换进程不可用'));
    return;
  }
  const task = taskQueue.shift();
  const id = ++nextTaskId;
  currentTask = {
    ...task,
    id,
    timer: setTimeout(() => {
      if (!currentTask || currentTask.id !== id) return;
      console.warn(`[wxgf] 转换超时: ${task.source}`);
      const failed = currentTask;
      currentTask = null;
      failed.reject(new Error('wxgf 转换超时'));
      if (worker) {
        const child = worker;
        worker = null;
        try { child.kill(); } catch (err) { /* ignore */ }
      }
      pump();
    }, TASK_TIMEOUT_MS),
  };

  try {
    worker.stdin.write(`${JSON.stringify({ id, src: task.source, dst: task.destination })}\n`);
  } catch (error) {
    clearTimeout(currentTask.timer);
    currentTask = null;
    task.reject(error);
    pump();
  }
}

function convertFile(sourceFile, destination, ephemeral) {
  return new Promise((resolve, reject) => {
    if (unavailableReason) {
      reject(new Error(unavailableReason));
      return;
    }
    if (!startWorker()) {
      reject(new Error(unavailableReason || 'wxgf 转换进程不可用'));
      return;
    }
    taskQueue.push({
      source: sourceFile,
      destination,
      ephemeral,
      resolve,
      reject,
    });
    pump();
  });
}

/**
 * 获取 wxgf 图片的 JPEG 缓存;没有缓存时异步转换。
 * @returns {Promise<{file: string, ephemeral: boolean}>}
 */
async function ensureWxgfJpeg(sourceFile, backupId, mediaPath) {
  const cached = cachedFileIfFresh(sourceFile, backupId, mediaPath);
  if (cached) return { file: cached, ephemeral: false };

  const useCache = hasCacheSpace();
  const target = useCache ? cacheFileFor(backupId, mediaPath) : tempFileFor(mediaPath);
  if (inflightByPath.has(target)) return inflightByPath.get(target);

  const promise = convertFile(sourceFile, target, !useCache)
    .then(() => ({ file: target, ephemeral: !useCache }))
    .finally(() => inflightByPath.delete(target));
  inflightByPath.set(target, promise);
  return promise;
}

process.once('exit', () => {
  if (worker) {
    try { worker.kill(); } catch (err) { /* ignore */ }
  }
});

module.exports = {
  CACHE_DIR,
  ensureWxgfJpeg,
  isWxgfFile,
};
