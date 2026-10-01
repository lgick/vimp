import clock from './clock.js';

/**
 * @class AbstractTimer
 * @description Базовый класс для управления таймерами (setTimeout, setInterval)
 * Унифицированные методы для запуска и остановки таймеров по ключу
 */
class AbstractTimer {
  constructor() {
    // хранилище для всех активных таймеров по их ключам
    this._timers = new Map();
  }

  /**
   * Централизованно запускает таймер и сохраняет его в Map,
   * если таймер с таким ключом уже существует, он будет сперва остановлен
   * Для setTimeout ключ удаляется автоматически после срабатывания.
   * @protected
   * @param {string} key - уникальный ключ для идентификации таймера
   * @param {function} callback - функция по завершению времени
   * @param {number} duration - длительность в миллисекундах
   * @param {boolean} [isInterval=false] - setInterval или setTimeout
   */
  _startTimer(key, callback, duration, isInterval = false) {
    // остановка существующего таймера с тем же ключом
    this._stopTimer(key);

    if (isInterval) {
      // setInterval живёт, пока его не остановят
      const timerId = clock.setInterval(callback, duration);
      this._timers.set(key, { timerId, isInterval });
    } else {
      // setTimeout удаляется сразу после выполнения
      const wrappedCallback = () => {
        this._timers.delete(key);
        callback();
      };

      const timerId = clock.setTimeout(wrappedCallback, duration);

      // срок и исходный колбэк — для остатка времени и паузы (контрольная
      // точка хоста, host-migration этап 5)
      this._timers.set(key, {
        timerId,
        isInterval,
        callback,
        endsAt: clock.now() + duration,
        leftMs: null,
      });
    }
  }

  /**
   * Остаток времени setTimeout-таймера (у стоящего на паузе — замороженный).
   * @protected
   * @param {string} key - ключ таймера
   * @returns {number|null} - миллисекунды; null — таймера нет или интервал
   */
  _timeLeft(key) {
    const entry = this._timers.get(key);

    if (!entry || entry.isInterval) {
      return null;
    }

    if (entry.leftMs !== null) {
      return entry.leftMs;
    }

    return Math.max(0, entry.endsAt - clock.now());
  }

  /**
   * Ставит setTimeout-таймеры на паузу: срабатывание снимается, остаток
   * запоминается, ключ остаётся (_hasTimer по-прежнему true).
   * @protected
   * @param {function} [filter] - (key) => boolean; без него — все
   */
  _pauseTimers(filter = () => true) {
    for (const [key, entry] of this._timers) {
      if (entry.isInterval || entry.leftMs !== null || !filter(key)) {
        continue;
      }

      clock.clearTimeout(entry.timerId);
      entry.leftMs = Math.max(0, entry.endsAt - clock.now());
    }
  }

  /**
   * Снимает с паузы таймеры, поставленные _pauseTimers: каждый дожидается
   * своего остатка.
   * @protected
   * @param {function} [filter] - (key) => boolean; без него — все
   */
  _resumeTimers(filter = () => true) {
    const paused = [...this._timers].filter(
      ([key, entry]) => entry.leftMs !== null && filter(key),
    );

    for (const [key, entry] of paused) {
      this._startTimer(key, entry.callback, entry.leftMs);
    }
  }

  /**
   * Централизованно останавливает таймер по его ключу
   * @protected
   * @param {string} key - ключ таймера, который нужно остановить
   */
  _stopTimer(key) {
    if (this._timers.has(key)) {
      const { timerId, isInterval } = this._timers.get(key);

      // вызов через clock, а не отрыв метода от объекта: сейчас это
      // замыкания, но привязка к модулю не должна зависеть от этого
      if (isInterval) {
        clock.clearInterval(timerId);
      } else {
        clock.clearTimeout(timerId);
      }

      this._timers.delete(key);
    }
  }

  /**
   * Проверяет наличие активного таймера по ключу
   * @protected
   * @param {string} key - ключ для проверки
   * @returns {boolean} - true, если таймер существует, иначе false
   */
  _hasTimer(key) {
    return this._timers.has(key);
  }

  /**
   * Останавливает и удаляет все активные таймеры, управляемые этим экземпляром
   * @protected
   */
  _clearAllTimers() {
    for (const timerData of this._timers.values()) {
      const { timerId, isInterval } = timerData;

      if (isInterval) {
        clock.clearInterval(timerId);
      } else {
        clock.clearTimeout(timerId);
      }
    }

    this._timers.clear();
  }
}

export default AbstractTimer;
