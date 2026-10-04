import HostHealthPolicy from '../network/HostHealthPolicy.js';
import PlannedHandoff, {
  controlsAfterAbort,
} from '../network/PlannedHandoff.js';
import { SESSION_STATES } from '../network/SessionSupervisor.js';
import TokenHandoffTimer from '../network/TokenHandoffTimer.js';

// Плановая передача хоста (host-migration этап 8.2) и уход из комнаты:
// «Hand over host», «Leave server», автотриггеры (этап 9b), просьба мастера
// (сеть — этап 9c, голосование — этап 10), передача по сроку входа
// (host-migration-review этап 15).
//
// Без DOM: сигналинг, роль хоста, супервизор, UI-действия и фабрики
// инъектирует сборщик (client/main.js).

export default class HandoffFlow {
  /**
   * @param {Object} deps
   * @param {Object} deps.signaling - SignalingClient.
   * @param {Object} deps.ctx - client/session/roomContext.js.
   * @param {Object} deps.hostRole - client/session/HostRole.js.
   * @param {Object} deps.standby - client/session/StandbyRole.js.
   * @param {Object} deps.membership - client/session/Membership.js.
   * @param {Function} deps.getPromotion - () → PromotionFlow.
   * @param {Function} deps.getSupervisor - () → SessionSupervisor | null.
   * @param {Function} deps.getTokenExpiresAt - () → мс эпохи | null.
   * @param {Object} deps.config - lobby.migration.
   * @param {Object} deps.ui - { showSessionOverlay(text|null),
   *   disableControls(), enableControls(), mute(), unmute(), isHidden(),
   *   setHandoffMenu(state|null), sendLeave(), reloadPage(hash) }.
   * @param {Object} [deps.factories] - конструкторы (тесты).
   */
  constructor({
    signaling,
    ctx,
    hostRole,
    standby,
    membership,
    getPromotion,
    getSupervisor,
    getTokenExpiresAt,
    config,
    ui,
    factories = {},
  }) {
    this._signaling = signaling;
    this._ctx = ctx;
    this._hostRole = hostRole;
    this._standby = standby;
    this._membership = membership;
    this._getPromotion = getPromotion;
    this._getSupervisor = getSupervisor;
    this._getTokenExpiresAt = getTokenExpiresAt;
    this._config = config;
    this._ui = ui;
    this._factories = {
      plannedHandoff: options => new PlannedHandoff(options),
      healthPolicy: options => new HostHealthPolicy(options),
      tokenTimer: options => new TokenHandoffTimer(options),
      ...factories,
    };

    // создаются в bind (лобби-режим)
    this._planned = null;
    // автотриггеры передачи (этап 9b)
    this._policy = null;
    // хост: проактивная передача роли перед истечением входа (повторяется,
    // пока не начнётся или вход не истечёт)
    this._tokenHandoff = null;
    // уход уже идёт (ожидание записи очков): повторный клик ничего не делает
    this._leavingServer = false;
  }

  // передача идёт (begin → released/aborted)
  get active() {
    return this._planned?.active === true;
  }

  // хост уходит из комнаты (stay: false)
  get leaving() {
    return this._planned?.leaving === true;
  }

