import { describe, it, expect, beforeEach } from 'vitest';
import RoomRegistry from '../../packages/engine/src/master/RoomRegistry.js';
import { isValidRoomId } from '../../packages/engine/src/lib/roomId.js';
import { deriveRoomSecret } from '../../packages/engine/src/master/roomSecret.js';

const KEY = 'k'.repeat(32);

// порог отключения регионального фильтра занижен для компактных тестов
const OPTIONS = {
  regionThreshold: 5,
  defaultLimit: 3,
  maxLimit: 4,
  maxPlayersLimit: 8,
  secretKey: KEY,
  heartbeatTimeout: 1000,
  memberGraceMs: 500,
  hostReclaimGraceMs: 300,
};

let registry;
let seq;

beforeEach(() => {
  registry = new RoomRegistry(OPTIONS);
  seq = 0;
});

// хост комнаты: сессия + вкладка + проверенный пользователь
const hostOf = (over = {}) => {
  seq += 1;

  return {
    sessionId: `s${seq}`,
    memberId: `m${seq}`,
    userId: seq,
    nick: `user${seq}`,
    ...over,
  };
};

const addRoom = (over = {}, now = 0) =>
  registry.add(
    {
      maxPlayers: 8,
      info: 'arena',
      region: 'EU',
      ip: `10.0.0.${seq + 1}`,
      gameId: 'tanks',
      host: hostOf(),
      ...over,
    },
    now,
  );

// регистрирует count комнат с уникальными IP
const addRooms = (count, region = 'EU') => {
  const rooms = [];

  for (let i = 0; i < count; i += 1) {
    rooms.push(
      addRoom({
        region,
        info: `map ${i}`,
        ip: `10.0.${region === 'EU' ? 0 : 1}.${i}`,
      }),
    );
  }

  return rooms;
};

describe('RoomRegistry.add', () => {
  it('создаёт комнату с roomId, эпохой 1 и хостом-участником', () => {
    const room = addRoom({ region: 'US', ip: '1.2.3.4' }, 100);

    expect(isValidRoomId(room.roomId)).toBe(true);
    expect(room).toMatchObject({
      epoch: 1,
      status: 'online',
      region: 'US',
      gameId: 'tanks',
      maxPlayers: 8,
      createdAt: 100,
      lastSeen: 100,
      host: { sessionId: 's1', memberId: 'm1', userId: 1, ip: '1.2.3.4' },
    });
    expect(room.members.get('m1')).toMatchObject({
      memberId: 'm1',
      userId: 1,
      nick: 'user1',
      sessionId: 's1',
      joinedAt: 100,
      detachedAt: null,
    });
    expect(registry.get(room.roomId)).toBe(room);
  });

  it('roomId уникальны на выборке', () => {
    const ids = new Set(addRooms(5).map(room => room.roomId));

    expect(ids.size).toBe(5);
  });

  it('коллизия roomId — генерация повторяется', () => {
    // первые две генерации дают один и тот же id, третья — другой
    const streams = [0, 0, 1];
    const collide = new RoomRegistry({
      ...OPTIONS,
      randomBytes: n => new Uint8Array(n).fill(streams.shift()),
    });
    const host = hostOf();

    const first = collide.add({ ip: '1.1.1.1', host });
    const second = collide.add({ ip: '2.2.2.2', host: hostOf() });

    expect(first.roomId).toBe('00000000');
    expect(second.roomId).toBe('11111111');
  });

  it('IP, который уже хостит комнату, вторую не создаёт', () => {
    addRoom({ ip: '1.2.3.4' });

    expect(addRoom({ ip: '1.2.3.4' })).toBeNull();
  });

  it('имени у комнаты нет, мусор получает дефолты', () => {
    const room = registry.add({
      name: 'ignored',
      maxPlayers: 'many',
      ip: '1.2.3.4',
      host: hostOf(),
    });

    expect(room).not.toHaveProperty('name');
    expect(room.maxPlayers).toBe(8);
    // строку карточки игра может не задавать — тогда её нет, без заглушки
    expect(room.info).toBeNull();
    expect(room.region).toBe('unknown');
    expect(room.gameId).toBeNull();
    expect(room.gameVersion).toBeNull();
  });

  it('не обрезает комнату игры, объявившей больший roomDefaults.maxPlayers', () => {
    const big = new RoomRegistry({
      ...OPTIONS,
      gameMaxPlayers: id => (id === 'snakes' ? 64 : undefined),
    });

    expect(
      big.add({ maxPlayers: 40, ip: '1', gameId: 'snakes', host: hostOf() })
        .maxPlayers,
    ).toBe(40);
    // неизвестная игра — санитарный дефолт
    expect(
      big.add({ maxPlayers: 40, ip: '2', gameId: 'quake', host: hostOf() })
        .maxPlayers,
    ).toBe(8);
  });
});

