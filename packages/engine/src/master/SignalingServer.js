import { v4 as uuidv4 } from 'uuid';
import closeCodes from '../config/closeCodes.js';
import { clientIp } from '../lib/clientIp.js';
import { verifyIdentityToken } from '../lib/jwt.js';
import { isValidRoomId } from '../lib/roomId.js';
import HostVoteManager from './HostVoteManager.js';
import MigrationCoordinator from './MigrationCoordinator.js';
import { pickSuccessor } from './successor.js';

// memberId — crypto.randomUUID() вкладки; формат проверяется, чтобы в реестр
// не попадал произвольный мусор как ключ участника
const MEMBER_ID_PATTERN = /^[0-9a-f-]{36}$/i;

// сглаживание RTT участника и его джиттера (host-migration этап 6)
const RTT_EMA_ALPHA = 0.2;

const isValidMemberId = value =>
  typeof value === 'string' && MEMBER_ID_PATTERN.test(value);

// строка карточки лобби: info (null очищает); страницы до host-migration
// этапа 2 присылают имя карты как mapName. undefined — поля нет вовсе
const infoOf = msg => {
  if ('info' in msg) {
    return msg.info;
  }

  return typeof msg.mapName === 'string' && msg.mapName !== ''
    ? msg.mapName
    : undefined;
};

// Signaling Server: маршрутизация WebRTC-координации между клиентами
// и браузерными хостами, реестр участников комнат. Игровой логики нет —
// только пересылка SDP-офферов/ответов, ICE-кандидатов и сигнальных пингов.
export default class SignalingServer {
  constructor(registry, options) {
    this._registry = registry;
    this._iceServers = options.iceServers;
    this._regionHeader = options.regionHeader;
    this._pingLimiter = options.pingLimiter;
    this._checkOrigin = options.checkOrigin;
    // стоит ли перед мастером прод-Nginx: от этого зависит, откуда берётся
    // адрес клиента (lib/clientIp.js). Он ключ и лимита пингов, и правила
    // «не больше одной комнаты с одного IP» — ошибиться тут значит отдать
    // оба ограничения тому, кто просто пришлёт свой заголовок
    this._trustProxy = options.trustProxy ?? false;
    this._mapsVersion = options.mapsVersion ?? null;
    this._codeVersion = options.codeVersion ?? null;
    // per-game mapsVersion (Этап 6.2) — хост объявляет gameId в
    // register_host, ответ несёт версию карт именно этой игры (GameCatalog);
    // без gameId/каталога — статичный fallback (options.mapsVersion, если
    // задан мастером)
    this._gameCatalog = options.gameCatalog ?? null;
    // идентичность хоста и участников — Bearer identity-токен, проверенный по
    // тому же JWKS-прокси, каким его проверяет Worker хоста
    // (packages/engine/src/lib/jwt.js). Без jwksProxy register_host и
    // join_room всегда отклоняются как invalidToken
    this._jwksProxy = options.jwksProxy ?? null;
    this._issuer = options.issuer ?? null;
    // часы — для тестов RTT и гистерезиса преемника
    this._now = options.now ?? (() => Date.now());
    // сессия без pong дольше — terminate() (host-migration этап 6)
    this._wsDeadAfterMs = options.wsDeadAfterMs ?? 12000;
    // выбор беты комнаты (master/successor.js)
    this._successorOptions = {
      minMemberAgeMs: 10000,
      switchRatio: 0.65,
      switchSustainMs: 30000,
      minFps: 0,
      ...options.successor,
    };

    // id соединения -> { id, ws, ip, region, roomId (комната, где хост),
    // memberOf ({ roomId, memberId } — комната, где участник), rttEma,
    // jitterEma, pingSentAt, lastPongAt }
    this._sessions = new Map();
    this._hostSessions = new Map(); // roomId -> id соединения текущего хоста
    // хендлеры диспетчерятся fire-and-forget (ws-сообщение не ждёт ответа) —
    // часть асинхронна (проверка токена по JWKS);
    // idle() даёт тестам детерминированно дождаться завершения без таймеров
    this._pending = new Set();

    // миграция хоста (этапы 7–8): машина состояний комнаты
    this._migration = new MigrationCoordinator({
      registry: this._registry,
      send: (sessionId, message) => {
        const session = this._sessions.get(sessionId);

        if (session) {
          this._send(session, message);
        }
      },
      hasSession: sessionId => this._sessions.has(sessionId),
      hostSessionId: roomId => this._hostSessions.get(roomId) ?? null,
      unbindHost: roomId => this._unbindHost(roomId),
      closeRoom: (room, reason) => {
        this._registry.remove(room.roomId);
        this._votes.forget(room.roomId);
        this._closeRoom(room, reason);
      },
      scoreOf: sessionId => this.scoreOf(sessionId),
      successorOptions: this._successorOptions,
      now: this._now,
      randomBytes: options.randomBytes,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      timings: options.migration,
      onTransition: room => this._votes.cancel(room),
    });

    // голосование «Change host» (этап 10): голоса считает мастер
    this._votes = new HostVoteManager({
      registry: this._registry,
      migration: this._migration,
      send: (sessionId, message) => {
        const session = this._sessions.get(sessionId);

        if (session) {
          this._send(session, message);
        }
      },
      hasSession: sessionId => this._sessions.has(sessionId),
      now: this._now,
      randomBytes: options.randomBytes,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      timings: options.vote,
    });

    // обработчики входящих сигнальных сообщений
    this._handlers = {
      'register_host': this._onRegisterHost,
      'reclaim_host': this._onReclaimHost,
      'update_host': this._onUpdateHost,
      'heartbeat': this._onHeartbeat,
      'join_room': this._onJoinRoom,
      'leave_room': this._onLeaveRoom,
      'member_update': this._onMemberUpdate,
      'standby_status': this._onStandbyStatus,
      'webrtc_offer': this._onWebRtcOffer,
      'webrtc_answer': this._onWebRtcAnswer,
      'ice_candidate': this._onIceCandidate,
      'ping_host': this._onPingHost,
      'pong_host': this._onPongHost,
      'host_unreachable': this._onHostUnreachable,
      'probe_ack': this._onProbeAck,
      'promote_failed': this._onPromoteFailed,
      'handoff_begin': this._onHandoffBegin,
      'host_leaving': this._onHostLeaving,
      'host_health': this._onHostHealth,
      'host_vote_start': this._onHostVoteStart,
      'host_vote_answer': this._onHostVoteAnswer,
    };
  }

