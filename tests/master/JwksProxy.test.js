import { describe, it, expect, vi } from 'vitest';
import JwksProxy from '../../packages/engine/src/master/JwksProxy.js';

const jwks = { keys: [{ kid: 'k1', kty: 'RSA' }] };

const makeFetch = (impl = async () => ({ ok: true, json: async () => jwks })) =>
  vi.fn(impl);

describe('JwksProxy', () => {
  it('проксирует /jwks auth-сервиса', async () => {
    const fetchImpl = makeFetch();
    const proxy = new JwksProxy('http://auth.local', { fetchImpl });

    const result = await proxy.get();

    expect(result).toEqual(jwks);
    expect(fetchImpl).toHaveBeenCalledWith('http://auth.local/jwks');
  });

  it('кэширует результат в пределах TTL', async () => {
    const fetchImpl = makeFetch();
    const proxy = new JwksProxy('http://auth.local', { fetchImpl, ttlMs: 10000 });

    await proxy.get();
    await proxy.get();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('перезапрашивает после истечения TTL', async () => {
    const fetchImpl = makeFetch();
    const proxy = new JwksProxy('http://auth.local', { fetchImpl, ttlMs: 5 });

    await proxy.get();
    await new Promise(r => setTimeout(r, 10));
    await proxy.get();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('бросает исключение при не-ok ответе auth-сервиса', async () => {
    const fetchImpl = makeFetch(async () => ({ ok: false, status: 502 }));
    const proxy = new JwksProxy('http://auth.local', { fetchImpl });

    await expect(proxy.get()).rejects.toThrow(/502/);
  });
});
