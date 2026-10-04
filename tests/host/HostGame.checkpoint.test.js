import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createFixtureHost,
  connectPlayer,
  joinTeam,
  tick,
  takeHandoff,
} from './fixtureHarness.js';

// Контрольная точка хоста (host-migration этап 5) на фикстурной миниигре:
// точка снимается на границе кадра, новый HostGame поднимает из неё матч на
// паузе — люди отсоединены и ждут RESUME, цикл стоит до startAfterRestore.

const MID_ROUND = { migration: { midRound: true } };

// мета-модули — синглтоны на модуль: второй HostGame в том же тесте без
// сброса получил бы таймеры и панель первого
const resetSingletons = async () =>
  (
    await import('../../packages/engine/src/devtools/resetHostSingletons.js')
  ).resetHostSingletons();

// точка на ближайшей границе кадра (у фикстуры networkSendRate 1 — каждый
// тик отправляемый)
const takeCheckpoint = host => {
  let taken = null;

  host.setCheckpointSink(checkpoint => {
    taken = checkpoint;
  });
  host.requestCheckpoint();
  tick(host, 1);
  host.setCheckpointSink(null);

  return taken;
};

// игрок вошёл в матч и получил секрет места (как SESSION_DATA порт-машины)
const enterMatch = async (host, opts = {}) => {
  const gameId = await connectPlayer(host, opts);

  joinTeam(host, gameId, 'team1');
  host.issueResumeKey(gameId);
  tick(host, 1);

  return gameId;
};

// заглушка auth-сервиса, которая помнит запросы
const makeProfileFetch = () =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ rank: 0, state: null }),
  }));

const rankPuts = fetchImpl =>
  fetchImpl.mock.calls
    .filter(([url, opts]) => opts?.method === 'PUT' && url.includes('/rank'))
    .map(([, opts]) => ({
      authorization: opts.headers.authorization,
      body: JSON.parse(opts.body),
    }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe('HostGame: снятие контрольной точки', () => {
  it('точка снимается только на границе кадра — после pack_body', async () => {
    const { host, core } = await createFixtureHost({ game: MID_ROUND });

    await enterMatch(host);

    const packBody = vi.spyOn(core, 'pack_body');
    const serialize = vi.spyOn(core, 'serialize_state');

    const sink = vi.fn();

    host.setCheckpointSink(sink);
    host.requestCheckpoint({ final: true });

    expect(sink).not.toHaveBeenCalled();

    tick(host, 1);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0].final).toBe(true);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(serialize.mock.invocationCallOrder[0]).toBeGreaterThan(
      packBody.mock.invocationCallOrder.at(-1),
    );
  });

  it('периодические точки — не чаще интервала', async () => {
    const { host } = await createFixtureHost({ game: MID_ROUND });
    const sink = vi.fn();

    await enterMatch(host);
    host.setCheckpointSink(sink);
    host.startCheckpoints(500);
    vi.advanceTimersByTime(1100);

    expect(sink.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sink.mock.calls.length).toBeLessThanOrEqual(3);

    host.stopCheckpoints();
    sink.mockClear();
    vi.advanceTimersByTime(1100);

    expect(sink).not.toHaveBeenCalled();
  });

  it('мета v4 без токенов; игра без opt-in — мягкий режим без ядра', async () => {
    const { host } = await createFixtureHost();

    await enterMatch(host, { token: 'secret-token' });

    const { meta, core } = takeCheckpoint(host);

    expect(meta.version).toBe(4);
    expect(meta.kind).toBe('checkpoint');
    expect(meta.mode).toBe('soft');
    expect(core).toBeNull();
    expect(JSON.stringify(meta)).not.toContain('secret-token');
    expect(meta.map.data.setId).toBe('m1');
  });

  it('opt-in игры: midRound и байты ядра', async () => {
    const { host } = await createFixtureHost({ game: MID_ROUND });

    await enterMatch(host);

    const { meta, core } = takeCheckpoint(host);

    expect(meta.mode).toBe('midRound');
    expect(core).toBeInstanceOf(Uint8Array);
    expect(meta.participants.humans).toHaveLength(1);
    expect(meta.participants.humans[0].resumeKey).toEqual(expect.any(String));
  });

  it('сбой дампа ядра не роняет матч — точка уходит мягкой', async () => {
    const { host, core } = await createFixtureHost({ game: MID_ROUND });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await enterMatch(host);
    vi.spyOn(core, 'serialize_state').mockImplementation(() => {
      throw new Error('boom');
    });

    const { meta, core: bytes } = takeCheckpoint(host);

    expect(meta.mode).toBe('soft');
    expect(bytes).toBeNull();
    expect(warn.mock.calls[0][0]).toMatch(/core serialize_state failed: boom/);

    warn.mockRestore();
  });

  it('хуки модулей игры: serializeState уходит в plugin по имени модуля', async () => {
    const { host } = await createFixtureHost({ game: MID_ROUND });

    host._modules.scripted.serializeState = () => ({ wave: 3 });

    const { meta } = takeCheckpoint(host);

    expect(meta.plugin).toEqual({ scripted: { wave: 3 } });
  });
});