  // ждёт завершения всех в моменте диспетчеризованных асинхронных хендлеров;
  // используется тестами вместо таймера-эвристики — детерминированно, без
  // произвольных задержек
  async idle() {
    while (this._pending.size > 0) {
      await Promise.all(this._pending);
    }
  }

  handleConnection(ws, req) {
    // до любых ранних return'ов: ws эмитит 'error' на самом сокете
    // (ECONNRESET, битый фрейм), и без слушателя это uncaughtException — то
    // есть один сорванный клиент роняет мастер. Ветка «нет адреса» ниже
    // срабатывает как раз на уже разорванном сокете, самом вероятном
    // источнике такой ошибки (тот же порядок, что в src/dedicated/main.js)
    ws.on('error', error => {
      console.error('Signaling WebSocket error:', error);
    });

    const ip = clientIp(req, { trustProxy: this._trustProxy });
    const requestOrigin = req.headers.origin;

    // если origin вообще не пришел (это скорее всего бот)
    if (!requestOrigin) {
      ws.terminate();
      return;
    }

    // адреса нет только у уже разорванного сокета: общий бакет '' раздал бы
    // всем таким соединениям один лимит пингов и одну квоту комнат
    if (!ip) {
      ws.terminate();
      return;
    }

    this._checkOrigin(requestOrigin, err => {
      if (err) {
        console.warn(err);
        // причина close ограничена 123 байтами, и ws бросает RangeError прямо
        // в колбэке process.nextTick — перехватить его некому, длинный Origin
        // валил бы процесс. Полный текст уходит в лог, клиенту — маркер
        ws.close(closeCodes.invalidOrigin, 'invalidOrigin');
        return;
      }

      const session = {
        id: uuidv4(),
        ws,
        ip,
        region: req.headers[this._regionHeader] || 'unknown',
        roomId: null,
        memberOf: null,
        // RTT до мастера (ws ping/pong): null — замера ещё не было
        rttEma: null,
        jitterEma: 0,
        pingSentAt: null,
        lastPongAt: this._now(),
      };

      this._sessions.set(session.id, session);

      ws.on('pong', () => this._onPong(session));

      this._send(session, {
        type: 'welcome',
        id: session.id,
        iceServers: this._iceServers,
      });

      ws.on('message', data => {
        const msg = this._unpack(data);

        if (msg && this._handlers[msg.type]) {
          const pending = Promise.resolve(
            this._handlers[msg.type].call(this, session, msg),
          ).catch(err => {
            console.error(`[signaling] handler "${msg.type}" failed:`, err);
          });

          this._pending.add(pending);
          pending.finally(() => this._pending.delete(pending));
        }
      });

      ws.on('close', () => {
        this._removeSession(session);
      });
    });
  }

