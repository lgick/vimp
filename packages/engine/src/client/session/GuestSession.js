import { buildSystemMessage } from '../../host/meta/modules/chat/systemMessages.js';
import {
  CHANGE_HOST_VALUES,
  CHANGE_HOST_VOTE,
  changeHostTitle,
  rejectionMessageKey,
  resultMessage,
} from '../lib/hostVoteCommand.js';
import {
  decideInvalidToken,
  decideUnknownRoom,
} from '../lib/signalingErrors.js';
import { SESSION_STATES } from '../network/SessionSupervisor.js';
import WebRtcManager from '../network/WebRtcManager.js';

// Сессия гостя комнаты (лобби-режим): вход по WebRTC и переподключение к
// текущему хосту, смена хоста (host_migrating / host_changed), закрытие
// комнаты, реконнект сигналинга с возвратом членства, голосование
// «Change host» (этап 10) и отказы мастера на сигнальные сообщения.
//
// Без DOM: сигналинг, роли, супервизор, UI-действия и фабрики инъектирует
// сборщик (client/main.js).

export default class GuestSession {
  /**
   * @param {Object} deps
   * @param {Object} deps.signaling - SignalingClient.
   * @param {Object} deps.ctx - client/session/roomContext.js.
   * @param {Object} deps.membership - client/session/Membership.js.
   * @param {Object} deps.hostRole - client/session/HostRole.js.
   * @param {Object} deps.standby - client/session/StandbyRole.js.
   * @param {Function} deps.getPromotion - () → PromotionFlow.
   * @param {Function} deps.getSupervisor - () → SessionSupervisor | null.
   * @param {Function} deps.getToken - () → identity-токен.
   * @param {Function} deps.logout - выход из лобби-авторизации.
   * @param {Object} deps.config - lobby-конфиг (webrtc, reconnect).
   * @param {Object} deps.diagnostics
   * @param {Object} deps.ui - { ensureWebRtc() → bool, showRoomLink(roomId),
   *   startSession(transport, reconnect), closeLobby(),
   *   leaveRoomWith(text), chat(message), getVote() → модуль голосования }.
   * @param {Object} [deps.factories] - конструкторы (тесты).
   * @param {Object} [deps.timers] - { setTimeout }.
   * @param {Function} [deps.now]
   */
  constructor({
    signaling,
    ctx,
    membership,
    hostRole,
    standby,
    getPromotion,
    getSupervisor,
    getToken,
    logout,
    config,
    diagnostics,
    ui,
    factories = {},
    timers = globalThis,
    now = () => Date.now(),
  }) {
    this._signaling = signaling;
    this._ctx = ctx;
    this._membership = membership;
    this._hostRole = hostRole;
    this._standby = standby;
    this._getPromotion = getPromotion;
    this._getSupervisor = getSupervisor;
    this._getToken = getToken;
    this._logout = logout;
    this._config = config;
    this._diagnostics = diagnostics;
    this._ui = ui;
    this._factories = {
      transport: (sig, options) => new WebRtcManager(sig, options),
      ...factories,
    };
    this._timers = timers;
    this._now = now;

    // WebRTC-транспорты к хосту комнаты, созданные этой сессией
    this._roomTransports = new WeakSet();
    // открытое у гостя голосование «Change host» ({ roomId, voteId }) —
    // ответ окна уходит мастеру с этим voteId
    this._hostVote = null;
  }

  get hostVote() {
    return this._hostVote;
  }

  // устанавливает P2P-соединение с текущим хостом комнаты и уходит из лобби
  connectToRoom(roomId) {
    if (!this._ui.ensureWebRtc()) {
      return;
    }

    this._ctx.roomId = roomId;
    this._ctx.entered = true;
    this._ui.showRoomLink(roomId);

    // первая попытка — обычный вход с рукопожатием, следующие (после обрыва
    // в матче) — переподключение с resume к текущему хосту той же комнаты
    this._ui.startSession(this.openTransport(roomId), this.reconnect());

    this._ui.closeLobby();
  }

  // попытки переподключения гостя: resume к текущему хосту комнаты
  reconnect() {
    return {
      createTransport: () =>
        this.openTransport(this._ctx.roomId, { resume: true }),
      getToken: () => this._getToken(),
    };
  }

  // WebRTC-попытка к текущему хосту комнаты (мастер резолвит roomId)
  openTransport(roomId, { resume = false } = {}) {
    const transport = this._factories.transport(this._signaling, {
      iceServers: this._signaling.iceServers,
      memberId: this._membership.memberId,
      resume,
      minEpoch: this._ctx.epoch,
      connectTimeoutMs: this._config.webrtc.connectTimeoutMs,
      offerRetryMs: this._config.webrtc.offerRetryMs,
    });

    this._roomTransports.add(transport);

    transport.publisher.on('open', () => {
      this._ctx.epoch = transport.epoch ?? this._ctx.epoch;
    });
    // тип ICE-кандидата — мастеру: по нему он выбирает бету (этап 6)
    transport.publisher.on('iceType', type =>
      this._membership.setIceType(type),
    );
    // канал standby открывает хост только назначенной бете
    transport.publisher.on('standby', channel => this._standby.attach(channel));
    transport.connect(roomId).catch(() => transport.close());

    return transport;
  }

