/**
 * @wepo/core — Wepo 微仓的 iOS 未加密备份解析与微信数据提取核心库
 */
const { ITunesBackup, BackupError, WECHAT_DOMAINS } = require('./backup');
const { ZipBackupExtractor } = require('./zip');
const { WechatBackupParser } = require('./parser');
const { parseRawMessage, getFieldByPath } = require('./protobuf');
const { parseMmkv, parseMmsetting } = require('./mmkv');
const { parseMessageContent, normalizeRefer } = require('./content');
const {
  warmupWcdbZstd,
  decodeMessageValue,
  isWcdbZstdReady,
  getWcdbZstdStats,
} = require('./wcdb-zstd');
const { MSG_TYPE, MSG_TYPE_LABEL, isChatroom, isOfficialAccount } = require('./types');

module.exports = {
  ITunesBackup,
  BackupError,
  ZipBackupExtractor,
  WechatBackupParser,
  WECHAT_DOMAINS,
  parseRawMessage,
  getFieldByPath,
  parseMmkv,
  parseMmsetting,
  parseMessageContent,
  normalizeRefer,
  warmupWcdbZstd,
  decodeMessageValue,
  isWcdbZstdReady,
  getWcdbZstdStats,
  MSG_TYPE,
  MSG_TYPE_LABEL,
  isChatroom,
  isOfficialAccount,
};
