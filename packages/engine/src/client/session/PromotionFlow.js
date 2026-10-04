import { buildSystemMessage } from '../../host/meta/modules/chat/systemMessages.js';
import { formatRoomLink } from '../lib/roomLink.js';
import LoopbackTransport from '../network/LoopbackTransport.js';
import Promotion, { savePendingPromotion } from '../network/Promotion.js';

// Промоушен преемника (host-migration этап 7.4) и разжалование бывшего хоста
// (этап 7.5): promote → матч из контрольной точки (или холодный перезапуск
// перезагрузкой) → регистрация комнаты → возврат своего игрока; отмена,
// отказ мастера, host_revoked.
//
// Без DOM: сигналинг, роли, супервизор, UI-действия и фабрики инъектирует
// сборщик (client/main.js).

export default class PromotionFlow {
  /**
   * @param {Object} deps
   * @param {Object} deps.signaling - SignalingClient.
   * @param {Object} deps.ctx - client/session/roomContext.js.
   * @param {Object} deps.hostRole - client/session/HostRole.js.
   * @param {Object} deps.standby - client/session/StandbyRole.js.
   * @param {Object} deps.membership - client/session/Membership.js.
   * @param {Function} deps.getHandoff - () → HandoffFlow.
   * @param {Function} deps.getGuest - () → GuestSession.
   * @param {Function} deps.getSupervisor - () → SessionSupervisor | null.
   * @param {Function} deps.getActiveGameId - () → id активной игры | undefined.
   * @param {Function} deps.getToken - () → identity-токен.
   * @param {Function} deps.prepareRoom - prepareHostRoom (hostRoomPrep.js).
   * @param {Object} deps.config - lobby-конфиг (migration, create).
   * @param {Object} deps.diagnostics
   * @param {Object} deps.ui - { reloadPage(hash), reloadToRoom(),
   *   showSessionOverlay(text|null), disableControls(), mute(),
   *   informTech(text), chat(message) }.
   * @param {Function} [deps.getStorage] - () → sessionStorage (может бросить).
   * @param {Object} [deps.factories] - конструкторы (тесты).
   */
  constructor({
    signaling,
    ctx,
    hostRole,
    standby,
    membership,
    getHandoff,
    getGuest,
    getSupervisor,
    getActiveGameId,
    getToken,
    prepareRoom,
    config,
    diagnostics,
    ui,
    getStorage = () => window.sessionStorage,
    factories = {},
  }) {
    this._signaling = signaling;
    this._ctx = ctx;
    this._hostRole = hostRole;
    this._standby = standby;
    this._membership = membership;
    this._getHandoff = getHandoff;
    this._getGuest = getGuest;
    this._getSupervisor = getSupervisor;
    this._getActiveGameId = getActiveGameId;
    this._getToken = getToken;
    this._prepareRoom = prepareRoom;
    this._config = config;
    this._diagnostics = diagnostics;
    this._ui = ui;
    this._getStorage = getStorage;
    this._factories = {
      promotion: options => new Promotion(options),
      loopback: (controller, socketId, options) =>
        new LoopbackTransport(controller, socketId, options),
      ...factories,
    };

    // промоушен из контрольной точки, Worker которого ещё поднимается
    this._inFlight = null;
  }

  get inFlight() {
    return this._inFlight;
  }

  // подписки сигналинга промоушена (лобби-режим, один раз на страницу)
  bind() {
    const publisher = this._signaling.publisher;

    // мастер повысил эту вкладку до хоста комнаты (host-migration этап 7.4)
    publisher.on('promote', msg => this.handlePromote(msg));

    // промоушен отменён (опоздали к дедлайну): матч гасится, вкладка снова
    // гость и ждёт нового хоста
    publisher.on('promote_cancelled', msg => {
      if (msg.roomId !== this._ctx.roomId) {
        return;
      }

      this.cancel();
      // сорвавшаяся плановая передача: её финальная точка следующую не
      // завершит
      this._standby.discardFinal();

      if (this._hostRole.promotion) {
        this.abandon();
      }
    });

    // хоста сменили, пока эта вкладка была без связи (host-migration этап
    // 7.5)
    publisher.on('host_revoked', msg => {
      if (
        this._hostRole.controller &&
        msg.roomId === this._hostRole.room?.roomId
      ) {
        this.demote(msg.epoch);
      }
    });
  }

