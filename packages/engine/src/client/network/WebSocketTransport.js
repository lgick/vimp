import Publisher from '../../lib/Publisher.js';

// Третий транспорт клиента (Этап 2 плана standalone-sdk): прямой WebSocket к
// dedicated-серверу. Интерфейсный близнец WebRtcManager и LoopbackTransport —
// publisher с 'message'/'close', connect/send/close, — поэтому клиентский код
// про него не знает.
//
// Отличия от WebRTC, которые надо держать в голове (см. docs/en/network.md):
// разделения meta/state тут нет, флаг reliable игнорируется. Значит PING/PONG
// идут надёжным каналом (замер RTT становится замером TCP-пути), а бэкпрешер
// вместо дропа позиционных кадров живёт на серверной стороне.

// WebSocket.OPEN: константа класса, а не инстанса — у фейкового сокета в
// тестах её может не быть вовсе
const WS_OPEN = 1;

export default class WebSocketTransport {
  /**
   * @param {string} url - Адрес игрового WebSocket.
   * @param {Object} [options]
   * @param {Function} [options.socketFactory] - Фабрика сокета (тесты).
   */
  constructor(url, { socketFactory = u => new WebSocket(u) } = {}) {
    this._url = url;
    this._socketFactory = socketFactory;
    this._ws = null;
    this._closed = false;

    this.publisher = new Publisher();
  }

  connect() {
    this._ws = this._socketFactory(this._url);

    // обязательно: клиент различает кадр снапшота и JSON-порт по
    // `data instanceof ArrayBuffer`, а дефолтный браузерный WS отдаёт Blob
    this._ws.binaryType = 'arraybuffer';

    this._ws.onopen = () => this.publisher.emit('open');
    this._ws.onmessage = event => this.publisher.emit('message', event.data);
    // код закрытия уезжает подписчику: политические отказы сервера (лимит
    // подключений, таймаут хендшейка) клиент лечить перезагрузкой не должен —
    // см. handleDisconnect в main.js
    this._ws.onclose = event => this._emitClose(event?.code);
    // ошибка сокета всегда сопровождается close — отдельного события наружу
    // не даём, иначе клиент погасил бы матч дважды
    this._ws.onerror = () => {};
  }

  /**
   * @param {string|ArrayBuffer} data - Кадр.
   * @param {boolean} [reliable] - Игнорируется: у WebSocket нет уровней
   *   надёжности, всё едет надёжно и по порядку.
   */
  send(data) {
    if (this._ws && this._ws.readyState === WS_OPEN) {
      this._ws.send(data);
    }
  }

  close() {
    if (this._closed) {
      return;
    }

    this._ws?.close();
    this._emitClose();
  }

  _emitClose(code) {
    if (this._closed) {
      return;
    }

    this._closed = true;
    this.publisher.emit('close', code);
  }
}
