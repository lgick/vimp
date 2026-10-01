import { describe, it, expect, beforeEach } from 'vitest';
import RoomRegistry from '../../packages/engine/src/master/RoomRegistry.js';
import RateLimiter from '../../packages/engine/src/lib/rateLimiter.js';
import { createRoomRoutes } from '../../packages/engine/src/master/roomRoutes.js';

// GET /rooms/:roomId (host-migration, этап 3): lobby.js поднимает сервер и из
// теста не импортируется — проверяется обработчик, который он вешает

const fakeRes = () => {
  const res = {
    code: 200,
    body: null,
    status(code) {
      res.code = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };

  return res;
};

const req = (roomId, ip = '1.1.1.1') => ({
  params: { roomId },
  headers: {},
  socket: { remoteAddress: ip },
});

let registry;
let routes;

const addRoom = (over = {}) =>
  registry.add({
    maxPlayers: 8,
    info: 'arena',
    region: 'EU',
    ip: '10.0.0.1',
    gameId: 'tanks',
    host: { sessionId: 's1', memberId: 'm1', userId: 1, nick: 'u1' },
    ...over,
  });

beforeEach(() => {
  registry = new RoomRegistry({ secretKey: 'k'.repeat(32) });
  routes = createRoomRoutes({
    registry,
    limiter: new RateLimiter({ limit: 2, windowMs: 1000 }),
  });
});

describe('GET /rooms/:roomId', () => {
  it('невалидный id — 400', () => {
    const res = fakeRes();

    routes.lookup(req('nope'), res);

    expect(res.code).toBe(400);
  });

  it('нет комнаты — 404 unknownRoom', () => {
    const res = fakeRes();

    routes.lookup(req('k7m2qx3a'), res);

    expect(res.code).toBe(404);
    expect(res.body).toEqual({ error: 'unknownRoom' });
  });

  it('есть — публичная форма + status, без служебных полей', () => {
    const room = addRoom();
    const res = fakeRes();

    routes.lookup(req(room.roomId), res);

    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({
      roomId: room.roomId,
      gameId: 'tanks',
      maxPlayers: 8,
      status: 'online',
    });
    expect(res.body.ip).toBeUndefined();
    expect(res.body.members).toBeUndefined();
  });

  it('скрытая комната по прямому id отдаётся', () => {
    const room = addRoom({ hidden: true });
    const res = fakeRes();

    routes.lookup(req(room.roomId), res);

    expect(res.code).toBe(200);
  });

  it('лимит на IP — 429, другой IP не страдает', () => {
    const codes = [1, 2, 3].map(() => {
      const res = fakeRes();

      routes.lookup(req('k7m2qx3a'), res);

      return res.code;
    });
    const other = fakeRes();

    routes.lookup(req('k7m2qx3a', '2.2.2.2'), other);

    expect(codes).toEqual([404, 404, 429]);
    expect(other.code).toBe(404);
  });
});
