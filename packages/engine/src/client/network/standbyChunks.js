// Нарезка контрольной точки для канала standby (host-migration этап 6):
// хост → преемник. SCTP-сообщение ограничено maxMessageSize, поэтому точка
// идёт кусками ≤ standbyChunkBytes. Общий модуль отправителя
// (StandbySender) и приёмника (StandbyReceiver).
//
// Логический поток одной точки: [u16 descLen][desc JSON utf-8][байты
// точки], desc = { checkpointId, createdAt, mode, game } — приёмнику не
// нужно распаковывать точку, чтобы сообщить мастеру её id и свежесть, а
// прогреву — чтобы узнать игру (game: { id, version } или null; хост старше
// поля его не шлёт, старый приёмник его игнорирует).
//
// Кусок: 24-байтный заголовок (little-endian) + данные потока:
//   0  u32 wireId      — номер точки у отправителя (растёт)
//   4  u32 index       — номер куска
//   8  u32 count       — кусков в точке
//   12 u32 totalBytes  — длина логического потока
//   16 u32 seq         — номер кадра хоста на момент точки
//   20 u8  final       — финальная точка (плановая передача, этап 8)
//   21 u8  version     — версия формата куска
//   22 u16 reserved

export const STANDBY_HEADER_BYTES = 24;
export const STANDBY_CHUNK_VERSION = 1;

const DESC_LEN_BYTES = 2;
const GAME_FIELD_MAX_LENGTH = 64;

/**
 * Режет точку на куски.
 * @param {Object} checkpoint - { checkpointId, createdAt, mode, game, seq,
 *   final, bytes } (как отдаёт HostController.onCheckpoint).
 * @param {number} wireId
 * @param {number} chunkBytes - потолок размера куска вместе с заголовком.
 * @returns {Uint8Array[]}
 */
export function encodeStandbyChunks(checkpoint, wireId, chunkBytes) {
  const payloadBytes = chunkBytes - STANDBY_HEADER_BYTES;

  if (!(payloadBytes > 0)) {
    throw new Error(`standby chunk must exceed ${STANDBY_HEADER_BYTES} bytes`);
  }

  const desc = new TextEncoder().encode(
    JSON.stringify({
      checkpointId: checkpoint.checkpointId,
      createdAt: checkpoint.createdAt,
      mode: checkpoint.mode ?? null,
      game: parseGame(checkpoint.game),
    }),
  );
  const bytes = checkpoint.bytes;
  const stream = new Uint8Array(
    DESC_LEN_BYTES + desc.byteLength + bytes.byteLength,
  );

  new DataView(stream.buffer).setUint16(0, desc.byteLength, true);
  stream.set(desc, DESC_LEN_BYTES);
  stream.set(bytes, DESC_LEN_BYTES + desc.byteLength);

  const count = Math.max(1, Math.ceil(stream.byteLength / payloadBytes));
  const chunks = [];

  for (let index = 0; index < count; index += 1) {
    const data = stream.subarray(
      index * payloadBytes,
      (index + 1) * payloadBytes,
    );
    const chunk = new Uint8Array(STANDBY_HEADER_BYTES + data.byteLength);
    const view = new DataView(chunk.buffer);

    view.setUint32(0, wireId >>> 0, true);
    view.setUint32(4, index, true);
    view.setUint32(8, count, true);
    view.setUint32(12, stream.byteLength, true);
    view.setUint32(16, (checkpoint.seq ?? 0) >>> 0, true);
    view.setUint8(20, checkpoint.final ? 1 : 0);
    view.setUint8(21, STANDBY_CHUNK_VERSION);
    chunk.set(data, STANDBY_HEADER_BYTES);
    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Читает заголовок куска.
 * @param {ArrayBuffer|Uint8Array} raw
 * @returns {Object|null} { wireId, index, count, totalBytes, seq, final,
 *   data } или null для битого/чужого куска.
 */
export function decodeStandbyChunk(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);

  if (bytes.byteLength < STANDBY_HEADER_BYTES) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint8(21) !== STANDBY_CHUNK_VERSION) {
    return null;
  }

  const chunk = {
    wireId: view.getUint32(0, true),
    index: view.getUint32(4, true),
    count: view.getUint32(8, true),
    totalBytes: view.getUint32(12, true),
    seq: view.getUint32(16, true),
    final: view.getUint8(20) === 1,
    data: bytes.subarray(STANDBY_HEADER_BYTES),
  };

  if (chunk.count === 0 || chunk.index >= chunk.count) {
    return null;
  }

  return chunk;
}

/**
 * Разбирает собранный логический поток.
 * @param {Uint8Array} stream
 * @returns {{ checkpointId: string, createdAt: number, mode: string|null,
 *   game: { id: string, version: string }|null, bytes: Uint8Array }|null}
 */
export function parseStandbyStream(stream) {
  if (stream.byteLength < DESC_LEN_BYTES) {
    return null;
  }

  const descLen = new DataView(
    stream.buffer,
    stream.byteOffset,
    stream.byteLength,
  ).getUint16(0, true);

  if (DESC_LEN_BYTES + descLen > stream.byteLength) {
    return null;
  }

  let desc;

  try {
    desc = JSON.parse(
      new TextDecoder().decode(
        stream.subarray(DESC_LEN_BYTES, DESC_LEN_BYTES + descLen),
      ),
    );
  } catch {
    return null;
  }

  if (
    !desc ||
    typeof desc.checkpointId !== 'string' ||
    !Number.isFinite(desc.createdAt)
  ) {
    return null;
  }

  return {
    checkpointId: desc.checkpointId,
    createdAt: desc.createdAt,
    mode: typeof desc.mode === 'string' ? desc.mode : null,
    game: parseGame(desc.game),
    // своя копия: буфер можно отдать в Worker списком переноса
    bytes: stream.slice(DESC_LEN_BYTES + descLen),
  };
}

// игра дескриптора — только { id, version } из непустых коротких строк:
// дескриптор шлёт хост, то есть другой игрок
function parseGame(game) {
  const isField = value =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= GAME_FIELD_MAX_LENGTH;

  if (!game || typeof game !== 'object' || !isField(game.id)) {
    return null;
  }

  return isField(game.version) ? { id: game.id, version: game.version } : null;
}
