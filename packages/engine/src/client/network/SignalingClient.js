import Publisher from '../../lib/Publisher.js';

// Клиент сигнального WebSocket мастер-сервера (src/master/SignalingServer.js).
// Только координация установки P2P: приём welcome (id соединения + iceServers),
// обмен SDP-офферами/ответами и ICE-кандидатами, сигнальный ping/pong, жалобы.
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

  // клиент → SDP-оффер конкретному хосту
  sendOffer(hostId, sdp) {
    this._send({ type: 'webrtc_offer', hostId, sdp });
  }

  // хост → регистрация комнаты у мастера (ответ — событие 'host_registered').
  // token — Bearer identity-токен хостера (server-rating этап 2): без него
  // мастер отклоняет регистрацию, т.к. не может атрибутировать комнату и
  // проверить рейтинг хостера
  registerHost({ name, maxPlayers, mapName, gameId, gameVersion, token }) {
    this._send({
      type: 'register_host',
      name,
      maxPlayers,
      mapName,
      gameId,
      gameVersion,
      token,
    });
  }

  // хост → актуализация комнаты (заодно heartbeat)
  updateHost({ currentPlayers, mapName } = {}) {
    this._send({ type: 'update_host', currentPlayers, mapName });
  }

  // хост → SDP-ответ конкретному клиенту
  sendAnswer(clientId, sdp) {
    this._send({ type: 'webrtc_answer', clientId, sdp });
  }

  // хост → pong на сигнальный ping клиента (замер задержки в лобби)
  pongHost(clientId, pingId) {
    this._send({ type: 'pong_host', clientId, pingId });
  }

  // обмен ICE-кандидатами (targetId — hostId со стороны клиента)
  sendIceCandidate(targetId, candidate) {
    this._send({ type: 'ice_candidate', targetId, candidate });
  }

  // сигнальный ping хосту (замер приблизительный: клиент→мастер→хост)
  pingHost(hostId, pingId) {
    this._send({ type: 'ping_host', hostId, pingId });
  }

  // /like·/unlike напрямую мастеру (минуя хоста-читера), server-rating
  // этап 2: reason — причина (обязательна), token — Bearer identity-токен
  // голосующего
  likeHost(hostId, reason, token) {
    this._send({ type: 'like_host', hostId, reason, token });
  }

  unlikeHost(hostId, reason, token) {
    this._send({ type: 'unlike_host', hostId, reason, token });
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