  // уборка реестра: комнаты с потерянным хостом (молчит дольше
  // heartbeatTimeout) уходят в миграцию (этап 7); отсоединённые участники и
  // пустые комнаты удаляются
  sweep(now = Date.now()) {
    const { lost, removed } = this._registry.sweep(now);

    for (const roomId of removed) {
      this._hostSessions.delete(roomId);
      this._migration.forget(roomId);
      this._votes.forget(roomId);
    }

    // участники, чей grace истёк, больше не голосуют
    this._votes.pruneAll();

    // отсоединённый хост не вернулся за grace (миграцию при обрыве WS не
    // начали — повышать было некого): теперь кандидатов нет — комната
    // закрывается
    for (const room of lost) {
      this._migration.hostLost(
        room,
        room.host.sessionId === null ? 'disconnected' : 'timeout',
      );
    }

    return { lost: lost.map(room => room.roomId), removed };
  }

  // сессия хоста больше не хост комнаты (миграция): ответы, кандидаты и
  // heartbeat от неё игнорируются; участником комнаты она остаётся
  _unbindHost(roomId) {
    const session = this._getHostSession(roomId);

    this._hostSessions.delete(roomId);

    if (session) {
      session.roomId = null;
    }
  }

  _closeRoom(room, reason) {
    const hostSession = this._getHostSession(room.roomId);

    this._hostSessions.delete(room.roomId);

    for (const member of room.members.values()) {
      const session = this._sessions.get(member.sessionId);

      if (session && session !== hostSession) {
        session.memberOf = null;
        this._send(session, {
          type: 'room_closed',
          roomId: room.roomId,
          reason,
        });
      }
    }

    // хост ещё на связи (людей для миграции нет) — комната закрыта и для
    // него
    if (hostSession) {
      hostSession.roomId = null;
      hostSession.memberOf = null;
      hostSession.ws.close(closeCodes.staleHost, 'staleHost');
    }
  }

  // ***** RTT участников (host-migration этап 6) ***** //

  /**
   * Пинг всех сессий (ws.ping) и обрыв тех, кто не отвечал pong дольше
   * wsDeadAfterMs. Вызывается периодически (master:room:rttProbeIntervalMs).
   * @param {number} [now]
   */
  probeSessions(now = this._now()) {
    for (const session of this._sessions.values()) {
      const { ws } = session;

      if (now - session.lastPongAt >= this._wsDeadAfterMs) {
        // 'close' придёт от ws и уберёт сессию обычным путём
        ws.terminate();
        continue;
      }

      if (ws.readyState !== ws.OPEN || typeof ws.ping !== 'function') {
        continue;
      }

      try {
        ws.ping();
        session.pingSentAt = now;
      } catch {
        // сокет закрывается — его уберёт 'close'
      }
    }
  }

  _onPong(session) {
    const now = this._now();

    session.lastPongAt = now;

    if (session.pingSentAt === null) {
      return; // самовольный pong без нашего ping
    }

    const rtt = Math.max(0, now - session.pingSentAt);

    session.pingSentAt = null;

    if (session.rttEma === null) {
      session.rttEma = rtt;
      session.jitterEma = 0;
      return;
    }

    session.jitterEma +=
      RTT_EMA_ALPHA * (Math.abs(rtt - session.rttEma) - session.jitterEma);
    session.rttEma += RTT_EMA_ALPHA * (rtt - session.rttEma);
  }

  /**
   * Единая линейка «насколько хорошо участник подключён к сети»: rttEma +
   * 2 × jitterEma до мастера. null — замера ещё нет.
   * @param {string|null} sessionId
   * @returns {number|null}
   */
  scoreOf(sessionId) {
    const session = this._sessions.get(sessionId);

    return session && session.rttEma !== null
      ? session.rttEma + 2 * session.jitterEma
      : null;
  }

  // ***** преемник комнаты (host-migration этап 6) ***** //

  /**
   * Плановый пересчёт бет всех комнат (master:room:successorReviewMs):
   * гистерезис смены беты держится на этом таймере.
   * @param {number} [now]
   */
  reviewSuccessors(now = this._now()) {
    for (const room of this._registry.rooms()) {
      this._reviewSuccessor(room, now);
    }
  }

  _reviewSuccessor(room, now = this._now()) {
    // смена хоста идёт (этапы 7–8): повышенная бета и хост, шлющий ей
    // финальную точку, должны видеть одного и того же преемника. Пересчёт —
    // после регистрации нового хоста (_onPromotedRegister) или отмены
    if (!room || this._migration.inTransition(room)) {
      return;
    }

    const members = [...room.members.values()].map(member => ({
      ...member,
      // кандидат — только с живой сессией: отсоединённый в grace не примет
      // точки
      live: member.sessionId !== null && this._sessions.has(member.sessionId),
      score: this.scoreOf(member.sessionId),
    }));
    const result = pickSuccessor(
      {
        hostMemberId: room.host.memberId,
        successorMemberId: room.successorMemberId,
        challenger: room.successorChallenger,
        members,
      },
      now,
      this._successorOptions,
    );

    room.successorChallenger = result.challenger;

    if (result.successorMemberId !== room.successorMemberId) {
      this._assignSuccessor(room, result.successorMemberId);
    }
  }

