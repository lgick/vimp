import { describe, it, expect, beforeEach, vi } from 'vitest';
import RouteBoot, {
  roomDefaultsOf,
} from '../../../packages/engine/src/client/session/RouteBoot.js';
import { createRoomContext } from '../../../packages/engine/src/client/session/roomContext.js';
import { PROMOTION_STORAGE_KEY } from '../../../packages/engine/src/client/network/Promotion.js';
import { makeConfig, makeSignaling } from './sessionFakes.js';

// Прямые ссылки: каждая ветка decideRouteAction, ожидание мигрирующей
// комнаты, смена hash во время ожидания, холодный промоушен из
// sessionStorage, hashchange в комнате.

const ROOM_ID = 'abcd2345';
const TOKEN = '0123456789abcdef0123456789abcdef';
const TANKS = {
  id: 'tanks',
  title: 'Tanks',
  roomDefaults: { maxPlayers: 8 },
  roomForm: [{ name: 'map', type: 'select', default: 'arena' }],
};

let ctx;
let signaling;
let membership;
let gamesById;
let selectActiveGame;
let connectToRoom;
let createRoom;
let fetchServers;
let ui;
let hash;
let responses;
let storage;
let config;

// очередь ответов fetch по url: последний повторяется
const fetch = vi.fn(async url => {
  const queue = responses[url];

  if (!queue) {
    throw new Error(`offline: ${url}`);
  }

  const res = queue.length > 1 ? queue.shift() : queue[0];

  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    json: async () => res.body,
  };
});

const create = (extra = {}) =>
  new RouteBoot({
    ctx,
    signaling,
    membership,
    config,
    gamesById,
    selectActiveGame,
    connectToRoom,
    createRoom,
    fetchServers,
    ui,
    fetch,
    getStorage: () => storage,
    sleep: async () => {},
    now: () => 0,
    ...extra,
  });

beforeEach(() => {
  ctx = createRoomContext();
  signaling = makeSignaling();
  membership = { tokenAllowsHostRole: vi.fn(() => true) };
  gamesById = new Map([['tanks', TANKS]]);
  selectActiveGame = vi.fn(async () => true);
  connectToRoom = vi.fn(() => {
    ctx.entered = true;
  });
  createRoom = vi.fn(async () => {
    ctx.entered = true;
  });
  fetchServers = vi.fn(async () => null);
  hash = '';
  ui = {
    initLobby: vi.fn(),
    selectLobbyGame: vi.fn(),
    informTech: vi.fn(),
    onInformerClick: vi.fn(),
    getHash: () => hash,
    setRoute: vi.fn(),
    reloadPage: vi.fn(),
  };
  responses = {};
  storage = new Map();
  storage.getItem = key => Map.prototype.get.call(storage, key) ?? null;
  storage.setItem = (key, value) => Map.prototype.set.call(storage, key, value);
  storage.removeItem = key => Map.prototype.delete.call(storage, key);
  config = makeConfig();
  fetch.mockClear();
});

describe('RouteBoot: ветки маршрута', () => {
  it('без hash — лобби', async () => {
    const route = create();

    route.boot();
    await vi.waitFor(() => expect(ui.initLobby).toHaveBeenCalled());

    expect(route.booted).toBe(true);
    expect(connectToRoom).not.toHaveBeenCalled();
  });

  it('повторный boot (реконнект сигналинга) маршрут не повторяет', async () => {
    const route = create();

    await route.run();
    route.boot();
    route.boot();

    expect(ui.initLobby).toHaveBeenCalledTimes(2);
  });

  it('живая комната — вход гостем на игре комнаты', async () => {
    hash = `#/tanks/${ROOM_ID}`;
    responses[`/rooms/${ROOM_ID}`] = [
      {
        status: 200,
        body: { gameId: 'tanks', currentPlayers: 1, maxPlayers: 8 },
      },
    ];

    await create().run();

    expect(selectActiveGame).toHaveBeenCalledWith('tanks', expect.any(Object));
    expect(connectToRoom).toHaveBeenCalledWith(ROOM_ID);
  });

  it('недоступная игра — лобби с причиной', async () => {
    hash = '#/snakes';

    await create().run();

    expect(ui.setRoute).toHaveBeenCalledWith('');
    expect(ui.initLobby).toHaveBeenCalled();
    expect(ui.informTech).toHaveBeenCalledWith(
      'Game "snakes" is not available.',
    );
    expect(ui.onInformerClick).toHaveBeenCalled();
  });

  it('игра не активировалась — лобби с её причиной', async () => {
    hash = '#/tanks';
    selectActiveGame.mockImplementation(async (gameId, { report }) => {
      report('Failed to load Tanks');

      return false;
    });
    responses['/quick-play/tanks'] = [
      { status: 200, body: { room: { roomId: ROOM_ID } } },
    ];

    await create().run();

    expect(ui.selectLobbyGame).toHaveBeenCalledWith('tanks');
    expect(ui.informTech).toHaveBeenCalledWith('Failed to load Tanks');
    expect(connectToRoom).not.toHaveBeenCalled();
  });
});

