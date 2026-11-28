/**
 * 微信 MMKV 文件解析。
 *
 * 文件格式:
 *   [0..4)   uint32 LE  数据实际长度(不含头部)
 *   数据区从偏移 8 开始,由若干条目组成:
 *     varint keyLen + key 字节 + varint valueLen + value 字节
 *   value 为字符串时是 MMBuffer 结构: varint 字符串长度 + 字符串字节,
 *   且该结构整体长度等于 valueLen。
 *
 * 常用键:
 *   "86" = UsrName, "87" = WXName, "88" = DisplayName(昵称),
 *   "headimgurl" = 头像, "headhdimgurl" = 高清头像
 */

const { readVarint } = require('./protobuf');

/** 解析 MMKV 文件中全部 key → string 映射 */
function parseMmkv(buffer) {
  const result = {};
  if (!buffer || buffer.length < 8) return result;
  const actualSize = buffer.readUInt32LE(0) + 4;
  const size = Math.min(actualSize, buffer.length);
  let offset = 8;
  while (offset + 1 < size) {
    const keyLen = readVarint(buffer, offset);
    if (keyLen === null || keyLen.value === 0 || keyLen.value > 1024) break;
    offset = keyLen.offset;
    const key = buffer.subarray(offset, offset + keyLen.value).toString('utf8');
    offset += keyLen.value;

    const valueLen = readVarint(buffer, offset);
    if (valueLen === null || valueLen.value === 0 || offset + valueLen.value > size) break;
    offset = valueLen.offset;
    const valueBytes = buffer.subarray(offset, offset + valueLen.value);
    offset += valueLen.value;

    // 字符串值: MMBuffer(varint 长度 + 字节);若不符合则按原始字节解码
    const inner = readVarint(valueBytes, 0);
    let str;
    if (inner !== null && inner.offset + inner.value === valueBytes.length) {
      str = valueBytes.subarray(inner.offset, inner.offset + inner.value).toString('utf8');
    } else {
      str = valueBytes.toString('utf8');
    }
    if (key !== '' && str.length > 0) result[key] = str;
  }
  return result;
}

/** 解析 mmsetting MMKV 文件,返回常用字段 */
function parseMmsetting(buffer) {
  const kv = parseMmkv(buffer);
  return {
    username: kv['86'] || kv.UsrName || '',
    wxName: kv['87'] || kv.WXName || '',
    displayName: kv['88'] || kv.NickName || '',
    portrait: kv.headimgurl || '',
    portraitHD: kv.headhdimgurl || '',
  };
}

module.exports = { parseMmkv, parseMmsetting };
