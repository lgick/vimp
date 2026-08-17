import crypto from 'crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  createGuestIdentity,
  createTokenIdentity,
} from '../../packages/engine/src/host/identity.js';

// Стратегии идентичности хоста (Этап 1 плана standalone-sdk): чем именно
// порт-машина заменяет свободный ввод ника — claim подписанного токена в
// лобби либо валидируемое движком поле формы в гостевом контуре.

describe('createGuestIdentity', () => {
  it('объявляет поле ника с движковым валидатором', () => {
    const { params, errorField } = createGuestIdentity();

    expect(errorField).toBe('name');
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe('name');
    expect(params[0].options.validator).toBe('isValidName');
    expect(params[0].options.storage).toBe('playerName');
    expect(params[0].options.maxlength).toBe(15);
  });

  it('возвращает валидный ник как есть', async () => {
    await expect(createGuestIdentity().resolve({ name: 'Guest' }, 's1')).resolves.toBe(
      'Guest',
    );
  });

  it('подставляет заглушку по socketId, если ник невалиден', async () => {
    const identity = createGuestIdentity();

    await expect(identity.resolve({ name: '#!' }, 'abcdef')).resolves.toBe(
      'Player_abcd',
    );
    await expect(identity.resolve({}, 'abcdef')).resolves.toBe('Player_abcd');
    await expect(identity.resolve(undefined, 'abcdef')).resolves.toBe(
      'Player_abcd',
    );
  });

  it('уважает собственный префикс заглушки', async () => {
    const identity = createGuestIdentity({ fallbackPrefix: 'Bot_' });

    await expect(identity.resolve({}, 'xyz9')).resolves.toBe('Bot_xyz9');
  });
});

describe('createTokenIdentity', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const kid = 'test-key-1';
  const issuer = 'vimp-auth-test';
  const jwksUrl = '/auth/jwks';

  const jwks = {
    keys: [
      { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
    ],
  };

  const sign = (payload, opts = {}) =>
    jwt.sign(payload, privateKey, {
      algorithm: 'RS256',
      keyid: kid,
      issuer,
      expiresIn: '15m',
      ...opts,
    });

  const mockFetch = impl => {
    const fetchMock = vi.fn(impl);

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
  };

  const okJwks = () =>
    mockFetch(async () => ({ ok: true, status: 200, json: async () => jwks }));

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('не объявляет полей формы и рапортует токен как поле ошибки', () => {
    const identity = createTokenIdentity({ jwksUrl, issuer });

    expect(identity.params).toEqual([]);
    expect(identity.errorField).toBe('token');
  });

  it('возвращает ник из claim проверенного токена', async () => {
    const fetchMock = okJwks();
    const identity = createTokenIdentity({ jwksUrl, issuer });

    await expect(
      identity.resolve({ token: sign({ nick: 'Vanya' }, { subject: '42' }) }),
    ).resolves.toBe('Vanya');
    expect(fetchMock).toHaveBeenCalledWith(jwksUrl);
  });

  it('кэширует JWKS на время жизни стратегии', async () => {
    const fetchMock = okJwks();
    const identity = createTokenIdentity({ jwksUrl, issuer });
    const token = sign({ nick: 'Vanya' });

    await identity.resolve({ token });
    await identity.resolve({ token });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('бросает на чужой подписи и на просроченном токене', async () => {
    okJwks();

    const identity = createTokenIdentity({ jwksUrl, issuer });
    const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = jwt.sign({ nick: 'x' }, otherKey.privateKey, {
      algorithm: 'RS256',
      keyid: kid,
      issuer,
    });

    await expect(identity.resolve({ token: forged })).rejects.toThrow();
    await expect(
      identity.resolve({ token: sign({ nick: 'Vanya' }, { expiresIn: '-1s' }) }),
    ).rejects.toThrow(/expired/);
  });

  it('не кэширует сбой загрузки JWKS навсегда', async () => {
    let ok = false;
    const fetchMock = mockFetch(async () =>
      ok
        ? { ok: true, status: 200, json: async () => jwks }
        : { ok: false, status: 503, json: async () => ({}) },
    );
    const identity = createTokenIdentity({ jwksUrl, issuer });
    const token = sign({ nick: 'Vanya' });

    await expect(identity.resolve({ token })).rejects.toThrow(/503/);

    ok = true;

    await expect(identity.resolve({ token })).resolves.toBe('Vanya');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
