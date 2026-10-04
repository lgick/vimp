// Повтор join_room на unknownRoom (host-migration-review этап 6): после
// рестарта мастера реестр комнат пуст, и комната появляется, только когда
// хост вернёт её reclaim_host. Гость, чей сигналинг переподключился раньше
// хоста, повторяет вход с бэкоффом, пока не истечёт окно.
//
// Без DOM: отправку, таймеры и часы инъектирует владелец (client/main.js).

const DEFAULT_DELAYS_MS = [1000, 2000, 4000, 8000, 8000, 8000];

export default class JoinRetry {
  /**
   * @param {Object} opts
   * @param {Function} opts.send - () отправить join_room.
   * @param {number[]} [opts.delaysMs] - задержки попыток; последняя
   *   повторяется.
   * @param {number} [opts.windowMs] - сколько всего пытаться (от первого
   *   schedule() после stop()).
   * @param {Object} [opts.timers] - { setTimeout, clearTimeout }.
   * @param {Function} [opts.now]
   */
  constructor({
    send,
    delaysMs = DEFAULT_DELAYS_MS,
    windowMs = 30000,
    timers = globalThis,
    now = () => Date.now(),
  }) {
    this._send = send;
    this._delaysMs = delaysMs;
    this._windowMs = windowMs;
    this._timers = timers;
    this._now = now;
    this._timer = null;
    this._attempt = 0;
    this._startedAt = null;
  }

  // следующая попытка, если окно не истекло
  schedule() {
    if (this._timer !== null) {
      return;
    }

    const now = this._now();

    if (this._startedAt === null) {
      this._startedAt = now;
    } else if (now - this._startedAt >= this._windowMs) {
      return;
    }

    const delay =
      this._delaysMs[Math.min(this._attempt, this._delaysMs.length - 1)];

    this._attempt += 1;
    this._timer = this._timers.setTimeout(() => {
      this._timer = null;
      this._send();
    }, delay);
  }

  // снять таймер и сбросить окно: вход состоялся или вкладка ушла
  stop() {
    if (this._timer !== null) {
      this._timers.clearTimeout(this._timer);
      this._timer = null;
    }

    this._attempt = 0;
    this._startedAt = null;
  }
}
