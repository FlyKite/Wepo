/**
 * 核心解析库端到端测试:构造合成 iOS 备份目录,验证
 * Manifest.db 解析、用户发现、联系人/会话/聊天记录提取。
 *
 * 运行方式(Electron ABI 下):
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test packages/core/test/parser.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { WechatBackupParser } = require('../src/parser');
const { ITunesBackup } = require('../src/backup');
const { parseMessageContent, normalizeRefer } = require('../src/content');
const { buildBackupFixture, md5 } = require('./fixture');

let backupDir;
let parser;

test.before(() => {
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wepo-test-backup-'));
  buildBackupFixture(backupDir);
  parser = new WechatBackupParser(backupDir);
});

test.after(() => {
  parser.close();
  fs.rmSync(backupDir, { recursive: true, force: true });
});

test('备份信息与用户发现', () => {
  const summary = parser.parseSummary();
  assert.strictEqual(summary.info.deviceName, '测试 iPhone');
  assert.strictEqual(summary.info.iosVersion, '17.5.1');
  assert.strictEqual(summary.users.length, 1);
  assert.strictEqual(summary.users[0].username, 'wxid_testuser');
  assert.strictEqual(summary.users[0].displayName, '测试用户');

  // 真实 iOS 备份的 Manifest.plist 可能是二进制 plist
  const binaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wepo-bplist-test-'));
  fs.writeFileSync(
    path.join(binaryDir, 'Manifest.plist'),
    Buffer.from(
      'YnBsaXN0MDDVAQIDBAUGBwgJClREYXRlW0RldmljZSBOYW1lXFByb2R1Y3QgVHlwZV8QD1Byb2R1Y3QgVmVyc2lvbl1TZXJpYWwgTnVtYmVyM0HINyVAAAAAW0JpbmFyeSBUZXN0WmlQaG9uZTE1LDJWMTcuNS4xVkJJTjEyMwgTGCQxQ1FaZnF4AAAAAAAAAQEAAAAAAAAACwAAAAAAAAAAAAAAAAAAAH8=',
      'base64'
    )
  );
  fs.writeFileSync(path.join(binaryDir, 'Manifest.db'), '');
  const binaryBackup = new ITunesBackup(binaryDir);
  try {
    const info = binaryBackup.getInfo();
    assert.strictEqual(info.deviceName, 'Binary Test');
    assert.strictEqual(info.iosVersion, '17.5.1');
    assert.strictEqual(info.serialNumber, 'BIN123');
    assert.strictEqual(info.parseError, undefined);
  } finally {
    binaryBackup.close();
    fs.rmSync(binaryDir, { recursive: true, force: true });
  }
});

test('解析过程上报细粒度进度', () => {
  const events = [];
  const progressParser = new WechatBackupParser(backupDir, {
    onParseProgress: (event) => events.push(event),
  });
  try {
    progressParser.parseSummary();
  } finally {
    progressParser.close();
  }
  assert.ok(events.length >= 4, `进度事件过少: ${events.length}`);
  assert.ok(events.some((event) => /正在解析联系人/.test(event.text)));
  assert.ok(events.some((event) => /正在统计聊天记录/.test(event.text)));
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].percent >= events[index - 1].percent,
      `进度不应回退: ${events[index - 1].percent} → ${events[index].percent}`);
  }
  assert.strictEqual(events[events.length - 1].percent, 100);
});

test('联系人合并(备注/昵称/群成员)', () => {
  const summary = parser.parseSummary();
  const peer = summary.contacts.find((c) => c.username === 'wxid_peer1');
  assert.ok(peer, 'wxid_peer1 应存在');
  assert.strictEqual(peer.remark, '备注好友一');
  assert.strictEqual(peer.nickname, '微信昵称一');
  assert.strictEqual(peer.wxName, 'peer1wx');
  assert.strictEqual(peer.region, 'Guangdong Shenzhen');
  assert.strictEqual(peer.phone, '13800138000');
  assert.strictEqual(peer.avatarUrl, 'http://example.com/avatar.jpg');
  assert.strictEqual(peer.unreadCount, 2);
  assert.strictEqual(peer.messageCount, 4);
  assert.strictEqual(peer.lastMessageType, 49);

  const room = summary.contacts.find((c) => c.username === 'room123@chatroom');
  assert.ok(room);
  assert.strictEqual(room.isChatroom, true);
  assert.strictEqual(room.members.length, 2);
  assert.strictEqual(room.members[0].displayName, '测试用户');
});

test('联系人标签提取(定义与成员关系)', () => {
  const summary = parser.parseSummary();
  assert.strictEqual(summary.tags.length, 1);
  const tag = summary.tags[0];
  assert.strictEqual(tag.owner, 'wxid_testuser');
  assert.strictEqual(tag.remoteId, 1);
  assert.strictEqual(tag.tagIndex, 0);
  assert.strictEqual(tag.name, '同事');
  assert.deepStrictEqual(tag.usernames.slice().sort(), ['room123@chatroom', 'wxid_peer1']);
});

test('消息解析(文本/图片/语音/链接)', () => {
  const summary = parser.parseSummary();
  const peer = summary.contacts.find((c) => c.username === 'wxid_peer1');
  const messages = [...parser.getMessages(peer)];
  assert.strictEqual(messages.length, 4);

  assert.strictEqual(messages[0].content, '你好,这是一条测试消息');
  assert.strictEqual(messages[0].isSent, true);
  assert.strictEqual(messages[0].type, 1);

  assert.strictEqual(messages[1].content, '[图片]');
  assert.strictEqual(messages[1].mediaKind, 'image');
  assert.strictEqual(messages[2].content, '[语音] 5″');
  assert.strictEqual(messages[2].mediaKind, 'voice');
  assert.strictEqual(messages[3].content, '[链接] 测试链接标题\n链接描述文字');
});

test('群聊消息发送者前缀拆分', () => {
  const summary = parser.parseSummary();
  const room = summary.contacts.find((c) => c.username === 'room123@chatroom');
  const messages = [...parser.getMessages(room)];
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].sender, 'wxid_peer1');
  assert.strictEqual(messages[0].content, '大家好,这是群聊消息');
});

test('媒体文件与头像提取', async () => {
  const summary = parser.parseSummary();
  const peer = summary.contacts.find((c) => c.username === 'wxid_peer1');
  const messages = [...parser.getMessages(peer)];
  const media = parser.getMediaFile(messages[1], peer);
  assert.ok(media, '图片文件应存在');
  assert.strictEqual(media.ext, 'jpg');
  assert.strictEqual(media.buffer[0], 0xff);
  const asyncMedia = await parser.getMediaFileAsync(messages[1], peer);
  assert.ok(asyncMedia, '异步媒体读取应存在');
  assert.strictEqual(asyncMedia.ext, 'jpg');
  assert.strictEqual(asyncMedia.buffer[0], 0xff);

  const room = summary.contacts.find((c) => c.username === 'room123@chatroom');
  const avatar = parser.getAvatarFile(room.hash);
  assert.ok(avatar, '群头像应存在(App Group 域)');
  assert.strictEqual(avatar[0], 0xff);

  const owner = summary.users[0];
  const ownerAvatar = parser.getAvatarFile(owner.hash);
  assert.ok(ownerAvatar, '当前账号头像应支持 share/... 路径');
  assert.strictEqual(ownerAvatar[0], 0xff);
});

test('头像查找支持同一 hash 出现在多个账号下', () => {
  // 同一个好友/群可能同时存在于多个微信账号;头像文件可能只缓存在其中一个
  // 账号的 headImg 目录。查找时不能只看第一个匹配联系人的账号。
  const roomHash = md5('room123@chatroom');
  const local = new WechatBackupParser(backupDir);
  local.summary = {
    users: [],
    contacts: [
      { hash: roomHash, owner: 'wxid_other' },
      { hash: roomHash, owner: 'wxid_testuser' },
    ],
  };
  try {
    const avatar = local.getAvatarFile(roomHash, 'wxid_other');
    assert.ok(avatar, '应回退到其他账号目录中的同 hash 头像');
    assert.strictEqual(avatar[0], 0xff);
  } finally {
    local.close();
  }
});

test('应用消息解析:引用不误判小程序/红包字段', () => {
  const quote = parseMessageContent(49, `<msg><appmsg>
    <title>回复内容</title><type>57</type>
    <weappinfo><appid></appid><username></username><pagepath></pagepath></weappinfo>
    <refermsg><type>1</type><displayname>张三</displayname><content>原消息</content></refermsg>
  </appmsg></msg>`);
  assert.strictEqual(quote.text, '[引用] 回复内容');
  assert.strictEqual(quote.extra.appType, 57);
  assert.strictEqual(quote.extra.weapp, undefined);
  assert.strictEqual(quote.extra.refer.displayName, '张三');
  assert.strictEqual(quote.extra.refer.content, '原消息');

  const red = parseMessageContent(49, `<msg><appmsg>
    <title>微信红包</title><des>恭喜发财</des><type>2001</type>
    <wcpayinfo><sendertitle>大吉大利</sendertitle><receiverdes>领取红包</receiverdes></wcpayinfo>
  </appmsg></msg>`);
  assert.strictEqual(red.text, '[红包] 恭喜发财');
  assert.strictEqual(red.extra.pay.senderTitle, '大吉大利');
  assert.strictEqual(red.extra.pay.receiverDesc, '领取红包');

  const transfer = parseMessageContent(49, `<msg><appmsg>
    <title>微信转账</title><des>向张三转账</des><type>2000</type>
    <wcpayinfo>
      <payer_username>wxid_sender</payer_username>
      <receiver_username>wxid_receiver</receiver_username>
      <receivestatus>2</receivestatus>
      <feedesc>¥168.00</feedesc>
      <pay_memo>礼金</pay_memo>
      <hinttext>已被接收</hinttext>
    </wcpayinfo>
  </appmsg></msg>`);
  assert.strictEqual(transfer.extra.pay.payerUsername, 'wxid_sender');
  assert.strictEqual(transfer.extra.pay.receiverUsername, 'wxid_receiver');
  assert.strictEqual(transfer.extra.pay.receiveStatus, '2');
  assert.strictEqual(transfer.extra.pay.feeDesc, '¥168.00');
  assert.strictEqual(transfer.extra.pay.payMemo, '礼金');
  assert.strictEqual(transfer.extra.pay.hintText, '已被接收');

  const mini = parseMessageContent(49, `<msg><appmsg>
    <title>现可预售。</title><type>33</type>
    <weappinfo>
      <appid>wx123</appid><username>gh_apple</username><pagepath>pages/index</pagepath>
      <sourcedisplayname>Apple 授权专营店商城</sourcedisplayname>
      <weappiconurl>https://example.com/icon.png</weappiconurl>
      <appservicetype>1</appservicetype>
    </weappinfo>
  </appmsg></msg>`);
  assert.strictEqual(mini.extra.weapp.appName, 'Apple 授权专营店商城');
  assert.strictEqual(mini.extra.weapp.iconUrl, 'https://example.com/icon.png');
  assert.strictEqual(mini.extra.weapp.serviceType, '1');

  const videoQuote = normalizeRefer({
    type: 49,
    displayName: '分享者',
    content: `wxid_sender:\n<?xml version="1.0"?>
      <msg><appmsg><title>视频标题</title><type>51</type>
        <finderFeed><nickname>视频号作者</nickname><desc>视频标题</desc>
          <mediaList><media><thumbUrl>https://finder.video.qq.com/thumb</thumbUrl></media></mediaList>
        </finderFeed>
      </appmsg></msg>`,
  });
  assert.strictEqual(videoQuote.appType, 51);
  assert.strictEqual(videoQuote.finder.nickname, '视频号作者');
  assert.strictEqual(videoQuote.title, '视频标题');
  assert.strictEqual(videoQuote.content, '[视频号] 视频标题');

  const linkQuote = normalizeRefer({
    type: 49,
    content: `wxid_sender:\n<msg><appmsg><title>链接标题</title><type>5</type>
      <url>https://example.com/a</url><sourcedisplayname>示例来源</sourcedisplayname>
    </appmsg></msg>`,
  });
  assert.strictEqual(linkQuote.appType, 5);
  assert.strictEqual(linkQuote.url, 'https://example.com/a');
  assert.strictEqual(linkQuote.sourceDisplayName, '示例来源');

  const voiceQuote = normalizeRefer({
    type: 34,
    content: '<msg><voicemsg voicelength="13500" voiceformat="4" /></msg>',
  });
  assert.strictEqual(voiceQuote.content, '[语音] 14″');

  const locationQuote = normalizeRefer({
    type: 48,
    content: 'wxid_sender:\n<msg><location x="23.1" y="113.2" label="地址" poiname="地点" /></msg>',
  });
  assert.strictEqual(locationQuote.content, '[位置] 地点');
  assert.strictEqual(locationQuote.location.poiname, '地点');

  const rawSticker = normalizeRefer({
    type: 47,
    content: '<msg><emoji md5="22e2148d0237308e8dd292a5f4534027" /></msg>',
  });
  assert.match(rawSticker.content, /^\[(表情|动画表情)\]$/);
  assert.ok(!rawSticker.content.includes('<'));
});

test('SQLite 无法直接打开时复制到本地临时目录重试', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wepo-db-test-'));
  const backup = new ITunesBackup(backupDir, { tempDir });
  const originalOpen = backup._openReadonly.bind(backup);
  let manifestFailures = 0;
  backup._openReadonly = (filePath) => {
    if (path.resolve(filePath) === path.resolve(backup.manifestPath) && manifestFailures === 0) {
      manifestFailures += 1;
      const err = new Error('unable to open database file');
      err.code = 'SQLITE_CANTOPEN';
      throw err;
    }
    return originalOpen(filePath);
  };
  try {
    const index = backup.getIndex();
    assert.ok(index.size > 0, '回退后应读取到微信文件索引');
    assert.strictEqual(manifestFailures, 1, '应先尝试直接打开一次');
    assert.ok(backup._tempDir, '应创建本地临时目录');
  } finally {
    backup.close();
  }
  assert.strictEqual(fs.existsSync(tempDir), false, '关闭后应清理临时目录');
});
