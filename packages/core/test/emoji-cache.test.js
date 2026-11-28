/**
 * 表情按需缓存的安全边界与图片类型识别(不发起网络请求)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  isAllowedEmojiUrl,
  detectImageExt,
} = require('../../server/src/emoji-cache');

test('表情 URL 只允许微信表情 CDN', () => {
  assert.strictEqual(isAllowedEmojiUrl('http://wxapp.tc.qq.com/262/20304/stodownload?m=x'), true);
  assert.strictEqual(isAllowedEmojiUrl('https://vweixinf.tc.qq.com/110/20401/x'), true);
  assert.strictEqual(isAllowedEmojiUrl('http://mmbiz.qpic.cn/mmbiz_gif/x'), true);

  assert.strictEqual(isAllowedEmojiUrl('http://127.0.0.1/x.gif'), false);
  assert.strictEqual(isAllowedEmojiUrl('https://example.com/x.gif'), false);
  assert.strictEqual(isAllowedEmojiUrl('http://wxapp.tc.qq.com.evil.example/x.gif'), false);
  assert.strictEqual(isAllowedEmojiUrl('file:///tmp/x.gif'), false);
  assert.strictEqual(isAllowedEmojiUrl('http://wxapp.tc.qq.com:8080/x.gif'), false);
  assert.strictEqual(isAllowedEmojiUrl('not a url'), false);
});

test('表情图片类型按文件头识别', () => {
  assert.strictEqual(detectImageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.strictEqual(
    detectImageExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'png'
  );
  assert.strictEqual(detectImageExt(Buffer.from('GIF89a')), 'gif');
  assert.strictEqual(detectImageExt(Buffer.from('RIFF0000WEBP')), 'webp');
  assert.strictEqual(detectImageExt(Buffer.from('<html>')), '');
  assert.strictEqual(detectImageExt(Buffer.alloc(0)), '');
});

test('微信内置表情标签资源完整', () => {
  const dir = path.join(__dirname, '../../server/public/wx-emoji');
  const groups = JSON.parse(fs.readFileSync(path.join(dir, 'emoji.json'), 'utf8'));
  const tokens = new Map();
  for (const group of groups) {
    for (const item of group.keys || []) {
      tokens.set(`${group.preTag || ''}${item.key}${group.postTag || ''}`, item.file);
      assert.match(item.file, /^wx-[a-z0-9-]+$/, `表情文件名不符合规范: ${item.file}`);
      assert.ok(fs.existsSync(path.join(dir, 'images', `${item.file}.png`)), `缺少表情图片: ${item.file}`);
    }
  }
  assert.strictEqual(tokens.get('[微笑]'), 'wx-wei-xiao');
  assert.strictEqual(tokens.get('[呲牙]'), 'wx-ci-ya');
  assert.ok(tokens.size >= 500, '表情标签数量不足');
  for (const file of fs.readdirSync(path.join(dir, 'images')).filter((name) => name.endsWith('.png'))) {
    assert.match(file, /^wx-[a-z0-9-]+\.png$/, `表情图片命名不符合规范: ${file}`);
  }
});