describe('RouteBoot: быстрая игра', () => {
  it('мёртвая ссылка — комната от мастера', async () => {
    hash = `#/tanks/${ROOM_ID}`;
    responses[`/rooms/${ROOM_ID}`] = [{ status: 404 }];
    responses['/quick-play/tanks'] = [
      { status: 200, body: { room: { roomId: 'zzzz2345' } } },
    ];

    await create().run();

    expect(connectToRoom).toHaveBeenCalledWith('zzzz2345');
  });

  it('мастер без роута — выбор по списку серверов', async () => {
    hash = '#/tanks';
    fetchServers.mockResolvedValue({
      servers: [
        {
          roomId: 'qqqq2345',
          gameId: 'tanks',
          currentPlayers: 2,
          maxPlayers: 8,
        },
      ],
    });

    await create().run();

    expect(fetchServers).toHaveBeenCalledWith({ search: 'tanks' });
    expect(connectToRoom).toHaveBeenCalledWith('qqqq2345');
  });

  it('комнат нет — своя комната с дефолтами формы', async () => {
    hash = '#/tanks';
    responses['/quick-play/tanks'] = [{ status: 200, body: { room: null } }];

    await create().run();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(createRoom).toHaveBeenCalledWith({
      hostSocketId: 'host',
      maxPlayers: 8,
      map: 'arena',
    });
  });

  it('браузер не может хостить — лобби под причиной', async () => {
    hash = '#/tanks';
    responses['/quick-play/tanks'] = [{ status: 200, body: { room: null } }];
    createRoom.mockResolvedValue();

    await create().run();

    expect(ui.initLobby).toHaveBeenCalled();
    expect(ui.onInformerClick).toHaveBeenCalled();
  });

  it('без автосоздания — лобби выбранной игры', async () => {
    hash = '#/tanks';
    config.quickPlay.autoCreate = false;
    responses['/quick-play/tanks'] = [{ status: 200, body: { room: null } }];

    await create().run();

    expect(createRoom).not.toHaveBeenCalled();
    expect(ui.selectLobbyGame).toHaveBeenCalledWith('tanks');
  });

  it('roomDefaultsOf: схема формы поверх roomDefaults', () => {
    expect(roomDefaultsOf(TANKS)).toEqual({ maxPlayers: 8, map: 'arena' });
    expect(roomDefaultsOf({ roomDefaults: { a: 1 } })).toEqual({ a: 1 });
  });
});

describe('RouteBoot: комната меняет хоста', () => {
  beforeEach(() => {
    hash = `#/tanks/${ROOM_ID}`;
  });

  it('ожидание до online, затем вход', async () => {
    responses[`/rooms/${ROOM_ID}`] = [
      { status: 200, body: { gameId: 'tanks', status: 'migrating' } },
      { status: 503 },
      {
        status: 200,
        body: { gameId: 'tanks', currentPlayers: 1, maxPlayers: 8 },
      },
    ];

    await create().run();

    expect(ui.informTech).toHaveBeenCalledWith('Switching host…');
    expect(ui.informTech).toHaveBeenLastCalledWith();
    expect(connectToRoom).toHaveBeenCalledWith(ROOM_ID);
  });

  it('комната пропала во время ожидания — быстрая игра', async () => {
    responses[`/rooms/${ROOM_ID}`] = [
      { status: 200, body: { gameId: 'tanks', status: 'handing_off' } },
      { status: 404 },
    ];
    responses['/quick-play/tanks'] = [
      { status: 200, body: { room: { roomId: 'zzzz2345' } } },
    ];

    await create().run();

    expect(connectToRoom).toHaveBeenCalledWith('zzzz2345');
  });

  it('не дождались к сроку — быстрая игра', async () => {
    let clock = 0;

    responses[`/rooms/${ROOM_ID}`] = [
      { status: 200, body: { gameId: 'tanks', status: 'migrating' } },
    ];
    responses['/quick-play/tanks'] = [
      { status: 200, body: { room: { roomId: 'zzzz2345' } } },
    ];

    await create({
      now: () => clock,
      sleep: async ms => {
        clock += ms;
      },
    }).run();

    expect(connectToRoom).toHaveBeenCalledWith('zzzz2345');
  });

  it('смена hash во время ожидания — разбор нового маршрута', async () => {
    responses[`/rooms/${ROOM_ID}`] = [
      { status: 200, body: { gameId: 'tanks', status: 'migrating' } },
    ];

    let route = null;
    let polls = 0;

    route = create({
      sleep: async () => {
        polls += 1;

        // игрок ушёл по другой ссылке, пока ждали
        if (polls === 2) {
          hash = '';
          route.handleHashChange();
        }
      },
    });
    route.boot();

    await vi.waitFor(() => expect(ui.initLobby).toHaveBeenCalled());
    expect(connectToRoom).not.toHaveBeenCalled();
    expect(ui.informTech).toHaveBeenLastCalledWith();
  });
});