describe('HostGame: восстановление из контрольной точки', () => {
  it('midRound: участники отсоединены, мир, счёт, панель, таймеры и кулдауны на месте', async () => {
    const { host, core } = await createFixtureHost({ game: MID_ROUND });
    const gameId = await enterMatch(host);

    vi.advanceTimersByTime(3000);
    host._timerManager.startVoteBlockTimer('mapChange', () => {});
    host._panel.updateUser(gameId, 'energy', 30);
    host._stat.updateUser(gameId, 1, { score: 2 });
    host._roundManager.restoreRound({ wipedTeamIds: [1], startMapNumber: 2 });

    const roundLeft = host._timerManager.getRoundTimeLeftMs();
    const position = core.position_of(gameId);
    const { meta, core: bytes } = takeCheckpoint(host);

    host.freeze();
    await resetSingletons();

    const restored = await createFixtureHost({
      game: MID_ROUND,
      opts: { checkpoint: { meta, core: bytes }, seqFloor: 1000 },
    });
    const next = restored.host;
    const step = vi.spyOn(restored.core, 'step');

    expect(next.restoreMode).toBe('midRound');
    expect(next.isRestorePending).toBe(true);
    expect(next.isDetached(gameId)).toBe(true);
    expect(restored.core.position_of(gameId)).toEqual(position);
    expect(next._panel.getCurrentValue(gameId, 'energy')).toBe(70);
    expect(next._stat.getFull()[0][0][2][2]).toBe(2);
    expect(next._roundManager.serialize()).toMatchObject({
      wipedTeamIds: [1],
      startMapNumber: 2,
    });
    expect(next.debugSnapshot().seq).toBeGreaterThanOrEqual(1030);

    // цикл стоит, пока его не запустят
    vi.advanceTimersByTime(1000);
    expect(step).not.toHaveBeenCalled();

    expect(next.startAfterRestore()).toBe(true);
    expect(next._timerManager.getRoundTimeLeftMs()).toBe(roundLeft);
    expect(next._timerManager.isVoteBlocked('mapChange')).toBe(true);

    vi.advanceTimersByTime(100);
    expect(step).toHaveBeenCalled();
    expect(next.startAfterRestore()).toBe(false);
  });

  it('отсоединённый участник возвращается RESUME тем же местом', async () => {
    const { host } = await createFixtureHost({ game: MID_ROUND });
    const gameId = await enterMatch(host);
    const { resumeKey } = host.getResumeTarget(gameId);
    const { meta, core } = takeCheckpoint(host);

    host.freeze();
    await resetSingletons();

    const { host: next, socket } = await createFixtureHost({
      game: MID_ROUND,
      opts: { checkpoint: { meta, core } },
    });

    expect(next.getResumeTarget(gameId).resumeKey).toBe(resumeKey);
    expect(next.resumeUser(gameId, 'new-socket', 'fresh')).toBe(true);
    expect(next.isDetached(gameId)).toBe(false);
    expect(socket.framesOf('sendResumeResult')[0].socketId).toBe('new-socket');
  });

  it('soft: раунд начинается заново после startAfterRestore', async () => {
    const { host } = await createFixtureHost();

    await enterMatch(host);

    const { meta, core } = takeCheckpoint(host);

    host.freeze();
    await resetSingletons();

    const { host: next } = await createFixtureHost({
      opts: { checkpoint: { meta, core } },
    });
    const newRound = vi.spyOn(next._roundManager, 'initiateNewRound');

    expect(next.restoreMode).toBe('soft');

    next.startAfterRestore();

    expect(newRound).toHaveBeenCalledTimes(1);
  });

  it('заморозка снимает точку сразу и останавливает цикл', async () => {
    const { host, core } = await createFixtureHost({ game: MID_ROUND });

    await enterMatch(host);
    host.freeze();

    const step = vi.spyOn(core, 'step');
    const sink = vi.fn();

    vi.advanceTimersByTime(500);
    expect(step).not.toHaveBeenCalled();

    host.setCheckpointSink(sink);
    host.requestCheckpoint({ final: true });
    expect(sink).toHaveBeenCalledTimes(1);

    host.unfreeze();
    vi.advanceTimersByTime(100);
    expect(step).toHaveBeenCalled();
  });

  it('после точки на заморозке unfreeze шлёт готовым полную синхронизацию', async () => {
    const { host, socket } = await createFixtureHost({ game: MID_ROUND });

    await enterMatch(host, { socketId: 's1' });
    await enterMatch(host, { name: 'P2', socketId: 's2', token: 'tok2' });

    host.freeze();
    host.setCheckpointSink(() => {});
    host.requestCheckpoint({ final: true });
    socket.clearFrames();

    host.unfreeze();

    for (const socketId of ['s1', 's2']) {
      const order = socket.frames
        .filter(frame => frame.socketId === socketId)
        .map(frame => frame.method);

      expect(order.indexOf('sendClear')).toBeGreaterThan(-1);
      expect(order.indexOf('sendFirstShot')).toBeGreaterThan(
        order.indexOf('sendClear'),
      );
    }

    expect(
      socket.framesOf('sendMap').every(frame => frame.args[0].resume === true),
    ).toBe(true);

    // повторная разморозка (или без точки) синхронизацию не повторяет
    socket.clearFrames();
    host.freeze();
    host.unfreeze();

    expect(socket.framesOf('sendClear')).toHaveLength(0);
  });

  // ревью F3: клиент хост-игрока не в режиме возобновления и отвечает на
  // первый кадр пакета синхронизации FIRST_SHOT_READY — это не вход в матч
  it.each([
    ['обычная игра', MID_ROUND],
    ['noSpectators', { ...MID_ROUND, noSpectators: true }],
  ])(
    'повторный FIRST_SHOT_READY после разморозки — не вход (%s)',
    async (_, game) => {
      const { host, socket } = await createFixtureHost({ game });
      const gameId = await enterMatch(host, { socketId: 's1' });

      host.freeze();
      host.setCheckpointSink(() => {});
      host.requestCheckpoint({ final: true });
      host.unfreeze();
      expect(socket.framesOf('sendFirstShot').length).toBeGreaterThan(0);

      socket.clearFrames();

      const pushSystem = vi.spyOn(host._chat, 'pushSystem');
      const admitPlayer = vi.spyOn(host._roundManager, 'admitPlayer');

      host.firstShotReady(gameId);

      expect(pushSystem).not.toHaveBeenCalledWith(
        'USER_JOINED',
        expect.anything(),
      );
      expect(socket.framesOf('sendFirstVote')).toHaveLength(0);
      expect(admitPlayer).not.toHaveBeenCalled();
    },
  );

  it('чужая игра в точке валит восстановление', async () => {
    const { host } = await createFixtureHost();
    const { meta, core } = takeCheckpoint(host);

    await resetSingletons();

    await expect(
      createFixtureHost({
        opts: { checkpoint: { meta: { ...meta, gameId: 'other' }, core } },
      }),
    ).rejects.toThrow(/game mismatch/);
  });
});

