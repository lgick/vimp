import { v4 as uuidv4 } from 'uuid';
import { verifyIdentityToken } from '../lib/jwt.js';

// Signaling Server: маршрутизация WebRTC-координации между клиентами
// и браузерными хостами. Игровой логики нет — только пересылка
// SDP-офферов/ответов, ICE-кандидатов, сигнальных пингов и голосов рейтинга.
export default class SignalingServer {
  constructor(registry, options) {
    this._registry = registry;
    this._iceServers = options.iceServers;
    this._regionHeader = options.regionHeader;
    this._heartbeatTimeout = options.heartbeatTimeout;
    this._pingLimiter = options.pingLimiter;
    this._checkOrigin = options.checkOrigin;
    this._mapsVersion = options.mapsVersion ?? null;
    this._codeVersion = options.codeVersion ?? null;
    // per-game mapsVersion (Этап 6.2) — хост объявляет gameId в
    // register_host, ответ несёт версию карт именно этой игры (GameCatalog);
    // без gameId/каталога — статичный fallback (options.mapsVersion, если
    // задан мастером)
    this._gameCatalog = options.gameCatalog ?? null;
    // server-rating этап 2 (stage_2.md): идентичность хостера/голосующего —
    // Bearer identity-токен, проверенный по тому же JWKS-прокси, каким его
    // проверяет Worker хоста (packages/engine/src/lib/jwt.js). Без jwksProxy
    // register_host/like_host/unlike_host всегда отклоняются как invalidToken
    this._jwksProxy = options.jwksProxy ?? null;
    this._hostRatingProxy = options.hostRatingProxy ?? null;
    this._issuer = options.issuer ?? null;

    this._sessions = new Map(); // id соединения -> { id, ws, ip, region, hostId }
    this._hostSessions = new Map(); // hostId -> id соединения

    // обработчики входящих сигнальных сообщений
    this._handlers = {
      'register_host': this._onRegisterHost,
      'update_host': this._onUpdateHost,
      'heartbeat': this._onHeartbeat,
      'webrtc_offer': this._onWebRtcOffer,
      'webrtc_answer': this._onWebRtcAnswer,
      'ice_candidate': this._onIceCandidate,
      'ping_host': this._onPingHost,
      'pong_host': this._onPongHost,
      'like_host': this._onLikeHost,
      'unlike_host': this._onUnlikeHost,
    };
  }

  handleConnection(ws, req) {
    const ipHeader = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ip = ipHeader.split(',')[0].trim();
    const requestOrigin = req.headers.origin;

    // если origin вообще не пришел (это скорее всего бот)
    if (!requestOrigin) {
      ws.terminate();
      return;
    }

    this._checkOrigin(requestOrigin, err => {
      if (err) {
        console.warn(err);
        ws.close(4001, JSON.stringify(err));
        return;
      }

      const session = {
        id: uuidv4(),
        ws,
        ip,
        region: req.headers[this._regionHeader] || 'unknown',
        hostId: null,
      };

      this._sessions.set(session.id, session);

      this._send(session, {
        type: 'welcome',
        id: session.id,
        iceServers: this._iceServers,
      });

      ws.on('message', data => {
        const msg = this._unpack(data);

        if (msg && this._handlers[msg.type]) {
          // register_host/like_host/unlike_host — async (проверка identity-
          // токена по JWKS, запрос рейтинга к auth); остальные — синхронные
          Promise.resolve(this._handlers[msg.type].call(this, session, msg)).catch(err => {
            console.error(`[signaling] handler "${msg.type}" failed:`, err);
          });
        }
      });

      ws.on('close', () => {
        this._removeSession(session);
      });
    });

    ws.on('error', error => {
      console.error('Signaling WebSocket error:', error);
    });
  }

  // удаляет комнаты без heartbeat и закрывает их соединения
  sweepStaleHosts(now = Date.now()) {
    const removed = this._registry.sweepStale(this._heartbeatTimeout, now);

    for (const hostId of removed) {
      const sessionId = this._hostSessions.get(hostId);
      const session = this._sessions.get(sessionId);

      this._hostSessions.delete(hostId);

      if (session) {
        session.hostId = null;
        session.ws.close(4000, 'staleHost');
      }
    }

    return removed;
  }

