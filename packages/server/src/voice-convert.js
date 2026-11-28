/**
 * 微信语音 SILK/AMR → WAV 按需转换。
 *
 * iOS 微信的 .aud 主要有两类:
 *   - Tencent SILK v3:文件头 \x02#!SILK_V3,用 MIT 许可的 silk-wasm 解码;
 *   - 原始 AMR-NB 帧:没有 #!AMR 文件头,每帧 32 字节(首字节 0x3c),
 *     补上 #!AMR\n 后用 Apache-2.0 的 @audio/decode-amr(opencore-amr WASM)解码。
 * 浏览器不能直接解码这些格式,所以这里统一转成单声道 WAV 并缓存。
 *
 * 缓存放在 data/media/<backup_id>/.voice-cache/,随备份删除一起清理。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MEDIA_DIR } = require('./db');

const SILK_SAMPLE_RATE = 24000;
const AMR_NB_SIZES = [13, 14, 16, 18, 20, 21, 27, 32, 6, 6, 6, 6, 1, 1, 1, 1];
const inflight = new Map();
let silkModule = null;
let amrModulePromise = null;

function getSilkModule() {
  if (!silkModule) silkModule = require('silk-wasm');
  return silkModule;
}

function getAmrModule() {
  if (!amrModulePromise) amrModulePromise = import('@audio/decode-amr');
  return amrModulePromise;
}

/** 读取文件头判断是否为 SILK(兼容微信前置的 0x02 字节) */
function isSilkFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(12);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    if (read < 10) return false;
    let text = header.subarray(0, read).toString('latin1');
    if (header[0] === 0x02) text = text.slice(1);
    return text.startsWith('!SILK') || text.startsWith('#!SILK');
  } catch (err) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function isAmrContainer(buffer) {
  const head = buffer.subarray(0, 9).toString('latin1');
  return head.startsWith('#!AMR\n') || head.startsWith('#!AMR-WB\n');
}

/**
 * 判断是否为没有文件头的原始 AMR-NB 帧序列。
 * 逐帧按 AMR-NB 帧大小表走完整个文件,避免把任意二进制误判成语音。
 */
function isRawAmrNb(buffer) {
  if (!buffer || buffer.length < 13) return false;
  let offset = 0;
  let frames = 0;
  while (offset < buffer.length) {
    const mode = (buffer[offset] >> 3) & 0x0f;
    const size = AMR_NB_SIZES[mode];
    if (!size || offset + size > buffer.length) return false;
    offset += size;
    frames += 1;
  }
  return frames > 0 && offset === buffer.length;
}

function cacheFileFor(backupId, mediaPath) {
  const root = path.resolve(MEDIA_DIR);
  const digest = crypto.createHash('sha1').update(String(mediaPath || ''), 'utf8').digest('hex');
  const file = path.resolve(root, String(backupId || ''), '.voice-cache', `${digest}.wav`);
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new Error('语音缓存路径非法');
  }
  return file;
}

function freshCache(sourceFile, target) {
  try {
    const source = fs.statSync(sourceFile);
    const cached = fs.statSync(target);
    return cached.isFile() && cached.size > 44 && cached.mtimeMs >= source.mtimeMs;
  } catch (err) {
    return false;
  }
}

/** PCM s16le → WAV(单声道 16-bit) */
function pcmToWav(pcm, sampleRate) {
  const data = Buffer.from(pcm);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Float32 单声道 → PCM s16le */
function floatToPcm16(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
    data.writeInt16LE(Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), i * 2);
  }
  return data;
}

function decodeSamplesFor(source) {
  const silk = getSilkModule();
  if (silk.isSilk(source)) {
    return silk.decode(source, SILK_SAMPLE_RATE).then((decoded) => ({
      pcm: decoded && decoded.data,
      sampleRate: SILK_SAMPLE_RATE,
    }));
  }
  if (isAmrContainer(source) || isRawAmrNb(source)) {
    return getAmrModule().then(async ({ default: decodeAmr }) => {
      const input = isAmrContainer(source)
        ? source
        : Buffer.concat([Buffer.from('#!AMR\n'), source]);
      const decoded = await decodeAmr(input);
      const channel = decoded && decoded.channelData && decoded.channelData[0];
      if (!channel || channel.length === 0) throw new Error('AMR 解码结果为空');
      return {
        pcm: floatToPcm16(channel),
        sampleRate: decoded.sampleRate,
      };
    });
  }
  return null;
}

async function writeVoiceWav(target, wav) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.promises.writeFile(temp, wav);
    await fs.promises.rename(temp, target);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch (cleanupErr) { /* ignore */ }
    throw err;
  }
}

/**
 * 将 SILK/AMR 语音转成 WAV 缓存文件;其他格式返回 null。
 * 同一文件的并发请求复用同一个转换 Promise。
 */
async function ensureVoiceWav(sourceFile, backupId, mediaPath) {
  const target = cacheFileFor(backupId, mediaPath);
  if (freshCache(sourceFile, target)) return target;

  const key = target;
  const existing = inflight.get(key);
  if (existing) return existing;

  const task = (async () => {
    const source = await fs.promises.readFile(sourceFile);
    const decoded = await decodeSamplesFor(source);
    if (!decoded || !decoded.pcm || decoded.pcm.length === 0) return null;
    const wav = pcmToWav(decoded.pcm, decoded.sampleRate);
    await writeVoiceWav(target, wav);
    return target;
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

module.exports = { ensureVoiceWav, isSilkFile, isRawAmrNb, pcmToWav };
