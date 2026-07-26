import Publisher from '../../lib/Publisher.js';

// Транспорт P2P-соединения клиента с браузерным хостом. Заменяет игровой
// WebSocket: два RTCDataChannel вместо одного сокета.
//
// - meta  (reliable-ordered)      — весь JSON-протокол [portId, payload] и
//                                    бинарные кадры с одноразовыми событиями;
// - state (unreliable-unordered)  — чисто позиционные бинарные кадры, их
//                                    потерю компенсирует следующий кадр.
//
// Классификация кадров meta/state — на стороне хоста при упаковке. Клиент лишь
// принимает данные из обоих каналов и отдаёт их одним потоком (событие
// 'message'), как раньше делал ws.onmessage. Исходящие сообщения клиента —
// управляющие, идут по reliable-каналу meta.
//
// Клиент — инициатор (offerer): создаёт каналы и оффер, обменивается с хостом
// SDP/ICE через сигнальный WebSocket (SignalingClient). RTCPeerConnection
// инъектируется фабрикой ради тестируемости.
export default class WebRtcManager {
  constructor(signaling, { iceServers, peerFactory } = {}) {
    this._signaling = signaling;
    this._iceServers = iceServers || signaling.iceServers;
    this._peerFactory =
      peerFactory || (config => new RTCPeerConnection(config));

    this._pc = null;
    this._meta = null;
    this._state = null;
    this._hostId = null;
    this._openChannels = 0;
    this._closed = false;

    this.publisher = new Publisher();

    // подписки на сигнальные ответы конкретно этого соединения
    this._signaling.publisher.on('webrtc_answer', 'onAnswer', this);
    this._signaling.publisher.on('ice_candidate', 'onRemoteCandidate', this);
  }

  // инициирует установку соединения с хостом
  async connect(hostId) {
    this._hostId = hostId;

    const pc = this._peerFactory({ iceServers: this._iceServers });

    this._pc = pc;

    // meta открывает канал, отправляемый по надёжному упорядоченному потоку
    this._meta = pc.createDataChannel('meta', { ordered: true });
    this._meta.binaryType = 'arraybuffer';

    // state — ненадёжный неупорядоченный (позиционные кадры)
    this._state = pc.createDataChannel('state', {
      ordered: false,
      maxRetransmits: 0,
    });
    this._state.binaryType = 'arraybuffer';

    this._wireChannel(this._meta);
    this._wireChannel(this._state);

    pc.onicecandidate = event => {
      if (event.candidate) {
        this._signaling.sendIceCandidate(hostId, event.candidate);
      }
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;

      // 'disconnected' транзиентен (может восстановиться) — не рвём;
      // реальный обрыв доведёт до 'failed' или закроет каналы (onclose)
      if (st === 'failed' || st === 'closed') {
        this._emitClose();
      }
    };

    const offer = await pc.createOffer();

    await pc.setLocalDescription(offer);

    this._signaling.sendOffer(hostId, pc.localDescription);
  }

  // приём SDP-ответа хоста (подписка на сигнальный канал)
  async onAnswer(msg) {
    if (!this._pc || msg.hostId !== this._hostId) {
      return;
    }

    await this._pc.setRemoteDescription(msg.sdp);
  }

  // приём удалённого ICE-кандидата (от хоста)
  async onRemoteCandidate(msg) {
    if (!this._pc || msg.fromId !== this._hostId) {
      return;
    }

    try {
      await this._pc.addIceCandidate(msg.candidate);
    } catch (e) {
      // кандидат до setRemoteDescription или дубль — не критично
    }
  }

  // отправляет данные хосту; управляющие сообщения клиента — по meta
  send(data, reliable = true) {
    const channel = reliable ? this._meta : this._state;

    if (channel && channel.readyState === 'open') {
      channel.send(data);
    }
  }

  close() {
    this._emitClose();
  }

  _wireChannel(channel) {
    channel.onopen = () => {
      this._openChannels += 1;

      // оба канала открыты — транспорт готов (как ws.onopen)
      if (this._openChannels === 2) {
        this.publisher.emit('open');
      }
    };

    channel.onmessage = event => this.publisher.emit('message', event.data);
    channel.onclose = () => this._emitClose();
  }

  _emitClose() {
    if (this._closed) {
      return;
    }

    this._closed = true;

    if (this._pc) {
      this._pc.close();
    }

    this.publisher.emit('close');
  }
}