  // подписки сигналинга передачи (лобби-режим, один раз на страницу)
  bind() {
    const migration = this._config;

    this._planned = this._factories.plannedHandoff({
      signaling: this._signaling,
      getRoom: () => this._hostRole.room,
      getController: () => this._hostRole.controller,
      slowAfterMs: migration.handoffSlowMs,
      deadlineMs: migration.handoffDeadlineMs,
      deferMaxMs: migration.deferMaxMs,
      onSlow: () => this._ui.setHandoffMenu('slow'),
      onFrozen: () => this._onFrozen(),
      onReleased: msg => this._onReleased(msg),
      onAborted: msg => this._onAborted(msg),
      onLeave: () => this.leave(),
    });

    // автотриггеры передачи (этап 9b): перегрузка и скрытая вкладка
    this._policy = this._factories.healthPolicy({
      config: migration.auto,
      handoff: {
        start: ({ reason, defer }) => this.start({ reason, stay: true, defer }),
        hurry: reason => this._planned.hurry(reason),
        // нагрузка нормализовалась до границы раунда — передача не нужна
        cancelDeferred: () => {
          const cancelled = this._planned.cancelDeferred();

          if (cancelled) {
            this._ui.setHandoffMenu(null);
          }

          return cancelled;
        },
        deferredReason: () =>
          this._planned.deferred ? this._planned.reason : null,
      },
    });
    this._policy.setHidden(this._ui.isHidden());

    // мастер просит отдать роль: сеть хоста заметно хуже, чем у беты (этап
    // 9c). Передача ждёт границы раунда; выключенные автотриггеры — отказ
    this._signaling.publisher.on('request_handoff', msg => {
      const room = this._hostRole.room;
      const ownRoom =
        Boolean(this._hostRole.controller) &&
        msg.roomId === room?.roomId &&
        msg.epoch === room.epoch;

      // хоста сняли голосованием (этап 10): передача сразу, при любых
      // настройках автотриггеров — иначе мастер снимет его аварийно
      if (msg.reason === 'vote' && ownRoom) {
        // передача уже ждёт границы раунда — сразу, с причиной vote; уже
        // идущая — её исход решит мастер
        if (!this._planned?.hurry('vote')) {
          this.start({ reason: 'vote', stay: true, defer: false });
        }

        return;
      }

      if (
        msg.reason === 'network' &&
        migration.auto.enabled !== false &&
        ownRoom
      ) {
        this.start({
          reason: 'network',
          stay: true,
          defer: msg.defer !== false,
        });
      }
    });

    // роль отдана, а передачи эта вкладка уже не ждёт (ответ мастера опоздал
    // к дедлайну): бета заняла комнату — свой игрок возвращается к ней гостем
    this._signaling.publisher.on('host_released', msg => {
      if (
        !this._planned.active &&
        this._hostRole.controller &&
        msg.roomId === this._hostRole.room?.roomId
      ) {
        this._onReleased({ stay: true, epoch: msg.epoch });
      }
    });
  }

  /**
   * Отдать роль хоста бете без отката: «Leave server» (stay: false — затем в
   * лобби), «Hand over host» (stay: true — дальше гостем). Повторный вызов во
   * время идущей передачи игнорируется.
   *
   * defer (по умолчанию — для stay): передача ждёт границы раунда, если игра
   * не умеет продолжать посреди него (без migration.midRound мягкая точка
   * начала бы раунд у беты заново); решает Worker, потолок —
   * lobby.migration.deferMaxMs. Уходящий хост не ждёт.
   * @param {Object} options
   * @param {string} options.reason - 'leave' | 'handover' | 'overload' |
   *   'hidden' | 'network' | 'vote'.
   * @param {boolean} [options.stay]
   * @param {boolean} [options.defer]
   * @returns {boolean} передача началась.
   */
  start({ reason, stay = true, defer = stay }) {
    const controller = this._hostRole.controller;

    // промоушен сам владеет Worker'ом
    if (!this._planned || !controller || this._hostRole.promotion) {
      return false;
    }

    // эстафета, ждущая границы раунда, уступает передаче: преемник и так
    // поднимется на актуальном коде. Своп, уже переносящий состояние, — нет
    if (this._hostRole.swapInProgress && !controller.cancelPendingSwap()) {
      return false;
    }

    const started = this._planned.start({ reason, stay, defer });

    if (started) {
      this._ui.setHandoffMenu('pending');
    }

    return started;
  }

  // роль хоста снимается: идущая передача бросается
  abort() {
    this._planned?.abort();
  }

  // хост с истекающим входом не вернёт комнату reclaim_host после моргания
  // сигналинга — роль заранее уходит бете
  armTokenHandoff() {
    this._tokenHandoff ??= this._factories.tokenTimer({
      getExpiresAt: () => this._getTokenExpiresAt(),
      leadMs: this._config.tokenHandoffLeadMs,
      retryMs: this._config.tokenHandoffRetryMs,
      tryStart: () =>
        Boolean(this._hostRole.controller) &&
        this._hostRole.successorMemberId !== null &&
        this.start({ reason: 'handover', stay: true, defer: true }),
    });
    this._tokenHandoff.arm();
  }

  cancelTokenHandoff() {
    this._tokenHandoff?.cancel();
  }

  // входы автотриггеров (этап 9b)
  setHost(isHost) {
    this._policy?.setHost(isHost);
  }

  setSuccessor(available) {
    this._policy?.setSuccessor(available);
  }

