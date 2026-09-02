import { describe, it, expect, beforeEach } from 'vitest';
import HostRegistry from '../../packages/engine/src/master/HostRegistry.js';

// порог отключения регионального фильтра занижен для компактных тестов
const OPTIONS = {
  regionThreshold: 5,
  defaultLimit: 3,
  maxLimit: 4,
  maxNameLength: 10,
  maxPlayersLimit: 8,
};

let registry;

beforeEach(() => {
  registry = new HostRegistry(OPTIONS);
});

// регистрирует count комнат с уникальными IP
const addHosts = (count, region = 'EU') => {
  const hosts = [];

  for (let i = 0; i < count; i += 1) {
    hosts.push(
      registry.add({
        name: `room ${i}`,
        maxPlayers: 8,
        mapName: 'arena',
        region,
        ip: `10.0.${region === 'EU' ? 0 : 1}.${i}`,
      }),
    );
  }

  return hosts;
};

describe('HostRegistry.add', () => {
  it('регистрирует комнату с полным набором полей', () => {
    const host = registry.add({
      name: 'My Room',
      maxPlayers: 4,
      mapName: 'arena',
      region: 'EU',
      ip: '1.2.3.4',
    });

    expect(host.hostId).toBeTypeOf('string');
    expect(host).toMatchObject({
      name: 'My Room',
      maxPlayers: 4,
      currentPlayers: 0,
      mapName: 'arena',
      region: 'EU',
      ip: '1.2.3.4',
      status: 'online',
    });
    expect(registry.get(host.hostId)).toBe(host);
  });

  it('сохраняет hosterUserId (server-rating этап 2, атрибуция голосов)', () => {
    const host = registry.add({ name: 'a', ip: '1.2.3.4', hosterUserId: 42 });

    expect(host.hosterUserId).toBe(42);
  });

  it('без hosterUserId — null', () => {
    const host = registry.add({ name: 'a', ip: '1.2.3.4' });

    expect(host.hosterUserId).toBeNull();
  });

  it('не даёт создать вторую комнату с того же IP', () => {
    registry.add({ name: 'a', ip: '1.2.3.4' });

    expect(registry.add({ name: 'b', ip: '1.2.3.4' })).toBeNull();
    expect(registry.size).toBe(1);
  });

  it('обрезает имя и подставляет дефолты для мусорных данных', () => {
    const host = registry.add({
      name: '  very long room name\x00 ',
      maxPlayers: 100,
      mapName: 42,
      region: undefined,
      ip: '1.2.3.4',
    });

    // maxNameLength = 10, управляющие символы удалены
    expect(host.name).toBe('very long');
    expect(host.maxPlayers).toBe(8); // clamp к maxPlayersLimit
    expect(host.mapName).toBe('unknown');
    expect(host.region).toBe('unknown');
  });

  it('не обрезает комнату игры, объявившей больший roomDefaults.maxPlayers', () => {
    const registry2 = new HostRegistry({
      ...OPTIONS,
      gameMaxPlayers: id => (id === 'snakes' ? 64 : undefined),
    });

    const host = registry2.add({
      name: 'big',
      maxPlayers: 40,
      ip: '1.2.3.4',
      gameId: 'snakes',
    });

    expect(host.maxPlayers).toBe(40);
  });

  it('клампит потолком игры и санирует мусор в её же рамке', () => {
    const registry2 = new HostRegistry({
      ...OPTIONS,
      gameMaxPlayers: () => 64,
    });

    expect(
      registry2.add({ maxPlayers: 100, ip: '1.2.3.4', gameId: 'snakes' })
        .maxPlayers,
    ).toBe(64);
    expect(
      registry2.add({ maxPlayers: 'nope', ip: '1.2.3.5', gameId: 'snakes' })
        .maxPlayers,
    ).toBe(64);
    expect(
      registry2.add({ maxPlayers: 0, ip: '1.2.3.6', gameId: 'snakes' })
        .maxPlayers,
    ).toBe(1);
  });

  it('падает на санитарный дефолт для неизвестной игры и gameId: null', () => {
    const registry2 = new HostRegistry({
      ...OPTIONS,
      gameMaxPlayers: id => (id === 'snakes' ? 64 : undefined),
    });

    expect(
      registry2.add({ maxPlayers: 40, ip: '1.2.3.4', gameId: 'quake' })
        .maxPlayers,
    ).toBe(8);
    expect(registry2.add({ maxPlayers: 40, ip: '1.2.3.5' }).maxPlayers).toBe(8);
  });

  it('подставляет "unnamed" для пустого имени', () => {
    const host = registry.add({ name: '   ', ip: '1.2.3.4' });

    expect(host.name).toBe('unnamed');
  });
});

