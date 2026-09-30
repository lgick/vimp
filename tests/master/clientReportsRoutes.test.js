import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClientReportsRoutes } from '../../packages/engine/src/master/clientReportsRoutes.js';

// Роуты журнала клиентских ошибок мастера (plan/client-reports, этап 5):
// обработчики на заглушке прокси, как lobbyGamesRoutes.test.js

const fakeRes = () => {
  const res = {
    code: 200,
    body: undefined,
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

let proxy;
let routes;

beforeEach(() => {
  proxy = {
    list: vi.fn(async () => ({ status: 200, json: { reports: [], total: 0 } })),
    setStatus: vi.fn(async () => ({
      status: 200,
      json: { report: { id: 1 } },
    })),
  };
  routes = createClientReportsRoutes({ proxy });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clientReportsRoutes.list', () => {
  it('пропускает в прокси только status, gameId, limit, offset', async () => {
    const res = fakeRes();

    await routes.list(
      {
        authToken: 'tok',
        query: {
          status: 'open',
          gameId: 'tanks',
          limit: '10',
          offset: '20',
          box: 'evil',
          sql: 'x',
        },
      },
      res,
    );

    expect(proxy.list).toHaveBeenCalledWith('tok', {
      status: 'open',
      gameId: 'tanks',
      limit: '10',
      offset: '20',
    });
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ reports: [], total: 0 });
  });

  it('массив вместо строки (?status=a&status=b) не доезжает до auth', async () => {
    await routes.list(
      { authToken: 'tok', query: { status: ['open', 'fixed'] } },
      fakeRes(),
    );

    expect(proxy.list).toHaveBeenCalledWith('tok', {});
  });

  it.each([
    [400, { error: 'badRequest' }],
    [403, { error: 'forbidden' }],
  ])('отдаёт статус auth %i как есть', async (status, json) => {
    const res = fakeRes();

    proxy.list.mockResolvedValue({ status, json });
    await routes.list({ authToken: 'tok', query: {} }, res);

    expect(res.code).toBe(status);
    expect(res.body).toEqual(json);
  });

  it('сеть упала — 502', async () => {
    const res = fakeRes();

    proxy.list.mockRejectedValue(new Error('ECONNREFUSED'));
    await routes.list({ authToken: 'tok', query: {} }, res);

    expect(res.code).toBe(502);
    expect(res.body).toEqual({ error: 'authServiceUnavailable' });
  });
});

describe('clientReportsRoutes.setStatus', () => {
  it('пропускает только status и note', async () => {
    const res = fakeRes();

    await routes.setStatus(
      {
        authToken: 'tok',
        params: { id: '5' },
        body: { status: 'fixed', note: 'done', statusBy: 999, count: 0 },
      },
      res,
    );

    expect(proxy.setStatus).toHaveBeenCalledWith('tok', '5', {
      status: 'fixed',
      note: 'done',
    });
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ report: { id: 1 } });
  });

  it.each([
    [400, { error: 'badRequest' }],
    [403, { error: 'forbidden' }],
    [404, { error: 'unknownReport' }],
  ])('отдаёт статус auth %i как есть', async (status, json) => {
    const res = fakeRes();

    proxy.setStatus.mockResolvedValue({ status, json });
    await routes.setStatus(
      { authToken: 'tok', params: { id: '5' }, body: { status: 'open' } },
      res,
    );

    expect(res.code).toBe(status);
    expect(res.body).toEqual(json);
  });

  it('без тела — поля undefined, решает auth', async () => {
    await routes.setStatus(
      { authToken: 'tok', params: { id: '5' } },
      fakeRes(),
    );

    expect(proxy.setStatus).toHaveBeenCalledWith('tok', '5', {
      status: undefined,
      note: undefined,
    });
  });

  it('сеть упала — 502', async () => {
    const res = fakeRes();

    proxy.setStatus.mockRejectedValue(new Error('timeout'));
    await routes.setStatus(
      { authToken: 'tok', params: { id: '5' }, body: {} },
      res,
    );

    expect(res.code).toBe(502);
  });
});