describe('RoomRegistry.restore', () => {
  it('восстанавливает комнату с заданными roomId и эпохой', () => {
    const room = registry.restore('abcd1234', 3, {
      ip: '1.1.1.1',
      gameId: 'tanks',
      host: hostOf(),
    });

    expect(room).toMatchObject({ roomId: 'abcd1234', epoch: 3 });
    expect(room.members.has('m1')).toBe(true);
  });

  it('занятый id или IP с другой комнатой — null', () => {
    const room = addRoom({ ip: '1.1.1.1' });

    expect(
      registry.restore(room.roomId, 1, { ip: '2.2.2.2', host: hostOf() }),
    ).toBeNull();
    expect(
      registry.restore('abcd1234', 1, { ip: '1.1.1.1', host: hostOf() }),
    ).toBeNull();
  });
});

describe('RoomRegistry: участники', () => {
  it('join добавляет участника, повторный join того же memberId перепривязывает', () => {
    const room = addRoom({}, 0);

    registry.joinMember(
      room.roomId,
      { memberId: 'g1', userId: 9, nick: 'g', sessionId: 'a' },
      10,
    );
    registry.detachMember('a', 20);
    registry.joinMember(
      room.roomId,
      { memberId: 'g1', userId: 9, nick: 'g', sessionId: 'b' },
      30,
    );

    expect(room.members.get('g1')).toMatchObject({
      sessionId: 'b',
      joinedAt: 10,
      detachedAt: null,
    });
  });

  it('join в неизвестную комнату — null', () => {
    expect(registry.joinMember('nope', { memberId: 'g1' })).toBeNull();
  });

  it('currentPlayers считает подключённых и отсоединённых в grace', () => {
    const room = addRoom({}, 0);

    registry.joinMember(room.roomId, { memberId: 'g1', sessionId: 'a' }, 0);
    registry.joinMember(room.roomId, { memberId: 'g2', sessionId: 'b' }, 0);
    registry.detachMember('b', 100);

    expect(registry.currentPlayers(room, 200)).toBe(3);
    expect(registry.liveMembers(room.roomId, 200)).toHaveLength(3);
    // grace 500 мс истёк
    expect(registry.currentPlayers(room, 700)).toBe(2);
    expect(registry.getList({}, 700).servers[0].currentPlayers).toBe(2);
  });

  it('leave удаляет участника сразу, без grace', () => {
    const room = addRoom();

    registry.joinMember(room.roomId, { memberId: 'g1', sessionId: 'a' });

    expect(registry.leaveMember(room.roomId, 'g1')).toBe(true);
    expect(room.members.has('g1')).toBe(false);
  });
});

describe('RoomRegistry.update', () => {
  it('heartbeat обновляет lastSeen и строку карточки', () => {
    const room = addRoom({}, 0);

    expect(registry.update(room.roomId, { info: 'dune' }, 50)).toBe(true);
    expect(room).toMatchObject({ lastSeen: 50, info: 'dune' });
    expect(registry.update('nope')).toBe(false);
  });

  it('info: undefined не трогает строку, null и пустая очищают', () => {
    const room = addRoom();

    registry.update(room.roomId, {});
    expect(room.info).toBe('arena');

    registry.update(room.roomId, { info: '   ' });
    expect(room.info).toBeNull();

    registry.update(room.roomId, { info: 'x' });
    registry.update(room.roomId, { info: null });
    expect(room.info).toBeNull();
  });

  it('строка карточки обрезается до maxInfoLength, не-строка — null', () => {
    const short = new RoomRegistry({ ...OPTIONS, maxInfoLength: 4 });

    expect(
      short.add({ ip: '1', info: '  abcdefgh ', host: hostOf() }).info,
    ).toBe('abcd');
    expect(short.add({ ip: '2', info: 42, host: hostOf() }).info).toBeNull();
  });
});

