const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zstd = require('@bokuweb/zstd-wasm');

const {
  warmupWcdbZstd,
  decodeMessageValue,
  getWcdbZstdStats,
} = require('../src/wcdb-zstd');
const { parseMessageContent } = require('../src/content');

const DICT_PATH = path.join(__dirname, '..', 'dicts', '5.zdict');

test('WCDB zstd dictionary 5 decodes compressed sticker XML', async () => {
  await warmupWcdbZstd();
  const dict = new Uint8Array(fs.readFileSync(DICT_PATH));
  const xml = '<msg><emoji md5="0123456789abcdef0123456789abcdef" '
    + 'cdnurl="http://wxapp.tc.qq.com/example/stodownload?m=0123456789abcdef0123456789abcdef" '
    + 'productid="com.tencent.xin.emoticon.person.stiker_test"></emoji></msg>';

  const cctx = zstd.createCCtx();
  let frame;
  try {
    frame = zstd.compressUsingDict(cctx, Buffer.from(xml, 'utf8'), dict, 3);
  } finally {
    zstd.freeCCtx(cctx);
  }

  const decoded = decodeMessageValue(Buffer.from(frame));
  assert.strictEqual(decoded, xml);

  const parsed = parseMessageContent(47, decoded);
  assert.strictEqual(parsed.extra.md5, '0123456789abcdef0123456789abcdef');
  assert.match(parsed.extra.cdnurl, /stodownload/);
  assert.strictEqual(parsed.mediaKind, null);

  const stats = getWcdbZstdStats();
  assert.ok(stats.ready);
  assert.ok(stats.decoded >= 1);
});
