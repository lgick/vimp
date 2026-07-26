import { describe, it, expect, vi } from 'vitest';
import HostRatingProxy from '../../packages/engine/src/master/HostRatingProxy.js';

const makeFetch = (impl = async () => ({ ok: true, json: async () => ({ score: 0, blocked: false }) })) =>
  vi.fn(impl);

describe('HostRatingProxy', () => {
  it('запрашивает собственный рейтинг с Bearer-токеном', async () => {
    const fetchImpl = makeFetch();
    const proxy = new HostRatingProxy('http://auth.local', { fetchImpl });

    const result = await proxy.getRating('tok');

    expect(result).toEqual({ status: undefined, json: { score: 0, blocked: false } });
    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/host-rating', {
      method: 'GET',
      headers: { authorization: 'Bearer tok' },
      body: undefined,
    });
  });

  it('отправляет голос PUT /host-rating/:hosterUserId с value и reason', async () => {
    const fetchImpl = makeFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ score: 1, blocked: false, counted: true }),
    }));
    const proxy = new HostRatingProxy('http://auth.local', { fetchImpl });

    const result = await proxy.vote('tok', 42, 1, 'good game');

    expect(result).toEqual({ status: 200, json: { score: 1, blocked: false, counted: true } });
    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/host-rating/42', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ value: 1, reason: 'good game' }),
    });
  });

  it('пробрасывает status ответа auth-сервиса', async () => {
    const fetchImpl = makeFetch(async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }));
    const proxy = new HostRatingProxy('http://auth.local', { fetchImpl });

    const result = await proxy.getRating('bad');

    expect(result).toEqual({ status: 401, json: { error: 'unauthorized' } });
  });

  it('getPublic запрашивает GET /host-rating/:hosterUserId без Bearer-заголовка', async () => {
    const fetchImpl = makeFetch(async () => ({
      status: 200,
      json: async () => ({ score: 3, blocked: false }),
    }));
    const proxy = new HostRatingProxy('http://auth.local', { fetchImpl });

    const result = await proxy.getPublic(42);

    expect(result).toEqual({ status: 200, json: { score: 3, blocked: false } });
    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/host-rating/42', {
      method: 'GET',
      headers: {},
      body: undefined,
    });
  });
});