describe('RoomRegistry.sweep', () => {
  it('хост без heartbeat дольше таймаута — комната потеряла хоста, но не удалена (миграция, этап 7)', () => {
    const room = addRoom({}, 0);

    expect(registry.sweep(999).lost).toEqual([]);

    const { lost } = registry.sweep(1000);

    expect(lost).toEqual([room]);
    expect(registry.get(room.roomId)).toBe(room);
  });

  it('комната в миграции в lost не попадает — её ведёт MigrationCoordinator', () => {
    const room = addRoom({}, 0);

    room.status = 'migrating';

    expect(registry.sweep(5000).lost).toEqual([]);
  });

  it('отсоединённый хост ждёт reclaim hostReclaimGraceMs', () => {
    const room = addRoom({}, 0);

    registry.detachHost(room.roomId, 100);

    expect(registry.sweep(399).lost).toEqual([]);

    registry.attachHost(
      room.roomId,
      { sessionId: 's9', memberId: 'm1', ip: '7.7.7.7' },
      399,
    );

    expect(registry.sweep(1000).lost).toEqual([]);
    expect(room.host).toMatchObject({ sessionId: 's9', ip: '7.7.7.7' });
    expect(room.members.get('m1').sessionId).toBe('s9');
  });

  it('хост не вернулся за grace — комната потеряла хоста', () => {
    const room = addRoom({}, 0);

    registry.detachHost(room.roomId, 100);

    expect(registry.sweep(400).lost).toEqual([room]);
  });

  it('участник после grace удаляется, пустая комната удаляется', () => {
    const room = addRoom({}, 0);

    registry.joinMember(room.roomId, { memberId: 'g1', sessionId: 'a' }, 0);
    registry.detachMember('a', 0);
    registry.update(room.roomId, {}, 600);

    expect(registry.sweep(600)).toEqual({ lost: [], removed: [] });
    expect(room.members.has('g1')).toBe(false);

    // без участников (хоста выкинули руками) комната удаляется
    room.members.clear();

    expect(registry.sweep(600).removed).toEqual([room.roomId]);
    expect(registry.size).toBe(0);
  });
});

describe('RoomRegistry hidden (тестовые комнаты застейдженных версий)', () => {
  it('скрытая комната видна только includeHidden === true', () => {
    addRoom({ hidden: true });

    expect(registry.getList().servers).toEqual([]);
    expect(registry.getList({ includeHidden: 'true' }).servers).toEqual([]);
    expect(registry.getList({ includeHidden: true }).servers).toHaveLength(1);
  });

  it('комната в миграции или с отсоединённым хостом в список не попадает (этап 7.0)', () => {
    const migrating = addRoom();
    const detached = addRoom({ ip: '2.2.2.2' });

    migrating.status = 'migrating';
    registry.detachHost(detached.roomId);

    expect(registry.getList().servers).toEqual([]);
    expect(registry.getList({ search: migrating.roomId }).servers).toEqual([]);
  });
});

describe('RoomRegistry.getPublic', () => {
  it('публичная форма комнаты + status; нет комнаты — null', () => {
    const room = addRoom();

    room.status = 'migrating';

    expect(registry.getPublic(room.roomId)).toMatchObject({
      roomId: room.roomId,
      gameId: 'tanks',
      status: 'migrating',
    });
    expect(registry.getPublic('k7m2qx3a')).toBeNull();
    expect(registry.getPublic(undefined)).toBeNull();
  });
});

describe('RoomRegistry.getList', () => {
  it('при малом реестре (<= порога) отдаёт всё без фильтров', () => {
    addRooms(3, 'EU');
    addRooms(2, 'US');

    const result = registry.getList({ region: 'EU', offset: '0', limit: '2' });

    expect(result.total).toBe(5);
    expect(result.servers).toHaveLength(5);
  });

  it('при большом реестре фильтрует по региону и режет страницу', () => {
    addRooms(6, 'EU');
    addRooms(4, 'US');

    const result = registry.getList({ region: 'EU', offset: '2', limit: '3' });

    expect(result.total).toBe(6);
    expect(result.servers.map(s => s.info)).toEqual([
      'map 2',
      'map 3',
      'map 4',
    ]);
  });

  it('ограничивает limit значением maxLimit и терпит мусорные параметры', () => {
    addRooms(6, 'EU');

    expect(registry.getList({}).servers).toHaveLength(3); // defaultLimit
    expect(
      registry.getList({ offset: 'junk', limit: '9999' }).servers,
    ).toHaveLength(4); // maxLimit
  });

  it('публичная форма — roomId (+алиас hostId), без имени, рейтинга и IP', () => {
    const room = addRoom({ ip: '1.2.3.4' });
    const [pub] = registry.getList().servers;

    expect(pub).toEqual({
      roomId: room.roomId,
      hostId: room.roomId,
      gameId: 'tanks',
      info: 'arena',
      mapName: 'arena',
      currentPlayers: 1,
      maxPlayers: 8,
      region: 'EU',
    });
  });

  it('без строки карточки: info null, алиас mapName пустой', () => {
    addRoom({ info: undefined });

    expect(registry.getList().servers[0]).toMatchObject({
      info: null,
      mapName: '',
    });
  });
});

