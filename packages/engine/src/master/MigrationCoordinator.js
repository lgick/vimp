import crypto from 'crypto';
import { pickSuccessor } from './successor.js';

// host_unreachable от одного участника — не чаще (этап 7.3)
const REPORT_MIN_INTERVAL_MS = 2000;

// promotionToken — 128 бит в hex. Формат проверяется до timingSafeEqual:
// тот бросает на буферах разной длины в байтах (не-ASCII строка той же
// длины в символах), а promote_failed приходит синхронно от любой сессии
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

// автоматические причины смены хоста (этап 9): их успешная смена ставит
// room.lastAutoMigrationAt — общий кулдаун правила лага
const AUTO_REASONS = ['overload', 'hidden', 'network'];

// причины плановой передачи (этапы 8–10); незнакомая считается handover —
// страница новее мастера не должна терять кнопку
const PLANNED_REASONS = ['leave', 'handover', 'vote', ...AUTO_REASONS];

// host_health приходит раз в 2 с; пауза дольше (матч заморожен, хост
// старый) рвёт «непрерывность» лага
const HEALTH_GAP_MS = 5000;

const tokensEqual = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  TOKEN_PATTERN.test(a) &&
  TOKEN_PATTERN.test(b) &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Миграция хоста. Аварийная (host-migration этап 7): машина состояний
// комнаты online(N) → migrating(N → N+1) → online(N+1). Хост потерян —
// мастер повышает преемника: бету со свежей контрольной точкой (checkpoint)
// или любого способного участника (cold); кандидатов нет — комната
// закрывается. Плановая (этап 8): online(N) → handing_off(N → N+1) →
// online(N+1) — хост жив и сам отдаёт бете финальную точку; сбой
// возвращает комнату в online(N), хост теряет связь посреди передачи —
// передача становится аварийной миграцией. Отдельно от SignalingServer, чтобы не раздувать его: сигналинг
// зовёт coordinator на событиях и даёт ему доступ к сессиям через колбэки.
// Состояние, переживающее попытки, лежит в комнате реестра; таймеры — здесь.
export default class MigrationCoordinator {
  /**
   * @param {Object} deps
   * @param {Object} deps.registry - RoomRegistry.
   * @param {Function} deps.send - (sessionId, message) отправка сессии.
   * @param {Function} deps.hasSession - (sessionId) жива ли сессия.
   * @param {Function} deps.hostSessionId - (roomId) id сессии текущего
   *   хоста или null.
   * @param {Function} deps.unbindHost - (roomId) сессия хоста больше не
   *   хост комнаты (её ответы/кандидаты игнорируются), участником остаётся.
   * @param {Function} deps.closeRoom - (room, reason) room_closed участникам
   *   и удаление комнаты.
   * @param {Function} deps.scoreOf - (sessionId) линейка связности.
   * @param {Object} deps.successorOptions - опции pickSuccessor.
   * @param {Object} [deps.timings] - пороги master.room.* (этап 7.8).
   * @param {Function} [deps.onTransition] - (room) хост комнаты начал
   *   меняться (этап 10: идущее голосование «Change host» отменяется).
   */
  constructor(deps) {
    this._registry = deps.registry;
    this._send = deps.send;
    this._hasSession = deps.hasSession;
    this._hostSessionId = deps.hostSessionId;
    this._unbindHost = deps.unbindHost;
    this._closeRoom = deps.closeRoom;
    this._scoreOf = deps.scoreOf;
    this._successorOptions = deps.successorOptions;
    this._onTransition = deps.onTransition ?? (() => {});
    this._now = deps.now ?? (() => Date.now());
    this._randomBytes = deps.randomBytes ?? crypto.randomBytes;
    this._setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);

        timer.unref?.();

