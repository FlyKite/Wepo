/**
 * 云端头像下载器的安全边界与图片类型识别(不发起网络请求)。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  isAllowedAvatarUrl,
  detectImageExt,
} = require('../../importer/src/avatar-downloader');

test('头像 URL 只允许微信头像 CDN', () => {
  assert.strictEqual(isAllowedAvatarUrl('https://wx.qlogo.cn/mmhead/ver_1/abc/0'), true);
  assert.strictEqual(isAllowedAvatarUrl('http://wx.qlogo.cn/mmhead/ver_1/abc/0'), true);
  assert.strictEqual(isAllowedAvatarUrl('https://thirdwx.qlogo.cn/mmhead/ver_1/abc/0'), true);
  assert.strictEqual(isAllowedAvatarUrl('https://mmhead.c2c.wechat.com/abc'), true);

  assert.strictEqual(isAllowedAvatarUrl('https://example.com/avatar.jpg'), false);
  assert.strictEqual(isAllowedAvatarUrl('http://127.0.0.1/avatar.jpg'), false);
  assert.strictEqual(isAllowedAvatarUrl('https://wx.qlogo.cn.evil.example/avatar.jpg'), false);
  assert.strictEqual(isAllowedAvatarUrl('file:///tmp/avatar.jpg'), false);
  assert.strictEqual(isAllowedAvatarUrl('not a url'), false);
});

test('头像图片类型按文件头识别', () => {
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
