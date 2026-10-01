import { describe, it, expect, vi } from 'vitest';
import HostHealthReporter from '../../../packages/engine/src/client/network/HostHealthReporter.js';

const sample = (over = {}) => ({
  tickRate: 120,
  maxGapMs: 9,
  lostMs: 0,
  peerRttMedian: 300,
  peerCount: 2,
  ...over,
});

const setup = ({ room = { roomId: 'r1', epoch: 2 } } = {}) => {
  const clock = { now: 0 };
  const send = vi.fn();
  const state = { room };
  const reporter = new HostHealthReporter({
    send,
    getRoom: () => state.room,
    intervalMs: 2000,
    now: () => clock.now,
  });

  return { clock, send, state, reporter };
};

describe('HostHealthReporter (этап 9c)', () => {
  it('первый сэмпл уходит сразу, дальше — не чаще intervalMs, с последним сэмплом', () => {
    const { clock, send, reporter } = setup();

    expect(reporter.add(sample())).toBe(true);
    expect(send).toHaveBeenLastCalledWith({
      roomId: 'r1',
      epoch: 2,
      tickRate: 120,
      peerRttMedian: 300,
      peerCount: 2,
    });

    clock.now = 1000;
    expect(reporter.add(sample({ peerRttMedian: 310 }))).toBe(false);

    clock.now = 2000;
    reporter.add(sample({ peerRttMedian: 320 }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].peerRttMedian).toBe(320);
  });

  it('комната ещё не зарегистрирована — отчёта нет', () => {
    const { send, state, reporter } = setup({ room: null });

    expect(reporter.add(sample())).toBe(false);

    state.room = { roomId: 'r1', epoch: 1 };
    expect(reporter.add(sample())).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('медианы нет (людей без pong) — peerRttMedian null, peerCount 0', () => {
    const { send, reporter } = setup();

    reporter.add({ tickRate: 119, peerRttMedian: null, peerCount: 0 });
    expect(send.mock.calls[0][0]).toMatchObject({
      peerRttMedian: null,
      peerCount: 0,
    });
  });
});
