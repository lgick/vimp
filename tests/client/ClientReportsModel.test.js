import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ClientReportsModel — синглтон, перезагружаем модуль для изоляции
let ClientReportsModel;

const config = {
  urls: {
    list: '/admin/client-reports',
    setStatus: id => `/admin/client-reports/${id}`,
  },
  pageSize: 2,
  defaultStatus: 'open',
};

const answer = (body, ok = true) => ({ ok, json: async () => body });
const report = (id, status = 'open') => ({ id, status, message: `m${id}` });

let model;
let fetchMock;
let states;

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  ClientReportsModel = (
    await import('../../packages/engine/src/client/components/model/ClientReports.js')
  ).default;
  model = new ClientReportsModel(config, () => 'token123');
  states = [];
  model.publisher.on('changed', state => states.push(state));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const last = () => states[states.length - 1];

describe('ClientReportsModel: страницы', () => {
  it('первая страница — графа Open, Bearer, limit=pageSize, offset=0', async () => {
    fetchMock.mockResolvedValue(answer({ reports: [report(1), report(2)], total: 3 }));

    await model.load({ reset: true });

    expect(fetchMock.mock.calls[0][0]).toBe('/admin/client-reports?status=open&limit=2&offset=0');
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer token123');
    expect(last()).toMatchObject({ total: 3, loading: false, error: null });
    expect(last().items.map(r => r.id)).toEqual([1, 2]);
  });

  it('«ещё» дописывает страницу со смещением по длине списка', async () => {
    fetchMock
      .mockResolvedValueOnce(answer({ reports: [report(1), report(2)], total: 3 }))
      .mockResolvedValueOnce(answer({ reports: [report(3)], total: 3 }));

    await model.load({ reset: true });
    await model.load();

    expect(fetchMock.mock.calls[1][0]).toContain('offset=2');
    expect(last().items.map(r => r.id)).toEqual([1, 2, 3]);
  });

  it('смена графы и игры сбрасывает список', async () => {
    fetchMock
      .mockResolvedValueOnce(answer({ reports: [report(1)], total: 1 }))
      .mockResolvedValueOnce(answer({ reports: [report(9, 'fixed')], total: 1 }))
      .mockResolvedValueOnce(answer({ reports: [], total: 0 }));

    await model.load({ reset: true });
    await model.setFilter({ status: 'fixed' });

    expect(fetchMock.mock.calls[1][0]).toBe('/admin/client-reports?status=fixed&limit=2&offset=0');
    expect(last().items.map(r => r.id)).toEqual([9]);

    await model.setFilter({ gameId: 'tanks' });

    expect(fetchMock.mock.calls[2][0]).toBe(
      '/admin/client-reports?status=fixed&limit=2&offset=0&gameId=tanks',
    );
    expect(last()).toMatchObject({ items: [], total: 0, status: 'fixed', gameId: 'tanks' });
  });

  it('ответ, обогнанный сменой графы, не дописывается', async () => {
    let resolveSlow;

    fetchMock
      .mockReturnValueOnce(new Promise(resolve => (resolveSlow = resolve)))
      .mockResolvedValueOnce(answer({ reports: [report(5, 'fixed')], total: 1 }));

    const slow = model.load({ reset: true });

    await model.setFilter({ status: 'fixed' });
    resolveSlow(answer({ reports: [report(1)], total: 1 }));
    await slow;

    expect(last().items.map(r => r.id)).toEqual([5]);
  });
});

describe('ClientReportsModel: решение админа', () => {
  beforeEach(async () => {
    fetchMock.mockResolvedValueOnce(answer({ reports: [report(1), report(2)], total: 2 }));
    await model.load({ reset: true });
  });

  it('fixed убирает запись из графы Open и уменьшает total', async () => {
    fetchMock.mockResolvedValueOnce(answer({ report: report(1, 'fixed') }));

    await model.setStatus(1, 'fixed', 'v2');

    const [url, init] = fetchMock.mock.calls[1];

    expect(url).toBe('/admin/client-reports/1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ status: 'fixed', note: 'v2' });
    expect(last().items.map(r => r.id)).toEqual([2]);
    expect(last().total).toBe(1);
  });

  it('в графе All запись заменяется ответом', async () => {
    fetchMock.mockResolvedValueOnce(answer({ reports: [report(1)], total: 1 }));
    await model.setFilter({ status: 'all' });
    fetchMock.mockResolvedValueOnce(answer({ report: { ...report(1, 'ignored'), statusNote: 'n' } }));

    await model.setStatus(1, 'ignored', 'n');

    expect(last().items).toEqual([{ ...report(1, 'ignored'), statusNote: 'n' }]);
    expect(last().total).toBe(1);
  });
});

describe('ClientReportsModel: ошибки', () => {
  it.each([
    ['403', () => answer({ error: 'forbidden' }, false), 'forbidden'],
    ['5xx без тела', () => answer(null, false), 'requestFailed'],
    ['сеть', () => Promise.reject(new TypeError('Failed to fetch')), 'network'],
  ])('%s → error, без исключений', async (_, reply, code) => {
    fetchMock.mockImplementation(reply);

    await expect(model.load({ reset: true })).resolves.toBeUndefined();
    expect(last()).toMatchObject({ error: code, loading: false });

    await expect(model.setStatus(1, 'fixed')).resolves.toBeUndefined();
    expect(last().error).toBe(code);
  });

  it('без токена в сеть не ходит', async () => {
    vi.resetModules();
    const Model = (
      await import('../../packages/engine/src/client/components/model/ClientReports.js')
    ).default;
    const anonymous = new Model(config, () => null);
    const seen = [];

    anonymous.publisher.on('changed', state => seen.push(state));
    await anonymous.load({ reset: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(seen[seen.length - 1].error).toBe('unauthorized');
  });
});
