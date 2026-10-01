import { describe, it, expect, vi } from 'vitest';
import VoteCoordinator from '../../packages/engine/src/host/meta/core/VoteCoordinator.js';

const makeDeps = (overrides = {}) => ({
  vote: {
    hasVoteCategory: vi.fn(() => false),
    addInVote: vi.fn(),
    getResult: vi.fn(() => 'Yes'),
    createVote: vi.fn(),
    reset: vi.fn(),
    ...overrides.vote,
  },
  chat: { pushSystemByUser: vi.fn(), ...overrides.chat },
  timerManager: {
    isVoteBlocked: vi.fn(() => false),
    startVoteTimer: vi.fn(),
    startVoteBlockTimer: vi.fn(),
    stopAllVoteTimers: vi.fn(),
    stopAllBlockedVoteTimers: vi.fn(),
    ...overrides.timerManager,
  },
});

describe('VoteCoordinator.canCreateVote', () => {
  it('запрещает при заблокированной категории', () => {
    const deps = makeDeps({ timerManager: { isVoteBlocked: () => true } });
    const vc = new VoteCoordinator(deps);

    expect(vc.canCreateVote('mapChange', 'u')).toBe(false);
    expect(deps.chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'VOTE_UNAVAILABLE',
    );
  });

  it('запрещает, если категория уже голосуется', () => {
    const deps = makeDeps({ vote: { hasVoteCategory: () => true } });
    const vc = new VoteCoordinator(deps);

    expect(vc.canCreateVote('mapChange', 'u')).toBe(false);
  });

  it('разрешает, когда категория свободна', () => {
    const deps = makeDeps();
    const vc = new VoteCoordinator(deps);

    expect(vc.canCreateVote('mapChange', 'u')).toBe(true);
    expect(deps.chat.pushSystemByUser).not.toHaveBeenCalled();
  });

  it('без gameId не шлёт сообщение в чат', () => {
    const deps = makeDeps({ timerManager: { isVoteBlocked: () => true } });
    const vc = new VoteCoordinator(deps);

    expect(vc.canCreateVote('mapChange')).toBe(false);
    expect(deps.chat.pushSystemByUser).not.toHaveBeenCalled();
  });
});

describe('VoteCoordinator.createVote', () => {
  it('регистрирует опрос в Vote и шлёт VOTE_CREATED инициатору', () => {
    const deps = makeDeps();
    const vc = new VoteCoordinator(deps);

    vc.createVote({
      voteName: 'mapChangeByUser',
      voteCategory: 'mapChange',
      payload: { name: 'mapChangeByUser' },
      resultFunc: vi.fn(),
      userList: ['a'],
      gameId: 'u',
    });

    expect(deps.chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'VOTE_CREATED',
    );
    expect(deps.vote.createVote).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'mapChangeByUser',
        category: 'mapChange',
        userList: ['a'],
        onStartCallback: expect.any(Function),
      }),
    );
  });

  it('onStartCallback добавляет голос инициатора и собирает результат', () => {
    const deps = makeDeps();
    const vc = new VoteCoordinator(deps);
    const resultFunc = vi.fn();

    vc.createVote({
      voteName: 'v1',
      voteCategory: 'cat',
      payload: {},
      resultFunc,
      userList: [],
      gameId: 'u',
    });

    // вызываем onStart, переданный в Vote.createVote
    const { onStartCallback } = deps.vote.createVote.mock.calls[0][0];
    onStartCallback();

    expect(deps.chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'VOTE_STARTED',
    );
    expect(deps.vote.addInVote).toHaveBeenCalledWith('v1', 'Yes');

    // запускаем колбэк таймера сбора результатов
    const timerCb = deps.timerManager.startVoteTimer.mock.calls[0][1];
    timerCb();

    expect(deps.timerManager.startVoteBlockTimer).toHaveBeenCalledWith(
      'cat',
      expect.any(Function),
    );
    expect(resultFunc).toHaveBeenCalledWith('Yes');
  });

  it('системный опрос (без gameId) не трогает чат и не голосует за инициатора', () => {
    const deps = makeDeps();
    const vc = new VoteCoordinator(deps);

    vc.createVote({
      voteName: 'mapChangeBySystem',
      voteCategory: 'mapChange',
      payload: {},
      resultFunc: vi.fn(),
    });

    const { onStartCallback } = deps.vote.createVote.mock.calls[0][0];
    onStartCallback();

    expect(deps.chat.pushSystemByUser).not.toHaveBeenCalled();
    expect(deps.vote.addInVote).not.toHaveBeenCalled();
  });
});

describe('VoteCoordinator.reset', () => {
  it('останавливает таймеры голосований и сбрасывает vote', () => {
    const deps = makeDeps();
    const vc = new VoteCoordinator(deps);

    vc.reset();

    expect(deps.timerManager.stopAllVoteTimers).toHaveBeenCalled();
    expect(deps.timerManager.stopAllBlockedVoteTimers).toHaveBeenCalled();
    expect(deps.vote.reset).toHaveBeenCalled();
  });
});

// кулдаун голосования переживает контрольную точку: остаток уезжает в
// timers.voteCooldowns и блокирует категорию у преемника
describe('VoteCoordinator: кулдауны через контрольную точку', () => {
  it('категория остаётся заблокированной остаток кулдауна', async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const TimerManager = (
      await import('../../packages/engine/src/host/meta/modules/TimerManager.js')
    ).default;
    const timers = { timeBlockedVote: 30000, voteTime: 10000 };
    const first = new TimerManager(timers, {});

    first.startVoteBlockTimer('mapChange', () => {});
    vi.advanceTimersByTime(10000);

    const { voteCooldowns } = first.serialize();

    first.stopAllBlockedVoteTimers();
    vi.resetModules();

    const NextTimerManager = (
      await import('../../packages/engine/src/host/meta/modules/TimerManager.js')
    ).default;
    const next = new NextTimerManager(timers, {});

    for (const { name, leftMs } of voteCooldowns) {
      next.startVoteBlockTimer(name, () => {}, leftMs);
    }

    const deps = makeDeps({ timerManager: next });
    const vc = new VoteCoordinator({ ...deps, timerManager: next });

    expect(vc.canCreateVote('mapChange')).toBe(false);
    vi.advanceTimersByTime(20000);
    expect(vc.canCreateVote('mapChange')).toBe(true);

    vi.useRealTimers();
  });
});
