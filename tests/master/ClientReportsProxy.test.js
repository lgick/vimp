import { describe, it, expect, vi } from 'vitest';
import ClientReportsProxy from '../../packages/engine/src/master/ClientReportsProxy.js';

// Прокси журнала клиентских ошибок (plan/client-reports, этап 5)

const makeFetch = (status = 200, body = { reports: [], total: 0 }) =>
  vi.fn(async () => ({ status, json: async () => body }));

describe('ClientReportsProxy', () => {
  it('list: GET с Bearer и заданными фильтрами', async () => {
    const fetchImpl = makeFetch();
    const proxy = new ClientReportsProxy('http://auth.local', { fetchImpl });

    await proxy.list('tok', { status: 'fixed', gameId: 'tanks', limit: 50, offset: 100 });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://auth.local/admin/client-reports?status=fixed&gameId=tanks&limit=50&offset=100',
      { method: 'GET', headers: { authorization: 'Bearer tok' }, body: undefined },
    );
  });

  it('list: незаданные поля в query не попадают', async () => {
    const fetchImpl = makeFetch();
    const proxy = new ClientReportsProxy('http://auth.local', { fetchImpl });

    await proxy.list('tok', { status: undefined, gameId: undefined, limit: 20 });
    await proxy.list('tok', {});

    expect(fetchImpl.mock.calls[0][0]).toBe('http://auth.local/admin/client-reports?limit=20');
    expect(fetchImpl.mock.calls[1][0]).toBe('http://auth.local/admin/client-reports');
  });

  it('setStatus: PATCH по encodeURIComponent(id) с телом { status, note }', async () => {
    const fetchImpl = makeFetch(200, { report: { id: 7 } });
    const proxy = new ClientReportsProxy('http://auth.local', { fetchImpl });

    await proxy.setStatus('tok', '7/../x', { status: 'fixed', note: 'v1.2' });

    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/admin/client-reports/7%2F..%2Fx', {
      method: 'PATCH',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'fixed', note: 'v1.2' }),
    });
  });

  it('отдаёт { status, json } ответа как есть', async () => {
    const proxy = new ClientReportsProxy('http://auth.local', {
      fetchImpl: makeFetch(403, { error: 'forbidden' }),
    });

    expect(await proxy.list('tok')).toEqual({ status: 403, json: { error: 'forbidden' } });
  });

  it('тело не JSON — json: null', async () => {
    const proxy = new ClientReportsProxy('http://auth.local', {
      fetchImpl: vi.fn(async () => ({
        status: 502,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      })),
    });

    expect(await proxy.list('tok')).toEqual({ status: 502, json: null });
  });
});