describe('HostGame: эстафета Worker’ов (v3/v4, токены)', () => {
  it('v3 от Worker’а прежней версии по-прежнему принимается', async () => {
    const { host: next } = await createFixtureHost({
      opts: {
        handoff: {
          version: 3,
          gameId: 'miniGame',
          seq: 10,
          currentMap: 'arena',
          mapTimeLeft: 5000,
          humans: [
            {
              gameId: '0',
              socketId: 's1',
              name: 'P1',
              model: 'm1',
              team: 'spectators',
              teamId: 2,
            },
          ],
          scripted: [],
          stat: { head: {}, body: {} },
        },
      },
    });

    expect(next._participants.get('0').socketId).toBe('s1');
    expect(next.currentMap).toBe('arena');
  });

  // баг: после эстафеты rank/state не писались до конца сессии — новый
  // Worker не знал токенов участников и не подгружал их профили
  it('после эстафеты очки игрока пишутся на мастер с его токеном', async () => {
    const firstFetch = makeProfileFetch();
    const { host } = await createFixtureHost({
      opts: { playerDataFetch: firstFetch },
    });
    const gameId = await connectPlayer(host, { token: 'tok-1' });

    // накопленное до границы раунда уходит из старого Worker'а — до
    // terminate(), а не теряется вместе с ним
    host.addPlayerPoints(gameId, 3);
    host.finishPlayerGame(gameId);

    const handoff = await takeHandoff(host);

    expect(rankPuts(firstFetch)).toContainEqual({
      authorization: 'Bearer tok-1',
      body: expect.objectContaining({ points: 3 }),
    });
    expect(handoff.localTokens).toEqual({ [gameId]: 'tok-1' });

    await resetSingletons();

    const nextFetch = makeProfileFetch();
    const { host: next } = await createFixtureHost({
      opts: { handoff, playerDataFetch: nextFetch },
    });

    next.addPlayerPoints(gameId, 5);
    next.finishPlayerGame(gameId);

    const flushed = next.flushPlayerData({ urgent: true });

    await vi.advanceTimersByTimeAsync(5000);
    await flushed;

    expect(rankPuts(nextFetch)).toContainEqual({
      authorization: 'Bearer tok-1',
      body: expect.objectContaining({ points: 5 }),
    });
  });

  it('сетевая точка токенов не несёт даже после эстафеты', async () => {
    const { host } = await createFixtureHost();
    const gameId = await enterMatch(host, { token: 'tok-2' });
    const handoff = await takeHandoff(host);

    expect(handoff.localTokens[gameId]).toBe('tok-2');

    await resetSingletons();

    const { host: next } = await createFixtureHost({ opts: { handoff } });

    next.completeHandoff(new Set(['s1']));

    const { meta } = takeCheckpoint(next);

    expect(JSON.stringify(meta)).not.toContain('tok-2');
  });
});

