import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import JoinRetry from '../../../packages/engine/src/client/lib/JoinRetry.js';

describe('JoinRetry', () => {
  let send;
  let retry;

  const make = (options = {}) =>
    new JoinRetry({
      send,
      delaysMs: [100, 200, 400],
      windowMs: 1000,
      timers: globalThis,
      now: () => Date.now(),
      ...options,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn();
    retry = make();
  });

  afterEach(() => {
    retry.stop();
    vi.useRealTimers();
  });

  it('попытки по задержкам, последняя задержка повторяется', () => {
    retry.schedule();
    vi.advanceTimersByTime(99);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);

    retry.schedule();
    vi.advanceTimersByTime(200);
    expect(send).toHaveBeenCalledTimes(2);

    retry.schedule();
    vi.advanceTimersByTime(400);
    expect(send).toHaveBeenCalledTimes(3);

    retry.schedule();
    vi.advanceTimersByTime(399);
    expect(send).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('окно истекло — schedule ничего не планирует', () => {
    // попытки на 100, 300, 700 и 1100 (запланирована на 700 < 1000)
    for (let i = 0; i < 4; i += 1) {
      retry.schedule();
      vi.runOnlyPendingTimers();
    }
    expect(send).toHaveBeenCalledTimes(4);

    retry.schedule();
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('повторный schedule во время ожидания не плодит таймеры', () => {
    retry.schedule();
    retry.schedule();
    retry.schedule();
    vi.advanceTimersByTime(1000);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stop снимает таймер и обнуляет окно и задержки', () => {
    for (let i = 0; i < 3; i += 1) {
      retry.schedule();
      vi.runOnlyPendingTimers();
    }
    retry.schedule();
    retry.stop();
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledTimes(3);

    // новое окно и снова первая задержка
    retry.schedule();
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('по умолчанию — задержки из плана и окно из конфига', () => {
    retry = new JoinRetry({ send, windowMs: 30000 });

    retry.schedule();
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);

    retry.schedule();
    vi.advanceTimersByTime(1999);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
