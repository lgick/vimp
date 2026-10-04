import { encodeStandbyChunks } from './standbyChunks.js';

// Хост → преемник (host-migration этап 6): канал standby к назначенной
// мастером бете и поток контрольных точек по нему.
//
// Канал открывается поверх уже живого RTCPeerConnection гостя
// (createDataChannel без ре-согласования SDP: SCTP-ассоциация уже есть —
// каналы meta/state). Пока бета есть, Worker снимает периодические точки
// (HostController.startCheckpoints); точка режется на куски ≤ chunkBytes.
//
// Backpressure: канал забит выше highWaterBytes — очередная периодическая
// точка пропускается (следующая всё равно свежее); финальная (этап 8) не
// пропускается, а ждёт bufferedamountlow. Приоритет финальной: пока она ждёт
// отправки, периодические не уходят, а снятые до неё (seq не новее —
// кодирование в Worker'е асинхронно) отбрасываются: бета не должна принять
// устаревшую точку поверх финальной.
//
// Канал закрылся сам при живом пире беты (ревью F8) — без повторного открытия
// поток точек встал бы до смены состава пиров, а бета докладывала бы мастеру
// всё более старую точку. Повтор — с экспоненциальной задержкой
// reopenDelayMs…reopenMaxDelayMs; открытие сбрасывает её.
export default class StandbySender {
  /**
   * @param {Object} options
   * @param {Object} options.controller - HostController (startCheckpoints,
   *   stopCheckpoints, onCheckpoint).
   * @param {Object} options.connections - HostConnectionManager
   *   (peerConnectionOf).
   * @param {number} options.intervalMs - период периодических точек.
   * @param {number} options.chunkBytes - потолок куска с заголовком.
   * @param {number} options.highWaterBytes - порог bufferedAmount.
   * @param {Object} [options.diagnostics] - журнал (пропуски точек).
   * @param {Function} [options.onStats] - после каждой отправки/пропуска.
   * @param {number} [options.reopenDelayMs] - первая пауза перед повторным
   *   открытием закрывшегося канала.
   * @param {number} [options.reopenMaxDelayMs] - потолок паузы.
   * @param {Object} [options.timers] - { setTimeout, clearTimeout } (тесты).
   * @param {Function} [options.now] - часы (мс).
   */
  constructor({
    controller,
    connections,
    intervalMs,
    chunkBytes,
    highWaterBytes,
    diagnostics = null,
    onStats = null,
    reopenDelayMs = 1000,
    reopenMaxDelayMs = 10000,
    timers = globalThis,
    now = () => Date.now(),
  }) {
    this._controller = controller;
    this._connections = connections;
    this._intervalMs = intervalMs;
    this._chunkBytes = chunkBytes;
    this._highWaterBytes = highWaterBytes;
    this._diagnostics = diagnostics;
    this._onStats = onStats;
    this._reopenDelayMs = reopenDelayMs;
    this._reopenMaxDelayMs = reopenMaxDelayMs;
    this._timers = timers;
    this._now = now;

    this._memberId = null;
    this._pc = null;
    this._channel = null;
    this._checkpointsOn = false;
    this._wireId = 0;
    // финальная точка, ждущая открытия канала или bufferedamountlow
    this._pendingFinal = null;
    // seq последней финальной точки (null — не было)
    this._finalSeq = null;
    this._lastSentAt = null;
    // повторное открытие закрывшегося канала: таймер и следующая пауза
    this._reopenTimer = null;
    this._reopenDelay = reopenDelayMs;

    this._stats = {
      sent: 0,
      skipped: 0,
      lastBytes: 0,
      lastChunks: 0,
      lastIntervalMs: null,
      lastLatencyMs: null,
    };

    this._unsubscribe = controller.onCheckpoint(checkpoint =>
      this._onCheckpoint(checkpoint),
    );
  }

  // метрики для настройки интервала/порогов (размер, интервал, пропуски)
  get stats() {
    return { ...this._stats };
  }

  /**
   * successor_assigned мастера: открыть канал новой бете, закрыть прежний.
   * @param {string|null} memberId
   */
  setSuccessor(memberId) {
    if (memberId === this._memberId) {
      this.refresh();
      return;
    }

    this._cancelReopen();
    this._reopenDelay = this._reopenDelayMs;
    this._closeChannel();
    this._memberId = memberId ?? null;
    this.refresh();
  }