  // смена беты: прежней — standby_released, новой — standby_assigned, хосту
  // — successor_assigned (к кому открыть канал standby)
  _assignSuccessor(room, successorMemberId) {
    const previous = room.members.get(room.successorMemberId);

    room.successorMemberId = successorMemberId;
    room.successorChallenger = null;
    room.standby = null;

    if (previous) {
      this._sendToMember(previous, {
        type: 'standby_released',
        roomId: room.roomId,
      });
    }

    const next = room.members.get(successorMemberId);

    if (next) {
      this._sendToMember(next, {
        type: 'standby_assigned',
        roomId: room.roomId,
        epoch: room.epoch,
      });
    }

    this._sendSuccessorToHost(room);
  }

  _sendSuccessorToHost(room) {
    const host = this._getHostSession(room.roomId);

    if (!host) {
      return; // хост отсоединён — узнает при reclaim_host
    }

    const successor = room.members.get(room.successorMemberId);

    this._send(host, {
      type: 'successor_assigned',
      roomId: room.roomId,
      epoch: room.epoch,
      successorMemberId: successor ? successor.memberId : null,
      successorClientId: successor?.sessionId ?? null,
    });
  }

  _sendToMember(member, message) {
    const session = this._sessions.get(member.sessionId);

    if (session) {
      this._send(session, message);
    }
  }

  // участник сообщил новые возможности (вкладка спрятана/показана, сменился
  // тип ICE-кандидата) — бета могла перестать быть кандидатом
  _onMemberUpdate(session, { roomId, caps }) {
    if (session.memberOf?.roomId !== roomId) {
      return;
    }

    if (this._registry.setMemberCaps(roomId, session.memberOf.memberId, caps)) {
      this._reviewSuccessor(this._registry.get(roomId));
    }
  }

  // бета получила полную точку (и далее раз в 5 с): мастер знает, есть ли у
  // неё точка и насколько свежая (этап 7 выбирает режим промоушена)
  _onStandbyStatus(session, { roomId, epoch, checkpointId, createdAt }) {
    const room = this._registry.get(roomId);

    if (
      !room ||
      session.memberOf?.roomId !== roomId ||
      session.memberOf.memberId !== room.successorMemberId ||
      epoch !== room.epoch ||
      typeof checkpointId !== 'string' ||
      !Number.isFinite(createdAt)
    ) {
      return;
    }

    room.standby = {
      memberId: room.successorMemberId,
      checkpointId: checkpointId.slice(0, 64),
      createdAt,
      receivedAt: this._now(),
    };
  }

  // хост создаёт комнату; token — Bearer identity-токен хоста: без него/при
  // неверной подписи регистрация отклоняется — комната привязана к
  // проверенному userId. name от страниц до этапа 2 игнорируется
  async _onRegisterHost(session, msg) {
    const { maxPlayers, gameId, gameVersion, token, memberId, caps, ...rest } =
      msg;

    if (session.roomId) {
      this._sendError(session, 'alreadyRegistered');
      return;
    }

    // преемник занимает существующую комнату (этап 7), а не создаёт новую
    if (msg.promotionToken !== undefined) {
      await this._onPromotedRegister(session, msg);
      return;
    }

    if (!this._gameAvailable(gameId)) {
      this._sendError(session, 'gameUnavailable');
      return;
    }

    const identity = await this._verifyToken(token);

    if (identity === null) {
      this._sendError(session, 'invalidToken');
      return;
    }

    const room = this._registry.add(
      this._roomFields(session, identity, {
        maxPlayers,
        info: infoOf(rest),
        gameId,
        gameVersion,
        memberId,
        caps,
        settings: msg.settings,
      }),
      this._now(),
    );

    // лимит: не более одной комнаты с одного IP
    if (!room) {
      this._sendError(session, 'hostLimit');
      return;
    }

    this._bindHost(session, room);
    this._sendRegistered(session, room, gameVersion);
  }

