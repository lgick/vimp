import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AbstractTimer from '../../packages/engine/src/lib/AbstractTimer.js';
import clock from '../../packages/engine/src/lib/clock.js';

// подкласс для доступа к protected-методам
class TestTimer extends AbstractTimer {
  start(key, cb, duration, isInterval) {
    this._startTimer(key, cb, duration, isInterval);
  }
  stop(key) {
    this._stopTimer(key);
  }
  has(key) {
    return this._hasTimer(key);
  }
  clearAll() {
    this._clearAllTimers();
  }
}

describe('AbstractTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('setTimeout срабатывает один раз и удаляет ключ', () => {
    const timer = new TestTimer();
    const cb = vi.fn();

    timer.start('t', cb, 1000);
    expect(timer.has('t')).toBe(true);

    vi.advanceTimersByTime(1000);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(timer.has('t')).toBe(false);
  });

  it('setInterval срабатывает многократно и остаётся активным', () => {
    const timer = new TestTimer();
    const cb = vi.fn();

    timer.start('i', cb, 100, true);
    vi.advanceTimersByTime(350);

    expect(cb).toHaveBeenCalledTimes(3);
    expect(timer.has('i')).toBe(true);
  });

  it('повторный start с тем же ключом перезапускает таймер', () => {
    const timer = new TestTimer();
    const first = vi.fn();
    const second = vi.fn();

    timer.start('t', first, 1000);
    vi.advanceTimersByTime(500);
    timer.start('t', second, 1000); // должен отменить first

    vi.advanceTimersByTime(1000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stop отменяет таймер до срабатывания', () => {
    const timer = new TestTimer();
    const cb = vi.fn();

    timer.start('t', cb, 1000);
    timer.stop('t');
    vi.advanceTimersByTime(2000);

    expect(cb).not.toHaveBeenCalled();
    expect(timer.has('t')).toBe(false);
  });

  it('clearAll останавливает все таймеры', () => {
    const timer = new TestTimer();
    const a = vi.fn();
    const b = vi.fn();

    timer.start('a', a, 500);
    timer.start('b', b, 500, true);
    timer.clearAll();
    vi.advanceTimersByTime(2000);

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(timer.has('a')).toBe(false);
    expect(timer.has('b')).toBe(false);
  });

  // все таймеры хоста идут через AbstractTimer, поэтому подмена clock —
  // единственное, что нужно headless-прогону для управления временем
  describe('работа через подменённый clock', () => {
    afterEach(() => {
      clock.reset();
    });

    it('setTimeout/setInterval берутся из clock', () => {
      const setTimeoutFake = vi.fn(() => 'timeout-id');
      const setIntervalFake = vi.fn(() => 'interval-id');
      const clearTimeoutFake = vi.fn();
      const clearIntervalFake = vi.fn();

      clock.install({
        setTimeout: setTimeoutFake,
        setInterval: setIntervalFake,
        clearTimeout: clearTimeoutFake,
        clearInterval: clearIntervalFake,
      });

      const timer = new TestTimer();
      const cb = vi.fn();

      timer.start('t', cb, 1000);
      timer.start('i', cb, 500, true);

      expect(setTimeoutFake).toHaveBeenCalledTimes(1);
      expect(setIntervalFake).toHaveBeenCalledWith(cb, 500);

      timer.clearAll();

      expect(clearTimeoutFake).toHaveBeenCalledWith('timeout-id');
      expect(clearIntervalFake).toHaveBeenCalledWith('interval-id');
    });

    it('callback подменённого setTimeout чистит ключ перед вызовом', () => {
      let fire;

      clock.install({
        setTimeout: callback => {
          fire = callback;
          return 1;
        },
      });

      const timer = new TestTimer();
      const cb = vi.fn(() => expect(timer.has('t')).toBe(false));

      timer.start('t', cb, 1000);
      expect(timer.has('t')).toBe(true);

      fire();

      expect(cb).toHaveBeenCalledTimes(1);
    });
  });
});

// контрольная точка хоста (host-migration этап 5): остаток и пауза
class PausableTimer extends TestTimer {
  left(key) {
    return this._timeLeft(key);
  }
  pause(filter) {
    this._pauseTimers(filter);
  }
  resume(filter) {
    this._resumeTimers(filter);
  }
}

describe('AbstractTimer: остаток и пауза', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('_timeLeft отдаёт остаток setTimeout и null для интервала', () => {
    const t = new PausableTimer();

    t.start('a', () => {}, 1000);
    t.start('i', () => {}, 1000, true);
    vi.advanceTimersByTime(300);

    expect(t.left('a')).toBe(700);
    expect(t.left('i')).toBeNull();
    expect(t.left('none')).toBeNull();
  });

  it('на паузе таймер не срабатывает, остаток замирает, ключ живёт', () => {
    const t = new PausableTimer();
    const cb = vi.fn();

    t.start('a', cb, 1000);
    vi.advanceTimersByTime(400);
    t.pause();
    vi.advanceTimersByTime(5000);

    expect(cb).not.toHaveBeenCalled();
    expect(t.has('a')).toBe(true);
    expect(t.left('a')).toBe(600);

    t.resume();
    vi.advanceTimersByTime(599);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(t.has('a')).toBe(false);
  });

  it('фильтр паузы оставляет остальные таймеры идти', () => {
    const t = new PausableTimer();
    const a = vi.fn();
    const b = vi.fn();

    t.start('a', a, 100);
    t.start('b', b, 100);
    t.pause(key => key === 'a');
    vi.advanceTimersByTime(100);

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
