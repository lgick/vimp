import wsports from '../config/wsports.js';
import SocketManager from '../host/meta/SocketManager.js';

// Транспорт хоста, который вместо сети пишет исходящие вызовы в память.
// Наследует боевой SocketManager, а не копирует его отправителей: составные
// отправители (sendFirstShot и компания), нагрузка портов и их номера
// остаются одни на прод и на headless — ручная копия уже расходилась с
// оригиналом и стоила прогону keySet, панели и первого снапшота мира.
//
// Записывается сам вызов (метод + аргументы, как их видит хост), а нагрузка
// транспорта — тем, что настоящий код успел передать в _send/_sendBinary:
// проверки инвариантов рассуждают о семантике («roundEnd объявил победителя»),
// а VirtualClient — о том, что реально уехало бы в data channel.

// имена отправителей берутся из прототипа: ручной список неизбежно отстаёт
// от боевого класса, что уже случалось
const SENDER_METHODS = Object.getOwnPropertyNames(SocketManager.prototype)
  .filter(name => name.startsWith('send'));

class RecordingSocketManager extends SocketManager {
  /**
   * @param {Object} [ports] - Карта портов host→client; по умолчанию боевая
   *   (движковые тесты меты создают транспорт без аргументов).
   * @param {Object} [gameOpts] - Игровая параметризация ({ soundCues,
   *   initialVote }) — та же, что получает боевой SocketManager.
   * @param {Object} [options]
   * @param {Function} [options.onFrame] - Вызывается на каждый исходящий кадр
   *   ({ method, socketId, args, tick, sent }) — runner раздаёт их
   *   VirtualClient'ам, не дожидаясь конца прогона.
   */
  constructor(ports = wsports.server, gameOpts = {}, { onFrame = null } = {}) {
    super(ports, gameOpts);

    this.frames = []; // [{ method, socketId, args, tick, sent }]

    // номер тика прогона: runner двигает его перед каждым шагом, кадры
    // получают метку — без неё проверки жизненного цикла раунда не могут
    // сказать «кому именно не доехал roundEnd на этом тике»
    this.tick = 0;
    this._onFrame = onFrame;

    // кадр, чьё тело сейчас исполняется: в него уходит нагрузка _send;
    // составные отправители вкладываются друг в друга, поэтому это стек
    // через локальную переменную в _record
    this._current = null;

    for (const method of SENDER_METHODS) {
      this[method] = (socketId, ...args) => {
        this._record(method, socketId, args, () =>
          SocketManager.prototype[method].call(this, socketId, ...args),
        );
      };
    }
  }

  close(socketId, code, key, arr) {
    this._record('close', socketId, [code, key, arr], () =>
      super.close(socketId, code, key, arr),
    );
  }

  // все кадры указанного метода
  framesOf(method) {
    return this.frames.filter(frame => frame.method === method);
  }

  clearFrames() {
    this.frames.length = 0;
  }

  // сети нет: всё, что боевой код отдал бы сокету, оседает в текущем кадре
  _send(socketId, port, data, reliable = true) {
    this._payload({ port, data, reliable });
  }

  _sendBinary(socketId, buffer, reliable) {
    this._payload({ port: this._PORT_SHOT_DATA, data: buffer, reliable });
  }

  _close(socketId, code, data) {
    this._payload({ port: null, data: { code, data } });
  }

  // Кадр публикуется в момент первой отправки — это и есть порядок провода:
  // составной отправитель отдаёт свою нагрузку раньше вложенных вызовов
  // (FIRST_SHOT_DATA → STAT → PANEL → KEYSET), и клиент прогона видит ту же
  // последовательность, что и браузер. Публикация после invoke() отдавала бы
  // родителя последним.
  //
  // Отсюда несущее допущение: у отправителя не больше ОДНОЙ собственной
  // нагрузки (составные раскладываются во вложенные вызовы, а два _send в
  // sendClear/sendTechInform — это ветки if/else). Нарушь его — и подписчик
  // получит кадр, собранный наполовину, уже после решения о маршрутизации.
  // Поэтому не молчим, а называем контракт.
  _payload(entry) {
    const frame = this._current;

    if (!frame) {
      return;
    }

    if (frame.sent.length) {
      throw new Error(
        `RecordingSocketManager: '${frame.method}' sent a second payload ` +
          `(port ${entry.port}) — a sender may hand the socket at most one, ` +
          'otherwise the subscriber already routed a half-built frame; ' +
          'split it into nested senders like sendFirstShot does',
      );
    }

    frame.sent.push(entry);
    this._emit(frame);
  }

  _record(method, socketId, args, invoke) {
    const frame = { method, socketId, args, tick: this.tick, sent: [] };
    const parent = this._current;

    this.frames.push(frame);
    this._current = frame;

    try {
      invoke();
    } finally {
      this._current = parent;
    }

    // отправитель без собственной нагрузки (составной вроде
    // sendPlayerDefaultShot либо отфильтрованный прод-кодом незамапленный
    // soundCue) всё равно доезжает до подписчика — но ровно один раз
    if (!frame.sent.length) {
      this._emit(frame);
    }
  }

  _emit(frame) {
    if (this._onFrame) {
      this._onFrame(frame);
    }
  }
}

export default RecordingSocketManager;
