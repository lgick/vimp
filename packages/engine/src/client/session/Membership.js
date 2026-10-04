import {
  buildHostCaps,
  canHostIn,
  tokenAllowsHosting,
} from '../lib/hostCaps.js';
import JoinRetry from '../lib/JoinRetry.js';

// Членство вкладки в комнате на мастере (лобби-режим): join_room, его повтор
// после рестарта мастера, возможности вкладки для выбора беты (caps,
// master/successor.js) и их пересылка, когда они меняются.
//
// Без DOM: сигналинг, токен, роль и таймеры инъектирует сборщик
// (client/main.js).

export default class Membership {
  /**
   * @param {Object} deps
   * @param {Object} deps.signaling - SignalingClient.
   * @param {Object} deps.ctx - client/session/roomContext.js.
   * @param {string} deps.memberId - id вкладки на мастере.
   * @param {Function} deps.getToken - () → identity-токен.
   * @param {Function} deps.getTokenExpiresAt - () → мс эпохи | null.
   * @param {Function} deps.isHost - () → вкладка держит Worker комнаты.
   * @param {Object} deps.config - lobby-конфиг (migration, session).
   * @param {Function} [deps.canHost] - () → может ли вкладка хостить.
   * @param {Function} [deps.now]
   * @param {Object} [deps.timers] - { setTimeout, clearTimeout }.
   */
  constructor({
    signaling,
    ctx,
    memberId,
    getToken,
    getTokenExpiresAt,
    isHost,
    config,
    canHost = () => canHostIn(),
    now = () => Date.now(),
    timers = globalThis,
  }) {
    this._signaling = signaling;
    this._ctx = ctx;
    this._memberId = memberId;
    this._getToken = getToken;
    this._getTokenExpiresAt = getTokenExpiresAt;
    this._isHost = isHost;
    this._config = config;
    this._canHost = canHost;
    this._now = now;
    this._timers = timers;

    // проба модульного Worker'а не бесплатна — считается один раз, лениво
    this._canHostCached = null;
    // тип своего ICE-кандидата в выбранной паре с хостом комнаты
    this._iceType = null;
    // средний FPS рендера гостя за интервал отчёта (этап 9c); null — неизвестен
    this._fps = null;
    // момент, когда вход станет слишком коротким для роли хоста: caps
    // пересылаются мастеру, и он пересматривает бету
    this._tokenCapsTimer = null;

    // повтор join_room, пока хост не вернул комнату рестартовавшему мастеру
    this._joinRetry = new JoinRetry({
      send: () => this.sendJoinRoom(),
      windowMs: config.session.joinRetryWindowMs,
      timers,
      now,
    });
  }

  get memberId() {
    return this._memberId;
  }

  // членство гостя в комнате на мастере (вход, реконнект сигналинга, повтор)
  sendJoinRoom() {
    this._ctx.memberJoined = true;
    this.armTokenCapsTimer();
    this._signaling.joinRoom({
      roomId: this._ctx.roomId,
      memberId: this._memberId,
      token: this._getToken(),
      caps: this.caps(),
    });
  }

  // хватит ли срока входа на роль хоста: register_host/reclaim_host
  // предъявляют токен мастеру посреди матча, а продления нет
  tokenAllowsHostRole() {
    return tokenAllowsHosting(
      this._getTokenExpiresAt(),
      this._config.migration.minTokenLifetimeMs,
      this._now(),
    );
  }

  // возможности вкладки для мастера (выбор беты, master/successor.js); у
  // хоста iceType не про него — он сам конец всех пар
  caps() {
    this._canHostCached ??= this._canHost();

    const isHost = this._isHost();

    return buildHostCaps({
      canHost: this._canHostCached && this.tokenAllowsHostRole(),
      iceType: isHost ? null : this._iceType,
      // средний FPS рендера гостя (этап 9c): мастер не назначает бетой
      // слабую вкладку
      fps: isHost ? null : this._fps,
    });
  }

  // возможности изменились (вкладка спрятана, сменился тип кандидата) —
  // мастер пересматривает бету
  sendUpdate() {
    if (this._ctx.roomId) {
      this._signaling.memberUpdate(this._ctx.roomId, this.caps());
    }
  }

  // тип ICE-кандидата — мастеру: по нему он выбирает бету (этап 6)
  setIceType(type) {
    this._iceType = type;
    this.sendUpdate();
  }

  // свежий средний FPS гостя мастеру (этап 9c); хост его не шлёт
  setFps(fps) {
    this._fps = fps;

    if (!this._isHost()) {
      this.sendUpdate();
    }
  }

  // canHost гаснет по времени, а не по событию — без таймера мастер держал бы
  // бетой вкладку, которая откажется от промоушена
  armTokenCapsTimer() {
    this.clearTokenCapsTimer();

    const expiresAt = this._getTokenExpiresAt();

    if (!this._ctx.roomId || expiresAt === null) {
      return;
    }

    const delay =
      expiresAt - this._config.migration.minTokenLifetimeMs - this._now();

    if (delay > 0) {
      this._tokenCapsTimer = this._timers.setTimeout(() => {
        this._tokenCapsTimer = null;
        this.sendUpdate();
      }, delay);
    }
  }

  clearTokenCapsTimer() {
    this._timers.clearTimeout(this._tokenCapsTimer);
    this._tokenCapsTimer = null;
  }

  // unknownRoom на join_room: мастер, возможно, ещё ждёт хоста
  scheduleJoinRetry() {
    this._joinRetry.schedule();
  }

  // мастер принял членство (или повторять бессмысленно)
  stopJoinRetry() {
    this._joinRetry.stop();
  }

  // членство больше не объявляется: уход из комнаты или роль хоста (хост —
  // участник своей комнаты через register_host, не join_room)
  forget() {
    this._ctx.memberJoined = false;
    this._joinRetry.stop();
  }
}
