/**
 * 鉴权:访问 Secret 的读取/校验与 Express 中间件。
 *
 * Secret 配置在项目根目录的 config.json:
 *   { "secret": "<secret>" }
 * 服务端启动时读取;若文件不存在或缺少 secret 字段,自动生成随机 Secret
 * 并写回 config.json(保留其它配置项)。
 *
 * 网页查看器首次访问时由用户手动输入 Secret,校验通过后保存在浏览器
 * localStorage,后续请求通过 X-WEPO-Secret 请求头携带。
 * 媒体文件(<img>/<audio>/<video>)无法携带请求头,额外支持 ?secret= 查询参数。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const CONFIG_PATH = process.env.WEPO_CONFIG_PATH
  || path.join(__dirname, '..', '..', '..', 'config.json');
// 容器/自动化部署可通过 WEPO_SECRET 提供 Secret;未提供时生成并持久化到
// config.json,启动日志会输出实际值,便于在群晖图形界面中查看。
const ENV_SECRET = String(process.env.WEPO_SECRET || '').trim();

/** 读取 config.json;不存在或解析失败时返回空对象 */
function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = JSON.parse(raw);
    return config && typeof config === 'object' ? config : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[auth] 读取 ${CONFIG_PATH} 失败: ${err.message}`);
    }
    return {};
  }
}

/** 读取 Secret;缺失时生成随机 Secret 并写回配置文件 */
function loadOrCreateSecret() {
  const config = readConfig();
  if (typeof config.secret === 'string' && config.secret.trim()) {
    return config.secret.trim();
  }
  config.secret = crypto.randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    console.warn(`[auth] config.json 中缺少 secret,已生成随机 Secret 并写入: ${CONFIG_PATH}`);
  } catch (err) {
    console.error(`[auth] 无法写入配置文件 ${CONFIG_PATH}: ${err.message}`);
  }
  return config.secret;
}

const SECRET = ENV_SECRET || loadOrCreateSecret();

/** 常量时间比较,防时序侧信道 */
function isSecretValid(input) {
  if (!SECRET || typeof input !== 'string' || input === '') return false;
  const a = Buffer.from(input, 'utf8');
  const b = Buffer.from(SECRET, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 从请求头或查询参数取 Secret(媒体标签无法带请求头,走 ?secret=) */
function extractSecret(req) {
  const header = req.get('X-WEPO-Secret');
  if (header) return header;
  return typeof req.query.secret === 'string' ? req.query.secret : '';
}

/** API 鉴权中间件:未通过返回 401 */
function authMiddleware(req, res, next) {
  // 健康检查与 Secret 校验接口保持公开
  if (req.path === '/health' || req.path === '/auth/verify') return next();
  if (isSecretValid(extractSecret(req))) return next();
  res.status(401).json({ error: '未授权:Secret 无效或缺失' });
}

/** Secret 校验接口(公开):POST /api/auth/verify { secret } */
const authRoutes = express.Router();
authRoutes.post('/verify', async (req, res) => {
  const { secret } = req.body || {};
  if (isSecretValid(secret)) {
    res.json({ ok: true });
  } else {
    // 简单防暴力猜测:失败时延迟响应
    await new Promise((r) => setTimeout(r, 600));
    res.status(401).json({ error: 'Secret 无效' });
  }
});

module.exports = { SECRET, ENV_SECRET, CONFIG_PATH, isSecretValid, authMiddleware, authRoutes };