describe('HostGame: находки ревью этапа 5', () => {
  // п.1: requestHandoff останавливает таймеры до сбора меты — остаток карты
  // не должен теряться (v3 его переносил)
  it('эстафета переносит остаток времени карты', async () => {
    const { host } = await createFixtureHost();

    await enterMatch(host);
    vi.advanceTimersByTime(4000);

    const expected = host._timerManager.getMapTimeLeft();
    const handoff = await takeHandoff(host);

    expect(handoff.timers.mapTimeLeft).toBeGreaterThan(0);
    expect(handoff.timers.mapTimeLeft).toBeLessThanOrEqual(expected);
    expect(handoff.timers.mapTimeLeft).toBeGreaterThan(expected - 5000);
  });

  // п.3: человек без resumeKey в мету не попадает, но его актор — в дампе
  // ядра; у преемника он не должен остаться бесхозным
  it('midRound: актор человека, не попавшего в точку, снимается из ядра', async () => {
    const { host } = await createFixtureHost({ game: MID_ROUND });
    const kept = await enterMatch(host, { socketId: 's1', name: 'A' });
    const dropped = await connectPlayer(host, { socketId: 's2', name: 'B' });

    joinTeam(host, dropped, 'team1');
    tick(host, 1);

    const { meta, core } = takeCheckpoint(host);

    host.freeze();
    await resetSingletons();

    const restored = await createFixtureHost({
      game: MID_ROUND,
      opts: { checkpoint: { meta, core } },
    });

    expect(restored.core.position_of(kept)).not.toEqual([]);
    expect(restored.core.position_of(dropped)).toEqual([]);
  });

  // п.5: точка, снятая до startAfterRestore, отдаёт таймеры восстановления
  it('точка до startAfterRestore сохраняет остатки таймеров', async () => {
    const { host } = await createFixtureHost({ game: MID_ROUND });

    await enterMatch(host);
    vi.advanceTimersByTime(3000);

    const first = takeCheckpoint(host);

    host.freeze();
    await resetSingletons();

    const { host: next } = await createFixtureHost({
      game: MID_ROUND,
      opts: { checkpoint: first },
    });
    let second = null;

    next.setCheckpointSink(checkpoint => {
      second = checkpoint;
    });
    next.requestCheckpoint();

    expect(second.meta.timers.mapTimeLeft).toBe(first.meta.timers.mapTimeLeft);
    expect(second.meta.timers.roundTimeLeft).toBe(
      first.meta.timers.roundTimeLeft,
    );
  });
});