  /**
   * Пересматривает канал: бета подключилась позже назначения, переподключила
   * WebRTC (новый pc) или канал закрылся. Зовётся и на смену состава пиров.
   */
  refresh() {
    if (!this._memberId) {
      this._setCheckpoints(false);
      return;
    }

    const pc = this._connections.peerConnectionOf(this._memberId);

    if (pc !== this._pc) {
      this._closeChannel();
    }

    if (pc && !this._channel) {
      this._openChannel(pc);
    }

    this._setCheckpoints(Boolean(this._channel));
  }

  destroy() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._cancelReopen();
    this._setCheckpoints(false);
    this._closeChannel();
    this._memberId = null;
  }

  _openChannel(pc) {
    let channel;

    try {
      channel = pc.createDataChannel('standby', { ordered: true });
    } catch {
      return; // pc уже закрыт — следующий refresh найдёт новый
    }

    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = this._highWaterBytes;
    channel.onopen = () => {
      this._reopenDelay = this._reopenDelayMs;
      this._flushFinal();
    };
    channel.onbufferedamountlow = () => this._flushFinal();
    channel.onclose = () => {
      if (this._channel === channel) {
        this._dropChannel();
        this._setCheckpoints(false);
        this._scheduleReopen();
      }
    };

    this._cancelReopen();
    this._pc = pc;
    this._channel = channel;
  }

  // пира нет — refresh() канал не откроет, и повторов больше не будет
  _scheduleReopen() {
    this._cancelReopen();

    const delay = this._reopenDelay;

    this._reopenDelay = Math.min(delay * 2, this._reopenMaxDelayMs);
    this._reopenTimer = this._timers.setTimeout(() => {
      this._reopenTimer = null;
      this.refresh();
    }, delay);
  }

  _cancelReopen() {
    if (this._reopenTimer !== null) {
      this._timers.clearTimeout(this._reopenTimer);
      this._reopenTimer = null;
    }
  }

  _closeChannel() {
    const channel = this._channel;

    this._dropChannel();

    try {
      channel?.close();
    } catch {
      // уже закрыт
    }
  }

  _dropChannel() {
    if (this._channel) {
      this._channel.onopen = null;
      this._channel.onclose = null;
      this._channel.onbufferedamountlow = null;
    }

    this._channel = null;
    this._pc = null;
    this._pendingFinal = null;
  }

  _setCheckpoints(on) {
    if (on === this._checkpointsOn) {
      return;
    }

    this._checkpointsOn = on;

    if (on) {
      this._controller.startCheckpoints(this._intervalMs);
    } else {
      this._controller.stopCheckpoints();
    }
  }

  _onCheckpoint(checkpoint) {
    const channel = this._channel;

    if (checkpoint.final) {
      // финальная точка не теряется: ждёт открытия канала и разгрузки
      this._pendingFinal = checkpoint;
      this._finalSeq = Number.isInteger(checkpoint.seq) ? checkpoint.seq : null;
      this._flushFinal();
      return;
    }

    if (
      this._pendingFinal ||
      (this._finalSeq !== null &&
        Number.isInteger(checkpoint.seq) &&
        checkpoint.seq <= this._finalSeq)
    ) {
      return;
    }

    if (!channel || channel.readyState !== 'open') {
      return;
    }

    if (channel.bufferedAmount > this._highWaterBytes) {
      this._stats.skipped += 1;
      this._diagnostics?.warn(
        'engine.standby.skipped',
        { bufferedAmount: channel.bufferedAmount },
        { source: 'host' },
      );
      this._onStats?.(this.stats);
      return;
    }

    this._send(channel, checkpoint);
  }

  _flushFinal() {
    const channel = this._channel;
    const checkpoint = this._pendingFinal;

    if (
      !checkpoint ||
      !channel ||
      channel.readyState !== 'open' ||
      channel.bufferedAmount > this._highWaterBytes
    ) {
      return;
    }

    this._pendingFinal = null;
    this._send(channel, checkpoint);
  }

  _send(channel, checkpoint) {
    this._wireId = (this._wireId + 1) >>> 0;

    const chunks = encodeStandbyChunks(
      checkpoint,
      this._wireId,
      this._chunkBytes,
    );

    try {
      for (const chunk of chunks) {
        channel.send(chunk);
      }
    } catch {
      return; // канал закрылся посреди отправки — onclose его уберёт
    }

    const now = this._now();

    this._stats.sent += 1;
    this._stats.lastBytes = checkpoint.bytes.byteLength;
    this._stats.lastChunks = chunks.length;
    this._stats.lastIntervalMs =
      this._lastSentAt === null ? null : now - this._lastSentAt;
    this._stats.lastLatencyMs = Number.isFinite(checkpoint.createdAt)
      ? now - checkpoint.createdAt
      : null;
    this._lastSentAt = now;
    this._onStats?.(this.stats);
  }
}
