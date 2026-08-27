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
    spectatorTeam: 'spectatorTeam' in overrides ? overrides.spectatorTeam : 'spec',
    spectatorId: 'spectatorId' in overrides ? overrides.spectatorId : 3,
    noSpectators: overrides.noSpectators,
    endlessRound: overrides.endlessRound,
    maps: overrides.maps || {},
    mapList: overrides.mapList || [],
    mapsInVote: overrides.mapsInVote ?? 3,
    mapScale: 1,
    mapSetId: 'c1',
    currentMap: overrides.currentMap || 'm1',
  });

// noSpectators: вход ведёт прямо в играющую команду, минуя голосование и
// changeTeam со всеми его правилами
describe('RoundManager.admitPlayer', () => {
  const user = gameId => ({
    gameId,
    team: 'players',
    teamId: 1,
    name: gameId.toUpperCase(),
    model: 's1',
    socketId: `s${gameId}`,
    isNetworked: true,
    respawnIndex: null,
  });

  // точки респауна — реальный список, занятость — реальные participant'ы:
  // мок getTeamSize зафиксировал бы ровно ту формулу, которая и ломалась
  const makeCtx = (ids = ['u'], respawns = [[10, 20, 0]]) => {
    const users = Object.fromEntries(ids.map(id => [id, user(id)]));

    const participants = {
      ...fakeParticipants(users),
      addActive: vi.fn(),
      removeActive: vi.fn(),
    };

    const rm = makeRm({
      participants,
      teams: { players: 1 },
      spectatorTeam: null,
      spectatorId: null,
      noSpectators: true,
      scripted: { removeOneForHuman: vi.fn(() => false) },
      game: { createPlayer: vi.fn(), removePlayer: vi.fn() },
      stat: { updateUser: vi.fn() },
      chat: { pushSystemByUser: vi.fn() },
      socketManager: {
        sendPlayerDefaultShot: vi.fn(),
        sendSpectatorDefaultShot: vi.fn(),
      },
    });

    rm._scaledMapData = { respawns: { players: respawns } };

    return rm;
  };

  it('выдаёт актора участнику играющей команды', () => {
    const rm = makeCtx();

    expect(rm.admitPlayer('u')).toBe(true);
    expect(rm._game.createPlayer).toHaveBeenCalledWith(
      'u',
      's1',
      'U',
      1,
      [10, 20, 0],
    );
    expect(rm._participants.addActive).toHaveBeenCalledWith('u');
    expect(rm._participants.get('u').status).toBe('active');
    expect(rm._participants.get('u').respawnIndex).toBe(0);
    expect(rm._socketManager.sendPlayerDefaultShot).toHaveBeenCalledWith(
      'su',
      'u',
    );
  });

  it('двое подряд получают РАЗНЫЕ точки', () => {
    const rm = makeCtx(
      ['a', 'b'],
      [
        [10, 20, 0],
        [30, 40, 90],
      ],
    );

    expect(rm.admitPlayer('a')).toBe(true);
    expect(rm.admitPlayer('b')).toBe(true);

    expect(rm._participants.get('a').respawnIndex).toBe(0);
    expect(rm._participants.get('b').respawnIndex).toBe(1);
    expect(rm._game.createPlayer).toHaveBeenNthCalledWith(
      2,
      'b',
      's1',
      'B',
      1,
      [30, 40, 90],
    );
  });

  it('освободившийся слот переиспользуется, а не пропускается', () => {
    const rm = makeCtx(
      ['a', 'b', 'c'],
      [
        [10, 20, 0],
        [30, 40, 90],
        [50, 60, 180],
      ],
    );

    rm.admitPlayer('a');
    rm.admitPlayer('b');

    // 'a' ушёл в наблюдатели: слот 0 снова свободен, и его получает 'c',
    // а не третья точка «по размеру команды»
    rm._setSpectatorFromActivePlayer(rm._participants.get('a'));

    expect(rm.admitPlayer('c')).toBe(true);
    expect(rm._participants.get('c').respawnIndex).toBe(0);
  });

  it('отказывает и говорит об этом, когда свободной точки нет', () => {
    const rm = makeCtx(['a', 'b'], [[10, 20, 0]]);

    rm.admitPlayer('a');
    rm._game.createPlayer.mockClear();

    expect(rm.admitPlayer('b')).toBe(false);
    expect(rm._game.createPlayer).not.toHaveBeenCalled();
    expect(rm._chat.pushSystemByUser).toHaveBeenCalledWith(
      'b',
      'TEAMS_TEAM_FULL',
      ['players', 'players'],
    );
  });

  it('освобождает место за счёт бота, прежде чем отказать', () => {
    const rm = makeCtx(['a', 'b'], [[10, 20, 0]]);

    rm.admitPlayer('a');

    // бот ушёл, но точка всё та же одна и занята живым 'a' — освобождение
    // места не должно превращаться в выдачу занятого слота
    rm._scripted.removeOneForHuman.mockReturnValue(true);

    expect(rm.admitPlayer('b')).toBe(false);
    expect(rm._scripted.removeOneForHuman).toHaveBeenCalledWith('players');

    // а вот когда бот действительно держал слот, человек его получает
    const other = makeCtx(
      ['a', 'b'],
      [
        [10, 20, 0],
        [30, 40, 90],
      ],
    );
    const bot = { gameId: 'bot', team: 'players', respawnIndex: 1 };

    other._participants.getAll = () => [
      ...['a', 'b'].map(id => other._participants.get(id)),
      bot,
    ];
    other._scripted.removeOneForHuman = vi.fn(() => {
      bot.respawnIndex = null;

      return true;
    });

    other.admitPlayer('a');

    expect(other.admitPlayer('b')).toBe(true);
    expect(other._participants.get('b').respawnIndex).toBe(1);
  });

  it('игнорирует неизвестного участника', () => {
    const rm = makeCtx();

    expect(rm.admitPlayer('ghost')).toBe(false);
  });

  it('не вытесняет бота, когда точек нет вовсе', () => {
    // «слоты кончились» и «списка точек ещё нет» — разные состояния: во
    // втором вытеснение бота места не создаёт, а бот уже удалён
    const rm = makeCtx(['a'], []);

    rm._scripted.removeOneForHuman.mockReturnValue(true);

    expect(rm.admitPlayer('a')).toBe(false);
    expect(rm._scripted.removeOneForHuman).not.toHaveBeenCalled();
  });
});