  // хост сообщает о создании комнаты; token — Bearer identity-токен хостера
  // (server-rating этап 2): без него/при неверной подписи регистрация
  // отклоняется, т.к. атрибуция и проверка блокировки по рейтингу требуют
  // проверенного userId
  async _onRegisterHost(session, { name, maxPlayers, mapName, gameId, gameVersion, token }) {
    if (session.hostId) {
      this._sendError(session, 'alreadyRegistered');
      return;
    }

    const hosterUserId = await this._verifyToken(token);

    if (hosterUserId === null) {
      this._sendError(session, 'invalidToken');
      return;
    }

    // хостер с рейтингом на/ниже blockAt не может поднять комнату, пока не
    // наберёт голосов обратно выше порога (замена бана по IP на этап 5.3);
    // заодно уже несём собственный рейтинг хостера — сеем им кэш лобби
    // (server-rating этап 3), не делая для этого второй запрос к auth
    let rating = 0;

    if (this._hostRatingProxy) {
      // кодревью №3: недоступность auth раньше бросала необработанным —
      // хост не получал ни host_registered, ни error, UI зависал. Теперь
      // это явная ошибка клиенту, регистрация не завершается
      let json;

      try {
        ({ json } = await this._hostRatingProxy.getRating(token));
      } catch (err) {
        console.error('[rating] getRating failed at register_host:', err.message);
        this._sendError(session, 'authServiceUnavailable');
        return;
      }

      if (json?.blocked) {
        this._sendError(session, 'blocked');
        return;
      }

      rating = json?.score ?? 0;
    }

    const host = this._registry.add({
      name,
      maxPlayers,
      mapName,
      gameId,
      gameVersion,
      hosterUserId,
      region: session.region,
      ip: session.ip,
    });

    // лимит: не более одной комнаты с одного IP
    if (!host) {
      this._sendError(session, 'hostLimit');
      return;
    }

    this._registry.setRating(host.hostId, rating);

    session.hostId = host.hostId;
    this._hostSessions.set(host.hostId, session.id);

    // per-game mapsVersion (Этап 6.2) — из манифеста игры, объявленной
    // хостом; без gameId/каталога — статичный fallback
    const gameManifest = gameId ? this._gameCatalog?.getManifest(gameId) : null;
    const mapsVersion = gameManifest?.maps.version ?? this._mapsVersion;

    // составной codeVersion (Этап 6.5): движок (worker-бандл) + игра
    // (id/version из каталога — источник истины, не то, что заявил хост);
    // без каталога/gameId — только движковая половина, как раньше
    const codeVersion = {
      engine: this._codeVersion,
      game: { id: host.gameId, version: gameManifest?.version ?? gameVersion ?? null },
    };

    // mapsVersion/codeVersion — актуальные версии каталога карт и
    // worker-бандла+игры: при re-register после разрыва (деплой рестартует
    // мастер) хост сравнивает их со своими и при расхождении фетчит карты /
    // заменяет Worker эстафетой (Этапы 5.1/5.2/6.5)
    this._send(session, {
      type: 'host_registered',
      hostId: host.hostId,
      // per-room секрет для атрибуции rank/state (server-rating кодревью №1,
      // доработка): уходит только этой сессии; хост эхом шлёт его в PUT
      // /auth/rank·/state, мастер сверяет с реестром (verifiedAttribution)
      hostSecret: host.secret,
      gameId: host.gameId,
      mapsVersion,
      codeVersion,
    });
  }

  // актуализация currentPlayers/mapName (заодно heartbeat)
  _onUpdateHost(session, { currentPlayers, mapName }) {
    if (session.hostId) {
      this._registry.update(session.hostId, { currentPlayers, mapName });
    }
  }

  _onHeartbeat(session) {
    if (session.hostId) {
      this._registry.update(session.hostId);
    }
  }

  // клиент шлёт SDP-оффер конкретному хосту
  _onWebRtcOffer(session, { hostId, sdp }) {
    const host = this._getHostSession(hostId);

    if (!host) {
      this._sendError(session, 'unknownHost');
      return;
    }

    // память о том, к каким комнатам сессия подключалась — право на like_host/unlike_host
    (session.offeredHosts ??= new Set()).add(hostId);

    this._send(host, { type: 'webrtc_offer', clientId: session.id, sdp });
  }

  // хост отвечает клиенту
  _onWebRtcAnswer(session, { clientId, sdp }) {
    const client = this._sessions.get(clientId);

    if (session.hostId && client) {
      this._send(client, {
        type: 'webrtc_answer',
        hostId: session.hostId,
        sdp,
      });
    }
  }

  // обмен ICE-кандидатами в обе стороны:
  // клиент адресует hostId, хост адресует clientId
  _onIceCandidate(session, { targetId, candidate }) {
    const target = this._sessions.get(targetId) ?? this._getHostSession(targetId);

    if (!target) {
      return;
    }

    this._send(target, {
      type: 'ice_candidate',
      fromId: session.hostId ?? session.id,
      candidate,
    });
  }

  // сигнальный пинг: замер приблизительный (клиент→мастер→хост)
  _onPingHost(session, { hostId, pingId }) {
    if (!this._pingLimiter.consume(session.ip)) {
      this._sendError(session, 'rateLimited');
      return;
    }

    const host = this._getHostSession(hostId);

    if (host) {
      this._send(host, { type: 'ping_host', clientId: session.id, pingId });
    }
  }

  _onPongHost(session, { clientId, pingId }) {
    const client = this._sessions.get(clientId);

    if (session.hostId && client) {
      this._send(client, {
        type: 'pong_host',
        hostId: session.hostId,
        pingId,
      });
    }
  }

  // /like — голос +1 за хостера комнаты (server-rating этап 2, замена /ban)
  _onLikeHost(session, { hostId, reason, token }) {
    return this._vote(session, hostId, 1, reason, token);
  }

