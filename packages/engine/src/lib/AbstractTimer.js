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
      const timerId = setInterval(callback, duration);
      this._timers.set(key, { timerId, isInterval });
    } else {
      // setTimeout удаляется сразу после выполнения
      const wrappedCallback = () => {
        this._timers.delete(key);
        callback();
      };

      const timerId = setTimeout(wrappedCallback, duration);
      this._timers.set(key, { timerId, isInterval });
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
      const handler = isInterval ? clearInterval : clearTimeout;

      handler(timerId);

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
      const handler = isInterval ? clearInterval : clearTimeout;

      handler(timerId);
    }

    this._timers.clear();
  }
}

export default AbstractTimer;
