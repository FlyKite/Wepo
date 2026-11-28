/**
 * Tauri Node sidecar: 读取一次性配置，启动共用的导入 worker。
 * 通过 stdout 每行一个 JSON 事件与 Rust 主进程通信。
 */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

function emit(payload) {
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch (err) {
    /* stdout 已关闭时忽略 */
  }
}

function fail(message) {
  emit({ event: 'error', message: String(message || '导入失败') });
  process.exitCode = 1;
}

const configPath = process.argv[2];
if (!configPath) {
  fail('缺少导入配置');
  process.exit();
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  fs.rmSync(configPath, { force: true });
} catch (err) {
  fail(`读取导入配置失败: ${err.message}`);
  process.exit();
}

if (!config || typeof config !== 'object') {
  fail('导入配置为空');
  process.exit();
}

// 不保留 stdin 句柄，避免导入结束后进程不退出。
try { process.stdin.destroy(); } catch (err) { /* ignore */ }

const workerPath = path.join(__dirname, 'node_modules', '@wepo', 'importer', 'worker.js');
let worker;
let terminal = false;

try {
  worker = new Worker(workerPath, { workerData: config });
} catch (err) {
  fail(`启动导入 worker 失败: ${err.message}`);
  process.exit();
}

process.on('SIGTERM', () => {
  worker.terminate().catch(() => {}).finally(() => process.exit(0));
});
process.on('SIGINT', () => {
  worker.terminate().catch(() => {}).finally(() => process.exit(0));
});

worker.on('message', (payload) => {
  if (payload && (payload.event === 'done' || payload.event === 'error')) terminal = true;
  emit(payload);
});
worker.on('error', (err) => {
  terminal = true;
  fail(err && err.message ? err.message : err);
});
worker.on('exit', (code) => {
  if (!terminal) {
    fail(`导入进程已退出(code ${code})`);
  }
  process.exitCode = code || (terminal ? 0 : 1);
});