  // register_host преемника {roomId, epoch, promotionToken, …}: занять
  // комнату в миграции. Лимит «IP не хостит другую комнату» не действует —
  // промоушен не создаёт комнату
  async _onPromotedRegister(session, msg) {
    const identity = await this._verifyToken(msg.token);

    if (identity === null) {
      this._sendError(session, 'invalidToken');
      return;
    }

    const room = this._registry.get(msg.roomId);
    const check = this._migration.checkPromotion(room, {
      epoch: msg.epoch,
      promotionToken: msg.promotionToken,
      userId: identity.userId,
    });

    if (!check.ok) {
      this._sendError(session, check.code);
      return;
    }

    const { migration } = room;
    const candidate = room.members.get(migration.candidateMemberId);

    this._registry.promoteHost(
      room.roomId,
      {
        epoch: room.pendingEpoch,
        sessionId: session.id,
        memberId: this._memberIdOf(session, msg.memberId),
        userId: identity.userId,
        nick: identity.nick ?? candidate?.nick ?? null,
        ip: session.ip,
        caps: msg.caps,
        // холодный промоушен перезагрузил страницу: прежняя запись вкладки
        previousMemberId: migration.candidateMemberId,
      },
      this._now(),
    );
    this._registry.setSettings(room.roomId, msg.settings);

    this._bindHost(session, room);
    this._sendRegistered(session, room, msg.gameVersion ?? room.gameVersion);
    this._migration.completePromotion(room, { migration });
    this._reviewSuccessor(room);
  }

  // хост переподключил сигналинг (или мастер перезапустился) и просит ту же
  // комнату. Секрет — HMAC от (roomId, epoch, userId из токена): видимого
  // roomId для угона мало
  async _onReclaimHost(session, msg) {
    const { roomId, epoch, roomSecret, memberId, gameId, gameVersion } = msg;

    if (session.roomId) {
      this._sendError(session, 'alreadyRegistered');
      return;
    }

    const identity = await this._verifyToken(msg.token);

    if (identity === null) {
      this._sendError(session, 'invalidToken');
      return;
    }

    if (
      !isValidRoomId(roomId) ||
      !Number.isInteger(epoch) ||
      epoch < 1 ||
      !this._registry.verifySecret(roomSecret, {
        roomId,
        epoch,
        userId: identity.userId,
      })
    ) {
      this._sendError(session, 'invalidRoomSecret');
      return;
    }

    let room = this._registry.get(roomId);

    if (room && room.epoch > epoch) {
      // хоста уже сменили (этап 7) — этот снимает роль
      this._sendError(session, 'staleEpoch');
      return;
    }

    // комната в миграции: обрыв одного сигналинга её отменяет, а хоста,
    // которого сместили принудительно или который сам отдаёт роль (плановая
    // передача, этап 8), назад не пускают
    if (
      room &&
      room.epoch === epoch &&
      room.host.userId === identity.userId &&
      this._migration.inTransition(room) &&
      !this._migration.canCancelByReclaim(room)
    ) {
      this._sendError(session, 'staleEpoch');
      return;
    }

    if (room && (room.epoch < epoch || room.host.userId !== identity.userId)) {
      // секрет верен, но id занят другой комнатой — клиент регистрируется
      // заново
      this._sendError(session, 'roomTaken');
      return;
    }

    if (room) {
      const other = this._registry.getByIp(session.ip);

      if (other && other !== room) {
        this._sendError(session, 'hostLimit');
        return;
      }

      // все проверки пройдены — только теперь отменять миграцию: гостям
      // уходит «возобновляйтесь к этому хосту»
      if (this._migration.isMigrating(room)) {
        this._migration.cancelByReclaim(room);
      }

      // прежняя сессия хоста могла ещё не закрыться (полуоткрытый сокет) —
      // комната переезжает на новую
      const previous = this._getHostSession(roomId);

      if (previous && previous !== session) {
        previous.roomId = null;
        previous.memberOf = null;
      }

      this._registry.attachHost(roomId, {
        sessionId: session.id,
        memberId: this._memberIdOf(session, memberId),
        ip: session.ip,
      });

      if (msg.caps !== undefined) {
        this._registry.setMemberCaps(
          roomId,
          this._memberIdOf(session, memberId),
          msg.caps,
        );
      }

      this._registry.setSettings(roomId, msg.settings);
    } else {
      // мастер перезапускался: реестр в памяти пуст, комната создаётся
      // заново с тем же roomId/epoch
      if (!this._gameAvailable(gameId)) {
        this._sendError(session, 'gameUnavailable');
        return;
      }

      room = this._registry.restore(
        roomId,
        epoch,
        this._roomFields(session, identity, {
          ...msg,
          info: infoOf(msg),
          memberId,
        }),
        this._now(),
      );

      if (!room) {
        this._sendError(session, 'hostLimit');
        return;
      }
    }

    this._bindHost(session, room);
    this._sendRegistered(session, room, gameVersion);

    // вернувшемуся хосту — кто бета (назначение могло смениться, пока его
    // не было); после рестарта мастера беты ещё нет
    if (room.successorMemberId) {
      this._sendSuccessorToHost(room);
    }

    this._reviewSuccessor(room);
  }

