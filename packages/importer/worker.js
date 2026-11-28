/**
 * Worker 线程入口:兼容客户端本地导入与服务端目录导入。
 * 参数通过 workerData 传入,事件通过 parentPort 上报。
 */

const { parentPort } = require('worker_threads');
const { runImport } = require('./src/import-runner');

runImport().catch((err) => {
  if (parentPort) {
    parentPort.postMessage({ event: 'error', message: err.message || String(err) });
  }
});