  handlePromote(msg) {
    // повтор promote нашей плановой передачи режимом checkpoint: хост пропал
    // посреди неё — финальную точку больше не ждём
    if (
      this._inFlight &&
      msg.mode === 'checkpoint' &&
      this._inFlight.degrade(msg)
    ) {
      return;
    }

    if (
      !this._ctx.roomId ||
      msg.roomId !== this._ctx.roomId ||
      this._hostRole.controller ||
      this._inFlight
    ) {
      return;
    }

    // вход истечёт посреди хостинга — отказ сразу, мастер возьмёт следующего
    if (!this._membership.tokenAllowsHostRole()) {
      this._signaling.promoteFailed(msg);
      return;
    }

    const gameId = this._getActiveGameId();

    // cold: точки нет — свежий матч той же комнаты после перезагрузки
    // (бутстрап видит отложенный промоушен и занимает комнату вместо
    // создания новой)
    if (msg.mode === 'cold') {
      let storage = null;

      try {
        storage = this._getStorage();
      } catch {
        storage = null;
      }

      if (!gameId || !savePendingPromotion(storage, msg, gameId)) {
        this._signaling.promoteFailed(msg);
        return;
      }

      this._ui.reloadPage(formatRoomLink(gameId, msg.roomId));

      return;
    }

    const migration = this._config.migration;
    const promotion = this._factories.promotion({
      promote: msg,
      receiver: this._standby.receiver,
      finalWaitMs: migration.finalWaitMs,
      maxRestoreAgeMs: migration.maxRestoreAgeMs,
      prewarm: this._standby.prewarm,
      prepareRoom: this._prepareRoom,
      hostSocketId: this._config.create.hostSocketId,
      diagnostics: this._diagnostics,
      hostCallbacks: {
        onLobbyInfoChange: info => this._hostRole.handleLobbyInfo(info),
      },
      hasSession: () => this._getSupervisor()?.hasSession === true,
      // host_migrating, если и придёт следом (старый мастер), migrate() уже
      // не исполнит — транспорт с каналом standby останется цел
      holdSession: () =>
        this._getSupervisor()?.migrate({ keepTransport: true }),
      onReady: ({ controller, room, prepared, lobbyInfo }) => {
        this._inFlight = null;
        this._hostRole.adopt(controller, room, prepared, {
          promotion: {
            mode: 'checkpoint',
            promotion: promotion.promotion,
            reason: msg.reason ?? null,
          },
        });
        this._hostRole.startRegistration(lobbyInfo);
      },
      onFailed: error => {
        this._inFlight = null;
        console.warn('[promotion] failed:', error);
        this._signaling.promoteFailed(promotion.promotion);
      },
    });

    this._inFlight = promotion;
    promotion.start();
  }

  // промоушен из точки ещё поднимает Worker — бросить его
  cancel() {
    this._inFlight?.cancel();
    this._inFlight = null;
  }

  // занять комнату не вышло (мастер отверг регистрацию или отменил
  // промоушен): роль снимается. report — сообщить мастеру, чтобы он взял
  // следующего кандидата, не дожидаясь дедлайна
  abandon({ code = null, report = false } = {}) {
    const { mode, promotion } = this._hostRole.promotion;

    if (code) {
      console.warn(`[promotion] register rejected: ${code}`);
    }

    if (report) {
      this._signaling.promoteFailed(promotion);
    }

    this._hostRole.teardown();

    // cold: страница — свежий хост без матча; гостем — чистым входом в ту же
    // комнату (отложенный промоушен уже снят). checkpoint: супервизор так и
    // ждёт нового хоста (migrating)
    if (mode === 'cold') {
      this._ui.reloadToRoom();
    }
  }

  // комната занята (host_registered): матч стартует, когда вернутся люди
  // точки (или по resumeWaitMs), свой игрок возвращается в него через
  // loopback
  finish({ mode, reason = null }) {
    this._standby.teardown();

    if (mode !== 'checkpoint') {
      return;
    }

    const controller = this._hostRole.controller;

    controller.startAfterRestore({ waitForResume: true, reason });

    const transport = this._factories.loopback(
      controller,
      this._config.create.hostSocketId,
      { resume: true },
    );

    transport.connect();

    // свой Worker: другой попытки, кроме loopback, нет — как у хоста
    // комнаты с создания. Комната уже занята этой вкладкой и гости
    // переключены на неё: сбой своего игрока её не гасит
    this._getSupervisor()?.resumeWith(transport, {
      reconnect: null,
      getToken: () => this._getToken(),
      onFailed: reason => this._onOwnPlayerLost(reason),
    });
  }

  // хоста сменили (host_revoked или staleEpoch на reclaim) или он отдал роль
  // сам (host_released, notice: false): матч этой вкладки гасится, свой
  // игрок возвращается гостем к новому хосту под своим gameId (его место
  // есть в точке беты). minEpoch — эпоха нового хоста или нижняя граница
  demote(minEpoch, { notice = true } = {}) {
    const handoff = this._getHandoff();

    // хост уходил из комнаты, а роль сменилась без него — уходит всё равно
    if (handoff.leaving) {
      handoff.leave();
      return;
    }

    this._hostRole.teardown();
    this._standby.teardown();
    this._ctx.epoch = minEpoch;

    if (notice) {
      this._ui.chat(buildSystemMessage('HOST_REVOKED'));
    }

    if (!this._ctx.roomId) {
      this._ui.reloadPage('');
      return;
    }

    this._membership.sendJoinRoom();

    const guest = this._getGuest();
    const reconnect = guest.reconnect();

    if (
      !this._getSupervisor()?.resumeWith(
        guest.openTransport(this._ctx.roomId, { resume: true }),
        { reconnect },
      )
    ) {
      this._ui.reloadToRoom();
    }
  }

  // свой игрок преемника не вернулся в поднятый им матч (секрета нет, отказ
  // RESUME, loopback закрыт): роль хоста остаётся — Worker, пиры, heartbeat
  // и поток точек живут, гости играют. Перезагрузка убила бы матч всех
  _onOwnPlayerLost(reason) {
    console.warn(`[promotion] own player not restored: ${reason}`);
    this._ui.showSessionOverlay(null);
    this._ui.disableControls();
    this._ui.mute();
    this._ui.informTech(
      'Your player could not be restored — the room keeps running for the others.',
    );
  }
}
