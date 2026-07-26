import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AbstractTimer from '../../packages/engine/src/lib/AbstractTimer.js';

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
});
