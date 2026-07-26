import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vimp-auth-jwt-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const privateKeyPath = path.join(tmpDir, 'jwt.pem');
const publicKeyPath = path.join(tmpDir, 'jwt.pub.pem');

fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }));
fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));

vi.mock('../../packages/auth/src/config/auth.js', () => ({
  default: {
    jwt: {
      privateKeyPath,
      publicKeyPath,
      keyId: 'test-key-1',
      issuer: 'vimp-auth-test',
      expiresIn: '15m',
      pendingExpiresIn: '10m',
    },
  },
}));

const { default: jwtLib } = await import('../../packages/auth/src/lib/jwt.js');

describe('jwt (auth)', () => {
  it('подписывает и проверяет identity-токен', () => {
    const token = jwtLib.signIdentityToken({ sub: 42, nick: 'Player1' });
    const payload = jwtLib.verifyToken(token);

    expect(payload.sub).toBe('42');
    expect(payload.nick).toBe('Player1');
    expect(payload.pending).toBeUndefined();
  });

  it('подписывает pending-токен без ника', () => {
    const token = jwtLib.signPendingToken({ sub: 7 });
    const payload = jwtLib.verifyToken(token);

    expect(payload.sub).toBe('7');
    expect(payload.pending).toBe(true);
  });

  it('отклоняет токен, подписанный другим ключом', async () => {
    const otherKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = (await import('jsonwebtoken')).default;
    const forged = jwt.sign({ sub: '1', nick: 'x' }, otherKeyPair.privateKey, {
      algorithm: 'RS256',
      issuer: 'vimp-auth-test',
    });

    expect(() => jwtLib.verifyToken(forged)).toThrow();
  });

  it('отдаёт JWKS с публичным ключом и правильным kid', () => {
    const jwks = jwtLib.getJwks();

    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].kid).toBe('test-key-1');
    expect(jwks.keys[0].kty).toBe('RSA');
  });
});
