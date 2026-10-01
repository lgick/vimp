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
  // resume — возобновление места в матче (host-migration этап 7.4:
  // преемник возвращает своего игрока в поднятый им матч): Worker ждёт
  // RESUME_REQUEST, а 'open' сообщает супервизору, что его пора слать
  constructor(controller, socketId = 'local', { resume = false } = {}) {
    this._controller = controller;
    this._socketId = socketId;
    this._resume = resume;
    this._closed = false;

    this.publisher = new Publisher();
  }

  // поднимает loopback-соединение (аналог WebRtcManager.connect)
  connect() {
    this._controller.open(this._socketId, {
      onMessage: payload => this.publisher.emit('message', payload),
      onClose: () => this._emitClose(),
      resume: this._resume,
    });

    // подписчики появляются после connect() (супервизор берёт уже
    // подключённый транспорт) — 'open' уходит следующей микрозадачей
    if (this._resume) {
      queueMicrotask(() => {
        if (!this._closed) {
          this.publisher.emit('open');
        }
      });
    }
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
