import { describe, it, expect, vi, beforeEach } from 'vitest';
import TokenHandoffTimer from '../../../packages/engine/src/client/network/TokenHandoffTimer.js';

// Передача роли хоста по сроку входа (ревью R2): первая попытка за leadMs до
// истечения, отказ и сорванная передача повторяются через retryMs, пока вход
// не истёк. Таймеры и Date.now — фейковые vitest.

const LEAD = 300000;
const RETRY = 5000;

describe('TokenHandoffTimer', () => {
  let expiresAt;
  let tryStart;
  let timer;

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    expiresAt = 400000;
    tryStart = vi.fn(() => true);
    timer = new TokenHandoffTimer({
      getExpiresAt: () => expiresAt,
      leadMs: LEAD,
      retryMs: RETRY,
      tryStart,
    });

    return () => {
      timer.cancel();
      vi.useRealTimers();
    };
  });

  it('arm: попытка за leadMs до истечения; удачная — без повторов', () => {
    timer.arm();

    vi.advanceTimersByTime(99999);
    expect(tryStart).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(tryStart).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LEAD);
    expect(tryStart).toHaveBeenCalledTimes(1);
  });

  it('отказ старта (нет беты, идёт своп) — повтор через retryMs', () => {
    tryStart.mockReturnValueOnce(false).mockReturnValueOnce(false);
    timer.arm();

    vi.advanceTimersByTime(100000);
    expect(tryStart).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(RETRY);
    expect(tryStart).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(RETRY);
    expect(tryStart).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(LEAD);
    expect(tryStart).toHaveBeenCalledTimes(3);
  });

  it('повторы не выходят за истечение входа', () => {
    tryStart.mockReturnValue(false);
    timer.arm();

    vi.advanceTimersByTime(expiresAt + RETRY);

    // 100000, 105000, …, 395000: следующая (400000) — уже по истёкшему входу
    expect(tryStart).toHaveBeenCalledTimes(LEAD / RETRY);
  });

  it('retry после сорванной передачи — только когда срок передачи настал', () => {
    timer.retry();
    vi.advanceTimersByTime(RETRY);
    // до окна передачи сорвалась ручная передача — ждём обычного срока
    expect(tryStart).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100000 - RETRY);
    expect(tryStart).toHaveBeenCalledTimes(1);

    timer.retry();
    vi.advanceTimersByTime(RETRY);
    expect(tryStart).toHaveBeenCalledTimes(2);
  });

  it('повторный вход переносит срок попытки', () => {
    timer.arm();
    vi.advanceTimersByTime(50000);

    expiresAt = 1000000;
    timer.arm();

    vi.advanceTimersByTime(50000);
    expect(tryStart).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000000 - LEAD - 100000);
    expect(tryStart).toHaveBeenCalledTimes(1);
  });

  it('arm в окне передачи (назначили бету) — попытка сразу', () => {
    vi.setSystemTime(200000);
    timer.arm();

    vi.advanceTimersByTime(0);
    expect(tryStart).toHaveBeenCalledTimes(1);
  });

  it('без срока входа и после cancel — тишина', () => {
    expiresAt = null;
    timer.arm();
    timer.retry();
    vi.advanceTimersByTime(1e7);
    expect(tryStart).not.toHaveBeenCalled();

    expiresAt = 400000;
    vi.setSystemTime(0);
    timer.arm();
    timer.cancel();
    vi.advanceTimersByTime(1e6);
    expect(tryStart).not.toHaveBeenCalled();
  });
});
