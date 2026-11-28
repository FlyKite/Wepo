/**
 * zip 压缩包提取测试:把合成备份打包(带外层文件夹),验证
 * ZipBackupExtractor 只解出微信相关文件,且解出的目录可正常解析。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const yazl = require('yazl');

const { ZipBackupExtractor } = require('../src/zip');
const { WechatBackupParser } = require('../src/parser');
const { buildBackupFixture, APP_DOMAIN } = require('./fixture');

let fixtureDir;
let zipPath;
let extractor;
let noiseName;

test.before(async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wepo-zip-test-'));
  fixtureDir = path.join(workDir, 'source');
  zipPath = path.join(workDir, 'backup.zip');
  const { files } = buildBackupFixture(fixtureDir);

  // 打包:外层套一个文件夹,模拟用户"把备份文件夹压缩成 zip"的场景
  const zipfile = new yazl.ZipFile();
  const addFile = (realPath, zipName) => zipfile.addFile(realPath, `我的备份-2026/${zipName}`);
  addFile(path.join(fixtureDir, 'Manifest.plist'), 'Manifest.plist');
  addFile(path.join(fixtureDir, 'Manifest.db'), 'Manifest.db');
  for (const f of files) {
    const fileId = crypto.createHash('sha1').update(`${f.domain}-${f.relativePath}`, 'utf8').digest('hex');
    addFile(path.join(fixtureDir, fileId.slice(0, 2), fileId), `${fileId.slice(0, 2)}/${fileId}`);
  }
  // 混入干扰文件:非微信域的普通备份文件不应被解压
  const noiseId = 'f'.repeat(40);
  noiseName = `${noiseId.slice(0, 2)}/${noiseId}`;
  zipfile.addBuffer(Buffer.from('noise'), `我的备份-2026/${noiseName}`);
  // __MACOSX 元数据目录应被忽略
  zipfile.addBuffer(Buffer.from('x'), '我的备份-2026/__MACOSX/._Manifest.db');

  await new Promise((resolve, reject) => {
    zipfile.outputStream.pipe(fs.createWriteStream(zipPath)).on('close', resolve).on('error', reject);
    zipfile.end();
  });
});

test.after(() => {
  if (extractor) extractor.cleanup();
  fs.rmSync(path.dirname(zipPath), { recursive: true, force: true });
});

test('压缩包提取:定位根目录、只解微信文件、布局正确', async () => {
  extractor = new ZipBackupExtractor(zipPath);
  const extractedDir = await extractor.extract();

  // 元信息与索引已解出
  assert.ok(fs.existsSync(path.join(extractedDir, 'Manifest.db')), 'Manifest.db 应存在');
  assert.ok(fs.existsSync(path.join(extractedDir, 'Manifest.plist')), 'Manifest.plist 应存在');
  // 微信文件按 <前2位>/<fileID> 布局落盘
  const wechatFile = `${crypto.createHash('sha1').update(`${APP_DOMAIN}-Documents/LoginInfo2.dat`, 'utf8').digest('hex')}`;
  assert.ok(
    fs.existsSync(path.join(extractedDir, wechatFile.slice(0, 2), wechatFile)),
    '微信文件应按备份布局落盘'
  );
  // 非微信域文件未被解压
  assert.ok(!fs.existsSync(path.join(extractedDir, noiseName.split('/')[0])), '非微信文件不应被解压');
});

test('压缩包提取后可正常解析微信数据', () => {
  const extractedDir = extractor.tempDir;
  assert.ok(extractedDir, '先执行提取');
  const parser = new WechatBackupParser(extractedDir);
  try {
    const summary = parser.parseSummary();
    assert.strictEqual(summary.info.deviceName, '测试 iPhone');
    assert.strictEqual(summary.users[0].username, 'wxid_testuser');
    const peer = summary.contacts.find((c) => c.username === 'wxid_peer1');
    assert.ok(peer);
    assert.strictEqual(peer.messageCount, 4);
    const messages = [...parser.getMessages(peer)];
    assert.strictEqual(messages[0].content, '你好,这是一条测试消息');
    assert.strictEqual(messages[1].mediaKind, 'image');
    const media = parser.getMediaFile(messages[1], peer);
    assert.ok(media, 'zip 解压出的媒体文件应可读取');
  } finally {
    parser.close();
  }
});

test('非备份压缩包应报错', async () => {
  const badZip = path.join(path.dirname(zipPath), 'bad.zip');
  const zipfile = new yazl.ZipFile();
  zipfile.addBuffer(Buffer.from('not a backup'), 'readme.txt');
  await new Promise((resolve, reject) => {
    zipfile.outputStream.pipe(fs.createWriteStream(badZip)).on('close', resolve).on('error', reject);
    zipfile.end();
  });
  const bad = new ZipBackupExtractor(badZip);
  await assert.rejects(() => bad.extract(), /未找到 iOS 备份/);
  bad.cleanup();
});