  // /unlike — голос -1; like/unlike переставляют предыдущий голос того же
  // голосующего, а не копят оба
  _onUnlikeHost(session, { hostId, reason, token }) {
    return this._vote(session, hostId, -1, reason, token);
  }

  // голос гостя за/против хостера комнаты hostId; token — Bearer identity-
  // токен голосующего, hostRatingProxy проксирует голос в auth (единственный
  // источник истины для score/blocked). При достижении blockAt хост
  // блокируется глобально и его сигнальный WS закрывается — новые офферы к
  // нему больше не маршрутизируются (уже подключённые P2P-пиры это не рвёт)
  async _vote(session, hostId, value, reason, token) {
    // голос принимаем только от сессии, реально подключавшейся к комнате
    // (слала ей оффер) — иначе чужие голосуют, не заходя в игру
    if (!session.offeredHosts?.has(hostId)) {
      this._sendError(session, 'voteRejected');
      return;
    }

    const room = this._registry.get(hostId);

    if (!room) {
      this._sendError(session, 'unknownHost');
      return;
    }

    const voterUserId = await this._verifyToken(token);

    if (voterUserId === null) {
      this._sendError(session, 'invalidToken');
      return;
    }

    // причина обязательна (правило /like·/unlike) — голос без неё не
    // учитывается; наружу причины не отдаются, это аудит в БД auth
    if (typeof reason !== 'string' || !reason.trim()) {
      return;
    }

    if (!this._hostRatingProxy || room.hosterUserId === null) {
      return;
    }

    // кодревью №3: голос уже подтверждён гостю ("Vote sent") на клиенте —
    // при сбое auth хотя бы залогировать и не уронить обработчик молча
    let json;

    try {
      ({ json } = await this._hostRatingProxy.vote(
        token,
        room.hosterUserId,
        value,
        reason.trim(),
      ));
    } catch (err) {
      console.error('[rating] vote failed:', err.message);
      this._sendError(session, 'authServiceUnavailable');
      return;
    }

    // кэш рейтинга в лобби (server-rating этап 3) — свежее значение сразу,
    // не дожидаясь periodic-опроса refreshRatings()
    if (json?.score !== undefined) {
      this._registry.setRating(hostId, json.score);
    }

    if (json?.blocked) {
      this._evacuateHoster(room.hosterUserId, json.score);
    }
  }

  // закрывает все активные комнаты заблокированного хостера (кодревью №2):
  // раньше блок применялся только в register_host/на голосе, который сам
  // пересёк порог на этом же мастере — хостер, забаненный на другом мастере
  // (или в прошлом, до рестарта), продолжал держать живую комнату здесь
  _evacuateHoster(hosterUserId, score) {
    console.warn(`[rating] hoster ${hosterUserId} blocked (score ${score})`);

    for (const hostId of this._registry.getHostIdsForHoster(hosterUserId)) {
      this._getHostSession(hostId)?.ws.close(4002, 'blocked');
      this._registry.remove(hostId);
      this._hostSessions.delete(hostId);
    }
  }

  // периодически опрашивает auth за актуальным рейтингом каждого активного
  // хостера (server-rating этап 3) — держит кэш GET /servers свежим даже без
  // голосов на этом мастере (например, счёт изменился на другом мастере или
  // после рестарта); публичный эндпоинт auth, Bearer-токен хостера не нужен.
  // Кодревью №2: json.blocked теперь тоже применяется здесь — глобальный
  // блок эвакуирует уже запущенные комнаты, а не только новые регистрации
  async refreshRatings() {
    if (!this._hostRatingProxy) {
      return;
    }

    for (const hosterUserId of this._registry.getHosterUserIds()) {
      try {
        const { json } = await this._hostRatingProxy.getPublic(hosterUserId);

        if (!json) {
          continue;
        }

        if (json.blocked) {
          this._evacuateHoster(hosterUserId, json.score ?? 0);
          continue;
        }

        this._registry.setRatingForHoster(hosterUserId, json.score ?? 0);
      } catch (err) {
        console.error(`[rating] refresh failed for hoster ${hosterUserId}:`, err.message);
      }
    }
  }

  // проверяет Bearer identity-токен по JWKS central auth-сервиса; возвращает
  // числовой userId или null (нет jwksProxy, токен отсутствует/невалиден)
  async _verifyToken(token) {
    if (!this._jwksProxy || typeof token !== 'string') {
      return null;
    }

    try {
      const jwks = await this._jwksProxy.get();
      const payload = await verifyIdentityToken(token, { jwks, issuer: this._issuer });

      return Number(payload.sub);
    } catch {
      return null;
    }
  }

  _getHostSession(hostId) {
    return this._sessions.get(this._hostSessions.get(hostId));
  }

  _removeSession(session) {
    if (session.hostId) {
      this._registry.remove(session.hostId);
      this._hostSessions.delete(session.hostId);
    }

    this._sessions.delete(session.id);
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