// overrideMapData: игра пересобрала геометрию сама, минуя смену карты
describe('RoundManager.overrideMapData', () => {
  const makeCtx = () => {
    const rm = makeRm({ teams: { players: 1 }, spectatorTeam: null });

    rm._scaledMapData = { respawns: { players: [[1, 1, 0]] } };

    return rm;
  };

  it('подменяет карту старта раунда, не начиная раунд', () => {
    const rm = makeCtx();
    const scaled = { respawns: { players: [[9, 9, 0]] } };

    rm.overrideMapData(scaled);

    expect(rm._scaledMapData).toBe(scaled);
    expect(rm.currentMap).toBe('m1');
  });

  it('пустое значение игнорируется — карту нечем заменить', () => {
    const rm = makeCtx();
    const before = rm._scaledMapData;

    rm.overrideMapData(null);
    rm.overrideMapData(undefined);

    expect(rm._scaledMapData).toBe(before);
  });
});

// endlessRound: раунд не заканчивается и не перезапускается сам — правило
// «активных людей меньше двух» обнуляло бы stat на каждом входе и выходе
describe('RoundManager: endlessRound', () => {
  const makeCtx = (endlessRound) => {
    const users = {
      u: {
        gameId: 'u',
        team: 'spec',
        teamId: 3,
        name: 'U',
        model: 'm1',
        socketId: 'su',
        isNetworked: true,
      },
    };

    const participants = {
      ...fakeParticipants(users),
      getTeamSize: vi.fn(() => 1),
      addToTeam: vi.fn(),
      removeFromTeam: vi.fn(),
      addActive: vi.fn(),
    };

    const rm = makeRm({
      participants,
      endlessRound,
      game: { createPlayer: vi.fn() },
      stat: { moveUser: vi.fn(), updateUser: vi.fn(), reset: vi.fn(), updateHead: vi.fn() },
      chat: { pushSystemByUser: vi.fn() },
      socketManager: { sendPlayerDefaultShot: vi.fn() },
      timerManager: {
        canChangeTeamInCurrentRound: () => true,
        stopRoundTimer: vi.fn(),
        startRoundTimer: vi.fn(),
        startRoundRestartDelay: vi.fn(),
      },
    });

    rm._scaledMapData = { respawns: { red: [[0, 0, 0], [1, 1, 0]] } };
    rm.initiateNewRound = vi.fn();

    return rm;
  };

  it('без флага одинокий игрок обнуляет stat и рестартует раунд', () => {
    const rm = makeCtx(false);

    rm.changeTeam('u', 'red');

    expect(rm._stat.reset).toHaveBeenCalled();
    expect(rm.initiateNewRound).toHaveBeenCalled();
  });

  it('под флагом смена команды не трогает stat и раунд', () => {
    const rm = makeCtx(true);

    rm.changeTeam('u', 'red');

    expect(rm._stat.reset).not.toHaveBeenCalled();
    expect(rm.initiateNewRound).not.toHaveBeenCalled();
    expect(rm._game.createPlayer).toHaveBeenCalled();
  });

  it('под флагом вычищенная команда не завершает раунд', () => {
    const rm = makeCtx(true);

    rm._checkTeamWipe(1, 2);

    expect(rm._stat.updateHead).not.toHaveBeenCalled();
    expect(rm._timerManager.startRoundRestartDelay).not.toHaveBeenCalled();
  });

  it('под флагом истечение времени раунда ничего не запускает', () => {
    const rm = makeCtx(true);

    rm.onRoundTimeEnd();

    expect(rm.initiateNewRound).not.toHaveBeenCalled();
  });

  it('без флага истечение времени раунда запускает новый', () => {
    const rm = makeCtx(false);

    rm.onRoundTimeEnd();

    expect(rm.initiateNewRound).toHaveBeenCalled();
  });
});

