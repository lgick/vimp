import HostPrewarm from '../network/HostPrewarm.js';
import StandbyReceiver from '../network/StandbyReceiver.js';

// Роль беты (host-migration этап 6): назначение мастера ({ roomId, epoch,
// game }), приём контрольных точек по каналу standby, прогретый Worker и
// периодический standby_status.
//
// Без DOM: сигналинг, подготовку комнаты, конфиг и фабрики инъектирует
// сборщик (client/main.js).

export default class StandbyRole {
  /**
   * @param {Object} deps
   * @param {Object} deps.signaling - SignalingClient.
   * @param {Object} deps.ctx - client/session/roomContext.js.
   * @param {Function} deps.isHost - () → вкладка держит Worker комнаты.
   * @param {Function} deps.prepareRoom - prepareHostRoom (hostRoomPrep.js).
   * @param {Object} deps.diagnostics
   * @param {Object} deps.config - lobby.migration.
   * @param {Function|null} [deps.debug] - debugLog dev-сборки.
   * @param {Function} [deps.createReceiver]
   * @param {Function} [deps.createPrewarm]
   * @param {Function} [deps.now]
   * @param {Object} [deps.timers] - { setInterval, clearInterval }.
   */
  constructor({
    signaling,
    ctx,
    isHost,
    prepareRoom,
    diagnostics,
    config,
    debug = null,
    createReceiver = () => new StandbyReceiver(),
    createPrewarm = options => new HostPrewarm(options),
    now = () => Date.now(),
    timers = globalThis,
  }) {
    this._signaling = signaling;
    this._ctx = ctx;
    this._isHost = isHost;
    this._prepareRoom = prepareRoom;
    this._diagnostics = diagnostics;
    this._config = config;
    this._debug = debug;
    this._createReceiver = createReceiver;
    this._createPrewarm = createPrewarm;
    this._now = now;
    this._timers = timers;

    this._role = null;
    this._receiver = null;
    this._prewarm = null;
    this._statusTimer = null;
    this._received = 0;
  }

  // назначение мастера { roomId, epoch, game } или null
  get role() {
    return this._role;
  }

  get receiver() {
    return this._receiver;
  }

  get prewarm() {
    return this._prewarm;
  }

  ensureReceiver() {
    if (!this._receiver) {
      this._receiver = this._createReceiver();
      this._receiver.publisher.on('checkpoint', checkpoint =>
        this._onCheckpoint(checkpoint),
      );
    }

    return this._receiver;
  }

  // канал standby открывает хост только назначенной бете
  attach(channel) {
    this.ensureReceiver().attach(channel);
  }

  // бета помнит seq последнего кадра хоста (seqFloor, этап 6) — до
  // push_frame: ядро может забрать буфер
  noteFrame(data) {
    this._receiver?.noteFrame(data);
  }

  // сорвавшаяся плановая передача: её финальная точка следующую не завершит
  discardFinal() {
    this._receiver?.discardFinal();
  }

  // standby_released, уход из комнаты, смена эпохи: прогретый Worker
  // гасится, точки выбрасываются
  teardown() {
    this._timers.clearInterval(this._statusTimer);
    this._statusTimer = null;
    this._receiver?.destroy();
    this._receiver = null;
    this._prewarm?.destroy();
    this._prewarm = null;
    this._role = null;
    this._received = 0;
  }

  // подписки сигналинга роли беты (лобби-режим, один раз на страницу)
  bind() {
    // гость: мастер назначил его бетой
    this._signaling.publisher.on('standby_assigned', msg => {
      if (this._isHost() || msg.roomId !== this._ctx.roomId) {
        return;
      }

      if (this._role && this._role.epoch !== msg.epoch) {
        this.teardown();
      }

      // game — игра комнаты по данным мастера: прогрев сверяет с ней точку
      this._role = {
        roomId: msg.roomId,
        epoch: msg.epoch,
        game: msg.game ?? null,
      };
      this.ensureReceiver();
      this._startDuties();
    });

    this._signaling.publisher.on('standby_released', msg => {
      if (msg.roomId === this._ctx.roomId) {
        this.teardown();
      }
    });
  }

  // полная точка собрана: мастеру — что она есть, Worker'у — прогрев
  _onCheckpoint(checkpoint) {
    this._received += 1;

    this._debug?.('standby received', {
      count: this._received,
      bytes: checkpoint.bytes.byteLength,
      checkpointId: checkpoint.checkpointId,
    });

    this._startDuties();
  }

  // канал мог открыться раньше, чем пришло standby_assigned: обязанности
  // беты начинаются, когда есть и назначение, и точка
  _startDuties() {
    const latest = this._receiver?.latest();

    if (!this._role || !latest) {
      return;
    }

    if (this._statusTimer === null) {
      this._reportStatus();
      this._statusTimer = this._timers.setInterval(
        () => this._reportStatus(),
        this._config.standbyStatusIntervalMs,
      );
    }

    this._prewarm ??= this._createPrewarm({
      prepareRoom: this._prepareRoom,
      diagnostics: this._diagnostics,
      onReady: prepared => {
        this._debug?.('standby worker prewarmed', prepared.gameRef);
      },
      onError: error => console.warn('[standby] prewarm failed:', error),
    });
    this._prewarm.warm(latest, { allowedGame: this._role.game });
  }

  _reportStatus() {
    const latest = this._receiver?.latest();

    if (this._role && latest) {
      this._signaling.standbyStatus({
        roomId: this._role.roomId,
        epoch: this._role.epoch,
        checkpointId: latest.checkpointId,
        createdAt: latest.createdAt,
        // мастер судит о свежести по возрасту точки, а не по приходу статуса
        ageMs: Math.max(0, this._now() - latest.receivedAt),
      });
    }
  }
}
