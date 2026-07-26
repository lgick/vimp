import { describe, it, expect, beforeEach } from 'vitest';

let ParticipantManager;

const TEAMS = { team1: 1, team2: 2, spectators: 3 };

// scripted-параметры — из конфига игры (namePrefix/defaultModel)
const SCRIPTED = { namePrefix: 'Bot', defaultModel: 'm1' };

const make = (maxPlayers = 8) =>
  new ParticipantManager(TEAMS, 'spectators', maxPlayers, SCRIPTED);

beforeEach(async () => {
  ParticipantManager = (
    await import('../../packages/engine/src/host/meta/player/ParticipantManager.js')
  ).default;
});

describe('ParticipantManager: создание людей', () => {
  it('createHuman возвращает числовой id и кладёт спектатора в реестр', () => {
    const pm = make();
    const gameId = pm.createHuman({ name: 'Alice', model: 'm1' }, 's1');

    expect(gameId).toBe('0');
    const p = pm.get(gameId);
    expect(p.name).toBe('Alice');
    expect(p.socketId).toBe('s1');
    expect(p.team).toBe('spectators');
    expect(p.teamId).toBe(3);
    expect(p.isNetworked).toBe(true);
    expect(p.isScripted).toBe(false);
    expect(pm.getTeamSize('spectators')).toBe(1);
  });

  it('createHuman пробрасывает identity-токен на участника (Этап B4)', () => {
    const pm = make();
    const gameId = pm.createHuman({ name: 'Alice', model: 'm1', token: 'jwt-1' }, 's1');

    expect(pm.get(gameId).token).toBe('jwt-1');
  });

  it('getNetworkedReady возвращает только готовых людей', () => {
    const pm = make();
    const a = pm.createHuman({ name: 'A', model: 'm1' }, 's1');
    pm.createHuman({ name: 'B', model: 'm1' }, 's2');

    expect(pm.getNetworkedReady()).toEqual([]);

    pm.get(a).isReady = true;
    expect(pm.getNetworkedReady().map(p => p.gameId)).toEqual([a]);
  });
});

describe('ParticipantManager: создание scripted-участников', () => {
  it('createScripted даёт числовой id из общего пула и имя <namePrefix><id>', () => {
    const pm = make();
    const gameId = pm.createScripted({ team: 'team1', model: 'm1' });

    const p = pm.get(gameId);
    expect(gameId).toBe('0');
    expect(p.name).toBe('Bot0');
    expect(p.team).toBe('team1');
    expect(p.teamId).toBe(1);
    expect(p.isScripted).toBe(true);
    expect(p.isNetworked).toBe(false);
    expect(pm.getTeamSize('team1')).toBe(1);
  });

  it('без model берётся scripted.defaultModel', () => {
    const pm = make();
    const gameId = pm.createScripted({ team: 'team1' });

    expect(pm.get(gameId).model).toBe('m1');
  });

  it('боты и люди делят единое числовое пространство id', () => {
    const pm = make();
    const h1 = pm.createHuman({ name: 'A', model: 'm1' }, 's1');
    const b1 = pm.createScripted({ team: 'team1', model: 'm1' });
    const h2 = pm.createHuman({ name: 'B', model: 'm1' }, 's2');

    expect([h1, b1, h2]).toEqual(['0', '1', '2']);
  });

  it('после удаления id переиспользуется (наименьший свободный)', () => {
    const pm = make();
    pm.createHuman({ name: 'A', model: 'm1' }, 's1'); // '0'
    const b = pm.createScripted({ team: 'team1', model: 'm1' }); // '1'
    pm.remove(b);

    const next = pm.createHuman({ name: 'C', model: 'm1' }, 's3');
    expect(next).toBe('1');
  });
});

describe('ParticipantManager.checkName: уникализация по всему реестру', () => {
  it('уникальное имя не меняется', () => {
    const pm = make();
    pm.createHuman({ name: 'Alice', model: 'm1' }, 's1');
    expect(pm.checkName('Bob')).toBe('Bob');
  });

  it('при коллизии добавляет #1', () => {
    const pm = make();
    pm.createHuman({ name: 'Bob', model: 'm1' }, 's1');
    expect(pm.checkName('Bob')).toBe('Bob#1');
  });

  it('при цепочке коллизий увеличивает номер', () => {
    const pm = make();
    pm.createHuman({ name: 'Bob', model: 'm1' }, 's1');
    pm.createHuman({ name: 'Bob#1', model: 'm1' }, 's2');
    expect(pm.checkName('Bob')).toBe('Bob#2');
  });

  it('учитывает имена ботов, а не только людей', () => {
    const pm = make();
    pm.createScripted({ team: 'team1', model: 'm1' }); // 'Bot0'
    expect(pm.checkName('Bot0')).toBe('Bot0#1');
  });
});

describe('ParticipantManager: лимит игроков', () => {
  it('totalCount считает людей и ботов, isFull срабатывает по maxPlayers', () => {
    const pm = make(2);
    pm.createHuman({ name: 'A', model: 'm1' }, 's1');
    expect(pm.isFull).toBe(false);

    pm.createScripted({ team: 'team1', model: 'm1' });
    expect(pm.totalCount).toBe(2);
    expect(pm.isFull).toBe(true);
  });

  it('без maxPlayers лимита нет', () => {
    const pm = make(0);
    pm.createHuman({ name: 'A', model: 'm1' }, 's1');
    expect(pm.isFull).toBe(false);
  });
});

