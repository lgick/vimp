import Publisher from '../../lib/Publisher.js';

// Транспорт хоста-игрока: та же вкладка играет в собственной комнате без
// WebRTC. Реализует интерфейс WebRtcManager (publisher c 'message'/'close',
// send/close), но данные ходят через HostController → Worker постмесседжами
// (postMessage-loopback). Для клиентского кода транспорт прозрачен.
//
// Флаг reliable игнорируется: loopback доставляет всё надёжно и по порядку
// (разделение meta/state актуально только для реального WebRTC).
export default class LoopbackTransport {
  /**
   * @param {HostController} controller - мост к Worker'у.
   * @param {string} [socketId] - id соединения хоста-игрока в Worker'е.
   */
  constructor(controller, socketId = 'local') {
    this._controller = controller;
    this._socketId = socketId;
    this._closed = false;

    this.publisher = new Publisher();
  }

  // поднимает loopback-соединение (аналог WebRtcManager.connect)
  connect() {
    this._controller.open(this._socketId, {
      onMessage: payload => this.publisher.emit('message', payload),
      onClose: () => this._emitClose(),
    });
  }

  // отправляет данные хосту (в Worker через роутер главного потока)
  send(data) {
    if (!this._closed) {
      this._controller.send(this._socketId, data);
    }
  }

  close() {
    this._emitClose();
  }

  _emitClose() {
    if (this._closed) {
      return;
    }

    this._closed = true;
    this._controller.disconnect(this._socketId);
    this.publisher.emit('close');
  }
}