describe('HostRegistry.update', () => {
  it('обновляет currentPlayers/mapName и lastSeen (heartbeat)', () => {
    const host = registry.add({ name: 'a', maxPlayers: 8, ip: '1.1.1.1' }, 0);

    const ok = registry.update(
      host.hostId,
      { currentPlayers: 5, mapName: 'dune' },
      100,
    );

    expect(ok).toBe(true);
    expect(host.currentPlayers).toBe(5);
    expect(host.mapName).toBe('dune');
    expect(host.lastSeen).toBe(100);
  });

  it('clamp числа игроков к maxPlayers комнаты', () => {
    const host = registry.add({ name: 'a', maxPlayers: 4, ip: '1.1.1.1' });

    registry.update(host.hostId, { currentPlayers: 99 });

    expect(host.currentPlayers).toBe(4);
  });

  it('вызов без данных — чистый heartbeat', () => {
    const host = registry.add({ name: 'a', ip: '1.1.1.1' }, 0);

    registry.update(host.hostId, undefined, 500);

    expect(host.lastSeen).toBe(500);
  });

  it('возвращает false для неизвестной комнаты', () => {
    expect(registry.update('nope', {})).toBe(false);
  });
});

describe('HostRegistry.sweepStale', () => {
  it('удаляет комнаты без heartbeat дольше таймаута', () => {
    const stale = registry.add({ name: 'stale', ip: '1.1.1.1' }, 0);
    const fresh = registry.add({ name: 'fresh', ip: '2.2.2.2' }, 900);

    const removed = registry.sweepStale(1000, 1500);

    expect(removed).toEqual([stale.hostId]);
    expect(registry.get(stale.hostId)).toBeUndefined();
    expect(registry.get(fresh.hostId)).toBe(fresh);
  });
});

describe('HostRegistry hidden (тестовые комнаты застейдженных версий)', () => {
  it('комната с hidden не попадает в общий список', () => {
    registry.add({ name: 'public', mapName: 'arena', region: 'EU', ip: '10.1.0.1' });
    registry.add({
      name: 'staged',
      mapName: 'arena',
      region: 'EU',
      ip: '10.1.0.2',
      gameId: 'tanks',
      gameVersion: 'v-next',
      hidden: true,
    });

    const list = registry.getList();

    expect(list.total).toBe(1);
    expect(list.servers.map(s => s.name)).toEqual(['public']);
  });

  it('includeHidden отдаёт и скрытые — для админского запроса', () => {
    registry.add({ name: 'public', mapName: 'arena', region: 'EU', ip: '10.1.0.1' });
    registry.add({ name: 'staged', mapName: 'arena', region: 'EU', ip: '10.1.0.2', hidden: true });

    const list = registry.getList({ includeHidden: true });

    expect(list.total).toBe(2);
  });

  it('includeHidden из строки запроса не открывает скрытые комнаты', () => {
    registry.add({ name: 'staged', mapName: 'arena', region: 'EU', ip: '10.1.0.2', hidden: true });

    expect(registry.getList({ includeHidden: 'true' }).total).toBe(0);
  });

  it('по умолчанию комната не скрыта', () => {
    const host = registry.add({ name: 'room', mapName: 'arena', region: 'EU', ip: '10.1.0.3' });

    expect(host.hidden).toBe(false);
  });
});