  setHidden(hidden) {
    this._policy?.setHidden(hidden);
  }

  addHealth(health) {
    this._policy?.addHealth(health);
  }

  // «Leave server» из меню комнаты (этап 8.3). Хост при других людях отдаёт
  // роль бете без отката и уходит; один в комнате — закрывает её
  // (host_leaving: людей нет — мастер закрывает комнату сразу). Гость
  // снимается у хоста сразу (LEAVE), а не через resumeGraceMs
  async leaveByUser() {
    if (this._leavingServer) {
      return;
    }

    const controller = this._hostRole.controller;

    if (controller) {
      const peerCount = this._hostRole.peerCount;

      if (peerCount > 0 && this.start({ reason: 'leave', stay: false })) {
        return;
      }

      // передавать некому: очки участников иначе пропали бы вместе с
      // Worker'ом. Пока они пишутся, мастер прячет комнату и не пускает в
      // неё (host_closing) — вошедший сразу вылетел бы по закрытию
      if (peerCount === 0) {
        this._leavingServer = true;
        this._ui.showSessionOverlay('Leaving…');

        const room = this._hostRole.room;

        if (room) {
          this._signaling.hostClosing(room.roomId, room.epoch);
        }

        try {
          await controller.shutdown({
            timeoutMs: this._config.leaveFlushTimeoutMs,
          });
        } catch (e) {
          console.warn('host shutdown failed', e);
        }
      }

      // передача уже идёт (эстафета Worker'ов, промоушен) или передавать
      // некому: уход по аварийному пути мастера
      const room = this._hostRole.room;

      if (room) {
        this._signaling.hostLeaving(room.roomId, room.epoch);
      }
    } else {
      this._ui.sendLeave();
    }

    this.leave();
  }

  // гость уходит: LEAVE хосту и leave_room мастеру (best-effort — страница
  // может закрыться раньше, чем пакеты уйдут)
  announceGuestLeave() {
    this._ui.sendLeave();

    if (this._ctx.roomId) {
      this._signaling.leaveRoom(this._ctx.roomId);
    }
  }

  // уход из комнаты в лобби (не быструю игру — она вернула бы в эту же
  // комнату). Мастер освобождает место сразу; бывшему хосту leave_room
  // принимается после host_released (сессия уже не хост). Уход объявлен —
  // диалог закрытия и pagehide снимает reloadPage
  leave() {
    if (this._ctx.roomId) {
      this._signaling.leaveRoom(this._ctx.roomId);
    }

    this._membership.forget();

    this._hostRole.teardown();
    this._standby.teardown();
    this._ui.reloadPage('');
  }

  // матч заморожен до прихода нового хоста — у своего игрока та же пауза,
  // что у гостей
  _onFrozen() {
    this._ui.showSessionOverlay('Switching host…');
    this._ui.disableControls();
    this._ui.mute();
  }

  // передача не состоялась, вкладка осталась хостом: замороженный матч
  // продолжается (Worker разморожен, гостям ушла полная синхронизация)
  _onAborted({ reason, frozen }) {
    console.warn(`[handoff] not completed: ${reason}`);
    this._ui.setHandoffMenu('failed');

    const { hideOverlay, restoreInput } = controlsAfterAbort({
      frozen,
      sessionState: this._getSupervisor()?.state ?? null,
    });

    if (hideOverlay) {
      this._ui.showSessionOverlay(null);
    }

    // вкладка осталась хостом: эстафета, вытесненная передачей, нужна снова
    if (this._hostRole.codeVersion) {
      this._hostRole.refreshWorker();
    }

    // передача по сроку входа всё ещё нужна
    this._tokenHandoff?.retry();

    if (!restoreInput) {
      return;
    }

    this._ui.enableControls();

    if (!this._ui.isHidden()) {
      this._ui.unmute();
    }
  }

  // бета заняла комнату с того же тика: Worker этой вкладки больше не нужен
  _onReleased({ stay, epoch }) {
    if (!stay) {
      this.leave();
      return;
    }

    this._getPromotion().demote(epoch, { notice: false });

    // возобновление идёт под тем же оверлеем, что и пауза передачи
    if (this._getSupervisor()?.state === SESSION_STATES.reconnecting) {
      this._ui.showSessionOverlay('Switching host…');
    }
  }
}