  // Игра, помеченная каталогом недоступной (compat.ok === false, этап 5
  // плана plugin-forward-compat), в лобби показана disabled — но это
  // решение КЛИЕНТА. Хост со своей сборкой или с открытой консолью поднял
  // бы по ней комнату, она попала бы в список живой строкой, а
  // присоединяющиеся упёрлись бы в loadClientPlugin. Проверка стоит до
  // _verifyToken: она дешевле сетевого запроса к auth
  _gameAvailable(gameId) {
    return !(
      gameId && this._gameCatalog?.getManifest(gameId)?.compat?.ok === false
    );
  }

  _roomFields(
    session,
    identity,
    { maxPlayers, info, gameId, gameVersion, memberId, caps, settings },
  ) {
    return {
      maxPlayers,
      info,
      gameId,
      gameVersion,
      settings,
      // тестовая комната админа (master-game-registry, этап 3.5): хост уже
      // присылает gameVersion (хеш бандла), поэтому мастер отличает комнату
      // на застейдженной версии от комнаты на одобренной, не меняя протокол.
      // Скрытая комната не показывается в общем списке — админ проверяет
      // новую версию, пока игроки играют в раздаваемую.
      //
      // Значение считается при регистрации, и после одобрения версии
      // тестовая комната остаётся скрытой до перерегистрации хоста. Для
      // текущего масштаба это приемлемо: одобрение — редкое админское
      // действие, а комната админа живёт минуты
      hidden: gameId
        ? this._gameCatalog?.isStaged?.(gameId, gameVersion) === true
        : false,
      region: session.region,
      ip: session.ip,
      host: {
        sessionId: session.id,
        memberId: this._memberIdOf(session, memberId),
        userId: identity.userId,
        nick: identity.nick,
        caps,
      },
    };
  }

  // страницы до этапа 2 memberId не присылают — участником их делает id
  // соединения
  _memberIdOf(session, memberId) {
    return isValidMemberId(memberId) ? memberId : session.id;
  }

  _bindHost(session, room) {
    session.roomId = room.roomId;
    session.memberOf = { roomId: room.roomId, memberId: room.host.memberId };
    this._hostSessions.set(room.roomId, session.id);
  }

  _sendRegistered(session, room, gameVersion) {
    // per-game mapsVersion (Этап 6.2) — из манифеста игры, объявленной
    // хостом; без gameId/каталога — статичный fallback
    const gameManifest = room.gameId
      ? this._gameCatalog?.getManifest(room.gameId)
      : null;
    const mapsVersion = gameManifest?.maps.version ?? this._mapsVersion;

    // составной codeVersion (Этап 6.5): движок (worker-бандл) + игра
    // (id/version из каталога — источник истины, не то, что заявил хост);
    // без каталога/gameId — только движковая половина, как раньше
    const codeVersion = {
      engine: this._codeVersion,
      game: {
        id: room.gameId,
        version: gameManifest?.version ?? gameVersion ?? null,
      },
    };
    const roomSecret = this._registry.roomSecret(room);

    // mapsVersion/codeVersion — актуальные версии каталога карт и
    // worker-бандла+игры: при reclaim после разрыва (деплой рестартует
    // мастер) хост сравнивает их со своими и при расхождении фетчит карты /
    // заменяет Worker эстафетой на границе раунда (Этапы 5.1/5.2/6.5)
    this._send(session, {
      type: 'host_registered',
      roomId: room.roomId,
      epoch: room.epoch,
      // секрет эпохи: уходит только этой сессии; хост эхом шлёт его в PUT
      // /auth/rank·/state (verifiedAttribution) и в reclaim_host
      roomSecret,
      // алиасы для страниц, загруженных до деплоя
      hostId: room.roomId,
      hostSecret: roomSecret,
      gameId: room.gameId,
      mapsVersion,
      codeVersion,
    });
  }

  // текущий хост комнаты сессии или null
  _hostedRoom(session) {
    return session.roomId &&
      this._hostSessions.get(session.roomId) === session.id
      ? session.roomId
      : null;
  }

  // актуализация строки карточки (заодно heartbeat); число игроков мастер
  // считает по участникам сам — currentPlayers хоста игнорируется
  _onUpdateHost(session, msg) {
    const roomId = this._hostedRoom(session);

    if (roomId) {
      this._registry.update(roomId, { info: infoOf(msg) });
    }
  }

  _onHeartbeat(session) {
    const roomId = this._hostedRoom(session);

    if (roomId) {
      this._registry.update(roomId);
    }
  }