        return timer;
      });
    this._clearTimer = deps.clearTimer ?? (timer => clearTimeout(timer));

    this._timings = {
      checkpointMaxAgeMs: 12000,
      promotionTimeoutMs: 10000,
      coldPromotionTimeoutMs: 25000,
      probeTimeoutMs: 2000,
      reportWindowMs: 5000,
      forcedMigrationCooldownMs: 30000,
      handoffTimeoutMs: 8000,
      lagRttThresholdMs: 250,
      lagSustainMs: 10000,
      lagImprovementRatio: 0.35,
      autoMigrationCooldownMs: 90000,
      ...deps.timings,
    };

    // roomId -> таймер дедлайна промоушена
    this._promotionTimers = new Map();
    // roomId -> { nonce, timer } — проба хоста в полёте
    this._probes = new Map();
    // roomId -> время последнего probe_ack
    this._lastAckAt = new Map();
  }

  isMigrating(room) {
    return room?.status === 'migrating';
  }

  isHandingOff(room) {
    return room?.status === 'handing_off';
  }

  // хост сменяется (аварийно или планово): преемник может занять комнату
  inTransition(room) {
    return this.isMigrating(room) || this.isHandingOff(room);
  }

  /**
   * Хост потерян: комната уходит в migrating или закрывается.
   * @param {Object} room
   * @param {string} reason - 'disconnected' | 'timeout' | 'unresponsive' |
   *   'unreachable' | 'leaving' (этап 8: host_leaving из pagehide).
   * @param {Object} [options]
   * @param {boolean} [options.keepIfNoCandidate] - кандидатов нет — комнату
   *   не трогать: хост ещё может быть жив (обрыв одного сигналинга —
   *   ждёт reclaim_host в grace уборки; принудительная миграция — хост
   *   остаётся). Без флага (уборка) комната закрывается.
   * @returns {boolean} комната ушла в миграцию.
   */
  hostLost(room, reason, { keepIfNoCandidate = false } = {}) {
    if (!room || this.isMigrating(room)) {
      return false;
    }

    if (this.isHandingOff(room)) {
      this._degradeHandoff(room);
      return true;
    }

    this._cancelProbe(room.roomId);

    const now = this._now();
    const people = this._registry
      .liveMembers(room.roomId, now)
      .filter(member => member.memberId !== room.host.memberId);

    // людей нет — мигрировать некому и незачем
    if (people.length === 0) {
      this._closeRoom(room, 'noHost');
      this.forget(room.roomId);
      return false;
    }

    const hasCandidate =
      this._pickCandidate(room, now, {
        oldHostMemberId: room.host.memberId,
        tried: [],
      }) !== null;

    if (!hasCandidate) {
      if (!keepIfNoCandidate) {
        this._closeRoom(room, 'noHost');
        this.forget(room.roomId);
      }

      return false;
    }

    room.status = 'migrating';
    room.pendingEpoch = room.epoch + 1;
    room.migration = {
      reason,
      oldHostMemberId: room.host.memberId,
      oldHostSessionId: room.host.sessionId,
      tried: [],
      candidateMemberId: null,
      candidateUserId: null,
      promotionToken: null,
      mode: null,
      startedAt: this._now(),
    };

    // хост, ещё державший сессию (молчание heartbeat, принудительная
    // миграция), перестаёт быть хостом комнаты сразу: его ответы и кандидаты
    // игнорируются, участником он остаётся
    this._unbindHost(room.roomId);
    this._onTransition(room);

    this._broadcast(
      room,
      {
        type: 'host_migrating',
        roomId: room.roomId,
        epoch: room.pendingEpoch,
        reason,
      },
      [room.host.memberId],
    );

    this._promoteNext(room);

    return true;
  }

  /**
   * Есть ли кому принять комнату, если хоста снять сейчас (этап 10:
   * голосование без кандидата бессмысленно).
   * @param {Object} room
   * @returns {boolean}
   */
  hasCandidate(room) {
    return (
      this._pickCandidate(room, this._now(), {
        oldHostMemberId: room.host.memberId,
        tried: [],
      }) !== null
    );
  }

  /**
   * Снять живого хоста аварийным путём (этап 10: прошедшее голосование, а
   * хост роль не отдал). Кулдаун принудительных миграций не действует —
   * решение приняли игроки, а не отчёты сети.
   * @param {Object} room
   * @param {string} reason
   * @returns {boolean} комната ушла в миграцию.
   */
  forceHostChange(room, reason) {
    // принять некому — хост остаётся, комната живёт (hostLost без
    // кандидатов закрыл бы комнату живого хоста)
    if (!this.hasCandidate(room)) {
      return false;
    }

    return this.hostLost(room, reason, { keepIfNoCandidate: true });
  }

  // следующий кандидат: сначала бета со свежей точкой, затем cold
  _promoteNext(room) {
    const migration = room.migration;
    const now = this._now();
    const next = this._pickCandidate(room, now, migration);

    if (!next) {
      this._closeRoom(room, 'noHost');
      this.forget(room.roomId);
      return;
    }

    migration.candidateMemberId = next.member.memberId;
    migration.candidateUserId = next.member.userId;
    migration.mode = next.mode;
    migration.promotionToken = this._randomBytes(16).toString('hex');
    migration.tried.push(next.member.memberId);

    this._send(next.member.sessionId, {
      type: 'promote',
      roomId: room.roomId,
      epoch: room.pendingEpoch,
      promotionToken: migration.promotionToken,
      mode: next.mode,
      reason: migration.reason,
      settings: room.settings,
    });

    const timeout =
      next.mode === 'cold'
        ? this._timings.coldPromotionTimeoutMs
        : this._timings.promotionTimeoutMs;

    this._clearPromotionTimer(room.roomId);
    this._promotionTimers.set(
      room.roomId,
      this._setTimer(() => this._onPromotionTimeout(room.roomId), timeout),
    );
  }

  // migration — { oldHostMemberId, tried }: текущая попытка или черновик
  // (проверка «есть ли кандидат» до старта миграции)
  _pickCandidate(room, now, migration) {
    const live = member =>
      member.sessionId !== null && this._hasSession(member.sessionId);
    const untried = member =>
      member.memberId !== migration.oldHostMemberId &&
      !migration.tried.includes(member.memberId);

    // первая попытка — назначенная бета, если её поток точек жив
    const beta = room.members.get(room.successorMemberId);
    const standby = room.standby;

    if (
      migration.tried.length === 0 &&
      beta &&
      live(beta) &&
      untried(beta) &&
      standby?.memberId === beta.memberId &&
      now - standby.receivedAt <= this._timings.checkpointMaxAgeMs
    ) {
      return { member: beta, mode: 'checkpoint' };
    }

    const members = [...room.members.values()].filter(untried).map(member => ({
      ...member,
      live: live(member),
      score: this._scoreOf(member.sessionId),
    }));
    const { successorMemberId } = pickSuccessor(
      {
        hostMemberId: migration.oldHostMemberId,
        successorMemberId: null,
        challenger: null,
        members,
      },
      now,
      // в аварии берём любого способного, и со скрытой вкладкой
      { ...this._successorOptions, allowHidden: true },
    );

    const member = room.members.get(successorMemberId);

    if (member) {
      return { member, mode: 'cold' };
    }

    // способны только смещённые голосованием (этап 10) — комната важнее
    // их отстранения
    if (members.some(candidate => candidate.demotedUntil > now)) {
      const fallback = pickSuccessor(
        {
          hostMemberId: migration.oldHostMemberId,
          successorMemberId: null,
          challenger: null,
          members: members.map(candidate => ({
            ...candidate,
            demotedUntil: null,
          })),
        },
        now,
        { ...this._successorOptions, allowHidden: true },
      ).successorMemberId;

      if (fallback) {
        return { member: room.members.get(fallback), mode: 'cold' };
      }
    }

    return null;
  }

  _onPromotionTimeout(roomId) {
    this._promotionTimers.delete(roomId);

    const room = this._registry.get(roomId);

    if (this.isHandingOff(room)) {
      this._abortHandoff(room);
      return;
    }

    if (this.isMigrating(room)) {
      this._abandonCandidate(room);
      this._promoteNext(room);
    }
  }

  // кандидат не справился (таймаут/promote_failed): его промоушен отменён —
  // опоздавший register_host с этим токеном уже не пройдёт
  _abandonCandidate(room) {
    const { migration } = room;
    const candidate = room.members.get(migration.candidateMemberId);

    if (candidate) {
      this._send(candidate.sessionId, {
        type: 'promote_cancelled',
        roomId: room.roomId,
        epoch: room.pendingEpoch,
      });
    }

    migration.promotionToken = null;
  }

  /**
   * Проверка register_host преемника.
   * @returns {{ ok: true } | { ok: false, code: string }}
   */
  checkPromotion(room, { epoch, promotionToken, userId }) {
    if (!room) {
      return { ok: false, code: 'unknownRoom' };
    }

    if (
      !this.inTransition(room) ||
      !Number.isInteger(epoch) ||
      epoch < room.pendingEpoch
    ) {
      return { ok: false, code: 'staleEpoch' };
    }

    const { migration } = room;

    if (
      epoch !== room.pendingEpoch ||
      !tokensEqual(promotionToken, migration.promotionToken) ||
      userId !== migration.candidateUserId
    ) {
      return { ok: false, code: 'invalidPromotion' };
    }

    return { ok: true };
  }

  /**
   * Преемник занял комнату (реестр уже переключён): остальным участникам
   * host_changed, старому хосту — host_revoked (плановая передача —
   * host_released: роль он отдал сам).
   * @param {Object} room
   * @param {Object} previous - { migration } — описание миграции до
   *   переключения реестра.
   */
  completePromotion(room, { migration }) {
    this.forget(room.roomId);

    if (AUTO_REASONS.includes(migration.reason)) {
      room.lastAutoMigrationAt = this._now();
    }

    if (
      migration.oldHostSessionId &&
      this._hasSession(migration.oldHostSessionId)
    ) {
      this._send(migration.oldHostSessionId, {
        type: migration.planned ? 'host_released' : 'host_revoked',
        roomId: room.roomId,
        epoch: room.epoch,
      });
    }

    this._broadcast(
      room,
      {
        type: 'host_changed',
        roomId: room.roomId,
        epoch: room.epoch,
        mode: migration.mode,
        reason: migration.reason,
      },
      [room.host.memberId, migration.oldHostMemberId],
    );
  }

  // можно ли отменить миграцию возвратом хоста (reclaim_host)
  canCancelByReclaim(room) {
    return room.migration?.reason === 'disconnected' && !room.migration.planned;
  }

  /**
   * reclaim_host старого хоста во время миграции. Обрыв одного сигналинга
   * (reason 'disconnected') отменяет миграцию: клиенты возобновляются к тому
   * же хосту. Принудительную (хост на связи, но недоступен игрокам) хост
   * отменить не может.
   * @returns {boolean} миграция отменена — reclaim продолжается.
   */
  cancelByReclaim(room) {
    if (!this.canCancelByReclaim(room)) {
      return false;
    }

    const { migration } = room;

    this._abandonCandidate(room);
    this.forget(room.roomId);

    room.status = 'online';
    room.pendingEpoch = null;
    room.migration = null;

    this._broadcast(
      room,
      {
        type: 'host_changed',
        roomId: room.roomId,
        epoch: room.epoch,
        mode: 'reclaimed',
        reason: migration.reason,
      },
      [migration.oldHostMemberId],
    );

    return true;
  }

  /**
   * promote_failed {roomId, epoch, promotionToken} от текущего кандидата.
   * После холодной перезагрузки страница кандидата — уже не участник
   * комнаты (новый memberId), её узнают по токену.
   */
  onPromoteFailed(room, { memberId, epoch, promotionToken }) {
    if (
      !this.inTransition(room) ||
      epoch !== room.pendingEpoch ||
      (memberId !== room.migration.candidateMemberId &&
        !tokensEqual(promotionToken, room.migration.promotionToken))
    ) {
      return;
    }

    this._clearPromotionTimer(room.roomId);

    if (this.isHandingOff(room)) {
      this._abortHandoff(room);
      return;
    }

    this._abandonCandidate(room);
    this._promoteNext(room);
  }

  /**
   * WS участника закрылся во время миграции. Кандидат `checkpoint` ушёл —
   * сразу следующий (хост и бета закрыты разом: мёртвого кандидата не ждут
   * promotionTimeoutMs). Кандидат `cold` закрывает WS сам — он
   * перезагружает страницу, его ждёт coldPromotionTimeoutMs.
   */
  onMemberGone(room, memberId) {
    if (
      !this.inTransition(room) ||
      room.migration.mode === 'cold' ||
      memberId !== room.migration.candidateMemberId
    ) {
      return;
    }

    this._clearPromotionTimer(room.roomId);

    // бета ушла посреди плановой передачи — хост жив, матч продолжается
    if (this.isHandingOff(room)) {
      this._abortHandoff(room);
      return;
    }

    this._abandonCandidate(room);
    this._promoteNext(room);
  }

  // ***** плановая передача (этап 8) ***** //

  /**
   * handoff_begin {roomId, epoch, reason} от текущего хоста комнаты: хост
   * отдаёт роль бете без отката. Хосту — handoff_go {epoch: N+1} (заморозить
   * матч и отправить бете финальную точку) или handoff_unavailable {reason}.
   * @param {Object} room - комната, которую хостит отправитель.
   * @param {Object} msg - { epoch, reason }.
   * @returns {boolean} передача началась.
   */
  beginHandoff(room, { epoch, reason }) {
    const hostSessionId = room.host.sessionId;
    const refuse = why => {
      this._send(hostSessionId, {
        type: 'handoff_unavailable',
        roomId: room.roomId,
        epoch: room.epoch,
        reason: why,
      });

      return false;
    };

    if (room.status !== 'online') {
      return refuse('busy');
    }

    if (epoch !== room.epoch) {
      return refuse('staleEpoch');
    }

    // финальная точка идёт по каналу standby: бета с живым потоком точек —
    // единственный, кто продолжит матч с того же тика
    const now = this._now();
    const beta = this._readyBeta(room, now);

    if (!beta) {
      return refuse('noSuccessor');
    }

    // хоста этой эпохи сняли голосованием (этап 10): передача — причина
    // vote, какую бы ни прислала его страница
    const votedOut = room.votedOutEpoch === room.epoch;
    const plannedReason = votedOut
      ? 'vote'
      : PLANNED_REASONS.includes(reason)
        ? reason
        : 'handover';

    this._cancelProbe(room.roomId);

    room.status = 'handing_off';
    this._onTransition(room);
    room.pendingEpoch = room.epoch + 1;
    room.migration = {
      reason: plannedReason,
      planned: true,
      oldHostMemberId: room.host.memberId,
      oldHostSessionId: hostSessionId,
      tried: [beta.memberId],
      candidateMemberId: beta.memberId,
      candidateUserId: beta.userId,
      promotionToken: this._randomBytes(16).toString('hex'),
      mode: 'planned',
      startedAt: now,
    };

    this._send(hostSessionId, {
      type: 'handoff_go',
      roomId: room.roomId,
      epoch: room.pendingEpoch,
    });

    this._send(beta.sessionId, {
      type: 'promote',
      roomId: room.roomId,
      epoch: room.pendingEpoch,
      promotionToken: room.migration.promotionToken,
      mode: 'planned',
      reason: plannedReason,
      settings: room.settings,
    });

    this._broadcast(
      room,
      {
        type: 'host_migrating',
        roomId: room.roomId,
        epoch: room.pendingEpoch,
        reason: plannedReason,
      },
      [room.host.memberId],
    );

    this._clearPromotionTimer(room.roomId);
    this._promotionTimers.set(
      room.roomId,
      this._setTimer(
        () => this._onPromotionTimeout(room.roomId),
        this._timings.handoffTimeoutMs,
      ),
    );

    return true;
  }

  // бета, способная принять плановую передачу: живая сессия и свежий поток
  // точек; null — такой нет
  _readyBeta(room, now) {
    const beta = room.members.get(room.successorMemberId);

    if (
      !beta ||
      beta.memberId === room.host.memberId ||
      beta.sessionId === null ||
      !this._hasSession(beta.sessionId) ||
      room.standby?.memberId !== beta.memberId ||
      now - room.standby.receivedAt > this._timings.checkpointMaxAgeMs
    ) {
      return null;
    }

    return beta;
  }

  // ***** сетевой лаг хоста (этап 9c) ***** //

  /**
   * host_health {roomId, epoch, tickRate, peerRttMedian, peerCount} от хоста
   * комнаты (раз в ~2 с). Хост не видит, лучше ли бета, — сравнивает мастер
   * по единой линейке score: медиана RTT хоста до гостей выше
   * lagRttThresholdMs непрерывно lagSustainMs, score беты хотя бы на
   * lagImprovementRatio лучше score хоста, с прошлой авто-смены в комнате и
   * с получения роли прошло autoMigrationCooldownMs → хосту request_handoff
   * (network, отложенная до границы раунда). Хоста, не выполнившего просьбу,
   * мастер не наказывает: это может быть старый клиент.
   * @param {Object} room - комната, которую хостит отправитель.
   * @param {Object} msg - { epoch, peerRttMedian, peerCount }.
   */
  onHostHealth(room, { epoch, peerRttMedian, peerCount }) {
    if (!room || epoch !== room.epoch || room.status !== 'online') {
      return;
    }

    const now = this._now();
    const timings = this._timings;
    const lagging =
      Number.isFinite(peerRttMedian) &&
      Number.isInteger(peerCount) &&
      peerCount >= 1 &&
      peerRttMedian > timings.lagRttThresholdMs;

    if (!lagging) {
      room.lag = null;
      return;
    }

    if (room.lag === null || now - room.lag.lastAt > HEALTH_GAP_MS) {
      room.lag = { since: now, lastAt: now };
      return;
    }

    room.lag.lastAt = now;

    if (now - room.lag.since < timings.lagSustainMs) {
      return;
    }

    const since = at =>
      at === null || now - at >= timings.autoMigrationCooldownMs;
    const cooled =
      since(room.hostSince) &&
      since(room.lastAutoMigrationAt) &&
      since(room.lastLagHandoffFailedAt);
    const beta = cooled ? this._readyBeta(room, now) : null;

    if (!beta) {
      return;
    }

    const hostScore = this._scoreOf(room.host.sessionId);
    const betaScore = this._scoreOf(beta.sessionId);

    if (
      !Number.isFinite(hostScore) ||
      !Number.isFinite(betaScore) ||
      betaScore > (1 - timings.lagImprovementRatio) * hostScore
    ) {
      return;
    }

    // повтор (хост не выполнил просьбу) — не раньше нового окна лага
    room.lag = null;

    this._send(room.host.sessionId, {
      type: 'request_handoff',
      roomId: room.roomId,
      epoch: room.epoch,
      reason: 'network',
      defer: true,
    });
  }

  /**
   * host_leaving {roomId, epoch} из pagehide хоста: вкладка закрывается —
   * аварийная миграция сразу, без ожидания обрыва WS.
   */
  onHostLeaving(room, epoch) {
    if (!room || epoch !== room.epoch || this.isMigrating(room)) {
      return;
    }

    this.hostLost(room, 'leaving');
  }

  // преемник не занял комнату, отказал или ушёл: комната возвращается в
  // online(N) — эпоха растёт только при успешной смене хоста. Гостям —
  // host_changed reclaimed: они уже бросили транспорт к хосту по
  // host_migrating и возобновляются к нему же
  _abortHandoff(room) {
    const { migration } = room;

    // сорванная сетевая передача (бета не справилась) — правило лага не
    // повторяет её раньше кулдауна: иначе матч замирал бы раз в ~20 с
    if (migration.reason === 'network') {
      room.lastLagHandoffFailedAt = this._now();
    }

    this._clearPromotionTimer(room.roomId);
    this._abandonCandidate(room);

    room.status = 'online';
    room.pendingEpoch = null;
    room.migration = null;

    this._send(migration.oldHostSessionId, {
      type: 'handoff_aborted',
      roomId: room.roomId,
      epoch: room.epoch,
    });

    // хоста сняли голосованием (этап 10): сорванная передача не
    // возвращает ему роль — гости, уже ждущие смены, получают аварийную
    // миграцию (откат к точке беты или cold); кандидатов нет — хост остаётся
    if (
      room.votedOutEpoch === room.epoch &&
      this.forceHostChange(room, 'vote')
    ) {
      return;
    }

    this._broadcast(
      room,
      {
        type: 'host_changed',
        roomId: room.roomId,
        epoch: room.epoch,
        mode: 'reclaimed',
        reason: migration.reason,
      },
      [migration.oldHostMemberId],
    );
  }

  // хост пропал посреди передачи (вкладка закрыта, WS оборвался): бета уже
  // повышена — дальше это аварийная миграция с тем же кандидатом; его сбой
  // ведёт к следующему, а не к отмене. Повторный promote (та же эпоха и
  // токен, mode checkpoint) говорит бете: финальной точки не будет, бери
  // последнюю периодическую сразу, не дожидаясь finalWaitMs
  _degradeHandoff(room) {
    const { migration } = room;
    const candidate = room.members.get(migration.candidateMemberId);

    room.status = 'migrating';
    migration.planned = false;
    migration.mode = 'checkpoint';
    this._unbindHost(room.roomId);

    if (candidate) {
      this._send(candidate.sessionId, {
        type: 'promote',
        roomId: room.roomId,
        epoch: room.pendingEpoch,
        promotionToken: migration.promotionToken,
        mode: 'checkpoint',
        reason: migration.reason,
        settings: room.settings,
      });
    }

    this._clearPromotionTimer(room.roomId);
    this._promotionTimers.set(
      room.roomId,
      this._setTimer(
        () => this._onPromotionTimeout(room.roomId),
        this._timings.promotionTimeoutMs,
      ),
    );
  }

  // ***** отчёты клиентов и проба хоста (этап 7.3) ***** //

  /**
   * host_unreachable {roomId, epoch} от участника комнаты.
   * @param {Object} room
   * @param {string} memberId
   * @param {number} epoch
   */
  onUnreachable(room, memberId, epoch) {
    if (
      !room ||
      room.status !== 'online' ||
      epoch !== room.epoch ||
      memberId === room.host.memberId ||
      !room.members.has(memberId)
    ) {
      return;
    }

    const now = this._now();
    const last = room.reports.get(memberId);

    if (last !== undefined && now - last < REPORT_MIN_INTERVAL_MS) {
      return;
    }

    room.reports.set(memberId, now);

    // сигналинг хоста уже потерян — свидетельства гостя достаточно
    if (!this._hostSessionId(room.roomId)) {
      this.hostLost(room, 'disconnected', { keepIfNoCandidate: true });
      return;
    }

    if (this._probes.has(room.roomId)) {
      return; // ответ пробы решит
    }

    const lastAck = this._lastAckAt.get(room.roomId);

    if (lastAck !== undefined && now - lastAck < this._timings.reportWindowMs) {
      this._checkQuorum(room);
      return;
    }

    this._sendProbe(room);
  }

  _sendProbe(room) {
    const nonce = this._randomBytes(8).toString('hex');
    const timer = this._setTimer(
      () => this._onProbeTimeout(room.roomId, nonce),
      this._timings.probeTimeoutMs,
    );

    this._probes.set(room.roomId, { nonce, timer });
    this._send(this._hostSessionId(room.roomId), {
      type: 'probe',
      roomId: room.roomId,
      nonce,
    });
  }

  _onProbeTimeout(roomId, nonce) {
    if (this._probes.get(roomId)?.nonce !== nonce) {
      return;
    }

    this._probes.delete(roomId);

    const room = this._registry.get(roomId);

    if (room?.status === 'online') {
      this._forceMigration(room, 'unresponsive');
    }
  }

  /**
   * probe_ack {nonce} от сессии хоста комнаты.
   */
  onProbeAck(room, nonce) {
    const probe = this._probes.get(room?.roomId);

    if (!probe || probe.nonce !== nonce) {
      return;
    }

    this._clearTimer(probe.timer);
    this._probes.delete(room.roomId);
    this._lastAckAt.set(room.roomId, this._now());
    this._checkQuorum(room);
  }

  // хост отвечает мастеру, но до него не достучалась половина гостей —
  // сломана его P2P-сторона
  _checkQuorum(room) {
    const now = this._now();

    for (const [memberId, at] of room.reports) {
      if (now - at >= this._timings.reportWindowMs) {
        room.reports.delete(memberId);
      }
    }

    const guests = [...room.members.values()].filter(
      member =>
        member.memberId !== room.host.memberId &&
        member.sessionId !== null &&
        this._hasSession(member.sessionId),
    ).length;
    const quorum = Math.max(1, Math.ceil(guests / 2));

    if (room.reports.size >= quorum) {
      this._forceMigration(room, 'unreachable');
    }
  }

  // миграция по отчётам/пробе при живом WS хоста — анти-флаппинг кулдауном
  _forceMigration(room, reason) {
    const now = this._now();

    if (
      room.lastForcedMigrationAt !== null &&
      now - room.lastForcedMigrationAt < this._timings.forcedMigrationCooldownMs
    ) {
      return;
    }

    // кандидатов нет — хост, отвечающий мастеру, лучше закрытой комнаты
    if (this.hostLost(room, reason, { keepIfNoCandidate: true })) {
      room.lastForcedMigrationAt = now;
    }
  }

  // ***** служебное ***** //

  // сообщение всем подключённым участникам, кроме перечисленных memberId
  _broadcast(room, message, exceptMemberIds = []) {
    for (const member of room.members.values()) {
      if (
        !exceptMemberIds.includes(member.memberId) &&
        member.sessionId !== null &&
        this._hasSession(member.sessionId)
      ) {
        this._send(member.sessionId, message);
      }
    }
  }

  _cancelProbe(roomId) {
    const probe = this._probes.get(roomId);

    if (probe) {
      this._clearTimer(probe.timer);
      this._probes.delete(roomId);
    }
  }

  _clearPromotionTimer(roomId) {
    const timer = this._promotionTimers.get(roomId);

    if (timer !== undefined) {
      this._clearTimer(timer);
      this._promotionTimers.delete(roomId);
    }
  }

  // комната удалена или миграция завершена — таймеры не нужны
  forget(roomId) {
    this._clearPromotionTimer(roomId);
    this._cancelProbe(roomId);
    this._lastAckAt.delete(roomId);
  }
}
