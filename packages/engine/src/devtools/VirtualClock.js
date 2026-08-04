import clock from '../lib/clock.js';

// Виртуальное время для headless-прогона: очередь отложенных задач + advance().
// Без него десятиминутный матч невозможно прогнать за секунды, а два прогона
// одного сценария не совпадут побайтово.
//
// Случайность тоже здесь: mulberry32 — маленький, полностью воспроизводимый
// PRNG (тот же seed → та же последовательность), в отличие от Math.random.

// одна итерация mulberry32
const mulberry32 = seed => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

class VirtualClock {
  /**
   * @param {Object} [options]
   * @param {number} [options.startTime] - Стартовая метка эпохи (мс) для now().
   * @param {number} [options.seed] - Seed PRNG для random().
   */
  constructor({ startTime = 1700000000000, seed = 1 } = {}) {
    this._startTime = startTime;
    // единый виртуальный счётчик: now() и monotonic() не могут разъехаться
    this._elapsed = 0;
    this._nextId = 1;
    this._tasks = new Map(); // id → { time, callback, interval }
    this._random = mulberry32(seed);
  }

  // ***** реализация clock ***** //

  now() {
    return this._startTime + this._elapsed;
  }

  monotonic() {
    return this._elapsed;
  }

  random() {
    return this._random();
  }

  setTimeout(callback, delay = 0) {
    return this._schedule(callback, delay, null);
  }

  setInterval(callback, delay = 0) {
    // нулевой интервал зациклил бы advance() навсегда
    return this._schedule(callback, delay, Math.max(1, delay));
  }

  clearTimeout(timerId) {
    this._tasks.delete(timerId);
  }

  clearInterval(timerId) {
    this._tasks.delete(timerId);
  }

  // ***** управление ***** //

  /**
   * Подменяет глобальный clock этим экземпляром.
   * @returns {Function} Функция отката.
   */
  install() {
    return clock.install({
      now: () => this.now(),
      monotonic: () => this.monotonic(),
      random: () => this.random(),
      setTimeout: (callback, delay) => this.setTimeout(callback, delay),
      clearTimeout: timerId => this.clearTimeout(timerId),
      setInterval: (callback, delay) => this.setInterval(callback, delay),
      clearInterval: timerId => this.clearInterval(timerId),
    });
  }

  /**
   * Прокручивает время на ms, выполняя созревшие задачи в порядке
   * (время, номер регистрации). Между задачами вычерпываются микрозадачи —
   * иначе очередь HostGame (queueMicrotask в createUser) отстаёт от таймеров.
   * @param {number} ms
   */
  async advance(ms) {
    const target = this._elapsed + ms;

    for (;;) {
      const next = this._earliest(target);

      if (!next) {
        break;
      }

      this._elapsed = next.time;

      if (next.interval === null) {
        this._tasks.delete(next.id);
      } else {
        next.time += next.interval;
      }

      next.callback();

      await flushMicrotasks();
    }

    this._elapsed = target;

    await flushMicrotasks();
  }

  // число зарегистрированных задач (диагностика утечек таймеров)
  get pendingCount() {
    return this._tasks.size;
  }

  _schedule(callback, delay, interval) {
    const id = this._nextId;

    this._nextId += 1;
    this._tasks.set(id, {
      id,
      time: this._elapsed + Math.max(0, delay),
      callback,
      interval,
    });

    return id;
  }

  // ближайшая задача не позже target; при равном времени — та, что
  // зарегистрирована раньше (иначе порядок зависел бы от обхода Map)
  _earliest(target) {
    let found = null;

    for (const task of this._tasks.values()) {
      if (task.time > target) {
        continue;
      }

      if (
        !found ||
        task.time < found.time ||
        (task.time === found.time && task.id < found.id)
      ) {
        found = task;
      }
    }

    return found;
  }
}

export const flushMicrotasks = () =>
  new Promise(resolve => queueMicrotask(resolve));

export default VirtualClock;