describe('RouteBoot: холодный промоушен', () => {
  const pending = (settings = { maxPlayers: 4 }) =>
    storage.setItem(
      PROMOTION_STORAGE_KEY,
      JSON.stringify({
        roomId: ROOM_ID,
        epoch: 3,
        promotionToken: TOKEN,
        gameId: 'tanks',
        settings,
      }),
    );

  beforeEach(() => {
    hash = `#/tanks/${ROOM_ID}`;
  });

  it('занимает комнату с настройками точки', async () => {
    pending();

    await create().run();

    expect(ctx.roomId).toBe(ROOM_ID);
    expect(createRoom).toHaveBeenCalledWith(
      { hostSocketId: 'host', maxPlayers: 4, map: 'arena' },
      { promotion: expect.objectContaining({ roomId: ROOM_ID, epoch: 3 }) },
    );
    expect(storage.getItem(PROMOTION_STORAGE_KEY)).toBeNull();
    expect(connectToRoom).not.toHaveBeenCalled();
  });

  it('вход истёк за перезагрузку — promote_failed и вход гостем', async () => {
    pending();
    membership.tokenAllowsHostRole.mockReturnValue(false);
    responses[`/rooms/${ROOM_ID}`] = [
      {
        status: 200,
        body: { gameId: 'tanks', currentPlayers: 1, maxPlayers: 8 },
      },
    ];

    await create().run();

    expect(signaling.promoteFailed).toHaveBeenCalled();
    expect(createRoom).not.toHaveBeenCalled();
    expect(connectToRoom).toHaveBeenCalledWith(ROOM_ID);
  });

  it('комната не поднялась — promote_failed и вход гостем', async () => {
    pending();
    createRoom.mockResolvedValue();
    responses[`/rooms/${ROOM_ID}`] = [
      {
        status: 200,
        body: { gameId: 'tanks', currentPlayers: 1, maxPlayers: 8 },
      },
    ];

    await create().run();

    expect(signaling.promoteFailed).toHaveBeenCalled();
    expect(connectToRoom).toHaveBeenCalledWith(ROOM_ID);
  });

  it('запись другой комнаты не используется и снимается', async () => {
    pending();
    hash = '#/tanks/zzzz2345';
    responses['/rooms/zzzz2345'] = [{ status: 404 }];
    responses['/quick-play/tanks'] = [
      { status: 200, body: { room: { roomId: 'zzzz2345' } } },
    ];

    await create().run();

    expect(createRoom).not.toHaveBeenCalled();
    expect(storage.getItem(PROMOTION_STORAGE_KEY)).toBeNull();
  });
});

describe('RouteBoot.handleHashChange', () => {
  it('до бутстрапа ничего не делает', () => {
    create().handleHashChange();

    expect(ui.initLobby).not.toHaveBeenCalled();
  });

  it('в комнате: та же комната — ничего, другая — перезагрузка', async () => {
    const route = create();

    route.boot();
    await vi.waitFor(() => expect(ui.initLobby).toHaveBeenCalled());

    ctx.entered = true;
    ctx.roomId = ROOM_ID;
    hash = `#/tanks/${ROOM_ID}`;
    route.handleHashChange();
    expect(ui.reloadPage).not.toHaveBeenCalled();

    hash = '#/tanks';
    route.handleHashChange();
    expect(ui.reloadPage).toHaveBeenCalledWith('#/tanks');
  });
});
