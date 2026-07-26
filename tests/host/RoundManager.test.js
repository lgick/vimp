import { describe, it, expect, vi } from 'vitest';
import RoundManager from '../../packages/engine/src/host/meta/core/RoundManager.js';

// RoundManager — обычный класс с DI. Подставляем фейковые сервисы.

const fakeParticipants = (usersMap = {}, activeList = []) => {
  const map = new Map(Object.entries(usersMap));

  return {
    get: id => map.get(id),
    getAll: () => [...map.values()],
    getHumans: () => [...map.values()].filter(p => !p.isScripted),
    getActiveList: () => activeList,
    replaceWatched: vi.fn(),
  };
};

const makeRm = (overrides = {}) =>
  new RoundManager({
    participants: overrides.participants || fakeParticipants(),
    game: overrides.game || {},
    panel: overrides.panel || {},
    stat: overrides.stat || {},
    chat: overrides.chat || {},
    socketManager: overrides.socketManager || {},
    timerManager: overrides.timerManager || {},
    scripted: overrides.scripted || {},
    voteCoordinator: overrides.voteCoordinator || {},
    snapshotManager: overrides.snapshotManager || {},
    playerDataSync: overrides.playerDataSync,
    teams: overrides.teams || { red: 1, blue: 2, spec: 3 },
    spectatorTeam: 'spec',
    spectatorId: 3,
    maps: overrides.maps || {},
    mapList: overrides.mapList || [],
    mapsInVote: overrides.mapsInVote ?? 3,
    mapScale: 1,
    mapSetId: 'c1',
    currentMap: overrides.currentMap || 'm1',
  });

describe('RoundManager.reportKill', () => {
  const makeCtx = () => {
    const users = {
      v: { gameId: 'v', teamId: 1, socketId: 'sv', isNetworked: true },
      k: {
        gameId: 'k',
        teamId: 2,
        socketId: 'sk',
        isNetworked: true,
        name: 'K',
      },
      ally: {
        gameId: 'ally',
        teamId: 1,
        socketId: 'sa',
        isNetworked: true,
        name: 'Ally',
      },
    };

    const rm = makeRm({
      participants: fakeParticipants(users),
      stat: { updateUser: vi.fn() },
      panel: { invalidate: vi.fn() },
      socketManager: {
        sendSpectatorDefaultShot: vi.fn(),
        sendSoundCue: vi.fn(),
      },
      chat: { pushSystem: vi.fn() },
    });

    rm._checkTeamWipe = vi.fn(); // изолируем от проверки вайпа

    return rm;
  };

  it('игнорирует неизвестную жертву', () => {
    const rm = makeCtx();
    rm.reportKill('ghost', 'k');
    expect(rm._stat.updateUser).not.toHaveBeenCalled();
  });

  it('помечает жертву мёртвой и переводит в наблюдатели', () => {
    const rm = makeCtx();
    rm.reportKill('v', 'k');

    expect(rm._participants.get('v').status).toBe('dead');
    expect(rm._participants.get('v').isWatching).toBe(true);
    expect(rm._stat.updateUser).toHaveBeenCalledWith('v', 1, {
      deaths: 1,
      status: 'dead',
    });
    expect(rm._panel.invalidate).toHaveBeenCalledWith('v');
  });

  it('начисляет фраг убийце-врагу и проверяет вайп', () => {
    const rm = makeCtx();
    rm.reportKill('v', 'k');

    expect(rm._stat.updateUser).toHaveBeenCalledWith('k', 2, { score: 1 });
    expect(rm._socketManager.sendSoundCue).toHaveBeenCalledWith('sk', 'frag');
    expect(rm._participants.replaceWatched).toHaveBeenCalledWith('v', 'k');
    expect(rm._checkTeamWipe).toHaveBeenCalledWith(1, 2);
  });

  it('снимает очко за огонь по своим', () => {
    const rm = makeCtx();
    rm.reportKill('v', 'ally');

    expect(rm._stat.updateUser).toHaveBeenCalledWith('ally', 1, { score: -1 });
  });

  it('самоубийство не меняет счёт', () => {
    const rm = makeCtx();
    rm.reportKill('v', 'v');

    const scoreCall = rm._stat.updateUser.mock.calls.find(
      ([, , data]) => 'score' in data,
    );
    expect(scoreCall).toBeUndefined();
  });

  it('начисляет ранг убийце-врагу через playerDataSync (Этап B4)', () => {
    const rm = makeCtx();
    rm._playerDataSync = { addRank: vi.fn() };

    rm.reportKill('v', 'k');

    expect(rm._playerDataSync.addRank).toHaveBeenCalledWith('k', 1);
  });

  it('снимает ранг за огонь по своим через playerDataSync (Этап B4)', () => {
    const rm = makeCtx();
    rm._playerDataSync = { addRank: vi.fn() };

    rm.reportKill('v', 'ally');

    expect(rm._playerDataSync.addRank).toHaveBeenCalledWith('ally', -1);
  });

  it('без убийцы только фиксирует смерть', () => {
    const rm = makeCtx();
    rm.reportKill('v');

    expect(rm._checkTeamWipe).not.toHaveBeenCalled();
    expect(rm._chat.pushSystem).not.toHaveBeenCalled();
  });

  it('убийца покинул игру: фраг не начисляется, вайп проверяется', () => {
    const rm = makeCtx();
    rm.reportKill('v', 'gone');

    expect(rm._participants.get('v').status).toBe('dead');
    expect(rm._chat.pushSystem).not.toHaveBeenCalled();
    expect(rm._socketManager.sendSoundCue).not.toHaveBeenCalledWith(
      'sk',
      'frag',
    );
    expect(rm._checkTeamWipe).toHaveBeenCalledWith(1, null);
  });
});

