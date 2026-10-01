import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// TimerManager — синглтон, перезагружаем модуль для изоляции
let TimerManager;

const timers = {
  mapTime: 600000,
  roundTime: 120000,
  timeStep: 1000 / 120,
  voteTime: 10000,
  timeBlockedVote: 30000,
  teamChangeGracePeriod: 10000,
  roundRestartDelay: 5000,
  mapChangeDelay: 2000,
  idleCheckInterval: 30000,
  rttPingInterval: 3000,
};

const makeCallbacks = () => ({
  onMapTimeEnd: vi.fn(),
  onRoundTimeEnd: vi.fn(),
  onShotTick: vi.fn(),
  onIdleCheck: vi.fn(),
  onSendPing: vi.fn(),
});

let callbacks;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  TimerManager = (
    await import('../../packages/engine/src/host/meta/modules/TimerManager.js')
  ).default;
  callbacks = makeCallbacks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TimerManager: время раунда и карты', () => {
  it('getRoundTimeLeft уменьшается со временем (в секундах)', () => {
    const tm = new TimerManager(timers, callbacks);
    tm.startRoundTimer();

    vi.setSystemTime(1_005_000); // прошло 5 секунд
    expect(tm.getRoundTimeLeft()).toBe(115); // (120000-5000)/1000
  });

  it('getRoundTimeLeft не уходит ниже 0', () => {
    const tm = new TimerManager(timers, callbacks);
    tm.startRoundTimer();

    vi.setSystemTime(2_000_000); // далеко за пределами раунда
    expect(tm.getRoundTimeLeft()).toBe(0);
  });

  it('getMapTimeLeft возвращает остаток в миллисекундах', () => {
    const tm = new TimerManager(timers, callbacks);
    tm.startMapTimer();

    vi.setSystemTime(1_010_000); // прошло 10 секунд
    expect(tm.getMapTimeLeft()).toBe(590000);
  });

  it('таймер раунда вызывает onRoundTimeEnd по истечении', () => {
    const tm = new TimerManager(timers, callbacks);
    tm.startRoundTimer();

    vi.advanceTimersByTime(timers.roundTime);
    expect(callbacks.onRoundTimeEnd).toHaveBeenCalledTimes(1);
  });
});

describe('TimerManager: смена команды', () => {
  it('разрешена внутри grace-периода', () => {
    const tm = new TimerManager(timers, callbacks);
    tm.startRoundTimer();

    vi.setSystemTime(1_009_000); // 9 c < 10 c grace
    expect(tm.canChangeTeamInCurrentRound()).toBe(true);
  });

  it('запрещена после grace-периода', () => {
    const tm = new TimerManager(timers, callbacks);
    tm.startRoundTimer();

    vi.setSystemTime(1_011_000); // 11 c > 10 c grace
    expect(tm.canChangeTeamInCurrentRound()).toBe(false);
  });
});

