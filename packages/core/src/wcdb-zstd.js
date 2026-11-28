/**
 * WCDB message decompression for newer iOS backups.
 *
 * WeChat 8.0.5x+ stores many non-text `Chat_*`.Message values as zstd frames
 * compressed with WCDB dictionary ID 5. The dictionary is not stored in the
 * backup; it is registered by the WeChat app at runtime. We ship the extracted
 * MsgDict (see ../dicts/README.md) so the importer can decode these messages.
 *
 * The WASM module is initialized asynchronously once per worker. The parser
 * itself is synchronous, so callers must await `warmupWcdbZstd()` before
 * parsing; otherwise compressed messages fall back to an empty content and
 * are rendered as `[表情]`/`[链接]` placeholders.
 */

const fs = require('fs');
const path = require('path');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DICT_PATH = path.join(__dirname, '..', 'dicts', '5.zdict');
const DICT_ID = 5;

let zstdModule = null;
let loadError = null;
try {
  // The package has separate Node/browser entry points; in Electron worker
  // threads the Node entry is selected and loads its bundled zstd.wasm.
  zstdModule = require('@bokuweb/zstd-wasm');
} catch (err) {
  loadError = err;
}

let dictionary = null;
let ready = false;
let warmupPromise = null;
const stats = { decoded: 0, failed: 0, skipped: 0 };

function isZstdFrame(value) {
  if (!value || typeof value === 'string' || value.length < ZSTD_MAGIC.length) return false;
  for (let i = 0; i < ZSTD_MAGIC.length; i++) {
    if (value[i] !== ZSTD_MAGIC[i]) return false;
  }
  return true;
}

/** Load the dictionary and initialize the WASM decoder. Safe to call repeatedly. */
function warmupWcdbZstd() {
  if (warmupPromise) return warmupPromise;
  warmupPromise = (async () => {
    if (!zstdModule) {
      throw loadError || new Error('zstd WASM module is unavailable');
    }
    await zstdModule.init();
    const data = fs.readFileSync(DICT_PATH);
    const dictId = data.length >= 8 ? data.readUInt32LE(4) : 0;
    if (dictId !== DICT_ID) {
      throw new Error(`unexpected WCDB zstd dictionary id ${dictId}`);
    }
    dictionary = new Uint8Array(data);
    ready = true;
    return { dictId, size: data.length };
  })();
  return warmupPromise;
}

/**
 * Convert a raw SQLite Message value to text.
 * - TEXT values are returned as-is.
 * - Non-zstd BLOBs keep the old UTF-8 decoding behaviour.
 * - zstd frames are decoded with dictionary 5; on failure/if not warmed up,
 *   return '' so the type-specific parser can emit its normal placeholder.
 */
function decodeMessageValue(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return String(value);

  const buffer = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);

  if (!isZstdFrame(buffer)) return buffer.toString('utf8');
  if (!ready || !dictionary) {
    stats.skipped += 1;
    return '';
  }

  let dctx = 0;
  try {
    dctx = zstdModule.createDCtx();
    const out = zstdModule.decompressUsingDict(dctx, buffer, dictionary);
    stats.decoded += 1;
    return Buffer.from(out).toString('utf8');
  } catch (err) {
    stats.failed += 1;
    return '';
  } finally {
    if (dctx) {
      try {
        zstdModule.freeDCtx(dctx);
      } catch (err) {
        /* ignore */
      }
    }
  }
}

function isWcdbZstdReady() {
  return ready;
}

function getWcdbZstdStats() {
  return { ...stats, ready };
}

module.exports = {
  ZSTD_MAGIC,
  DICT_ID,
  warmupWcdbZstd,
  decodeMessageValue,
  isWcdbZstdReady,
  getWcdbZstdStats,
};