  // гость вошёл в матч комнаты (или переподключил сигналинг): мастер знает
  // состав комнаты сам
  async _onJoinRoom(session, { roomId, memberId, token, caps }) {
    if (!isValidMemberId(memberId)) {
      return;
    }

    const identity = await this._verifyToken(token);

    if (identity === null) {
      this._sendError(session, 'invalidToken');
      return;
    }

    const room = this._registry.get(roomId);

    if (!room) {
      this._sendError(session, 'unknownRoom');
      return;
    }

    // одна вкладка — одна комната
    if (session.memberOf && session.memberOf.roomId !== roomId) {
      const previousRoomId = session.memberOf.roomId;

      this._registry.leaveMember(previousRoomId, session.memberOf.memberId);
      this._votes.membersChanged(previousRoomId);
      this._reviewSuccessor(this._registry.get(previousRoomId));
    }

    this._registry.joinMember(roomId, {
      memberId,
      userId: identity.userId,
      nick: identity.nick,
      sessionId: session.id,
      caps,
    });
    session.memberOf = { roomId, memberId };

    this._send(session, { type: 'room_joined', roomId, epoch: room.epoch });

    // реконнект сигналинга действующей беты: назначение ей заново (точки
    // она могла потерять вместе со страницей)
    if (room.successorMemberId === memberId) {
      this._send(session, {
        type: 'standby_assigned',
        roomId,
        epoch: room.epoch,
      });
    }

    this._reviewSuccessor(room);
  }

  // участник ушёл сам — сразу, без grace. Хост так комнату не покидает
  _onLeaveRoom(session, { roomId }) {
    if (session.memberOf?.roomId !== roomId || this._hostedRoom(session)) {
      return;
    }

    this._registry.leaveMember(roomId, session.memberOf.memberId);
    session.memberOf = null;
    this._votes.membersChanged(roomId);
    this._reviewSuccessor(this._registry.get(roomId));
  }

  // клиент шлёт SDP-оффер текущему хосту комнаты (hostId — алиас roomId
  // от страниц до этапа 2)
  _onWebRtcOffer(session, { roomId, hostId, sdp, memberId, resume }) {
    const id = roomId ?? hostId;
    const host = this._getHostSession(id);

    // плановая передача (этап 8): хост заморожен и вот-вот уйдёт — новый
    // гость повторит оффер через 1 с, уже к преемнику
    if (host && this._migration.isHandingOff(this._registry.get(id))) {
      this._sendError(session, 'migrating');
      return;
    }

    if (!host) {
      // unknownHost — код страниц до этапа 2, оставлен алиасом
      this._send(session, {
        type: 'error',
        code: 'unknownRoom',
        alias: 'unknownHost',
      });
      return;
    }

    this._send(host, {
      type: 'webrtc_offer',
      clientId: session.id,
      sdp,
      memberId: isValidMemberId(memberId) ? memberId : undefined,
      resume: resume === true ? true : undefined,
      epoch: this._registry.get(id)?.epoch,
    });
  }

  // хост отвечает клиенту
  _onWebRtcAnswer(session, { clientId, sdp }) {
    const roomId = this._hostedRoom(session);
    const client = this._sessions.get(clientId);

    if (roomId && client) {
      this._send(client, {
        type: 'webrtc_answer',
        roomId,
        hostId: roomId,
        epoch: this._registry.get(roomId)?.epoch,
        sdp,
      });
    }
  }

  // обмен ICE-кандидатами в обе стороны:
  // клиент адресует roomId (резолвится в текущего хоста), хост — clientId
  _onIceCandidate(session, { targetId, candidate }) {
    const target =
      this._sessions.get(targetId) ?? this._getHostSession(targetId);

    if (!target) {
      return;
    }

    const roomId = this._hostedRoom(session);

    this._send(target, {
      type: 'ice_candidate',
      fromId: roomId ?? session.id,
      epoch: roomId ? this._registry.get(roomId)?.epoch : undefined,
      candidate,
    });
  }

  // сигнальный пинг: замер приблизительный (клиент→мастер→хост)
  _onPingHost(session, { roomId, hostId, pingId }) {
    if (!this._pingLimiter.consume(session.ip)) {
      this._sendError(session, 'rateLimited');
      return;
    }

    const host = this._getHostSession(roomId ?? hostId);

    if (host) {
      this._send(host, { type: 'ping_host', clientId: session.id, pingId });
    }
  }

  _onPongHost(session, { clientId, pingId }) {
    const roomId = this._hostedRoom(session);
    const client = this._sessions.get(clientId);

    if (roomId && client) {
      this._send(client, {
        type: 'pong_host',
        roomId,
        hostId: roomId,
        pingId,
      });
    }
  }

  // ***** аварийная миграция (этап 7) ***** //

  // гость не достучался до хоста по WebRTC
  _onHostUnreachable(session, { roomId, epoch }) {
    if (session.memberOf?.roomId !== roomId) {
      return;
    }

    this._migration.onUnreachable(
      this._registry.get(roomId),
      session.memberOf.memberId,
      epoch,
    );
  }

