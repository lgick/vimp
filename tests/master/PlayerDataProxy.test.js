import { describe, it, expect, vi } from 'vitest';
import PlayerDataProxy from '../../packages/engine/src/master/PlayerDataProxy.js';

const makeFetch = (impl = async () => ({ ok: true, json: async () => ({ rank: 5 }) })) =>
  vi.fn(impl);

describe('PlayerDataProxy', () => {
  it('запрашивает rank с Bearer-токеном и query game', async () => {
    const fetchImpl = makeFetch();
    const proxy = new PlayerDataProxy('http://auth.local', { fetchImpl });

    const result = await proxy.getRank('tok', 'tanks');

    expect(result).toEqual({ status: undefined, json: { rank: 5 } });
    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/rank?game=tanks', {
      method: 'GET',
      headers: { authorization: 'Bearer tok' },
      body: undefined,
    });
  });

  it('отправляет PUT rank с дельтой в теле JSON', async () => {
    const fetchImpl = makeFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    const proxy = new PlayerDataProxy('http://auth.local', { fetchImpl });

    await proxy.putRank('tok', 'tanks', 10);

    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/rank?game=tanks', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ delta: 10 }),
    });
  });

  it('запрашивает и обновляет state', async () => {
    const fetchImpl = makeFetch(async () => ({ ok: true, status: 200, json: async () => ({ state: { skill: 1 } }) }));
    const proxy = new PlayerDataProxy('http://auth.local', { fetchImpl });

    const getResult = await proxy.getState('tok', 'tanks');
    expect(getResult.json).toEqual({ state: { skill: 1 } });

    await proxy.putState('tok', 'tanks', { skill: 2 });
    expect(fetchImpl).toHaveBeenLastCalledWith('http://auth.local/state?game=tanks', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ state: { skill: 2 } }),
    });
  });

  // кодревью №1 (plan/server-rating/review.md): атрибуция проставляется
  // мастером (из проверенного register_host), не телом хоста — putRank/
  // putState просто сливают её в тело запроса к auth
  it('putRank/putState несут атрибуцию hosterUserId/sessionId в теле', async () => {
    const fetchImpl = makeFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    const proxy = new PlayerDataProxy('http://auth.local', { fetchImpl });

    await proxy.putRank('tok', 'tanks', 10, { hosterUserId: 7, sessionId: 'host-1' });

    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/rank?game=tanks', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ delta: 10, hosterUserId: 7, sessionId: 'host-1' }),
    });

    await proxy.putState('tok', 'tanks', { skill: 2 }, { hosterUserId: 7, sessionId: 'host-1' });

    expect(fetchImpl).toHaveBeenLastCalledWith('http://auth.local/state?game=tanks', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ state: { skill: 2 }, hosterUserId: 7, sessionId: 'host-1' }),
    });
  });

  it('пробрасывает status ответа auth-сервиса', async () => {
    const fetchImpl = makeFetch(async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }));
    const proxy = new PlayerDataProxy('http://auth.local', { fetchImpl });

    const result = await proxy.getRank('bad', 'tanks');

    expect(result).toEqual({ status: 401, json: { error: 'unauthorized' } });
  });

  // lobby-page-plan: getLeaderboard — публичный эндпоинт, без Bearer-токена
  // (как HostRatingProxy.getPublic), несёт limit доп. query-параметром
  it('getLeaderboard запрашивает без authorization-заголовка и с limit в URL', async () => {
    const fetchImpl = makeFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ leaderboard: [{ nick: 'a', rank: 10 }], total: 1 }),
    }));
    const proxy = new PlayerDataProxy('http://auth.local', { fetchImpl });

    const result = await proxy.getLeaderboard('tanks', 10);

    expect(result.json).toEqual({ leaderboard: [{ nick: 'a', rank: 10 }], total: 1 });
    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/leaderboard?game=tanks&limit=10', {
      method: 'GET',
      headers: {},
      body: undefined,
    });
  });

  // lobby-page-plan: getPlacement несёт Bearer-токен вызывающего игрока
  it('getPlacement запрашивает с Bearer-токеном', async () => {
    const fetchImpl = makeFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ placement: 3, total: 10, rank: 100 }),
    }));
    const proxy = new PlayerDataProxy('http://auth.local', { fetchImpl });

    const result = await proxy.getPlacement('tok', 'tanks');

    expect(result.json).toEqual({ placement: 3, total: 10, rank: 100 });
    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/placement?game=tanks', {
      method: 'GET',
      headers: { authorization: 'Bearer tok' },
      body: undefined,
    });
  });
});