describe('HostRegistry.getList', () => {
  it('поиск по подстроке имени игнорирует регион и пагинацию', () => {
    addHosts(4, 'EU');
    addHosts(4, 'US');

    const result = registry.getList({
      search: 'ROOM 2',
      region: 'EU',
      offset: '100',
      limit: '1',
    });

    // 'room 2' есть в обоих регионах, регистр не учитывается
    expect(result.total).toBe(2);
    expect(result.servers.map(s => s.name)).toEqual(['room 2', 'room 2']);
  });

  it('при малом реестре (<= порога) отдаёт всё без фильтров', () => {
    addHosts(3, 'EU');
    addHosts(2, 'US');

    const result = registry.getList({ region: 'EU', offset: '0', limit: '2' });

    expect(result.total).toBe(5);
    expect(result.servers).toHaveLength(5);
  });

  it('при большом реестре фильтрует по региону и режет страницу', () => {
    addHosts(6, 'EU');
    addHosts(4, 'US');

    const result = registry.getList({ region: 'EU', offset: '2', limit: '3' });

    expect(result.total).toBe(6);
    expect(result.servers.map(s => s.name)).toEqual([
      'room 2',
      'room 3',
      'room 4',
    ]);
    expect(result.servers.every(s => s.region === 'EU')).toBe(true);
  });

  it('без региона отдаёт общий список с дефолтным лимитом страницы', () => {
    addHosts(6, 'EU');

    const result = registry.getList({});

    expect(result.total).toBe(6);
    expect(result.servers).toHaveLength(3); // defaultLimit
  });

  it('ограничивает limit значением maxLimit и терпит мусорные параметры', () => {
    addHosts(6, 'EU');

    const result = registry.getList({ offset: 'junk', limit: '9999' });

    expect(result.servers).toHaveLength(4); // maxLimit
  });

  it('не отдаёт забаненные комнаты', () => {
    const [banned] = addHosts(3, 'EU');
    banned.status = 'banned';

    const result = registry.getList({});

    expect(result.total).toBe(2);
    expect(result.servers.find(s => s.hostId === banned.hostId)).toBeUndefined();
  });

  // lobby-page-plan: серверный поиск "gameId/name" — формат совпадает с
  // видом карточки в лобби ("tanks/room 0")
  it('поиск "gameId/name" фильтрует по игре И имени', () => {
    registry.add({ name: 'test', ip: '1.1.1.1', gameId: 'tanks' });
    registry.add({ name: 'classic', ip: '2.2.2.2', gameId: 'tanks' });
    registry.add({ name: 'test', ip: '3.3.3.3', gameId: 'other' });

    const result = registry.getList({ search: 'tanks/test' });

    expect(result.total).toBe(1);
    expect(result.servers[0]).toMatchObject({ gameId: 'tanks', name: 'test' });
  });

  it('поиск "gameId/" (пустой namePart) фильтрует только по игре', () => {
    registry.add({ name: 'a', ip: '1.1.1.1', gameId: 'tanks' });
    registry.add({ name: 'b', ip: '2.2.2.2', gameId: 'tanks' });
    registry.add({ name: 'c', ip: '3.3.3.3', gameId: 'other' });

    const result = registry.getList({ search: 'tanks/' });

    expect(result.total).toBe(2);
    expect(result.servers.every(s => s.gameId === 'tanks')).toBe(true);
  });

  it('поиск "gameId/name" без совпадений возвращает пустой список', () => {
    registry.add({ name: 'test server', ip: '1.1.1.1', gameId: 'tanks' });

    const result = registry.getList({ search: 'other/test' });

    expect(result).toEqual({ total: 0, servers: [] });
  });

  it('не раскрывает IP и служебные поля в публичном списке', () => {
    addHosts(1, 'EU');

    const [server] = registry.getList({}).servers;

    expect(Object.keys(server).sort()).toEqual([
      'currentPlayers',
      'gameId',
      'hostId',
      'mapName',
      'maxPlayers',
      'name',
      'rating',
      'region',
    ]);
  });
});

