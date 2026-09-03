import { describe, it, expect, vi } from 'vitest';
import GameRegistryProxy from '../../packages/engine/src/master/GameRegistryProxy.js';

// Клиент реестра игр auth-сервиса (master-game-registry, этап 3): мастер не
// имеет доступа к БД и ходит REST'ом, как за rank/state/jwks.

const makeFetch = (impl = async () => ({ status: 200, json: async () => ({ games: [] }) })) =>
  vi.fn(impl);

describe('GameRegistryProxy', () => {
  it('запрашивает публичный каталог без Bearer-токена', async () => {
    const fetchImpl = makeFetch(async () => ({
      status: 200,
      json: async () => ({ games: [{ id: 'tanks', version: '0.16.1' }] }),
    }));
    const proxy = new GameRegistryProxy('http://auth.local', { fetchImpl });

    const result = await proxy.list();

    expect(result).toEqual({
      status: 200,
      json: { games: [{ id: 'tanks', version: '0.16.1' }] },
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/games', {
      method: 'GET',
      signal: expect.any(AbortSignal),
      headers: {},
      body: undefined,
    });
  });

  it('прокидывает Bearer-токен в админскую очередь модерации', async () => {
    const fetchImpl = makeFetch();
    const proxy = new GameRegistryProxy('http://auth.local', { fetchImpl });

    await proxy.listAll('tok');

    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/admin/games', {
      method: 'GET',
      signal: expect.any(AbortSignal),
      headers: { authorization: 'Bearer tok' },
      body: undefined,
    });
  });

  it('отправляет заявку разработчика телом JSON', async () => {
    const fetchImpl = makeFetch(async () => ({ status: 201, json: async () => ({ game: {} }) }));
    const proxy = new GameRegistryProxy('http://auth.local', { fetchImpl });

    await proxy.submit('tok', { id: 'snakes', packageName: '@vimp-games/snakes', version: '0.9.1' });

    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/games', {
      method: 'POST',
      signal: expect.any(AbortSignal),
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'snakes', packageName: '@vimp-games/snakes', version: '0.9.1' }),
    });
  });

  it('заявка на версию и решение модератора адресуются по id', async () => {
    const fetchImpl = makeFetch();
    const proxy = new GameRegistryProxy('http://auth.local', { fetchImpl });

    await proxy.requestVersion('tok', 'tanks', '0.17.0');
    expect(fetchImpl).toHaveBeenLastCalledWith('http://auth.local/games/tanks/version', {
      method: 'POST',
      signal: expect.any(AbortSignal),
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.17.0' }),
    });

    await proxy.moderate('tok', 'tanks', { status: 'approved', version: '0.17.0' });
    expect(fetchImpl).toHaveBeenLastCalledWith('http://auth.local/admin/games/tanks', {
      method: 'PATCH',
      signal: expect.any(AbortSignal),
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved', version: '0.17.0' }),
    });
  });

  it('удаление уходит DELETE с токеном, id экранируется', async () => {
    const fetchImpl = makeFetch();
    const proxy = new GameRegistryProxy('http://auth.local', { fetchImpl });

    await proxy.remove('tok', 'my game');

    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/games/my%20game', {
      method: 'DELETE',
      signal: expect.any(AbortSignal),
      headers: { authorization: 'Bearer tok' },
      body: undefined,
    });
  });

  it('заявки вызывающего идут с его токеном', async () => {
    const fetchImpl = makeFetch();
    const proxy = new GameRegistryProxy('http://auth.local', { fetchImpl });

    await proxy.mine('tok');

    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/games/mine', {
      method: 'GET',
      signal: expect.any(AbortSignal),
      headers: { authorization: 'Bearer tok' },
      body: undefined,
    });
  });

  it('зависший auth не держит проход бесконечно: запрос идёт с AbortSignal', async () => {
    const fetchImpl = makeFetch();
    const proxy = new GameRegistryProxy('http://auth.local', { fetchImpl, timeout: 1234 });

    await proxy.list();

    const [, options] = fetchImpl.mock.calls[0];

    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
  });

  it('timeout: 0 отключает дедлайн — сигнала в запросе нет', async () => {
    const fetchImpl = makeFetch();
    const proxy = new GameRegistryProxy('http://auth.local', { fetchImpl, timeout: 0 });

    await proxy.list();

    expect(fetchImpl.mock.calls[0][1].signal).toBeUndefined();
  });

  it('отказ апстрима отдаётся кодом и пустым json, а не броском', async () => {
    const fetchImpl = makeFetch(async () => ({
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    }));
    const proxy = new GameRegistryProxy('http://auth.local', { fetchImpl });

    await expect(proxy.list()).resolves.toEqual({ status: 502, json: null });
  });
});