describe('RoundManager._checkTeamWipe', () => {
  const makeCtx = (overrides = {}) => {
    const users = {
      a: { gameId: 'a', teamId: 1, socketId: 'sa' },
      b: { gameId: 'b', teamId: 2, socketId: 'sb' },
    };

    return makeRm({
      participants: fakeParticipants(users),
      game: { isAlive: () => false, ...overrides.game },
      stat: { updateHead: vi.fn() },
      teams: { red: 1, blue: 2 },
      socketManager: {
        sendSoundCue: vi.fn(),
        sendRoundEnd: vi.fn(),
      },
      timerManager: {
        stopRoundTimer: vi.fn(),
        startRoundRestartDelay: vi.fn(),
      },
    });
  };

  it('завершает раунд при уничтожении команды и рассылает исход', () => {
    const rm = makeCtx();
    rm._checkTeamWipe(1, 2);

    expect(rm._isRoundEnding).toBe(true);
    expect(rm._stat.updateHead).toHaveBeenCalledWith(1, 'deaths', 1);
    expect(rm._stat.updateHead).toHaveBeenCalledWith(2, 'score', 1);
    expect(rm._socketManager.sendSoundCue).toHaveBeenCalledWith('sa', 'defeat');
    expect(rm._socketManager.sendSoundCue).toHaveBeenCalledWith(
      'sb',
      'victory',
    );
    expect(rm._socketManager.sendRoundEnd).toHaveBeenCalledWith('sa', 'blue');
    expect(rm._timerManager.startRoundRestartDelay).toHaveBeenCalled();
  });

  it('не срабатывает, если раунд уже завершается', () => {
    const rm = makeCtx();
    rm._isRoundEnding = true;
    rm._checkTeamWipe(1, 2);
    expect(rm._stat.updateHead).not.toHaveBeenCalled();
  });

  it('игнорирует команду наблюдателей', () => {
    const rm = makeCtx();
    rm._checkTeamWipe(3, 2); // victimTeamId === spectatorId
    expect(rm._stat.updateHead).not.toHaveBeenCalled();
  });

  it('не завершает раунд, если в команде есть живой', () => {
    const rm = makeCtx({ game: { isAlive: () => true } });
    rm._checkTeamWipe(1, 2);
    expect(rm._isRoundEnding).toBe(false);
    expect(rm._stat.updateHead).not.toHaveBeenCalled();
  });

  it('синхронизирует rank/state участников по итогам раунда (Этап B4)', () => {
    const rm = makeCtx();
    rm._playerDataSync = { flushAll: vi.fn() };

    rm._checkTeamWipe(1, 2);

    expect(rm._playerDataSync.flushAll).toHaveBeenCalled();
  });
});

describe('RoundManager._getMapList: пагинация', () => {
  it('возвращает весь список, если он не длиннее лимита', () => {
    const rm = makeRm({ mapList: ['m1', 'm2'], mapsInVote: 3 });
    expect(rm._getMapList()).toEqual(['m1', 'm2']);
  });

  it('листает страницы и зацикливается с переполнением', () => {
    const rm = makeRm({ mapList: ['m1', 'm2', 'm3', 'm4'], mapsInVote: 2 });

    expect(rm._getMapList()).toEqual(['m1', 'm2']);
    expect(rm._getMapList()).toEqual(['m3', 'm4']);
    // следующая страница выходит за конец → дозабор с начала
    expect(rm._getMapList()).toEqual(['m1', 'm2']);
  });
});

describe('RoundManager.changeName', () => {
  const makeCtx = () =>
    makeRm({
      participants: fakeParticipants({
        u: { gameId: 'u', teamId: 1, socketId: 's', name: 'Old' },
      }),
      game: { changeName: vi.fn() },
      stat: { updateUser: vi.fn() },
      chat: { pushSystem: vi.fn(), pushSystemByUser: vi.fn() },
      socketManager: { sendName: vi.fn() },
    });

  it('валидное имя применяется и рассылается', () => {
    const rm = makeCtx();
    // checkName реестра не задан в фейке — подменяем на identity
    rm._participants.checkName = name => name;

    rm.changeName('u', 'NewName');

    expect(rm._participants.get('u').name).toBe('NewName');
    expect(rm._game.changeName).toHaveBeenCalledWith('u', 'NewName');
    expect(rm._socketManager.sendName).toHaveBeenCalledWith('s', 'NewName');
  });

  it('невалидное имя отклоняется', () => {
    const rm = makeCtx();
    rm.changeName('u', '');
    expect(rm._chat.pushSystemByUser).toHaveBeenCalledWith('u', 'NAME_INVALID');
  });
});