describe('TimerManager: таймеры голосования', () => {
  it('startVoteTimer вызывает колбэк по истечении voteTime', () => {
    const tm = new TimerManager(timers, callbacks);
    const onEnd = vi.fn();

    tm.startVoteTimer('map', onEnd);
    vi.advanceTimersByTime(timers.voteTime);

    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('stopAllVoteTimers отменяет активные голосования', () => {
    const tm = new TimerManager(timers, callbacks);
    const onEnd = vi.fn();

    tm.startVoteTimer('map', onEnd);
    tm.stopAllVoteTimers();
    vi.advanceTimersByTime(timers.voteTime * 2);

    expect(onEnd).not.toHaveBeenCalled();
  });

  it('isVoteBlocked отражает блокирующий таймер', () => {
    const tm = new TimerManager(timers, callbacks);

    expect(tm.isVoteBlocked('map')).toBe(false);
    tm.startVoteBlockTimer('map', vi.fn());
    expect(tm.isVoteBlocked('map')).toBe(true);

    vi.advanceTimersByTime(timers.timeBlockedVote);
    expect(tm.isVoteBlocked('map')).toBe(false); // снят по истечении
  });

  it('stopAllBlockedVoteTimers снимает блокировки', () => {
    const tm = new TimerManager(timers, callbacks);
    tm.startVoteBlockTimer('map', vi.fn());
    tm.stopAllBlockedVoteTimers();
    expect(tm.isVoteBlocked('map')).toBe(false);
  });
});

describe('TimerManager: отложенные действия', () => {
  it('startRoundRestartDelay вызывает onRoundTimeEnd', () => {
    const tm = new TimerManager(timers, callbacks);
    tm.startRoundRestartDelay();

    vi.advanceTimersByTime(timers.roundRestartDelay);
    expect(callbacks.onRoundTimeEnd).toHaveBeenCalledTimes(1);
  });

  it('startMapChangeDelay вызывает переданный колбэк', () => {
    const tm = new TimerManager(timers, callbacks);
    const onEnd = vi.fn();
    tm.startMapChangeDelay(onEnd);

    vi.advanceTimersByTime(timers.mapChangeDelay);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('TimerManager: игровой цикл', () => {
  it('_startGameLoop планирует первый тик через timeStep', () => {
    const tm = new TimerManager(timers, callbacks);
    tm._startGameLoop();

    expect(callbacks.onShotTick).not.toHaveBeenCalled(); // ещё не сработал
    vi.advanceTimersByTime(timers.timeStep);
    expect(callbacks.onShotTick).toHaveBeenCalledTimes(1);

    tm._stopGameLoop();
  });

  it('_loopTick самоперепланируется и вызывает onShotTick каждый кадр', () => {
    const tm = new TimerManager(timers, callbacks);
    tm._startGameLoop();

    vi.advanceTimersByTime(timers.timeStep * 5);
    expect(callbacks.onShotTick.mock.calls.length).toBeGreaterThanOrEqual(5);

    tm._stopGameLoop();
  });

  it('onShotTick получает dt в секундах', () => {
    const tm = new TimerManager(timers, callbacks);
    tm._startGameLoop();

    vi.advanceTimersByTime(timers.timeStep);
    const dt = callbacks.onShotTick.mock.calls[0][0];
    expect(typeof dt).toBe('number');
    expect(dt).toBeGreaterThanOrEqual(0);

    tm._stopGameLoop();
  });

  it('_stopGameLoop останавливает цикл', () => {
    const tm = new TimerManager(timers, callbacks);
    tm._startGameLoop();

    vi.advanceTimersByTime(timers.timeStep);
    const callsAfterFirst = callbacks.onShotTick.mock.calls.length;

    tm._stopGameLoop();
    vi.advanceTimersByTime(timers.timeStep * 10);

    // после остановки новых тиков нет
    expect(callbacks.onShotTick.mock.calls.length).toBe(callsAfterFirst);
  });

  it('startGameTimers запускает игровой цикл, таймеры карты и раунда', () => {
    const tm = new TimerManager(timers, callbacks);
    tm.startGameTimers();

    expect(tm._hasTimer('gameLoop')).toBe(true);
    expect(tm._hasTimer('map')).toBe(true);
    expect(tm._hasTimer('round')).toBe(true);

    tm.stopGameTimers();
    expect(tm._hasTimer('gameLoop')).toBe(false);
    expect(tm._hasTimer('map')).toBe(false);
    expect(tm._hasTimer('round')).toBe(false);
  });
});

describe('TimerManager: периодические проверки', () => {
  it('startIdleCheckTimer вызывает onIdleCheck немедленно и затем периодически', () => {
    const tm = new TimerManager(timers, callbacks);
    tm.startIdleCheckTimer();

    // первый тик — синхронно при запуске
    expect(callbacks.onIdleCheck).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(timers.idleCheckInterval * 2);
    expect(callbacks.onIdleCheck).toHaveBeenCalledTimes(3);

    tm.stopIdleCheckTimer();
  });
});

describe('TimerManager: контрольная точка (host-migration этап 5)', () => {
  it('serialize отдаёт остатки карты, раунда, отложенных вызовов и кулдаунов', () => {
    const tm = new TimerManager(timers, callbacks);

    tm.startMapTimer();
    tm.startRoundTimer();
    vi.advanceTimersByTime(4000);
    tm.startRoundRestartDelay();
    tm.startMapChangeDelay(() => {}, { targetMap: 'dust' });
    tm.startVoteBlockTimer('mapChange', () => {});
    vi.advanceTimersByTime(500);

    const state = tm.serialize();

    expect(state.mapTimeLeft).toBe(600000 - 4500);
    expect(state.roundTimeLeft).toBe(120000 - 4500);
    expect(state.roundElapsed).toBe(4500);
    expect(state.teamChangeGraceLeft).toBe(10000 - 4500);
    expect(state.pending).toEqual([
      { kind: 'roundRestart', leftMs: 4500 },
      { kind: 'mapChange', leftMs: 1500, targetMap: 'dust' },
    ]);
    expect(state.voteCooldowns).toEqual([{ name: 'mapChange', leftMs: 29500 }]);

    tm.stopGameTimers();
    tm.stopAllBlockedVoteTimers();
  });

  it('resumeFromState поднимает таймеры с остатками и виртуальным стартом раунда', () => {
    const tm = new TimerManager(timers, callbacks);

    tm.resumeFromState({
      mapTimeLeft: 1000,
      roundTimeLeft: 115000,
      roundElapsed: 5000,
      pending: [{ kind: 'roundRestart', leftMs: 200 }],
      voteCooldowns: [{ name: 'mapChange', leftMs: 300 }],
    });

    expect(tm.getRoundTimeLeftMs()).toBe(115000);
    expect(tm.canChangeTeamInCurrentRound()).toBe(true);
    expect(tm.isVoteBlocked('mapChange')).toBe(true);

    vi.advanceTimersByTime(200);
    expect(callbacks.onRoundTimeEnd).toHaveBeenCalledTimes(1);
    expect(callbacks.onShotTick).toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(tm.isVoteBlocked('mapChange')).toBe(false);

    vi.advanceTimersByTime(700);
    expect(callbacks.onMapTimeEnd).toHaveBeenCalledTimes(1);

    tm.stopGameTimers();
  });

  it('раунд без таймера (завершается) восстанавливает прошедшее время', () => {
    const tm = new TimerManager(timers, callbacks);

    tm.resumeFromState({
      mapTimeLeft: 1000,
      roundTimeLeft: null,
      roundElapsed: 20000,
    });

    expect(tm.canChangeTeamInCurrentRound()).toBe(false);

    tm.stopGameTimers();
  });

  it('pause/resume замораживают цикл и остатки карты и раунда', () => {
    const tm = new TimerManager(timers, callbacks);

    tm.startGameTimers();
    vi.advanceTimersByTime(1000);
    tm.pause();

    const ticks = callbacks.onShotTick.mock.calls.length;
    const mapLeft = tm.getMapTimeLeft();
    const roundLeft = tm.getRoundTimeLeftMs();

    vi.advanceTimersByTime(60000);

    expect(tm.isPaused).toBe(true);
    expect(callbacks.onShotTick.mock.calls.length).toBe(ticks);
    expect(tm.getMapTimeLeft()).toBe(mapLeft);
    expect(callbacks.onRoundTimeEnd).not.toHaveBeenCalled();

    tm.resume();

    expect(tm.getMapTimeLeft()).toBe(mapLeft);
    expect(tm.getRoundTimeLeftMs()).toBe(roundLeft);

    vi.advanceTimersByTime(100);
    expect(callbacks.onShotTick.mock.calls.length).toBeGreaterThan(ticks);

    tm.stopGameTimers();
  });
});

describe('TimerManager: метрики здоровья цикла (host-migration 9a)', () => {
  let restoreClock;

  beforeEach(async () => {
    const clock = (await import('../../packages/engine/src/lib/clock.js'))
      .default;

    // dt цикла — от тех же фейковых часов, что двигают таймеры
    restoreClock = clock.install({ monotonic: () => Date.now() });
    callbacks.onLoopStats = vi.fn();
  });

  afterEach(() => {
    restoreClock();
  });

  it('раз в ~1 с отдаёт tickRate и maxGapMs без потерь', () => {
    const tm = new TimerManager(timers, callbacks);

    tm._startGameLoop();
    vi.advanceTimersByTime(1000);

    expect(callbacks.onLoopStats).toHaveBeenCalledTimes(1);

    const stats = callbacks.onLoopStats.mock.calls[0][0];

    // фейковые таймеры целочисленны: шаг 8.33 мс идёт как 8–9 мс
    expect(stats.tickRate).toBeGreaterThan(100);
    expect(stats.tickRate).toBeLessThanOrEqual(125);
    expect(stats.maxGapMs).toBeLessThanOrEqual(10);
    expect(stats.lostMs).toBe(0);
    expect(stats.windowMs).toBeGreaterThanOrEqual(1000);

    tm._stopGameLoop();
  });

  it('разрыв больше капа dt копится в lostMs и maxGapMs', () => {
    const tm = new TimerManager(timers, callbacks);

    tm._startGameLoop();
    vi.advanceTimersByTime(100);

    // главный поток Worker'а «спал» 350 мс: срезано 250 мс сверх капа 0.1 с
    vi.setSystemTime(Date.now() + 350);
    vi.advanceTimersByTime(1000);

    const stats = callbacks.onLoopStats.mock.calls[0][0];

    expect(stats.maxGapMs).toBeGreaterThanOrEqual(350);
    expect(stats.lostMs).toBeGreaterThanOrEqual(240);
    expect(stats.lostMs).toBeLessThanOrEqual(260);

    tm._stopGameLoop();
  });

  it('на паузе метрик нет, после resume окно начинается заново', () => {
    const tm = new TimerManager(timers, callbacks);

    tm.startGameTimers();
    vi.advanceTimersByTime(500);
    tm.pause();
    vi.advanceTimersByTime(5000);

    expect(callbacks.onLoopStats).not.toHaveBeenCalled();

    tm.resume();
    vi.advanceTimersByTime(1000);

    expect(callbacks.onLoopStats).toHaveBeenCalledTimes(1);
    // пауза не считается разрывом цикла
    expect(callbacks.onLoopStats.mock.calls[0][0].lostMs).toBe(0);

    tm.stopGameTimers();
  });
});
