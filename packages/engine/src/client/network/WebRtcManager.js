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
//
// Хост может открыть третий канал — standby (host-migration этап 6): только
// у назначенного мастером преемника; он отдаётся событием 'standby'.

/**
 * Тип своего локального ICE-кандидата в выбранной паре (host-migration этап
 * 6): 'relay' значит, что этому игроку для связи нужен ретранслятор.
 * Выбранная пара — по transport.selectedCandidatePairId, а без него — пара
 * nominated && succeeded.
 * @param {RTCStatsReport|Map} stats
 * @returns {string|null} 'host'|'srflx'|'prflx'|'relay' или null.
 */
export function selectedLocalCandidateType(stats) {
  if (!stats) {
    return null;
  }

  const reports = [...stats.values()];
  let pair = null;

  for (const report of reports) {
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      pair = stats.get(report.selectedCandidatePairId) ?? null;

      if (pair) {
        break;
      }
    }
  }

  pair ??=
    reports.find(
      report =>
        report.type === 'candidate-pair' &&
        report.nominated === true &&
        report.state === 'succeeded',
    ) ?? null;

  if (!pair) {
    return null;
  }

  return stats.get(pair.localCandidateId)?.candidateType ?? null;
}

export default class WebRtcManager {
  /**
   * @param {SignalingClient} signaling
   * @param {Object} [opts]
   * @param {Array} [opts.iceServers]
   * @param {Function} [opts.peerFactory] - фабрика RTCPeerConnection (тесты).
   * @param {string} [opts.memberId] - id вкладки (ключ участника на мастере).
   * @param {boolean} [opts.resume] - переподключение к матчу: хост не начнёт
   *   хендшейк, а будет ждать RESUME_REQUEST (host-migration этап 4).
   * @param {number} [opts.minEpoch] - эпоха хоста, известная клиенту: ответы
   *   более старых эпох — чужие (сообщения прежнего хоста).
   * @param {number} [opts.connectTimeoutMs] - каналы не открылись за это
   *   время — close('connectTimeout'); 0 — без таймаута.
   * @param {number} [opts.offerRetryMs] - пауза перед повтором оффера, на
   *   который мастер ответил error {code: 'migrating'} (комната в плановой
   *   передаче хоста, host-migration этап 8).
   * @param {number} [opts.iceStatsIntervalMs] - период перечитывания типа
   *   ICE-кандидата после открытия каналов; 0 — только один раз.
   * @param {Object} [opts.timers] - { setTimeout, clearTimeout } (тесты).
   */
  constructor(
    signaling,
    {
      iceServers,
      peerFactory,
      memberId,
      resume = false,
      minEpoch = null,
      connectTimeoutMs = 0,
      offerRetryMs = 1000,
      iceStatsIntervalMs = 30000,
      timers = globalThis,
    } = {},
  ) {
    this._signaling = signaling;
    this._iceServers = iceServers || signaling.iceServers;
    this._peerFactory =
      peerFactory || (config => new RTCPeerConnection(config));

    this._pc = null;
    this._meta = null;
    this._state = null;
    this._roomId = null;
    // id вкладки — хост хранит его рядом с clientId пира
    this._memberId = memberId ?? null;
    this._resume = resume === true;
    this._minEpoch = minEpoch;
    // эпоха хоста, ответившего на этот оффер: дальше чужие эпохи отсекаются
    this._epoch = null;
    this._connectTimeoutMs = connectTimeoutMs;
    this._timers = timers;
    this._connectTimer = null;
    this._offerRetryMs = offerRetryMs;
    this._retryTimer = null;
    this._offerSent = false;
    // свои ICE-кандидаты: повтор оффера отправляет их заново — прежние
    // ушли хосту, который оффер не принял
    this._sentCandidates = [];
    this._openChannels = 0;
    this._closed = false;
    // тип своего ICE-кандидата в выбранной паре (null — ещё не известен)
    this._iceType = null;
    this._iceStatsIntervalMs = iceStatsIntervalMs;
    this._iceTimer = null;

    this.publisher = new Publisher();

    // подписки на сигнальные ответы конкретно этого соединения; destroy()
    // их снимает — иначе брошенный менеджер ел бы ответы нового
    this._signaling.publisher.on('webrtc_answer', 'onAnswer', this);
    this._signaling.publisher.on('ice_candidate', 'onRemoteCandidate', this);
    this._signaling.publisher.on('error', 'onSignalingError', this);
  }

