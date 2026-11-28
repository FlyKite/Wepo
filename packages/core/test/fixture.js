/**
 * 测试共享夹具:构造合成 iOS 备份目录(Manifest.db + 微信数据库文件)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const APP_DOMAIN = 'AppDomain-com.tencent.xin';
const GROUP_DOMAIN = 'AppDomainGroup-group.com.tencent.xin';

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function pbVarint(n) {
  const bytes = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  return Buffer.from(bytes);
}

function pbField(fieldNo, wireType, value) {
  return Buffer.concat([pbVarint(fieldNo * 8 + wireType), value]);
}

function pbBytes(fieldNo, buf) {
  return pbField(fieldNo, 2, Buffer.concat([pbVarint(buf.length), buf]));
}

function pbString(fieldNo, str) {
  return pbBytes(fieldNo, Buffer.from(str, 'utf8'));
}

/** MMKV 文件:4 字节总长 + 4 字节 CRC 占位 + key/value 条目 */
function makeMmkv(entries) {
  const body = [];
  for (const [key, value] of entries) {
    const keyBuf = Buffer.from(key, 'utf8');
    const valBuf = Buffer.from(value, 'utf8');
    const valueWrap = Buffer.concat([pbVarint(valBuf.length), valBuf]);
    body.push(Buffer.concat([pbVarint(keyBuf.length), keyBuf, pbVarint(valueWrap.length), valueWrap]));
  }
  const data = Buffer.concat(body);
  const total = Buffer.alloc(4 + 4 + data.length);
  total.writeUInt32LE(total.length - 4, 0);
  data.copy(total, 8);
  return total;
}

/**
 * 用临时文件构造 SQLite 数据库并返回其字节内容
 * (避免 better-sqlite3 的 serialize() 在 Electron V8 沙箱下崩溃)
 */