describe('HostGame: старт у преемника (host-migration этап 7.4)', () => {
  // два человека в точке: s1 — будущий хост-игрок преемника, s2 — гость
  const promotedHost = async () => {
    const { host } = await createFixtureHost({ game: MID_ROUND });
    const first = await enterMatch(host, { name: 'A', socketId: 's1' });
    const second = await enterMatch(host, { name: 'B', socketId: 's2' });
    const { meta, core } = takeCheckpoint(host);

    host.freeze();
    await resetSingletons();

    const { host: next } = await createFixtureHost({
      game: MID_ROUND,
      opts: { checkpoint: { meta, core }, hostSocketId: 'local' },
    });

    return { next, first, second };
  };

  it('стартует, когда вернулись все люди точки; HOST_CHANGED всем', async () => {
    const { next, first, second } = await promotedHost();
    const chat = vi.spyOn(next._chat, 'pushSystem');
    const onStart = vi.fn();

    expect(next.startAfterResume(onStart)).toBe(true);
    expect(next.startAfterResume(onStart)).toBe(false);

    next.resumeUser(first, 'local', 'tok');

    expect(next.isRestorePending).toBe(true);
    expect(onStart).not.toHaveBeenCalled();

    next.resumeUser(second, 's9', 'tok');

    expect(next.isRestorePending).toBe(false);
    expect(onStart).toHaveBeenCalledWith([]);
    expect(chat).toHaveBeenCalledWith('HOST_CHANGED');
  });

  it('причина автоматической передачи — её код вместо HOST_CHANGED', async () => {
    for (const [reason, code] of [
      ['overload', 'HOST_CHANGED_OVERLOAD'],
      ['hidden', 'HOST_CHANGED_HIDDEN'],
      ['network', 'HOST_CHANGED_NETWORK'],
      ['handover', 'HOST_CHANGED'],
      ['constructor', 'HOST_CHANGED'],
    ]) {
      const { next, first, second } = await promotedHost();
      const chat = vi.spyOn(next._chat, 'pushSystem');

      next.startAfterResume(null, { reason });
      next.resumeUser(first, 'local', 'tok');
      next.resumeUser(second, 's9', 'tok');

      expect(chat).toHaveBeenCalledWith(code);
    }
  });

  it('не дождались за resumeWaitMs — старт без них, их id — для grace', async () => {
    const { next, first, second } = await promotedHost();
    const onStart = vi.fn();

    next.startAfterResume(onStart);
    next.resumeUser(first, 'local', 'tok');

    vi.advanceTimersByTime(2999);
    expect(next.isRestorePending).toBe(true);

    vi.advanceTimersByTime(1);
    expect(next.isRestorePending).toBe(false);
    expect(onStart).toHaveBeenCalledWith([second]);
    expect(next.isDetached(second)).toBe(true);
  });

  it('хост-игрок переезжает на вернувшегося через loopback', async () => {
    const { next, first, second } = await promotedHost();

    next.startAfterResume();
    next.resumeUser(first, 'local', 'tok');
    next.resumeUser(second, 's9', 'tok');

    // хост-игрок не отсоединяется (и не кикается), гость — как обычно
    expect(next.detachUser(first)).toBe(false);
    expect(next.detachUser(second)).toBe(true);
  });

  it('без ожидающих — старт сразу; без восстановления — нечего стартовать', async () => {
    const { next, first, second } = await promotedHost();

    next.resumeUser(first, 'local', 'tok');
    next.resumeUser(second, 's9', 'tok');

    const onStart = vi.fn();

    expect(next.startAfterResume(onStart)).toBe(true);
    expect(next.isRestorePending).toBe(false);
    expect(onStart).toHaveBeenCalledWith([]);
    expect(next.startAfterResume(onStart)).toBe(false);
  });
});

describe('HostGame: плановая передача ждёт границы раунда (этап 8d)', () => {
  it('игра без midRound: колбэк — на старте следующего раунда, один раз', async () => {
    const { host } = await createFixtureHost();
    const cb = vi.fn();

    await enterMatch(host);
    host.awaitRoundBoundary(cb);
    tick(host, 5);
    expect(cb).not.toHaveBeenCalled();

    host._roundManager.initiateNewRound();
    host._roundManager.initiateNewRound();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('cancelRoundBoundary снимает ожидание', async () => {
    const { host } = await createFixtureHost();
    const cb = vi.fn();

    await enterMatch(host);
    host.awaitRoundBoundary(cb);
    host.cancelRoundBoundary();
    host._roundManager.initiateNewRound();

    expect(cb).not.toHaveBeenCalled();
  });

  it('игра с midRound: ждать нечего — колбэк сразу', async () => {
    const { host } = await createFixtureHost({ game: MID_ROUND });
    const cb = vi.fn();

    host.awaitRoundBoundary(cb);

    expect(cb).toHaveBeenCalledOnce();
  });
});

describe('HostGame: плановая передача вытесняет эстафету (ревью, этап 8)', () => {
  it('cancelHandoff: граница раунда стартует раунд, колбэк эстафеты не зовётся', async () => {
    const { host } = await createFixtureHost();
    const cb = vi.fn();

    await enterMatch(host);
    host.requestHandoff(cb);
    host.cancelHandoff();

    const startRound = vi.spyOn(host._roundManager, '_startRound');

    host._roundManager.initiateNewRound();
    await vi.advanceTimersByTimeAsync(5000);

    expect(startRound).toHaveBeenCalledOnce();
    expect(cb).not.toHaveBeenCalled();
  });
});
