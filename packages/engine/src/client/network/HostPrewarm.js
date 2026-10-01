import { decodeCheckpoint } from '../../lib/checkpointCodec.js';
import HostController from './HostController.js';

// Прогрев преемника (host-migration этап 6): по первой полной контрольной
// точке бета готовит комнату так же, как это делает создание комнаты
// (prepareHostRoom в main.js: манифест игры той версии, что в точке, карты
// мастера, URL worker-бандла), и поднимает HostController в режиме preload —
// Worker импортировал плагин и скомпилировал wasm, матча нет. Промоушен
// (этап 7) поднимет в нём матч из точки без ожидания сети.
export default class HostPrewarm {
  /**
   * @param {Object} options
   * @param {Function} options.prepareRoom - (settings, gameRef) →
   *   Promise<{ room, workerUrl, mapsVersion, codeVersion }>; gameRef — { id,
   *   version } из точки.
   * @param {Function} [options.createController] - (room, opts) →
   *   HostController (тесты).
   * @param {Function} [options.decode] - распаковка точки (тесты).
   * @param {Object} [options.diagnostics]
   * @param {Function} [options.onReady] - Worker прогрет (prepared).
   * @param {Function} [options.onError] - прогрев не удался (Error).
   */
  constructor({
    prepareRoom,
    createController = (room, opts) => new HostController(room, opts),
    decode = decodeCheckpoint,
    diagnostics = null,
    onReady = null,
    onError = null,
  }) {
    this._prepareRoom = prepareRoom;
    this._createController = createController;
    this._decode = decode;
    this._diagnostics = diagnostics;
    this._onReady = onReady;
    this._onError = onError;

    // 'idle' | 'warming' | 'ready' | 'failed' | 'destroyed'
    this._state = 'idle';
    this._gameKey = null;
    // версия, прогрев которой провалился: точки идут 2 раза в секунду, и
    // повтор на каждую означал бы шторм запросов к мастеру
    this._failedKey = null;
    this._controller = null;
    this._prepared = null;
  }

  get state() {
    return this._state;
  }

  // прогретый HostController (null — ещё нет)
  get controller() {
    return this._state === 'ready' ? this._controller : null;
  }

  // { room, workerUrl, mapsVersion, codeVersion, gameRef } прогретой комнаты
  get prepared() {
    return this._state === 'ready' ? this._prepared : null;
  }

  /**
   * Прогрев по точке. Повторный вызов с той же игрой/версией ничего не
   * делает; смена версии игры в точке (деплой в живой комнате) — прогрев
   * заново.
   * @param {Uint8Array} bytes - Сжатая контрольная точка (не передаётся —
   *   копия остаётся у вызывающего).
   * @returns {Promise<void>}
   */
  async warm(bytes) {
    if (this._state === 'destroyed' || this._state === 'warming') {
      return;
    }

    let meta;

    // негодная точка — проблема этой точки, а не версии игры: прогретый
    // Worker остаётся, следующая точка той же версии проверяется как обычно
    try {
      ({ meta } = await this._decode(bytes));
    } catch (e) {
      this._onError?.(e);
      return;
    }

    const gameRef = meta?.room?.game ?? null;

    if (!gameRef?.id || !gameRef.version) {
      this._onError?.(new Error('checkpoint has no room.game'));
      return;
    }

    const gameKey = `${gameRef.id}@${gameRef.version}`;

    if (
      this._state === 'destroyed' ||
      gameKey === this._gameKey ||
      gameKey === this._failedKey
    ) {
      return;
    }

    this._terminate();
    this._gameKey = gameKey;
    this._state = 'warming';

    let prepared;

    try {
      prepared = await this._prepareRoom(
        { ...(meta.room.settings ?? {}) },
        gameRef,
      );
    } catch (e) {
      this._fail(e);
      return;
    }

    if (this._state !== 'warming' || this._gameKey !== gameKey) {
      return; // destroy() или новая версия, пока готовились
    }

    this._prepared = { ...prepared, gameRef };
    this._controller = this._createController(prepared.room, {
      workerUrl: prepared.workerUrl ?? undefined,
      diagnostics: this._diagnostics ?? undefined,
      preload: true,
      onPreloaded: () => {
        if (this._state === 'warming' && this._gameKey === gameKey) {
          this._state = 'ready';
          this._onReady?.(this._prepared);
        }
      },
      onError: msg => {
        if (this._gameKey === gameKey) {
          this._fail(new Error(msg?.message || 'preload failed'));
        }
      },
    });
  }

  /**
   * Промоушен (host-migration этап 7.4) забирает прогретый Worker: дальше
   * им владеет вызывающий, destroy() его уже не гасит.
   * @returns {Object|null} { controller, prepared } или null — прогрева нет.
   */
  take() {
    if (this._state !== 'ready') {
      return null;
    }

    const taken = { controller: this._controller, prepared: this._prepared };

    this._controller = null;
    this._prepared = null;
    this._state = 'destroyed';

    return taken;
  }

  // standby_released, уход из комнаты, смена эпохи
  destroy() {
    this._terminate();
    this._state = 'destroyed';
  }

  _fail(error) {
    this._terminate();
    this._state = 'failed';
    this._failedKey = this._gameKey;
    this._gameKey = null;
    this._onError?.(error);
  }

  _terminate() {
    this._controller?.destroy();
    this._controller = null;
    this._prepared = null;
  }
}
