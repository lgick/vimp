import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { decodeJwtPayload, verifyIdentityToken } from '../../packages/engine/src/lib/jwt.js';

const encodeSegment = obj =>
  Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const makeToken = payload => `${encodeSegment({ alg: 'RS256' })}.${encodeSegment(payload)}.sig`;

describe('decodeJwtPayload', () => {
  it('разбирает payload валидного JWT', () => {
    const token = makeToken({ sub: 'u1', nick: 'Vanya' });

    expect(decodeJwtPayload(token)).toEqual({ sub: 'u1', nick: 'Vanya' });
  });

  it('возвращает null для не-строки', () => {
    expect(decodeJwtPayload(null)).toBeNull();
    expect(decodeJwtPayload(undefined)).toBeNull();
  });

  it('возвращает null для строки без трёх частей', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
  });

  it('возвращает null для битого base64/JSON', () => {
    expect(decodeJwtPayload('a.!!!.c')).toBeNull();
  });
});

describe('verifyIdentityToken', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const issuer = 'vimp-auth-test';

  const jwks = {
    keys: [
      {
        ...publicKey.export({ format: 'jwk' }),
        kid,
        use: 'sig',
        alg: 'RS256',
      },
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

  it('проверяет подпись и возвращает payload с ником', async () => {
    const token = sign({ nick: 'Vanya' }, { subject: '42' });

    const payload = await verifyIdentityToken(token, { jwks, issuer });

    expect(payload.nick).toBe('Vanya');
    expect(payload.sub).toBe('42');
  });

  it('отклоняет токен, подписанный другим ключом', async () => {
    const otherKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = jwt.sign({ nick: 'x' }, otherKeyPair.privateKey, {
      algorithm: 'RS256',
      keyid: kid,
      issuer,
    });

    await expect(verifyIdentityToken(forged, { jwks, issuer })).rejects.toThrow();
  });

  it('отклоняет неизвестный issuer', async () => {
    const token = sign({ nick: 'Vanya' }, { issuer: 'someone-else' });

    await expect(verifyIdentityToken(token, { jwks, issuer })).rejects.toThrow(/issuer/);
  });

  it('отклоняет просроченный токен', async () => {
    const token = sign({ nick: 'Vanya' }, { expiresIn: '-1s' });

    await expect(verifyIdentityToken(token, { jwks, issuer })).rejects.toThrow(/expired/);
  });

  it('отклоняет токен без ника', async () => {
    const token = sign({}, {});

    await expect(verifyIdentityToken(token, { jwks, issuer })).rejects.toThrow(/nick/);
  });

  it('отклоняет неизвестный kid', async () => {
    const token = sign({ nick: 'Vanya' }, { keyid: 'other-key' });

    await expect(verifyIdentityToken(token, { jwks, issuer })).rejects.toThrow(/key/);
  });

  it('отклоняет не-строку и битый токен', async () => {
    await expect(verifyIdentityToken(null, { jwks, issuer })).rejects.toThrow();
    await expect(verifyIdentityToken('not-a-jwt', { jwks, issuer })).rejects.toThrow();
  });
});