describe('RoomRegistry.getList: поиск', () => {
  let rooms;

  beforeEach(() => {
    rooms = [
      addRoom({ gameId: 'tanks', info: 'arena' }),
      addRoom({ gameId: 'snakes', info: 'pool' }),
    ];
    // поиск игнорирует регион и пагинацию — реестр больше порога
    addRooms(6, 'US');
  });

  const found = search =>
    registry.getList({ search, region: 'EU' }).servers.map(s => s.roomId);

  it('по префиксу roomId', () => {
    expect(found(rooms[1].roomId.slice(0, 8))).toEqual([rooms[1].roomId]);
  });

  it('по подстроке gameId и строки карточки', () => {
    expect(found('snak')).toEqual([rooms[1].roomId]);
    expect(found('POOL')).toEqual([rooms[1].roomId]);
  });

  it('форма карточки gameId/<префикс roomId>', () => {
    expect(found(`tanks/${rooms[0].roomId}`)).toEqual([rooms[0].roomId]);
    expect(found(`snakes/${rooms[0].roomId}`)).toEqual([]);
    expect(found('snakes/')).toEqual([rooms[1].roomId]);
  });
});

describe('RoomRegistry: секрет комнаты', () => {
  it('секрет — HMAC текущей эпохи и пользователя хоста', () => {
    const room = addRoom();

    expect(registry.roomSecret(room)).toBe(
      deriveRoomSecret(KEY, { roomId: room.roomId, epoch: 1, userId: 1 }),
    );
  });

  it('верный секрет → { sessionId: roomId }', () => {
    const room = addRoom();

    expect(
      registry.verifiedAttribution(room.roomId, registry.roomSecret(room)),
    ).toEqual({ sessionId: room.roomId });
  });

  it('чужой/пустой секрет или неизвестная комната → {}', () => {
    const room = addRoom();
    const other = addRoom();

    expect(
      registry.verifiedAttribution(room.roomId, registry.roomSecret(other)),
    ).toEqual({});
    expect(registry.verifiedAttribution(room.roomId, undefined)).toEqual({});
    expect(registry.verifiedAttribution('nope', 'x')).toEqual({});
  });

  it('смена эпохи меняет секрет', () => {
    const room = addRoom();
    const before = registry.roomSecret(room);

    room.epoch = 2;

    expect(registry.verifiedAttribution(room.roomId, before)).toEqual({});
  });
});

describe('RoomRegistry: настройки и смена хоста (host-migration этап 7)', () => {
  it('settings санируются при создании и в публичную форму не попадают', () => {
    const room = addRoom({
      settings: { map: 'dust', roundTime: 1e12, friendlyFire: 'yes', evil: 1 },
    });

    expect(room.settings).toEqual({ map: 'dust', roundTime: 86400000 });
    expect(registry.getList().servers[0]).not.toHaveProperty('settings');
    expect(registry.getPublic(room.roomId)).not.toHaveProperty('settings');
  });

  it('setSettings заменяет настройки, undefined не трогает', () => {
    const room = addRoom({ settings: { map: 'dust' } });

    registry.setSettings(room.roomId, undefined);
    expect(room.settings).toEqual({ map: 'dust' });

    registry.setSettings(room.roomId, { maxPlayers: 4 });
    expect(room.settings).toEqual({ maxPlayers: 4 });
  });

  it('promoteHost: новая эпоха и хост, online, бета сброшена, прежняя вкладка преемника удалена', () => {
    const room = addRoom({}, 0);

    registry.joinMember(room.roomId, { memberId: 'g1', sessionId: 'a' }, 0);
    room.status = 'migrating';
    room.pendingEpoch = 2;
    room.migration = { mode: 'cold' };
    room.successorMemberId = 'g1';
    room.standby = { memberId: 'g1' };
    room.reports.set('g1', 0);

    registry.promoteHost(
      room.roomId,
      {
        epoch: 2,
        sessionId: 'b',
        memberId: 'g1-reloaded',
        userId: 42,
        nick: 'beta',
        ip: '8.8.8.8',
        previousMemberId: 'g1',
      },
      50,
    );

    expect(room).toMatchObject({
      epoch: 2,
      status: 'online',
      pendingEpoch: null,
      migration: null,
      successorMemberId: null,
      standby: null,
      lastSeen: 50,
    });
    expect(room.host).toMatchObject({
      sessionId: 'b',
      memberId: 'g1-reloaded',
      userId: 42,
      ip: '8.8.8.8',
      detachedAt: null,
    });
    expect(room.reports.size).toBe(0);
    expect(room.members.has('g1')).toBe(false);
    expect(room.members.get('g1-reloaded')).toMatchObject({ nick: 'beta' });
    // секрет новой эпохи — от нового хоста
    expect(registry.roomSecret(room)).toBe(
      deriveRoomSecret(KEY, { roomId: room.roomId, epoch: 2, userId: 42 }),
    );
  });
});
