/**
 * 微信账号(用户)接口。
 *   GET /api/users                 所有导入中出现过的账号(去重,最新导入在前)
 *   GET /api/users/:username/avatar 账号头像(跨导入查找可用的最新头像)
 *
 * 账号信息来自 users 表(每次导入都会写入),这里按 username 去重,
 * 昵称/微信号取最新非空值,头像取任意一次导入中可用的文件。
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, MEDIA_DIR } = require('../db');
const { sendFileWithValidation, detectImageType } = require('../file-response');

const router = express.Router();

router.get('/users', (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY id DESC').all();
  const byName = new Map();

  for (const row of rows) {
    const username = row.username || '';
    if (!username) continue;
    if (!byName.has(username)) {
      byName.set(username, {
        username,
        displayName: '',
        wxName: '',
        hasAvatar: false,
        avatarVersion: '',
        lastId: row.id,
      });
    }
    const user = byName.get(username);
    if (!user.displayName && row.display_name) user.displayName = row.display_name;
    if (!user.wxName && row.wx_name) user.wxName = row.wx_name;
    if (row.avatar) {
      user.hasAvatar = true;
      // rows 按 id 倒序,保留最新一条头像路径作为缓存版本
      if (!user.avatarVersion) user.avatarVersion = `${row.backup_id}/${row.avatar}`;
    }
  }

  const items = [...byName.values()]
    .sort((a, b) => b.lastId - a.lastId)
    .map((user) => ({
      username: user.username,
      displayName: user.displayName || user.username,
      wxName: user.wxName,
      avatar: user.hasAvatar
        ? `/api/users/${encodeURIComponent(user.username)}/avatar?v=${encodeURIComponent(user.avatarVersion || user.lastId)}`
        : '',
    }));

  res.json({ items, total: items.length });
});

router.get('/users/:username/avatar', (req, res) => {
  const username = req.params.username;
  const candidates = db
    .prepare(`
      SELECT backup_id, avatar
      FROM users
      WHERE username = ? AND avatar <> ''
      ORDER BY id DESC
    `)
    .all(username);

  const found = candidates.find((candidate) => (
    fs.existsSync(path.join(MEDIA_DIR, candidate.backup_id, candidate.avatar))
  ));
  if (!found) return res.status(404).end();

  const file = path.join(MEDIA_DIR, found.backup_id, found.avatar);
  sendFileWithValidation(req, res, file, detectImageType(file).contentType);
});

module.exports = router;
