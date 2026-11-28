/**
 * 微信"Raw Message"(无 schema 的 protobuf wire format)解析器。
 * 使用 protobuf 的 unknown field 机制解析,这里直接按 protobuf 线格式读取。
 *
 * wire type:
 *   0 = varint
 *   1 = fixed64
 *   2 = length-delimited(bytes/string/嵌套消息)
 *   5 = fixed32
 */

/** 读取 varint,返回 { value, offset } */
function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  while (offset < buf.length) {
    const byte = buf[offset++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { value: result, offset };
    }
    shift += 7;
    if (shift > 56) {
      // 防御性处理:varint 过长,按 64 位截断
      return { value: result % 2 ** 64, offset };
    }
  }
  return null;
}

/**
 * 解析 protobuf 二进制为字段表。
 * @returns {Object<number, Array<{wireType:number, value:*}>>
 *   value: varint→number, fixed32→number, fixed64→number(安全范围内),
 *   length-delimited→Buffer
 */
function parseRawMessage(buf) {
  const fields = {};
  let offset = 0;
  while (offset < buf.length) {
    const key = readVarint(buf, offset);
    if (key === null) break;
    offset = key.offset;
    const fieldNo = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    let value;
    if (wireType === 0) {
      const v = readVarint(buf, offset);
      if (v === null) break;
      value = v.value;
      offset = v.offset;
    } else if (wireType === 1) {
      if (offset + 8 > buf.length) break;
      const big = buf.readBigUInt64LE(offset);
      value = big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
      offset += 8;
    } else if (wireType === 2) {
      const len = readVarint(buf, offset);
      if (len === null) break;
      offset = len.offset;
      value = buf.subarray(offset, offset + len.value);
      offset += len.value;
    } else if (wireType === 5) {
      if (offset + 4 > buf.length) break;
      value = buf.readUInt32LE(offset);
      offset += 4;
    } else {
      // 未知 wire type,无法继续
      break;
    }
    if (!fields[fieldNo]) fields[fieldNo] = [];
    fields[fieldNo].push({ wireType, value });
  }
  return fields;
}

/** 取字段的第一个值;bytes 解码为 utf8 字符串,varint 转字符串 */
function getFieldValue(fields, fieldNo) {
  const list = fields[fieldNo];
  if (!list || list.length === 0) return undefined;
  const { value } = list[0];
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

/** 取字段的第一个值,bytes 按 Buffer 原样返回 */
function getFieldBytes(fields, fieldNo) {
  const list = fields[fieldNo];
  if (!list || list.length === 0) return undefined;
  const { value } = list[0];
  return Buffer.isBuffer(value) ? value : undefined;
}

/** 取字段的第一个值(数字) */
function getFieldNumber(fields, fieldNo) {
  const list = fields[fieldNo];
  if (!list || list.length === 0) return undefined;
  const { value } = list[0];
  return typeof value === 'number' ? value : Number(value);
}

/**
 * 按路径取嵌套字段值,如 "10.1.2" 表示 field10 → 其 bytes 内层 field1 → field2。
 * @returns {string|undefined}
 */
function getFieldByPath(fields, path) {
  const parts = path.split('.').map(Number);
  let current = fields;
  for (const part of parts) {
    const list = current[part];
    if (!list || list.length === 0) return undefined;
    const { value } = list[0];
    if (!Buffer.isBuffer(value)) {
      return part === parts[parts.length - 1] ? String(value) : undefined;
    }
    if (part === parts[parts.length - 1]) return value.toString('utf8');
    current = parseRawMessage(value);
  }
  return undefined;
}

/** 提取嵌套消息中的所有字符串字段值(按字段号升序),用于启发式解析 */
function collectStrings(buf) {
  const fields = parseRawMessage(buf);
  const strings = [];
  for (const fieldNo of Object.keys(fields).sort((a, b) => a - b)) {
    for (const { wireType, value } of fields[fieldNo]) {
      if (wireType === 2 && Buffer.isBuffer(value)) {
        const str = value.toString('utf8');
        if (str.length > 0) strings.push(str);
      }
    }
  }
  return strings;
}

module.exports = {
  readVarint,
  parseRawMessage,
  getFieldValue,
  getFieldBytes,
  getFieldNumber,
  getFieldByPath,
  collectStrings,
};