  // главный поток хоста ответил на пробу
  _onProbeAck(session, { nonce }) {
    const roomId = this._hostedRoom(session);

    if (roomId) {
      this._migration.onProbeAck(this._registry.get(roomId), nonce);
    }
  }

  // преемник не смог поднять матч (плагин, wasm, init) — следующий кандидат
  _onPromoteFailed(session, { roomId, epoch, promotionToken }) {
    this._migration.onPromoteFailed(this._registry.get(roomId), {
      memberId:
        session.memberOf?.roomId === roomId
          ? session.memberOf.memberId
          : undefined,
      epoch,
      promotionToken,
    });
  }

  // ***** плановая передача (этап 8) ***** //

  // хост отдаёт роль бете («Leave server», «Hand over host»)
  _onHandoffBegin(session, { roomId, epoch, reason }) {
    const hosted = this._hostedRoom(session);

    if (!hosted || hosted !== roomId) {
      return;
    }

    this._migration.beginHandoff(this._registry.get(roomId), {
      epoch,
      reason,
    });
  }

  // вкладка хоста закрывается (pagehide) — миграция без ожидания обрыва WS
  _onHostLeaving(session, { roomId, epoch }) {
    const hosted = this._hostedRoom(session);

    if (!hosted || hosted !== roomId) {
      return;
    }

    this._migration.onHostLeaving(this._registry.get(roomId), epoch);
  }

  // здоровье хоста (этап 9c): мастер решает, не отдать ли роль из-за лага
  _onHostHealth(session, msg) {
    const hosted = this._hostedRoom(session);

    if (!hosted || hosted !== msg.roomId) {
      return;
    }

    this._migration.onHostHealth(this._registry.get(hosted), msg);
  }

  // ***** голосование «Change host» (этап 10) ***** //

  // участник комнаты предлагает сменить хоста (/changehost)
  _onHostVoteStart(session, { roomId }) {
    if (session.memberOf?.roomId !== roomId) {
      return;
    }

    this._votes.start(this._registry.get(roomId), session.memberOf.memberId);
  }

  // ответ участника в окне «Change host?»
  _onHostVoteAnswer(session, { roomId, voteId, value }) {
    if (session.memberOf?.roomId !== roomId) {
      return;
    }

    this._votes.answer(this._registry.get(roomId), session.memberOf.memberId, {
      voteId,
      value,
    });
  }

  // проверяет Bearer identity-токен по JWKS central auth-сервиса; возвращает
  // { userId, nick } или null (нет jwksProxy, токен отсутствует/невалиден)
  async _verifyToken(token) {
    if (!this._jwksProxy || typeof token !== 'string') {
      return null;
    }

    try {
      const jwks = await this._jwksProxy.get();
      const payload = await verifyIdentityToken(token, {
        jwks,
        issuer: this._issuer,
      });

      return {
        userId: Number(payload.sub),
        nick: typeof payload.nick === 'string' ? payload.nick : null,
      };
    } catch {
      return null;
    }
  }

  _getHostSession(roomId) {
    return typeof roomId === 'string'
      ? this._sessions.get(this._hostSessions.get(roomId))
      : undefined;
  }

  _removeSession(session) {
    const roomId = this._hostedRoom(session);

    this._sessions.delete(session.id);

    // хост: комната сразу уходит в миграцию (этап 7.0); reclaim_host до
    // регистрации преемника её отменит — это был обрыв одного сигналинга
    if (roomId) {
      this._hostSessions.delete(roomId);
      this._registry.detachHost(roomId);
      this._registry.detachMember(session.id);
      // повышать некого — комната ждёт reclaim_host hostReclaimGraceMs, как
      // до миграции: P2P-матч, возможно, цел
      this._migration.hostLost(this._registry.get(roomId), 'disconnected', {
        keepIfNoCandidate: true,
      });

      return;
    }

    if (session.memberOf) {
      const { roomId, memberId } = session.memberOf;

      this._registry.detachMember(session.id);
      this._migration.onMemberGone(this._registry.get(roomId), memberId);
      // ушла бета — назначить другую сразу, не дожидаясь таймера (комнату —
      // заново: без кандидатов миграция её закрыла)
      this._reviewSuccessor(this._registry.get(roomId));
    }
  }

  _send(session, message) {
    const { ws } = session;

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  _sendError(session, code) {
    this._send(session, { type: 'error', code });
  }

  _unpack(data) {
    try {
      const msg = JSON.parse(data);

      return msg && typeof msg.type === 'string' ? msg : undefined;
    } catch (e) {
      return undefined;
    }
  }
}