function makeDbBytes(build) {
  const Database = require('better-sqlite3');
  const tmp = path.join(os.tmpdir(), `wepo-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(tmp);
  build(db);
  db.close();
  const buf = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return Buffer.from(buf);
}

/**
 * 构造合成备份目录。
 * @returns {{ dir: string, files: Array }} files 为 [{ domain, relativePath }]
 */
function buildBackupFixture(dir) {
  const Database = require('better-sqlite3');
  fs.mkdirSync(dir, { recursive: true });

  const manifestPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Device Name</key><string>测试 iPhone</string>
  <key>Product Type</key><string>iPhone15,2</string>
  <key>Product Version</key><string>17.5.1</string>
  <key>SerialNumber</key><string>TEST123456</string>
  <key>Date</key><date>2026-10-01T08:00:00Z</date>
</dict></plist>`;
  fs.writeFileSync(path.join(dir, 'Manifest.plist'), manifestPlist);

  const files = [
    // LoginInfo2.dat: field1 = 两个 varint 长度前缀的用户消息
    {
      domain: APP_DOMAIN,
      relativePath: 'Documents/LoginInfo2.dat',
      content: (() => {
        const user1 = Buffer.concat([
          pbString(1, 'wxid_testuser'),
          pbString(2, 'testwx'),
          pbString(3, '测试用户'),
        ]);
        return Buffer.concat([pbBytes(1, Buffer.concat([pbVarint(user1.length), user1]))]);
      })(),
    },
    // 用户昵称 MMKV
    {
      domain: APP_DOMAIN,
      relativePath: 'Documents/MMappedKV/mmsetting.archive.wxid_testuser',
      content: makeMmkv([['88', '测试用户'], ['87', 'testwx']]),
    },
    // 联系人库 WCDB_Contact.sqlite
    {
      domain: APP_DOMAIN,
      relativePath: `Documents/${md5('wxid_testuser')}/DB/WCDB_Contact.sqlite`,
      content: makeDbBytes((db) => {
        db.exec(`
          CREATE TABLE Friend (userName TEXT, dbContactRemark BLOB, dbContactChatRoom BLOB, dbContactHeadImage BLOB, dbContactProfile BLOB, dbContactSocial BLOB, type INTEGER);
          CREATE TABLE OpenIMContact (userName TEXT, dbContactRemark BLOB, dbContactChatRoom BLOB, dbContactHeadImage BLOB, dbContactProfile BLOB, dbContactSocial BLOB, type INTEGER);
          CREATE TABLE ContactTagTable (nsName TEXT, tagIndex INTEGER, uiID INTEGER PRIMARY KEY);
          CREATE TABLE ContactTagRelationTable (uiID INTEGER, userName TEXT);
        `);
        const insert = db.prepare('INSERT INTO Friend VALUES (?, ?, ?, ?, ?, ?, ?)');
        insert.run(
          'wxid_peer1',
          Buffer.concat([pbString(1, '微信昵称一'), pbString(2, 'peer1wx'), pbString(3, '备注好友一')]),
          Buffer.from(''),
          Buffer.concat([pbString(2, 'http://example.com/avatar.jpg')]),
          Buffer.concat([pbString(2, 'CN'), pbString(3, 'Guangdong'), pbString(4, 'Shenzhen')]),
          Buffer.concat([pbBytes(11, Buffer.concat([pbVarint(11), Buffer.from('13800138000')]))]),
          0
        );
        insert.run(
          'room123@chatroom',
          Buffer.from(''),
          Buffer.concat([pbString(6, '<RoomData><Member UserName="wxid_testuser" DisplayName="测试用户"/><Member UserName="wxid_peer1" DisplayName="好友一"/></RoomData>')]),
          Buffer.from(''),
          Buffer.from(''),
          Buffer.from(''),
          0
        );
        db.prepare('INSERT INTO ContactTagTable VALUES (?, ?, ?)').run('同事', 0, 1);
        const insertTagUser = db.prepare('INSERT INTO ContactTagRelationTable VALUES (?, ?)');
        insertTagUser.run(1, 'wxid_peer1');
        insertTagUser.run(1, 'room123@chatroom');
      }),
    },
    // 会话库 session.db
    {
      domain: APP_DOMAIN,
      relativePath: `Documents/${md5('wxid_testuser')}/session/session.db`,
      content: makeDbBytes((db) => {
        db.exec('CREATE TABLE SessionAbstract (ConStrRes1 TEXT, CreateTime INTEGER, unreadcount INTEGER, UsrName TEXT)');
        const insert = db.prepare('INSERT INTO SessionAbstract VALUES (?, ?, ?, ?)');
        insert.run('session/data/aa/test', 1720000000, 2, 'wxid_peer1');
        insert.run('session/data/bb/test', 1720000100, 0, 'room123@chatroom');
      }),
    },
    // 聊天记录库 MM.sqlite
    {
      domain: APP_DOMAIN,
      relativePath: `Documents/${md5('wxid_testuser')}/DB/MM.sqlite`,
      content: makeDbBytes((db) => {
        const table1 = `Chat_${md5('wxid_peer1')}`;
        const table2 = `Chat_${md5('room123@chatroom')}`;
        db.exec(`
          CREATE TABLE "${table1}" (CreateTime INTEGER, Des INTEGER, MesLocalID INTEGER, Message TEXT, MesSvrID INTEGER, Status INTEGER, Type INTEGER);
          CREATE TABLE "${table2}" (CreateTime INTEGER, Des INTEGER, MesLocalID INTEGER, Message TEXT, MesSvrID INTEGER, Status INTEGER, Type INTEGER);
        `);
        const ins1 = db.prepare(`INSERT INTO "${table1}" VALUES (?, ?, ?, ?, ?, ?, ?)`);
        ins1.run(1720000001, 0, 1, '你好,这是一条测试消息', 1001, 1, 1);
        ins1.run(1720000002, 1, 2, '<msg><img cdnthumbwidth="640" cdnthumbheight="480" /></msg>', 1002, 1, 3);
        ins1.run(1720000003, 1, 3, '<msg><voicemsg voicelength="5200" voiceformat="4"/></msg>', 1003, 1, 34);
        ins1.run(
          1720000004, 1, 4,
          '<msg><appmsg><title>测试链接标题</title><des>链接描述文字</des><url>https://example.com/a</url><type>5</type></appmsg></msg>',
          1004, 1, 49
        );
        const ins2 = db.prepare(`INSERT INTO "${table2}" VALUES (?, ?, ?, ?, ?, ?, ?)`);
        ins2.run(1720000101, 1, 1, 'wxid_peer1:\n大家好,这是群聊消息', 2001, 1, 1);
      }),
    },
    // 群头像(App Group 域)
    {
      domain: GROUP_DOMAIN,
      relativePath: `Documents/${md5('wxid_testuser')}/session/headImg/${md5('room123@chatroom')}.pic`,
      content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
    },
    // iOS 17 实测头像目录:App Group 的 share/<账号md5>/session/headImg/
    {
      domain: GROUP_DOMAIN,
      relativePath: `share/${md5('wxid_testuser')}/session/headImg/${md5('wxid_testuser')}.pic`,
      content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0x04]),
    },
    // 图片文件
    {
      domain: APP_DOMAIN,
      relativePath: `Documents/${md5('wxid_testuser')}/Img/${md5('wxid_peer1')}/2.pic`,
      content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
    },
  ];

  // Manifest.db Files 表 + 文件落盘
  const db = new Database(path.join(dir, 'Manifest.db'));
  db.exec('CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)');
  const insert = db.prepare('INSERT INTO Files VALUES (?, ?, ?, ?, ?)');
  for (const f of files) {
    const fileId = crypto.createHash('sha1').update(`${f.domain}-${f.relativePath}`, 'utf8').digest('hex');
    const subDir = path.join(dir, fileId.slice(0, 2));
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, fileId), f.content);
    insert.run(fileId, f.domain, f.relativePath, 1, null);
  }
  db.close();
  return { dir, files };
}

module.exports = {
  buildBackupFixture,
  makeMmkv,
  makeDbBytes,
  pbString,
  pbBytes,
  md5,
  APP_DOMAIN,
  GROUP_DOMAIN,
};