// слот респауна при смене команды: он должен уходить от участника только
// вместе с актором, а не «на всякий случай» перед проверкой
describe('RoundManager.changeTeam: слот респауна', () => {
  const makeCtx = () => {
    const users = {
      u: {
        gameId: 'u',
        team: 'blue',
        teamId: 2,
        name: 'U',
        model: 'm1',
        socketId: 'su',
        isNetworked: true,
        respawnIndex: 0,
      },
      // держит единственную точку красных
      v: {
        gameId: 'v',
        team: 'red',
        teamId: 1,
        name: 'V',
        model: 'm1',
        socketId: 'sv',
        isNetworked: true,
        respawnIndex: 0,
      },
    };

    const participants = {
      ...fakeParticipants(users),
      // гейт «команда полна» считает по размеру команды, аллокатор — по
      // записанным слотам: тест разводит их ровно там, где они расходятся
      getTeamSize: vi.fn(() => 0),
      addToTeam: vi.fn(),
      removeFromTeam: vi.fn(),
      addActive: vi.fn(),
    };

    const rm = makeRm({
      participants,
      endlessRound: true,
      game: { createPlayer: vi.fn(), changePlayerData: vi.fn() },
      stat: { moveUser: vi.fn(), updateUser: vi.fn(), reset: vi.fn() },
      chat: { pushSystemByUser: vi.fn() },
      socketManager: { sendPlayerDefaultShot: vi.fn() },
      timerManager: { canChangeTeamInCurrentRound: () => true },
      scripted: { removeOneForHuman: vi.fn(() => false) },
    });

    rm._scaledMapData = { respawns: { red: [[0, 0, 0]] } };
    rm.initiateNewRound = vi.fn();

    return rm;
  };

  it('неудачный переход оставляет игроку его слот', () => {
    const rm = makeCtx();

    rm.changeTeam('u', 'red');

    expect(rm._chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'TEAMS_TEAM_FULL',
      ['red', 'blue'],
    );
    // иначе его физически занятая точка выглядит свободной для следующего
    // _freeRespawnIndex — и на неё встанет второй актор
    expect(rm._participants.get('u').respawnIndex).toBe(0);
    expect(rm._game.changePlayerData).not.toHaveBeenCalled();
  });

  it('успешный переход занимает свободный слот новой команды', () => {
    const rm = makeCtx();

    rm._scaledMapData = { respawns: { red: [[0, 0, 0], [1, 1, 0]] } };

    rm.changeTeam('u', 'red');

    // слот 0 держит 'v', поэтому переходящему достаётся 1 — свой прежний
    // индекс той же цифры занятостью в НОВОЙ команде не считается
    expect(rm._participants.get('u').respawnIndex).toBe(1);
    expect(rm._game.changePlayerData).toHaveBeenCalledWith('u', {
      respawnData: [1, 1, 0],
      teamId: 1,
      gameId: 'u',
    });
  });
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

describe('RoundManager.createMap', () => {
  const makeCtx = () => {
    const users = {
      u: { gameId: 'u', teamId: 1, team: 'red', socketId: 's' },
    };

    const participants = fakeParticipants(users);
    participants.resetTeamSizes = vi.fn();
    participants.clearActive = vi.fn();
    participants.addToTeam = vi.fn();

    return makeRm({
      participants,
      maps: { m1: { name: 'm1' } },
      game: { clear: vi.fn(), createMap: vi.fn() },
      panel: { reset: vi.fn() },
      stat: { reset: vi.fn(), moveUser: vi.fn() },
      voteCoordinator: { reset: vi.fn() },
      snapshotManager: { reset: vi.fn() },
      timerManager: { stopGameTimers: vi.fn(), startGameTimers: vi.fn() },
      scripted: {
        createMap: vi.fn(),
        getCountsPerTeam: () => ({}),
        removeScripted: vi.fn(),
        createScripted: vi.fn(),
      },
      socketManager: {
        sendClear: vi.fn(),
        sendSpectatorDefaultShot: vi.fn(),
        sendTechInform: vi.fn(),
        sendMap: vi.fn(),
      },
    });
  };

  it('шлёт keyset наблюдателя каждому человеку до очистки полотна', () => {
    const rm = makeCtx();
    const order = [];

    rm._socketManager.sendSpectatorDefaultShot.mockImplementation(id =>
      order.push(`keyset:${id}`),
    );
    rm._socketManager.sendClear.mockImplementation(id =>
      order.push(`clear:${id}`),
    );

    rm.createMap();

    expect(order).toEqual(['keyset:s', 'clear:s']);
  });

  it('переводит человека в наблюдатели и отправляет карту', () => {
    const rm = makeCtx();

    rm.createMap();

    const user = rm._participants.get('u');
    expect(user.status).toBe('spectator');
    expect(user.teamId).toBe(3);
    expect(rm._socketManager.sendMap).toHaveBeenCalledWith(
      's',
      expect.objectContaining({ name: 'm1' }),
    );
  });
});
