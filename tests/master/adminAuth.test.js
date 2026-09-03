import crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createAdminAuth } from '../../packages/engine/src/master/adminAuth.js';

// Авторизующая middleware мастера (master-game-registry, этап 4). Токены
// подписаны настоящим RS256-ключом и проверяются по JWKS — тем же путём,
// каким их проверяет сигнальный сервер (SignalingServer.test.js)

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const ISSUER = 'vimp-auth-test';

const jwks = {
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }],
};

const signToken = ({ sub = 7, role, expiresIn = '15m' } = {}) =>
  jwt.sign({ nick: `user${sub}`, ...(role ? { role } : {}) }, privateKey, {
    subject: String(sub),
    algorithm: 'RS256',
    keyid: KID,
    issuer: ISSUER,
    expiresIn,
  });

const reqWith = token => ({
  get: name => (name === 'authorization' && token ? `Bearer ${token}` : undefined),
});

const fakeRes = () => {
  const res = {
    code: null,
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

let adminAuth;

beforeEach(() => {
  adminAuth = createAdminAuth({ get: vi.fn(async () => jwks) }, ISSUER);
});

describe('adminAuth.required', () => {
  it('пропускает админский токен и заполняет req.user', async () => {
    const req = reqWith(signToken({ role: 'admin' }));
    const next = vi.fn();

    await new Promise(resolve => {
      adminAuth.required(req, fakeRes(), () => {
        next();
        resolve();
      });
    });

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ id: 7, nick: 'user7', role: 'admin' });
    expect(req.authToken).toBeTypeOf('string');
  });

  it('токен без роли — 403', async () => {
    const res = fakeRes();
    const next = vi.fn();

    await adminAuth.required(reqWith(signToken()), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.code).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });

  it('протухший токен — 401', async () => {
    const res = fakeRes();

    await adminAuth.required(reqWith(signToken({ role: 'admin', expiresIn: -10 })), res, vi.fn());

    expect(res.code).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('без заголовка — 401', async () => {
    const res = fakeRes();

    await adminAuth.required(reqWith(null), res, vi.fn());

    expect(res.code).toBe(401);
  });
});

describe('adminAuth.optional', () => {
  it('пропускает без токена и оставляет req.user пустым', async () => {
    const req = reqWith(null);

    await new Promise(resolve => adminAuth.optional(req, fakeRes(), resolve));

    expect(req.user).toBeUndefined();
    expect(adminAuth.isAdmin(req.user)).toBe(false);
  });

  it('заполняет req.user валидным токеном', async () => {
    const req = reqWith(signToken({ role: 'admin' }));

    await new Promise(resolve => adminAuth.optional(req, fakeRes(), resolve));

    expect(adminAuth.isAdmin(req.user)).toBe(true);
  });

  it('не считает админом произвольную роль', async () => {
    const req = reqWith(signToken({ role: 'superadmin' }));

    await new Promise(resolve => adminAuth.optional(req, fakeRes(), resolve));

    expect(req.user).toBeDefined();
    expect(adminAuth.isAdmin(req.user)).toBe(false);
  });
});

describe('adminAuth.authenticated', () => {
  it('пропускает любого авторизованного, без роли', async () => {
    const next = vi.fn();

    await new Promise(resolve => {
      adminAuth.authenticated(reqWith(signToken()), fakeRes(), () => {
        next();
        resolve();
      });
    });

    expect(next).toHaveBeenCalled();
  });

  it('без токена — 401', async () => {
    const res = fakeRes();

    await adminAuth.authenticated(reqWith(null), res, vi.fn());

    expect(res.code).toBe(401);
  });
});
