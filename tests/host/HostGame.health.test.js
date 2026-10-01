import { describe, it, expect, afterEach, vi } from 'vitest';
import { createFixtureHost, connectPlayer } from './fixtureHarness.js';

// HostGame: метрики здоровья хоста (host-migration этап 9a) — метрики цикла
// дополняются медианой RTT удалённых людей; хост-игрок на loopback не в счёт

describe('HostGame: health', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('медиана RTT — без хост-игрока, приёмник получает метрики цикла', async () => {
    const { host } = await createFixtureHost({
      opts: { hostSocketId: 'local' },
    });
    const local = await connectPlayer(host, { socketId: 'local', name: 'H' });
    const guest = await connectPlayer(host, { socketId: 's1', name: 'G' });
    const sink = vi.fn();

    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    host.setHealthSink(sink);
    host._sendPing();

    // EMA (alpha 0.1) от стартовых 100: гость 300 → 120, хост 1100 → 200
    vi.setSystemTime(1_000_300);
    host.updateRTT(guest, host._RTTManager._users.get(guest).pingIdCounter);
    vi.setSystemTime(1_001_100);
    host.updateRTT(local, host._RTTManager._users.get(local).pingIdCounter);

    const stats = { tickRate: 119, maxGapMs: 10, lostMs: 0, windowMs: 1000 };

    host._onLoopStats(stats);

    expect(sink).toHaveBeenCalledWith({
      ...stats,
      peerRttMedian: 120,
      peerCount: 1,
    });
  });

  it('без приёмника метрики не считаются', async () => {
    const { host } = await createFixtureHost();
    const getRttStats = vi.spyOn(host._RTTManager, 'getRttStats');

    host._onLoopStats({ tickRate: 120, maxGapMs: 9, lostMs: 0 });

    expect(getRttStats).not.toHaveBeenCalled();
  });
});
