import crypto from 'crypto';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import config from '../config/auth.js';

let keys;

// ленивая загрузка пары ключей — тестам не нужны файлы на диске,
// пока они не подписывают/не проверяют токен
function loadKeys() {
  if (!keys) {
    keys = {
      privateKey: fs.readFileSync(config.jwt.privateKeyPath, 'utf8'),
      publicKey: fs.readFileSync(config.jwt.publicKeyPath, 'utf8'),
    };
  }

  return keys;
}

// полноценный токен личности: sub (user id) + nick, короткоживущий —
// хост проверяет подпись по /jwks и берёт ник из токена (не свободный ввод)
function signIdentityToken({ sub, nick }) {
  return jwt.sign({ nick }, loadKeys().privateKey, {
    subject: String(sub),
    algorithm: 'RS256',
    keyid: config.jwt.keyId,
    issuer: config.jwt.issuer,
    expiresIn: config.jwt.expiresIn,
  });
}

// временный токен между OAuth-колбэком и POST /nick (первый вход,
// ника ещё нет — полноценный identity-токен выдать нельзя)
function signPendingToken({ sub }) {
  return jwt.sign({ pending: true }, loadKeys().privateKey, {
    subject: String(sub),
    algorithm: 'RS256',
    keyid: config.jwt.keyId,
    issuer: config.jwt.issuer,
    expiresIn: config.jwt.pendingExpiresIn,
  });
}

function verifyToken(token) {
  return jwt.verify(token, loadKeys().publicKey, {
    algorithms: ['RS256'],
    issuer: config.jwt.issuer,
  });
}

// JWKS для /jwks — публичный ключ в формате JWK (RFC 7517),
// crypto.createPublicKey(...).export({ format: 'jwk' }) — нативный Node API
function getJwks() {
  const jwk = crypto.createPublicKey(loadKeys().publicKey).export({ format: 'jwk' });

  return {
    keys: [{ ...jwk, kid: config.jwt.keyId, use: 'sig', alg: 'RS256' }],
  };
}

export default { signIdentityToken, signPendingToken, verifyToken, getJwks };