describe('ParticipantManager: размеры команд', () => {
  it('resetTeamSizes создаёт пустые Set по командам', () => {
    const pm = make();
    pm.createHuman({ name: 'A', model: 'm1' }, 's1');
    pm.resetTeamSizes();

    expect(pm.getTeamSize('team1')).toBe(0);
    expect(pm.getTeamSize('spectators')).toBe(0);
  });

  it('addToTeam/removeFromTeam меняют размер', () => {
    const pm = make();
    pm.addToTeam('x', 'team1');
    expect(pm.getTeamSize('team1')).toBe(1);
    pm.removeFromTeam('x', 'team1');
    expect(pm.getTeamSize('team1')).toBe(0);
  });

  it('getPlayableTeams исключает команду наблюдателей', () => {
    const pm = make();
    expect(pm.getPlayableTeams()).toEqual(['team1', 'team2']);
  });
});

describe('ParticipantManager: активные игроки и наблюдение', () => {
  it('addActive добавляет без дублей', () => {
    const pm = make();
    pm.addActive('a');
    pm.addActive('b');
    pm.addActive('a');
    expect(pm.getActiveList()).toEqual(['a', 'b']);
  });

  it('removeActive удаляет и переназначает наблюдателей', () => {
    const pm = make();
    const watcher = pm.createHuman({ name: 'W', model: 'm1' }, 's1');
    pm.get(watcher).watchedGameId = 'a';
    pm.addActive('a');
    pm.addActive('b');

    pm.removeActive('a');

    expect(pm.getActiveList()).toEqual(['b']);
    expect(pm.get(watcher).watchedGameId).toBe('b');
  });

  it('clearActive опустошает список', () => {
    const pm = make();
    pm.addActive('a');
    pm.clearActive();
    expect(pm.getActiveList()).toEqual([]);
  });

  it('replaceWatched переводит наблюдателей на убийцу', () => {
    const pm = make();
    const w1 = pm.createHuman({ name: 'W1', model: 'm1' }, 's1');
    const w2 = pm.createHuman({ name: 'W2', model: 'm1' }, 's2');
    pm.get(w1).watchedGameId = 'victim';
    pm.get(w2).watchedGameId = 'x';
    pm.addActive('killer');

    pm.replaceWatched('victim', 'killer');

    expect(pm.get(w1).watchedGameId).toBe('killer');
    expect(pm.get(w2).watchedGameId).toBe('x');
  });

  it('replaceWatched ничего не делает, если убийцы нет в активных', () => {
    const pm = make();
    const w1 = pm.createHuman({ name: 'W1', model: 'm1' }, 's1');
    pm.get(w1).watchedGameId = 'victim';

    pm.replaceWatched('victim', 'killer');

    expect(pm.get(w1).watchedGameId).toBe('victim');
  });
});

describe('ParticipantManager.remove', () => {
  it('убирает из реестра, команды и списка активных', () => {
    const pm = make();
    const id = pm.createHuman({ name: 'A', model: 'm1' }, 's1');
    pm.addToTeam(id, 'team1');
    pm.addActive(id);

    pm.remove(id);

    expect(pm.get(id)).toBeUndefined();
    expect(pm.getActiveList()).not.toContain(id);
    expect(pm.getTeamSize('spectators')).toBe(0);
    expect(pm.totalCount).toBe(0);
  });

  it('remove несуществующего id не бросает', () => {
    const pm = make();
    expect(() => pm.remove('ghost')).not.toThrow();
  });
});

// Эстафета Worker'ов (Этап 5.2): восстановление участников с исходными id
describe('ParticipantManager: restoreHuman/restoreScripted', () => {
  it('восстанавливает человека с исходным gameId и командой', () => {
    const pm = make();
    const p = pm.restoreHuman({
      gameId: '5',
      socketId: 's1',
      name: 'Alice',
      model: 'm1',
      team: 'team1',
      teamId: 1,
    });

    expect(p).toMatchObject({
      gameId: '5',
      socketId: 's1',
      team: 'team1',
      teamId: 1,
    });
    expect(pm.get('5')).toBe(p);
    expect(pm.getTeamSize('team1')).toBe(1);
  });

  it('восстанавливает scripted-участника с исходным gameId', () => {
    const pm = make();
    const bot = pm.restoreScripted({
      gameId: '3',
      name: 'Bot3',
      model: 'm1',
      team: 'team2',
      teamId: 2,
    });

    expect(bot.isScripted).toBe(true);
    expect(pm.get('3')).toBe(bot);
    expect(pm.getTeamSize('team2')).toBe(1);
  });

  it('занятый id или неизвестная команда — null, запись пропускается', () => {
    const pm = make();
    const id = pm.createHuman({ name: 'A', model: 'm1' }, 's1');

    expect(
      pm.restoreHuman({
        gameId: id,
        socketId: 's2',
        name: 'B',
        model: 'm1',
        team: 'team1',
        teamId: 1,
      }),
    ).toBeNull();

    expect(
      pm.restoreScripted({
        gameId: '9',
        name: 'B',
        model: 'm1',
        team: 'ghosts',
        teamId: 9,
      }),
    ).toBeNull();
    expect(pm.get('9')).toBeUndefined();
  });

  it('генерация id учитывает восстановленные (единое пространство)', () => {
    const pm = make();

    pm.restoreHuman({
      gameId: '0',
      socketId: 's1',
      name: 'A',
      model: 'm1',
      team: 'team1',
      teamId: 1,
    });
    pm.restoreScripted({
      gameId: '1',
      name: 'B',
      model: 'm1',
      team: 'team2',
      teamId: 2,
    });

    expect(pm.createHuman({ name: 'C', model: 'm1' }, 's2')).toBe('2');
  });
});