  // эпоха хоста, ответившего на оффер (null — ответа ещё не было)
  get epoch() {
    return this._epoch;
  }

  // тип своего локального ICE-кандидата в выбранной паре с хостом
  get iceType() {
    return this._iceType;
  }

  // инициирует установку соединения с текущим хостом комнаты
  async connect(roomId) {
    this._roomId = roomId;

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

    // канал standby открывает хост — только преемнику (этап 6)
    pc.ondatachannel = event => {
      if (event.channel?.label === 'standby') {
        event.channel.binaryType = 'arraybuffer';
        this.publisher.emit('standby', event.channel);
      }
    };

    this._startConnectTimer();

    pc.onicecandidate = event => {
      if (event.candidate) {
        this._sentCandidates.push(event.candidate);
        this._signaling.sendIceCandidate(roomId, event.candidate);
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

    // менеджер могли закрыть, пока собирался оффер
    if (this._closed) {
      return;
    }

    this._offerSent = true;
    this._sendOffer();
  }

  _sendOffer() {
    this._signaling.sendOffer(
      this._roomId,
      this._pc.localDescription,
      this._memberId,
      { resume: this._resume },
    );
  }

  // отказ мастера на оффер этой попытки: комната передаёт хоста (этап 8) —
  // тот же оффер через offerRetryMs, к хосту, который будет к тому времени.
  // Окно connectTimeoutMs отсчитывается заново: передача ограничена
  // таймаутом мастера, ожидание не бесконечно
  onSignalingError(msg) {
    // ответ про другую комнату или на другой запрос (join_room, голосование)
    // к этому офферу не относится
    if (msg?.roomId && msg.roomId !== this._roomId) {
      return;
    }

    if (msg?.re && msg.re !== 'webrtc_offer') {
      return;
    }

    if (
      msg?.code !== 'migrating' ||
      this._closed ||
      !this._offerSent ||
      this._epoch !== null ||
      this._retryTimer !== null
    ) {
      return;
    }

    this._clearConnectTimer();
    this._retryTimer = this._timers.setTimeout(() => {
      this._retryTimer = null;

      if (this._closed) {
        return;
      }

      this._startConnectTimer();
      this._sendOffer();

      for (const candidate of this._sentCandidates) {
        this._signaling.sendIceCandidate(this._roomId, candidate);
      }
    }, this._offerRetryMs);
  }

  // сообщение этой попытки: своя комната и эпоха не старше известной.
  // Эпоха фиксируется первым ответом — кандидаты прежнего хоста той же
  // комнаты после этого отсекаются
  _isOwnEpoch(epoch) {
    if (epoch === undefined || epoch === null) {
      return true;
    }

    if (this._epoch !== null) {
      return epoch === this._epoch;
    }

    return this._minEpoch === null || epoch >= this._minEpoch;
  }

  // приём SDP-ответа хоста (подписка на сигнальный канал); hostId — алиас
  // roomId от мастера до host-migration этапа 2
  async onAnswer(msg) {
    if (
      !this._pc ||
      this._closed ||
      (msg.roomId ?? msg.hostId) !== this._roomId ||
      !this._isOwnEpoch(msg.epoch)
    ) {
      return;
    }

    if (msg.epoch !== undefined && msg.epoch !== null) {
      this._epoch = msg.epoch;
    }

    await this._pc.setRemoteDescription(msg.sdp);
  }

  // приём удалённого ICE-кандидата (от хоста)
  async onRemoteCandidate(msg) {
    if (
      !this._pc ||
      this._closed ||
      msg.fromId !== this._roomId ||
      !this._isOwnEpoch(msg.epoch)
    ) {
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

  // тихое закрытие: отписка от сигналинга и закрытие pc без события 'close'
  // (менеджер брошен владельцем — например, супервизор сменил попытку)
  destroy() {
    this._unsubscribe();

    if (this._closed) {
      return;
    }

    this._closed = true;
    this._clearConnectTimer();
    this._clearRetryTimer();
    this._clearIceTimer();
    this._dropChannelHandlers();
    this._pc?.close();
  }

  _unsubscribe() {
    this._signaling.publisher.off('webrtc_answer', 'onAnswer', this);
    this._signaling.publisher.off('ice_candidate', 'onRemoteCandidate', this);
    this._signaling.publisher.off('error', 'onSignalingError', this);
  }

  // оба канала открыты и менеджер не закрыт
  get isOpen() {
    return this._openChannels === 2 && !this._closed;
  }

  // перечитывает тип ICE-кандидата; смена — событие 'iceType'
  async refreshIceType() {
    if (!this._pc || this._closed || typeof this._pc.getStats !== 'function') {
      return this._iceType;
    }

    let type = null;

    try {
      type = selectedLocalCandidateType(await this._pc.getStats());
    } catch {
      return this._iceType; // pc закрылся посреди запроса
    }

    if (!this._closed && type !== this._iceType) {
      this._iceType = type;
      this.publisher.emit('iceType', type);
    }

    return this._iceType;
  }

  // после открытия каналов — сразу и далее раз в iceStatsIntervalMs: пара
  // может смениться (ICE restart, смена сети)
  _watchIceType() {
    this.refreshIceType();

    if (this._iceStatsIntervalMs > 0) {
      this._iceTimer = this._timers.setTimeout(() => {
        this._iceTimer = null;
        this._watchIceType();
      }, this._iceStatsIntervalMs);
    }
  }

  _clearIceTimer() {
    if (this._iceTimer !== null) {
      this._timers.clearTimeout(this._iceTimer);
      this._iceTimer = null;
    }
  }

  // каналы не открылись вовремя (хост молчит, ICE не сошёлся) — попытка
  // провалена; 'failed' браузер может объявлять десятки секунд
  _startConnectTimer() {
    if (this._connectTimeoutMs > 0) {
      this._connectTimer = this._timers.setTimeout(() => {
        this._connectTimer = null;
        this._emitClose();
      }, this._connectTimeoutMs);
    }
  }

  _clearRetryTimer() {
    if (this._retryTimer !== null) {
      this._timers.clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
  }

  _clearConnectTimer() {
    if (this._connectTimer !== null) {
      this._timers.clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
  }

  // поздние события каналов закрытого менеджера не должны ничего эмитить
  _dropChannelHandlers() {
    for (const channel of [this._meta, this._state]) {
      if (channel) {
        channel.onopen = null;
        channel.onmessage = null;
        channel.onclose = null;
      }
    }

    if (this._pc) {
      this._pc.onicecandidate = null;
      this._pc.onconnectionstatechange = null;
      this._pc.ondatachannel = null;
    }
  }

  _wireChannel(channel) {
    channel.onopen = () => {
      this._openChannels += 1;

      // оба канала открыты — транспорт готов (как ws.onopen)
      if (this._openChannels === 2) {
        this._clearConnectTimer();
        this.publisher.emit('open');
        this._watchIceType();
      }
    };

    channel.onmessage = event => this.publisher.emit('message', event.data);
    channel.onclose = () => this._emitClose();
  }

  // кода закрытия у data channel нет: 'close' эмитится без аргумента, как
  // и раньше (код приходит только от WebSocket-транспорта dedicated)
  _emitClose() {
    if (this._closed) {
      return;
    }

    this._closed = true;
    this._clearConnectTimer();
    this._clearRetryTimer();
    this._clearIceTimer();
    this._unsubscribe();
    this._dropChannelHandlers();

    if (this._pc) {
      this._pc.close();
    }

    this.publisher.emit('close');
  }
}
