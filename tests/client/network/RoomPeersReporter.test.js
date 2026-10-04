import { describe, it, expect, vi, beforeEach } from 'vitest';
import RoomPeersReporter from '../../../packages/engine/src/client/network/RoomPeersReporter.js';

// Отчёт хоста room_peers: дебаунс изменений, периодический повтор, тишина
// без комнаты. Таймеры — фейковые vitest.

describe('RoomPeersReporter', () => {
  let send;
  let room;
  let memberIds;
  let reporter;

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn();
    room = { roomId: 'r1', epoch: 3 };
    memberIds = ['m1'];
    reporter = new RoomPeersReporter({
      send,
      getRoom: () => room,
      getMemberIds: () => memberIds,
      intervalMs: 15000,
      debounceMs: 500,
    });

    return () => {
      reporter.destroy();
      vi.useRealTimers();
    };
  });

  it('notify: одна отправка после дебаунса, с текущим составом', () => {
    reporter.notify();
    reporter.notify();
    memberIds = ['m1', 'm2'];

    vi.advanceTimersByTime(499);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      roomId: 'r1',
      epoch: 3,
      memberIds: ['m1', 'm2'],
    });
  });

  it('refresh: немедленно и снимает отложенный notify', () => {
    reporter.notify();
    reporter.refresh();

    expect(send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('повторяет отчёт раз в intervalMs', () => {
    vi.advanceTimersByTime(15000);
    expect(send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(15000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('без комнаты молчит', () => {
    room = null;

    reporter.refresh();
    reporter.notify();
    vi.advanceTimersByTime(15000);

    expect(send).not.toHaveBeenCalled();
  });

  it('destroy снимает таймеры', () => {
    reporter.notify();
    reporter.destroy();
    vi.advanceTimersByTime(30000);

    expect(send).not.toHaveBeenCalled();

    // после destroy — не шлёт и по прямому вызову
    reporter.refresh();
    expect(send).not.toHaveBeenCalled();
  });
});
