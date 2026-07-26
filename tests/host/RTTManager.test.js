import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import RTTManager from '../../packages/engine/src/host/meta/modules/RTTManager.js';

const makeCallbacks = () => ({
  onKickForMissedPings: vi.fn(),
  onKickForMaxLatency: vi.fn(),
});

describe('RTTManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('addUser создаёт запись с дефолтным RTT', () => {
    const rtt = new RTTManager({ maxMissedPings: 5, maxLatency: 300 }, makeCallbacks());
    rtt.addUser('u1');
    // первый ping должен включить пользователя в итератор
    const entries = [...rtt.scheduleNextPing()];
    expect(entries.map(([id]) => id)).toContain('u1');
  });

  it('handlePong вычисляет RTT по последнему пингу', () => {
    vi.setSystemTime(1_000_000); // реалистичный момент (не 0)
    const rtt = new RTTManager({ maxMissedPings: 5, maxLatency: 1000 }, makeCallbacks());
    rtt.addUser('u1');

    rtt.scheduleNextPing(); // pingId = 1
    vi.setSystemTime(1_000_050); // через 50 мс пришёл pong

    const latency = rtt.handlePong('u1', 1);
    expect(latency).toBe(50);
  });

  it('игнорирует pong на устаревший pingId', () => {
    const rtt = new RTTManager({ maxMissedPings: 5, maxLatency: 1000 }, makeCallbacks());
    rtt.addUser('u1');

    rtt.scheduleNextPing(); // pingId = 1
    rtt.scheduleNextPing(); // pingId = 2 (предыдущий считается пропущенным)

    // ответ на устаревший pingId = 1 должен игнорироваться
    expect(rtt.handlePong('u1', 1)).toBeNull();
  });

  it('handlePong для удалённого пользователя возвращает null', () => {
    const rtt = new RTTManager({ maxMissedPings: 5, maxLatency: 1000 }, makeCallbacks());
    expect(rtt.handlePong('ghost', 1)).toBeNull();
  });

  it('кикает за превышение maxMissedPings', () => {
    const callbacks = makeCallbacks();
    const rtt = new RTTManager({ maxMissedPings: 2, maxLatency: 1000 }, callbacks);
    rtt.addUser('u1');

    // 1-й ping: outstanding пуст → отправляется, outstanding={1}
    rtt.scheduleNextPing();
    // 2-й ping: остался неотвеченный → missedPings=1 (<2), новый ping
    rtt.scheduleNextPing();
    // 3-й ping: снова неотвеченный → missedPings=2 (>=2) → кик
    rtt.scheduleNextPing();

    expect(callbacks.onKickForMissedPings).toHaveBeenCalledWith('u1');
  });

  it('сбрасывает missedPings после успешного pong', () => {
    const callbacks = makeCallbacks();
    const rtt = new RTTManager({ maxMissedPings: 2, maxLatency: 1000 }, callbacks);
    rtt.addUser('u1');

    rtt.scheduleNextPing(); // ping 1
    rtt.scheduleNextPing(); // missedPings=1, ping 2
    rtt.handlePong('u1', 2); // ответ → missedPings=0, outstanding очищен

    rtt.scheduleNextPing(); // outstanding пуст → missedPings остаётся 0
    rtt.scheduleNextPing(); // missedPings=1
    expect(callbacks.onKickForMissedPings).not.toHaveBeenCalled();
  });

  it('кикает за превышение maxLatency', () => {
    vi.setSystemTime(1_000_000);
    const callbacks = makeCallbacks();
    // низкий порог, чтобы EMA быстро превысила его
    const rtt = new RTTManager({ maxMissedPings: 100, maxLatency: 100 }, callbacks);
    rtt.addUser('u1'); // стартовый rtt = 100

    // большой замер задержки поднимет EMA выше 100
    rtt.scheduleNextPing();
    vi.setSystemTime(1_001_000); // 1000 мс задержки
    rtt.handlePong('u1', 1);

    expect(callbacks.onKickForMaxLatency).toHaveBeenCalledWith('u1');
  });

  it('removeUser исключает пользователя из пингов', () => {
    const rtt = new RTTManager({ maxMissedPings: 5, maxLatency: 1000 }, makeCallbacks());
    rtt.addUser('u1');
    rtt.removeUser('u1');
    const entries = [...rtt.scheduleNextPing()];
    expect(entries).toHaveLength(0);
  });
});