  // оффер ушёл, каналы ещё не открыты: unknownRoom в этот момент —
  // комнаты нет
  offerPending() {
    const transport = this._getSupervisor()?.transport;

    return this._roomTransports.has(transport) && !transport.isOpen;
  }

  // транспорт к хосту оборвался в матче: мастер узнаёт об этом от гостя
  // раньше, чем сам (host-migration этап 7.2) — проба хоста или его смена.
  // Эпоха — хоста, к которому был транспорт: чужую мастер отбросит
  reportHostUnreachable() {
    if (
      this._ctx.roomId &&
      this._ctx.epoch !== null &&
      !this._hostRole.controller
    ) {
      this._signaling.hostUnreachable(this._ctx.roomId, this._ctx.epoch);
    }
  }

  // сигнальный WS живёт постоянно и у хоста (офферы, heartbeat), и у гостя
  // (членство в комнате): при разрыве переподключаемся с бэкоффом, а welcome
  // возвращает комнату — хост reclaim_host'ом, гость повторным join_room с
  // тем же memberId
  bind() {
    const publisher = this._signaling.publisher;
    let reconnectAttempt = 0;

    publisher.on('close', () => {
      const {
        baseDelay,
        maxDelay,
        hostFirstDelay = 0,
      } = this._config.reconnect;
      // хост: мастер держит комнату hostDisconnectGraceMs — первая попытка
      // сразу, дальше тот же бэкофф, сдвинутый на одну ступень
      const isHost = Boolean(this._hostRole.controller);
      const delay =
        isHost && reconnectAttempt === 0
          ? hostFirstDelay
          : Math.min(
              maxDelay,
              baseDelay *
                2 ** (isHost ? reconnectAttempt - 1 : reconnectAttempt),
            );

      reconnectAttempt += 1;
      this._timers.setTimeout(() => this._signaling.connect(), delay);
    });

    publisher.on('welcome', () => {
      reconnectAttempt = 0;

      if (this._hostRole.controller) {
        this._hostRole.reRegister();
      } else if (this._ctx.roomId && this._ctx.memberJoined) {
        this._membership.sendJoinRoom();
      }
    });

    // смена хоста комнаты (host-migration этап 7.2): старый транспорт
    // закрывается сразу, ждём host_changed. Хост этой вкладки сообщения не
    // получает (его ждёт host_revoked)
    publisher.on('host_migrating', msg => {
      if (
        !this._ownRoom(msg) ||
        this._hostRole.controller ||
        (this._ctx.epoch !== null && msg.epoch <= this._ctx.epoch)
      ) {
        return;
      }

      const supervisor = this._getSupervisor();

      // повтор той же эпохи — следующий кандидат: ждать дольше (waitMs)
      if (supervisor?.state === SESSION_STATES.migrating) {
        supervisor.extendMigration(msg.waitMs);
      } else {
        supervisor?.migrate({ waitMs: msg.waitMs });
      }
    });

    // у комнаты новый хост (или прежний вернулся — reclaimed, та же эпоха):
    // возобновление у него, cold — перезагрузка в комнату
    publisher.on('host_changed', msg => {
      if (
        !this._ownRoom(msg) ||
        this._hostRole.controller ||
        (this._ctx.epoch !== null && msg.epoch < this._ctx.epoch)
      ) {
        return;
      }

      // ответы прежних эпох попыткам возобновления чужие
      this._ctx.epoch = msg.epoch;
      this._getSupervisor()?.hostChanged({ mode: msg.mode });
    });

    publisher.on('room_closed', msg => {
      if (!this._ownRoom(msg)) {
        return;
      }

      this._membership.stopJoinRetry();

      // быстрее, чем ждать падения WebRTC; причина важнее общего текста
      // handleDisconnect
      this._ui.leaveRoomWith(
        'The host left — the room is closed. Finding another room…',
      );
    });

    // мастер принял членство — повторы join_room больше не нужны
    publisher.on('room_joined', msg => {
      if (msg.roomId === this._ctx.roomId) {
        this._membership.stopJoinRetry();
      }
    });

    publisher.on('error', msg => this.handleSignalingError(msg));

    this._bindHostVote();
  }

