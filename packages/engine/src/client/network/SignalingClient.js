import Publisher from '../../lib/Publisher.js';

// Клиент сигнального WebSocket мастер-сервера (src/master/SignalingServer.js).
// Координация установки P2P и членство в комнате: приём welcome (id
// соединения + iceServers), регистрация/возврат комнаты хостом, вход/выход
// участника, обмен SDP-офферами/ответами и ICE-кандидатами, сигнальный
// ping/pong.
// Игровой трафик идёт по WebRTC-каналам (WebRtcManager), не через мастер.
//
// Входящие сообщения ретранслируются подписчикам через Publisher по полю type;
// welcome дополнительно кэширует id/iceServers. Транспорт WebSocket инъекций
// ради тестируемости — фабрика по умолчанию использует глобальный WebSocket.
export default class SignalingClient {
  constructor(url, socketFactory = u => new WebSocket(u)) {
    this._url = url;
    this._socketFactory = socketFactory;

    this._ws = null;
    this._id = null;
    this._iceServers = [];

    this.publisher = new Publisher();
  }

  get id() {
    return this._id;
  }

  get iceServers() {
    return this._iceServers;
  }

  get connected() {
    return this._ws !== null && this._ws.readyState === this._ws.OPEN;
  }

  // открывает соединение; событие 'welcome' — после приёма welcome от мастера
  connect() {
    if (this._ws) {
      return;
    }

    const ws = this._socketFactory(this._url);

    this._ws = ws;

    ws.onopen = () => this.publisher.emit('open');
    ws.onerror = () => this.publisher.emit('socketError');

    ws.onclose = event => {
      this._ws = null;
      this.publisher.emit('close', event);
    };

    ws.onmessage = event => this._onMessage(event.data);
  }

  // клиент → SDP-оффер текущему хосту комнаты (мастер резолвит roomId).
  // resume — переподключение к матчу (host-migration этап 4): хост ждёт
  // RESUME_REQUEST вместо хендшейка
  sendOffer(roomId, sdp, memberId, { resume = false } = {}) {
    this._send({
      type: 'webrtc_offer',
      roomId,
      sdp,
      memberId,
      ...(resume ? { resume: true } : {}),
    });
  }

  // хост → регистрация комнаты у мастера (ответ — событие 'host_registered'
  // с roomId/epoch/roomSecret). token — Bearer identity-токен хоста: без
  // него мастер отклоняет регистрацию (комната привязана к проверенному
  // пользователю)
  // info — строка карточки лобби (gameConfig.lobbyInfo игры), null — нет;
  // caps — возможности вкладки (host-migration этап 6, lib/hostCaps.js);
  // settings — настройки комнаты для холодного перезапуска преемником
  // (этап 7.6, lib/roomSettings.js); promotion — { roomId, epoch,
  // promotionToken } из promote мастера (этап 7.4): преемник занимает
  // существующую комнату, а не создаёт новую
  registerHost({
    gameId,
    gameVersion,
    maxPlayers,
    info,
    token,
    memberId,
    caps,
    settings,
    promotion = null,
  }) {
    this._send({
      type: 'register_host',
      gameId,
      gameVersion,
      maxPlayers,
      info,
      token,
      memberId,
      caps,
      settings,
      ...(promotion
        ? {
            roomId: promotion.roomId,
            epoch: promotion.epoch,
            promotionToken: promotion.promotionToken,
          }
        : {}),
    });
  }

  // хост → та же комната после реконнекта сигналинга или рестарта мастера.
  // Поля комнаты (игра, вместимость, карточка) нужны мастеру, чтобы создать её
  // заново, если реестр пуст
  reclaimHost({
    roomId,
    epoch,
    roomSecret,
    memberId,
    token,
    gameId,
    gameVersion,
    maxPlayers,
    info,
    caps,
    settings,
  }) {
    this._send({
      type: 'reclaim_host',
      roomId,
      epoch,
      roomSecret,
      memberId,
      token,
      gameId,
      gameVersion,
      maxPlayers,
      info,
      caps,
      settings,
    });
  }

  // хост → актуализация карточки комнаты (заодно heartbeat); info: null
  // очищает строку у мастера
  updateHost({ info } = {}) {
    this._send({ type: 'update_host', info });
  }

  // гость → вошёл в матч комнаты (ответ — 'room_joined'); повторяется с тем
  // же memberId после реконнекта сигналинга
  // caps — возможности вкладки: по ним мастер выбирает преемника хоста
  joinRoom({ roomId, memberId, token, caps }) {
    this._send({ type: 'join_room', roomId, memberId, token, caps });
  }