describe('HostRegistry: рейтинг хостера (server-rating этап 3)', () => {
  it('новая комната стартует с рейтингом 0', () => {
    const host = registry.add({ name: 'a', ip: '1.1.1.1' });

    expect(host.rating).toBe(0);

    const [server] = registry.getList({}).servers;

    expect(server.rating).toBe(0);
  });

  it('setRating обновляет рейтинг конкретной комнаты', () => {
    const host = registry.add({ name: 'a', ip: '1.1.1.1' });

    registry.setRating(host.hostId, 7);

    expect(host.rating).toBe(7);
  });

  it('setRating на неизвестный hostId — no-op', () => {
    expect(() => registry.setRating('nope', 7)).not.toThrow();
  });

  it('setRatingForHoster обновляет рейтинг во всех комнатах этого хостера', () => {
    const a = registry.add({ name: 'a', ip: '1.1.1.1', hosterUserId: 42 });
    const b = registry.add({ name: 'b', ip: '2.2.2.2', hosterUserId: 42 });
    const other = registry.add({ name: 'c', ip: '3.3.3.3', hosterUserId: 99 });

    registry.setRatingForHoster(42, -3);

    expect(a.rating).toBe(-3);
    expect(b.rating).toBe(-3);
    expect(other.rating).toBe(0);
  });

  it('getHosterUserIds возвращает уникальные id хостеров активных комнат', () => {
    registry.add({ name: 'a', ip: '1.1.1.1', hosterUserId: 42 });
    registry.add({ name: 'b', ip: '2.2.2.2', hosterUserId: 42 });
    registry.add({ name: 'c', ip: '3.3.3.3' });

    expect(registry.getHosterUserIds()).toEqual(new Set([42]));
  });

  // кодревью №2 (plan/server-rating/review.md): эвакуация всех комнат
  // заблокированного хостера — обычно одна, но технически может быть больше
  it('getHostIdsForHoster возвращает все hostId данного хостера', () => {
    const a = registry.add({ name: 'a', ip: '1.1.1.1', hosterUserId: 42 });
    const b = registry.add({ name: 'b', ip: '2.2.2.2', hosterUserId: 42 });
    registry.add({ name: 'c', ip: '3.3.3.3', hosterUserId: 99 });

    expect(registry.getHostIdsForHoster(42).sort()).toEqual([a.hostId, b.hostId].sort());
    expect(registry.getHostIdsForHoster(99)).toEqual([expect.any(String)]);
    expect(registry.getHostIdsForHoster(7)).toEqual([]);
  });
});

// кодревью №1 (доработка): атрибуция rank/state к комнате допустима, только
// если запрос несёт per-room секрет этой комнаты — иначе хост мог бы подставить
// чужой публичный hostId (обойти void / подставить хостера-жертву)
describe('HostRegistry.verifiedAttribution (server-rating кодревью №1)', () => {
  it('add выдаёт per-room секрет, не раскрываемый в публичном списке', () => {
    const host = registry.add({ name: 'a', ip: '1.1.1.1', hosterUserId: 42 });

    expect(host.secret).toBeTypeOf('string');
    expect(host.secret).not.toBe(host.hostId);
    expect(registry.getList({}).servers[0]).not.toHaveProperty('secret');
  });

  it('верный секрет → { hosterUserId, sessionId: hostId }', () => {
    const host = registry.add({ name: 'a', ip: '1.1.1.1', hosterUserId: 42 });

    expect(registry.verifiedAttribution(host.hostId, host.secret)).toEqual({
      hosterUserId: 42,
      sessionId: host.hostId,
    });
  });

  it('неверный/отсутствующий секрет → {} (чужой hostId не подставить)', () => {
    const host = registry.add({ name: 'a', ip: '1.1.1.1', hosterUserId: 42 });

    expect(registry.verifiedAttribution(host.hostId, 'wrong')).toEqual({});
    expect(registry.verifiedAttribution(host.hostId, undefined)).toEqual({});
    expect(registry.verifiedAttribution(host.hostId, null)).toEqual({});
  });

  it('неизвестный hostId → {}', () => {
    expect(registry.verifiedAttribution('nope', 'x')).toEqual({});
    expect(registry.verifiedAttribution(null, null)).toEqual({});
  });

  it('комната без hosterUserId → {} даже с верным секретом', () => {
    const host = registry.add({ name: 'a', ip: '1.1.1.1' });

    expect(registry.verifiedAttribution(host.hostId, host.secret)).toEqual({});
  });
});

describe('HostRegistry.add — gameId/gameVersion', () => {
  it('сохраняет gameId/gameVersion и выставляет gameId в публичный список', () => {
    const host = registry.add({
      name: 'a',
      ip: '1.1.1.1',
      gameId: 'tanks',
      gameVersion: 'abc123',
    });

    expect(host.gameId).toBe('tanks');
    expect(host.gameVersion).toBe('abc123');

    const [server] = registry.getList({}).servers;

    expect(server.gameId).toBe('tanks');
  });

  it('без gameId/gameVersion — null (хосты до Этапа 6.4)', () => {
    const host = registry.add({ name: 'a', ip: '1.1.1.1' });

    expect(host.gameId).toBeNull();
    expect(host.gameVersion).toBeNull();
  });
});