  // отказы мастера на сигнальные сообщения
  handleSignalingError(msg = {}) {
    const { code, reason } = msg;
    const hostRole = this._hostRole;

    switch (code) {
      // мастер не начал голосование «Change host» (этап 10)
      case 'voteRejected':
      case 'noSuccessor':
        this._ui.chat(
          buildSystemMessage(rejectionMessageKey({ code, reason })),
        );
        break;

      // запрос ушёл в комнату, которой уже нет
      case 'unknownRoom': {
        const action = decideUnknownRoom({
          msg,
          currentRoomId: this._ctx.roomId,
          promoting: Boolean(hostRole.promotion),
          sessionState: this._getSupervisor()?.state ?? null,
          offerPending: this.offerPending(),
          memberJoined: this._ctx.memberJoined,
          isHost: Boolean(hostRole.controller),
        });

        if (action === 'abandonPromotion') {
          this._getPromotion().abandon({ code, report: true });
        } else if (action === 'retryJoin') {
          this._membership.scheduleJoinRetry();
        } else if (action === 'leave') {
          this._ui.leaveRoomWith(
            'Room no longer exists. Finding another room…',
          );
        }
        break;
      }

      // memberId вкладки (randomUUID) занят другим пользователем — честная
      // вкладка сюда не попадает; только в журнал
      case 'memberTaken':
        console.warn('join_room rejected: memberTaken', msg.roomId);
        break;

      // токен истёк или отозван: решение — по запросу, на который отказ
      case 'invalidToken': {
        const action = decideInvalidToken({
          msg,
          promoting: Boolean(hostRole.promotion),
          inRoom: Boolean(this._ctx.roomId),
          sessionState: this._getSupervisor()?.state ?? null,
        });

        if (action === 'abandonPromotion') {
          this._getPromotion().abandon({ code, report: true });
        } else if (action === 'keepPlaying') {
          // P2P-матчу токен не нужен; без нового текста в UI (системные
          // сообщения — только кодами, тексты в играх)
          this._diagnostics.warn(
            'engine.session.tokenExpired',
            { re: msg.re },
            { source: 'client' },
          );
          this._membership.stopJoinRetry();
        } else {
          this._logout();

          if (action === 'logoutAndLeave') {
            this._ui.leaveRoomWith(
              'Your session has expired — please sign in again.',
            );
          }
        }
        break;
      }

      // с этого адреса уже хостится другая комната
      case 'hostLimit':
        if (hostRole.controller) {
          // быстрая игра подняла бы комнату снова и упёрлась бы в тот же
          // лимит — уход на главную, как при несостоявшемся старте
          this._ctx.startFailed = true;
          this._ui.leaveRoomWith(
            'Another room is already hosted from your network — this room is ' +
              'closed. Click to return to the lobby.',
          );
        }
        break;

      // прежнюю комнату вернуть нельзя (id занят или секрет не принят —
      // dev-мастер без VIMP_ROOM_SECRET_KEY после рестарта): новая
      // регистрация
      case 'roomTaken':
      case 'invalidRoomSecret':
        if (hostRole.controller) {
          hostRole.reRegister({ fresh: true });
        }
        break;

      // хоста комнаты уже сменили (host-migration этап 7.5): преемник
      // опоздал — роль снимается; бывший хост вернулся после смены — он
      // гость новой эпохи
      case 'staleEpoch':
        if (hostRole.promotion) {
          this._getPromotion().abandon({ code, report: true });
        } else if (hostRole.controller && hostRole.room) {
          this._getPromotion().demote(hostRole.room.epoch + 1);
        }
        break;

      // promotionToken не принят (промоушен отменён, кандидат сменился)
      case 'invalidPromotion':
        if (hostRole.promotion) {
          this._getPromotion().abandon({ code, report: true });
        }
        break;
    }
  }

  _ownRoom(msg) {
    return Boolean(this._ctx.roomId) && msg.roomId === this._ctx.roomId;
  }

  // голосование «Change host» (этап 10): окно у гостей, кроме инициатора;
  // хосту мастер его не шлёт
  _bindHostVote() {
    const publisher = this._signaling.publisher;

    publisher.on('host_vote', msg => {
      if (!this._ownRoom(msg) || this._hostRole.controller) {
        return;
      }

      this._hostVote = { roomId: msg.roomId, voteId: msg.voteId };
      this._ui.getVote()?.openEngineVote({
        name: CHANGE_HOST_VOTE,
        title: changeHostTitle(msg.initiatorNick),
        values: CHANGE_HOST_VALUES,
        // часы мастера и вкладки расходятся — окно считается от прихода
        deadline: this._now() + msg.durationMs,
      });
    });

    // своё голосование началось — как у голосований хоста
    publisher.on('host_vote_started', msg => {
      if (this._ownRoom(msg)) {
        this._ui.chat(buildSystemMessage('VOTE_STARTED'));
      }
    });

    // свой ответ в окне «Change host?» засчитан — как у голосований хоста
    publisher.on('host_vote_accepted', msg => {
      if (this._ownRoom(msg)) {
        this._ui.chat(buildSystemMessage('VOTE_ACCEPTED'));
      }
    });

    publisher.on('host_vote_result', msg => {
      if (!this._ownRoom(msg)) {
        return;
      }

      if (this._hostVote?.voteId === msg.voteId) {
        this._hostVote = null;
        this._ui.getVote()?.closeEngineVote(CHANGE_HOST_VOTE);
      }

      const { key, params } = resultMessage(msg);

      this._ui.chat(buildSystemMessage(key, params));
    });
  }
}