  // участник → возможности изменились (вкладка спрятана/показана, сменился
  // тип ICE-кандидата) — host-migration этап 6
  memberUpdate(roomId, caps) {
    this._send({ type: 'member_update', roomId, caps });
  }

  // бета → у неё есть полная контрольная точка (id и свежесть: ageMs —
  // сколько назад бета её получила)
  standbyStatus({ roomId, epoch, checkpointId, createdAt, ageMs }) {
    this._send({
      type: 'standby_status',
      roomId,
      epoch,
      checkpointId,
      createdAt,
      ageMs,
    });
  }

  // хост → участники с открытыми каналами к нему: мастер считает игроков
  // и кандидатов в беты только по ним
  roomPeers({ roomId, epoch, memberIds }) {
    this._send({ type: 'room_peers', roomId, epoch, memberIds });
  }

  // хост → ответ на пробу мастера (host-migration этап 7.3): главный поток
  // жив и держит сигналинг
  probeAck(nonce) {
    this._send({ type: 'probe_ack', nonce });
  }

  // гость → WebRTC к хосту комнаты оборвался (host-migration этап 7.2):
  // свидетельство мастеру, он решает — проба хоста или смена
  hostUnreachable(roomId, epoch) {
    this._send({ type: 'host_unreachable', roomId, epoch });
  }

  // преемник → поднять матч не удалось (плагин, wasm, init): мастер берёт
  // следующего кандидата (host-migration этап 7.4)
  promoteFailed({ roomId, epoch, promotionToken }) {
    this._send({ type: 'promote_failed', roomId, epoch, promotionToken });
  }

  // хост → плановая передача роли бете (host-migration этап 8): ответ —
  // handoff_go {epoch} или handoff_unavailable {reason}. stay — останется ли
  // вкладка в комнате гостем (мастеру не нужно, для журнала)
  handoffBegin({ roomId, epoch, reason, stay }) {
    this._send({ type: 'handoff_begin', roomId, epoch, reason, stay });
  }

  // хост → здоровье матча (host-migration этап 9c, раз в ~2 с): мастер
  // сравнивает сеть хоста и беты и при стойком лаге шлёт request_handoff
  hostHealth({ roomId, epoch, tickRate, peerRttMedian, peerCount }) {
    this._send({
      type: 'host_health',
      roomId,
      epoch,
      tickRate,
      peerRttMedian,
      peerCount,
    });
  }

  // хост → вкладка уходит (pagehide, «Leave server» без передачи): мастер
  // начинает аварийную миграцию сразу, не дожидаясь обрыва WS
  hostLeaving(roomId, epoch) {
    this._send({ type: 'host_leaving', roomId, epoch });
  }

  // хост → в комнате нет людей, он пишет очки перед закрытием: мастер
  // скрывает комнату и закрывает её для входа до host_leaving
  hostClosing(roomId, epoch) {
    this._send({ type: 'host_closing', roomId, epoch });
  }

  // гость → покинул комнату
  leaveRoom(roomId) {
    this._send({ type: 'leave_room', roomId });
  }

  // голосование «Change host» (host-migration этап 10): голоса считает мастер
  hostVoteStart(roomId) {
    this._send({ type: 'host_vote_start', roomId });
  }

  hostVoteAnswer({ roomId, voteId, value }) {
    this._send({ type: 'host_vote_answer', roomId, voteId, value });
  }

  // хост → SDP-ответ конкретному клиенту
  sendAnswer(clientId, sdp) {
    this._send({ type: 'webrtc_answer', clientId, sdp });
  }

  // хост → pong на сигнальный ping клиента (замер задержки в лобби)
  pongHost(clientId, pingId) {
    this._send({ type: 'pong_host', clientId, pingId });
  }

  // обмен ICE-кандидатами (targetId — roomId со стороны клиента)
  sendIceCandidate(targetId, candidate) {
    this._send({ type: 'ice_candidate', targetId, candidate });
  }

  // сигнальный ping хосту (замер приблизительный: клиент→мастер→хост)
  pingHost(roomId, pingId) {
    this._send({ type: 'ping_host', roomId, pingId });
  }

  close() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  _onMessage(raw) {
    let msg;

    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    if (msg.type === 'welcome') {
      this._id = msg.id;
      this._iceServers = msg.iceServers || [];
    }

    this.publisher.emit(msg.type, msg);
  }

  _send(message) {
    if (this.connected) {
      this._ws.send(JSON.stringify(message));
    }
  }
}
