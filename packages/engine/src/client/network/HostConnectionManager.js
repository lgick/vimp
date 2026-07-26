// WebRTC-answerer браузерного хоста (Фаза 2 Этапа 4). Зеркало WebRtcManager:
// клиент — offerer (создаёт каналы meta/state и оффер), хост здесь — answerer.
// Живёт в главном потоке (RTCPeerConnection в Worker'е недоступны); входящие
// кадры каналов уходят в Worker через HostController, исходящие Worker-кадры
// раскладываются по каналам meta (reliable) / state (unreliable) по флагу
// reliable из ядра (body_has_events). Медленным пирам state-кадры дропаются
// по bufferedAmount (бэкпрешер) — meta не дропается никогда.
export default class HostConnectionManager {
  /**
   * @param {SignalingClient} signaling - сигнальный WS мастера.
   * @param {HostController} controller - мост к Worker'у хоста.
   * @param {Object} [opts]
   * @param {Array} [opts.iceServers]
   * @param {Function} [opts.peerFactory] - фабрика RTCPeerConnection (тесты).
   * @param {number} [opts.backpressureThreshold] - порог bufferedAmount на
   *   state-канале, при превышении позиционные кадры дропаются (байты).
   * @param {Function} [opts.onPeersChange] - вызывается с числом активных
   *   пиров при подключении/отключении (актуализация currentPlayers).
   */
  constructor(signaling, controller, opts = {}) {
    this._signaling = signaling;
    this._controller = controller;
    this._iceServers = opts.iceServers || signaling.iceServers;
    this._peerFactory =
      opts.peerFactory || (config => new RTCPeerConnection(config));
    this._threshold = opts.backpressureThreshold ?? 262144; // 256 КБ
    this._onPeersChange = opts.onPeersChange;

    this._peers = new Map(); // clientId → { pc, meta, state, openCount }

    signaling.publisher.on('webrtc_offer', 'onOffer', this);
    signaling.publisher.on('ice_candidate', 'onRemoteCandidate', this);
    signaling.publisher.on('ping_host', 'onPing', this);
  }

  // приём SDP-оффера клиента: создаёт peer, отвечает answer
  async onOffer(msg) {
    const { clientId, sdp } = msg;

    if (this._peers.has(clientId)) {
      return;
    }

    const pc = this._peerFactory({ iceServers: this._iceServers });
    const peer = { pc, meta: null, state: null, openCount: 0 };

    this._peers.set(clientId, peer);

    // каналы создаёт offerer — ловим их здесь
    pc.ondatachannel = event => this._wireChannel(clientId, peer, event.channel);

    pc.onicecandidate = event => {
      if (event.candidate) {
        this._signaling.sendIceCandidate(clientId, event.candidate);
      }
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;

      // 'disconnected' транзиентен (может восстановиться) — не рвём;
      // реальный обрыв доведёт до 'failed' или закроет каналы (onclose)
      if (st === 'failed' || st === 'closed') {
        this._closePeer(clientId);
      }
    };

    try {
      await pc.setRemoteDescription(sdp);

      const answer = await pc.createAnswer();

      await pc.setLocalDescription(answer);
    } catch (e) {
      // битый SDP или peer уже закрыт — не оставляем осиротевшую запись
      this._closePeer(clientId);
      return;
    }

    this._signaling.sendAnswer(clientId, pc.localDescription);
  }

  // приём ICE-кандидата клиента
  async onRemoteCandidate(msg) {
    const peer = this._peers.get(msg.fromId);

    if (!peer) {
      return;
    }

    try {
      await peer.pc.addIceCandidate(msg.candidate);
    } catch (e) {
      // кандидат до setRemoteDescription или дубль — не критично
    }
  }

  // сигнальный ping клиента из лобби → pong (замер приблизительный)
  onPing(msg) {
    this._signaling.pongHost(msg.clientId, msg.pingId);
  }

  _wireChannel(clientId, peer, channel) {
    channel.binaryType = 'arraybuffer';

    if (channel.label === 'meta') {
      peer.meta = channel;
    } else if (channel.label === 'state') {
      peer.state = channel;
    }

    // входящие сообщения клиента (управление) — в Worker
    channel.onmessage = event => this._controller.send(clientId, event.data);
    channel.onclose = () => this._closePeer(clientId);

    channel.onopen = () => {
      // peer мог закрыться до открытия второго канала (гонка open/close) —
      // фантомное соединение в Worker'е поднимать нельзя
      if (this._peers.get(clientId) !== peer) {
        return;
      }

      peer.openCount += 1;

      // оба канала открыты — поднимаем соединение клиента в Worker'е
      // (Worker сразу шлёт CONFIG_DATA по meta)
      if (peer.openCount === 2) {
        this._controller.open(clientId, {
          onMessage: (payload, reliable) => this._deliver(peer, payload, reliable),
          onClose: () => this._closePeer(clientId),
        });

        this._onPeersChange?.(this._peers.size);
      }
    };
  }

  // раскладывает исходящий Worker-кадр по каналам meta/state
  _deliver(peer, payload, reliable) {
    // JSON-протокол и событийные кадры — надёжно по meta; позиционные кадры
    // и PING — по state (замер RTT не искажается ретрансмиссиями meta)
    const channel = reliable === false ? peer.state : peer.meta;

    if (!channel || channel.readyState !== 'open') {
      return;
    }

    // бэкпрешер: позиционные кадры медленному пиру дропаем (следующий кадр
    // компенсирует потерю); meta не дропается никогда
    if (reliable === false && channel.bufferedAmount > this._threshold) {
      return;
    }

    channel.send(payload);
  }

  _closePeer(clientId) {
    const peer = this._peers.get(clientId);

    if (!peer) {
      return;
    }

    this._peers.delete(clientId);
    this._controller.disconnect(clientId); // Worker: removeUser

    // снять обработчики каналов — замыкания не должны удерживать peer
    for (const channel of [peer.meta, peer.state]) {
      if (channel) {
        channel.onopen = null;
        channel.onmessage = null;
        channel.onclose = null;
      }
    }

    try {
      peer.pc.close();
    } catch (e) {
      // уже закрыт
    }

    this._onPeersChange?.(this._peers.size);
  }

  // число активных пиров (для currentPlayers у мастера)
  get peerCount() {
    return this._peers.size;
  }

  // закрывает все соединения (закрытие комнаты)
  destroy() {
    for (const clientId of [...this._peers.keys()]) {
      this._closePeer(clientId);
    }
  }
}
