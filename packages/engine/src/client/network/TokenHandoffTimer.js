// Передача роли хоста по сроку входа (host-migration-review этап 15, R2):
// хост с истекающим токеном не вернёт комнату reclaim_host после моргания
// сигналинга, поэтому за leadMs до истечения роль заранее уходит бете.
// Одна попытка теряется (беты ещё нет, идёт эстафета Worker'ов, передача
// сорвалась) — повтор через retryMs, пока вход не истёк.
//
// Без DOM: срок, попытку и таймеры инъектирует владелец (client/main.js).

export default class TokenHandoffTimer {
  /**
   * @param {Object} options
   * @param {Function} options.getExpiresAt - () → мс эпохи | null.
   * @param {number} options.leadMs
   * @param {number} options.retryMs
   * @param {Function} options.tryStart - () → true, если передача началась.
   * @param {Function} [options.now]
   * @param {Object} [options.timers] - { setTimeout, clearTimeout } (тесты).
   */
  constructor({
    getExpiresAt,
    leadMs,
    retryMs,
    tryStart,
    now = () => Date.now(),
    timers = globalThis,
  }) {
    this._getExpiresAt = getExpiresAt;
    this._leadMs = leadMs;
    this._retryMs = retryMs;
    this._tryStart = tryStart;
    this._now = now;
    this._timers = timers;
    this._timer = null;
  }

  // срок по текущему входу (роль хоста, новый вход, назначена бета): в окне
  // передачи — попытка сразу
  arm() {
    this._schedule(0);
  }

  // попытка не удалась или передача сорвалась: в окне передачи — повтор
  // через retryMs, раньше окна — обычный срок
  retry() {
    this._schedule(this._retryMs);
  }

  cancel() {
    if (this._timer !== null) {
      this._timers.clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _schedule(minDelay) {
    this.cancel();

    const expiresAt = this._getExpiresAt();

    if (expiresAt === null) {
      return;
    }

    const now = this._now();
    const delay = Math.max(minDelay, expiresAt - this._leadMs - now);

    // по истёкшему входу передача уже ничего не спасает
    if (now + delay >= expiresAt) {
      return;
    }

    this._timer = this._timers.setTimeout(() => {
      this._timer = null;

      if (this._tryStart() !== true) {
        this.retry();
      }
    }, delay);
  }
}
