// Кодек контрольной точки хоста (host-migration этап 5). Изоморфен: Worker
// браузера, Node ≥ 18 (CompressionStream/DecompressionStream — глобалы) и
// headless-runner кодируют одинаково.
//
// Контейнер до сжатия: [u32 metaLen LE][meta JSON utf-8][байты дампа ядра];
// весь буфер — gzip. Дамп ядра сам по себе JSON (serialize_state), и без
// сжатия точка tanks весит ~420 КБ, с ним ~21 КБ (plan/host-migration,
// spike-results).

import hostDefaults from '../config/hostDefaults.js';

const HEADER_BYTES = 4;

// поток → один Uint8Array; maxBytes — предел накопленного (распаковка чужой
// точки — защита от «zip-бомбы»: превышение обрывает чтение, а не память)
async function readAll(stream, maxBytes = Infinity) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`checkpoint exceeds ${maxBytes} bytes unpacked`);
    }

    chunks.push(value);
  }

  // новый буфер целиком принадлежит результату: его можно отдать в список
  // переноса postMessage без копии
  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}

function pipeBytes(bytes, transform) {
  return new Blob([bytes]).stream().pipeThrough(transform);
}

/**
 * Упаковывает контрольную точку.
 * @param {Object} meta - JSON-сериализуемая мета (HANDOFF_VERSION 4).
 * @param {Uint8Array|null} [core] - Дамп ядра; null — мягкий режим.
 * @returns {Promise<Uint8Array>} gzip-буфер, владеющий своим ArrayBuffer.
 */
export async function encodeCheckpoint(meta, core = null) {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const coreBytes = core ?? new Uint8Array(0);
  const raw = new Uint8Array(
    HEADER_BYTES + metaBytes.byteLength + coreBytes.byteLength,
  );

  new DataView(raw.buffer).setUint32(0, metaBytes.byteLength, true);
  raw.set(metaBytes, HEADER_BYTES);
  raw.set(coreBytes, HEADER_BYTES + metaBytes.byteLength);

  return readAll(pipeBytes(raw, new CompressionStream('gzip')));
}

/**
 * Распаковывает контрольную точку.
 * @param {Uint8Array|ArrayBuffer} bytes - Результат encodeCheckpoint.
 * @param {Object} [options]
 * @param {number} [options.maxBytes] - Предел распакованного размера.
 * @returns {Promise<{meta: Object, core: Uint8Array|null}>}
 * @throws {Error} Битый буфер, превышение предела, нечитаемая мета.
 */
export async function decodeCheckpoint(
  bytes,
  { maxBytes = hostDefaults.maxCheckpointBytes } = {},
) {
  let raw;

  try {
    raw = await readAll(
      pipeBytes(bytes, new DecompressionStream('gzip')),
      maxBytes,
    );
  } catch (e) {
    throw new Error(`checkpoint is corrupted: ${e && e.message}`);
  }

  if (raw.byteLength < HEADER_BYTES) {
    throw new Error('checkpoint is corrupted: no header');
  }

  const metaLen = new DataView(raw.buffer).getUint32(0, true);

  if (HEADER_BYTES + metaLen > raw.byteLength) {
    throw new Error('checkpoint is corrupted: meta length out of range');
  }

  let meta;

  try {
    meta = JSON.parse(
      new TextDecoder().decode(
        raw.subarray(HEADER_BYTES, HEADER_BYTES + metaLen),
      ),
    );
  } catch (e) {
    throw new Error(`checkpoint is corrupted: meta is not JSON`);
  }

  const core = raw.subarray(HEADER_BYTES + metaLen);

  return { meta, core: core.byteLength ? core.slice() : null };
}

export default { encode: encodeCheckpoint, decode: decodeCheckpoint };
