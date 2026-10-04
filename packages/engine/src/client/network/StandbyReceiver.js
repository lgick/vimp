import hostDefaults from '../../config/hostDefaults.js';
import wsports from '../../config/wsports.js';
import Publisher from '../../lib/Publisher.js';
import { decodeStandbyChunk, parseStandbyStream } from './standbyChunks.js';

const PS_SHOT_DATA = wsports.server.SHOT_DATA;

// заголовок бинарного кадра: u8 port, u8 version, u32 seq (big-endian)
const FRAME_SEQ_OFFSET = 2;
const FRAME_MIN_BYTES = FRAME_SEQ_OFFSET + 4;

// Преемник (бета, host-migration этап 6): собирает куски контрольных точек
// из канала standby и держит последнюю полную. Незавершённая точка
// выбрасывается, как только пошла более новая (в канале ordered куски одной
// точки идут подряд). Заодно помнит seq последнего кадра хоста, который
// видел этот клиент, — seqFloor восстановленного матча (этап 5).
//
// События publisher: 'checkpoint' (последняя полная точка).
export default class StandbyReceiver {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxBytes] - предел логического потока точки.
   * @param {Function} [options.now] - часы (мс).
   * @param {Object} [options.timers] - { setTimeout, clearTimeout } (тесты).
   */
  constructor({
    maxBytes = hostDefaults.maxCheckpointBytes,
    now = () => Date.now(),
    timers = globalThis,
  } = {}) {
    this._maxBytes = maxBytes;
    this._now = now;
    this._timers = timers;

    this._channel = null;
    this._partial = null;
    this._latest = null;
    this._lastSeenSeq = null;
    this._waiters = new Set();
    // передача сорвалась раньше, чем дошла её финальная точка: та ещё может
    // доехать (ждала разгрузки канала у хоста) и должна прийти периодической
    this._expectStaleFinal = false;

    this.publisher = new Publisher();
  }

  // seq последнего кадра хоста, который видел этот клиент (null — ни одного)
  get lastSeenSeq() {
    return this._lastSeenSeq;
  }

  /**
   * Последняя полная точка.
   * @returns {Object|null} { bytes, checkpointId, wireId, seq, createdAt,
   *   final, mode, game, receivedAt }; game — { id, version } из
   *   дескриптора или null (хост его не прислал).
   */
  latest() {
    return this._latest;
  }

  /**
   * Подключает канал standby (новый канал заменяет прежний).
   * @param {RTCDataChannel} channel
   */
  attach(channel) {
    this._detachChannel();
    this._channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = event => this.receive(event.data);
    channel.onclose = () => {
      if (this._channel === channel) {
        this._detachChannel();
      }
    };
  }

  /**
   * Кадр хоста из игрового транспорта: запоминает его seq.
   * @param {ArrayBuffer} data
   */
  noteFrame(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < FRAME_MIN_BYTES) {
      return;
    }

    const view = new DataView(data);

    if (view.getUint8(0) !== PS_SHOT_DATA) {
      return;
    }

    this._lastSeenSeq = view.getUint32(FRAME_SEQ_OFFSET, false);
  }

  /**
   * Один кусок из канала.
   * @param {ArrayBuffer|Uint8Array} raw
   */
  receive(raw) {
    const chunk = decodeStandbyChunk(raw);

    if (!chunk || chunk.totalBytes > this._maxBytes) {
      return;
    }

    // устаревшее: точка не новее уже собранной
    if (this._latest && chunk.wireId <= this._latest.wireId) {
      return;
    }

    // периодическая, снятая не позже финальной, её не вытесняет: бета
    // поднимает матч из финальной (тот же тик, без отката)
    if (
      this._latest?.final &&
      !chunk.final &&
      Number.isInteger(chunk.seq) &&
      chunk.seq <= this._latest.seq
    ) {
      return;
    }

    let partial = this._partial;

    if (partial && chunk.wireId < partial.wireId) {
      return;
    }

    if (!partial || chunk.wireId > partial.wireId) {
      // пошла более новая — незавершённая выбрасывается
      if (chunk.index !== 0) {
        this._partial = null;
        return;
      }

      partial = {
        wireId: chunk.wireId,
        count: chunk.count,
        totalBytes: chunk.totalBytes,
        seq: chunk.seq,
        final: chunk.final,
        buffer: new Uint8Array(chunk.totalBytes),
        offset: 0,
        next: 0,
      };
      this._partial = partial;
    }

    if (
      chunk.index !== partial.next ||
      chunk.count !== partial.count ||
      chunk.totalBytes !== partial.totalBytes ||
      partial.offset + chunk.data.byteLength > partial.totalBytes
    ) {
      this._partial = null; // дыра или несогласованный кусок — точка битая
      return;
    }

    partial.buffer.set(chunk.data, partial.offset);
    partial.offset += chunk.data.byteLength;
    partial.next += 1;

    if (partial.next < partial.count) {
      return;
    }

    this._partial = null;

    if (partial.offset !== partial.totalBytes) {
      return;
    }

    const parsed = parseStandbyStream(partial.buffer);

    if (!parsed) {
      return;
    }

    // канал ordered, а хост после финальной не шлёт периодических, пока она
    // не уйдёт: опоздавшая финальная сорвавшейся передачи — первая точка
    // после discardFinal, если она вообще будет
    const final = partial.final && !this._expectStaleFinal;

    this._expectStaleFinal = false;
    this._latest = {
      ...parsed,
      wireId: partial.wireId,
      seq: partial.seq,
      final,
      receivedAt: this._now(),
    };

    this.publisher.emit('checkpoint', this._latest);

    if (final) {
      for (const waiter of [...this._waiters]) {
        if (partial.wireId >= waiter.minWireId) {
          waiter.resolve(this._latest);
        }
      }
    }
  }

  /**
   * Ждёт финальную точку (плановая передача, этап 8).
   * @param {number} [minWireId] - не старше этого номера точки; уже
   *   полученная финальная подходит сразу.
   * @param {number} [timeoutMs]
   * @returns {Promise<Object>} Точка, как latest().
   */
  waitForFinal(minWireId = 0, timeoutMs = 5000) {
    const latest = this._latest;

    if (latest?.final && latest.wireId >= minWireId) {
      return Promise.resolve(latest);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        minWireId,
        resolve: checkpoint => {
          this._timers.clearTimeout(waiter.timer);
          this._waiters.delete(waiter);
          resolve(checkpoint);
        },
        reject: error => {
          this._timers.clearTimeout(waiter.timer);
          this._waiters.delete(waiter);
          reject(error);
        },
        timer: null,
      };

      waiter.timer = this._timers.setTimeout(
        () => waiter.reject(new Error('final checkpoint timed out')),
        timeoutMs,
      );
      this._waiters.add(waiter);
    });
  }

  /**
   * Плановая передача сорвалась (promote_cancelled): её финальная точка
   * остаётся последней, но следующую передачу не завершит — хост разморожен
   * и пришлёт новую финальную. Ещё не дошедшая финальная примется
   * периодической.
   */
  discardFinal() {
    if (this._latest?.final) {
      this._latest = { ...this._latest, final: false };
    } else {
      this._expectStaleFinal = true;
    }
  }

  // standby_released, уход из комнаты, смена эпохи: точки выбросить
  destroy() {
    this._detachChannel();
    this._partial = null;
    this._latest = null;
    this._expectStaleFinal = false;

    for (const waiter of [...this._waiters]) {
      waiter.reject(new Error('standby released'));
    }
  }

  _detachChannel() {
    const channel = this._channel;

    this._channel = null;
    this._partial = null;

    if (!channel) {
      return;
    }

    channel.onmessage = null;
    channel.onclose = null;

    try {
      channel.close();
    } catch {
      // уже закрыт
    }
  }
}
