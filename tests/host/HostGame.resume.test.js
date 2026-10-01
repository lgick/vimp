import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createFixtureHost,
  connectPlayer,
  joinTeam,
  tick,
} from './fixtureHarness.js';

// HostGame: отсоединённый участник и возобновление (host-migration этап 4)
// поверх фикстурной миниигры. Порт-машинную половину (RESUME_REQUEST,
// таймеры ожидания) проверяет portMachine.test.js.

describe('HostGame: detach/resume', () => {
  let host;
  let socket;

  const framesTo = (method, socketId) =>
    socket.framesOf(method).filter(frame => frame.socketId === socketId);

  // активный игрок с выданным секретом места
  const activePlayer = async (socketId = 's1', name = 'P1') => {
    const gameId = await connectPlayer(host, { socketId, name });

    joinTeam(host, gameId, 'team1');
    tick(host, 1);
    host.issueResumeKey(gameId);

    return { gameId, user: host._participants.get(gameId) };
  };

  beforeEach(async () => {
    ({ host, socket } = await createFixtureHost());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('issueResumeKey выдаёт ключ один раз', async () => {
    const gameId = await connectPlayer(host);
    const key = host.issueResumeKey(gameId);

    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(host.issueResumeKey(gameId)).toBeNull();
    expect(host.issueResumeKey(9999)).toBeNull();
  });

  it('без секрета места detach отказывает (снимать сразу)', async () => {
    const gameId = await connectPlayer(host);

    expect(host.detachUser(gameId)).toBe(false);
    expect(host.isDetached(gameId)).toBe(false);
  });

  it('хост-игрок не отсоединяется', async () => {
    ({ host, socket } = await createFixtureHost({
      opts: { hostSocketId: 'local' },
    }));

    const gameId = await connectPlayer(host, { socketId: 'local' });

    host.issueResumeKey(gameId);

    expect(host.detachUser(gameId)).toBe(false);
  });

  it('detach отпускает все команды актора', async () => {
    const { gameId, user } = await activePlayer();
    const applyInput = vi.spyOn(host._game, 'applyInput');

    expect(user.isWatching).toBe(false);

    host.updateKeys(gameId, '7:down:forward');
    applyInput.mockClear();

    expect(host.detachUser(gameId)).toBe(true);

    expect(applyInput.mock.calls).toEqual([
      [gameId, 7, 'up', 'forward'],
      [gameId, 7, 'up', 'back'],
      [gameId, 7, 'up', 'fire'],
    ]);
  });

  it('отсоединённый держит слот, но не получает кадров, пингов и кика', async () => {
    ({ host, socket } = await createFixtureHost({ game: { maxPlayers: 1 } }));

    const { gameId } = await activePlayer();

    host.detachUser(gameId);

    // слот занят: новый вход в полную комнату отклоняется
    expect(host.isFull).toBe(true);

    socket.clearFrames();
    tick(host, 5);
    host._sendPing();
    host._kickIdleUsers();

    expect(socket.frames.filter(frame => frame.socketId === 's1')).toEqual([]);
    expect(socket.framesOf('sendShot')).toEqual([]);
    expect(socket.framesOf('close')).toEqual([]);
    expect(host._RTTManager._users.has(gameId)).toBe(false);
    expect(host._participants.get(gameId)).toBeDefined();
  });

  it('resumeUser возвращает активного игрока с полным пакетом входа', async () => {
    const { gameId, user } = await activePlayer();
    const oldKey = user.resumeKey;

    host.detachUser(gameId);
    socket.clearFrames();

    expect(host.resumeUser(gameId, 's2', 'fresh-token')).toBe(true);

    const order = socket.frames
      .filter(frame => frame.socketId === 's2')
      .map(frame => frame.method);

    // ответ — первым, секрет — последним; keyset наблюдателя до CLEAR
    expect(order[0]).toBe('sendResumeResult');
    expect(order.at(-1)).toBe('sendSessionData');
    expect(order.indexOf('sendSpectatorDefaultShot')).toBeLessThan(
      order.indexOf('sendClear'),
    );
    expect(order).toContain('sendFirstShot');
    expect(order).toContain('sendPlayerDefaultShot');

    expect(framesTo('sendResumeResult', 's2')[0].args[0]).toEqual({
      ok: true,
      gameId,
      epoch: null,
    });
    expect(user.resumeKey).not.toBe(oldKey);
    expect(user.token).toBe('fresh-token');
    expect(user.socketId).toBe('s2');
    expect(host.isDetached(gameId)).toBe(false);
    expect(host._RTTManager._users.has(gameId)).toBe(true);

    // кадры снова идут новому соединению
    socket.clearFrames();
    tick(host, 1);
    expect(framesTo('sendShot', 's2')).toHaveLength(1);
  });

  // CLEAR без списка стирает на клиенте и карту: без MAP_DATA следом первый
  // кадр создал бы сущности карты из частичных данных (ручная проверка
  // этапа 7: пустой экран и падение парта карты у преемника)
  it('пакет входа пересылает карту между CLEAR и первым кадром', async () => {
    const { gameId, user } = await activePlayer();

    host.detachUser(gameId);
    socket.clearFrames();
    host.resumeUser(gameId, 's2');

    const order = socket.frames
      .filter(frame => frame.socketId === 's2')
      .map(frame => frame.method);
    const mapIndex = order.indexOf('sendMap');

    expect(mapIndex).toBeGreaterThan(order.indexOf('sendClear'));
    expect(mapIndex).toBeLessThan(order.indexOf('sendFirstShot'));
    expect(framesTo('sendMap', 's2')[0].args[0]).toEqual({
      ...host._roundManager.currentMapData,
      resume: true,
    });
    expect(host._roundManager.currentMapData.resume).toBeUndefined();
    // это не загрузка карты: участник остаётся готовым, `loading` не уходит
    expect(user.isReady).toBe(true);
    expect(user.currentMap).toBe(host._roundManager.currentMap);
  });

  it('наблюдатель получает пакет без панели игрока', async () => {
    const gameId = await connectPlayer(host);

    host.issueResumeKey(gameId);
    host.detachUser(gameId);
    socket.clearFrames();
    host.resumeUser(gameId, 's2');

    expect(framesTo('sendFirstShot', 's2')).toHaveLength(1);
    expect(framesTo('sendPlayerDefaultShot', 's2')).toHaveLength(0);
  });

  it('карта сменилась в отсутствие — вместо кадра заново грузится карта', async () => {
    const { gameId, user } = await activePlayer();

    host.detachUser(gameId);
    // смена карты пометила участника не готовым (карта ушла в заглушку)
    host._roundManager.sendMap(gameId);
    expect(user.isReady).toBe(false);

    socket.clearFrames();
    host.resumeUser(gameId, 's2');

    expect(framesTo('sendMap', 's2')).toHaveLength(1);
    // обычная загрузка — без метки возобновления: клиент ответит MAP_READY
    expect(framesTo('sendMap', 's2')[0].args[0].resume).toBeUndefined();
    expect(framesTo('sendFirstShot', 's2')).toHaveLength(0);
    expect(framesTo('sendSessionData', 's2')).toHaveLength(1);
  });

  it('свежий токен уходит в PlayerDataSync', async () => {
    const { gameId } = await activePlayer();
    const attach = vi.spyOn(host._playerDataSync, 'attachToken');

    host.detachUser(gameId);
    host.resumeUser(gameId, 's2', 'fresh-token');

    expect(attach).toHaveBeenCalledWith(gameId, 'fresh-token');
  });

  it('removeUser отсоединённого снимает заглушку соединения', async () => {
    const { gameId, user } = await activePlayer();

    host.detachUser(gameId);

    const detachedId = user.socketId;
    const removeUser = vi.spyOn(socket, 'removeUser');

    host.removeUser(gameId);

    expect(removeUser).toHaveBeenCalledWith(detachedId);
    expect(host._participants.get(gameId)).toBeUndefined();
  });
});
