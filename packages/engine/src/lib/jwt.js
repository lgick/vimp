// декодирует base64url-сегмент JWT в строку (без проверки подписи)
function base64UrlToString(segment) {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');

  return atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='));
}

// декодирует base64url-сегмент JWT в байты (подпись — для crypto.subtle.verify)
function base64UrlToBytes(segment) {
  const binary = base64UrlToString(segment);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

// Разбор payload JWT без проверки подписи — только для чтения claims на
// клиенте (отображение ника в лобби). Подпись авторитетно проверяет хост по
// /jwks (Этап B3); эта функция не является средством аутентификации.
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') {
    return null;
  }

  const parts = token.split('.');

  if (parts.length !== 3) {
    return null;
  }

  try {
    return JSON.parse(base64UrlToString(parts[1]));
  } catch {
    return null;
  }
}

// Авторитетная проверка identity-токена (Этап B3): подпись RS256 по JWKS
// central auth-сервиса (packages/auth), issuer и срок годности. Работает через
// Web Crypto API (crypto.subtle) — доступен в браузере, Worker'е хоста и в
// Node ≥19 глобально, отдельной JWT-библиотеки не требует. Возвращает
// проверенный payload ({ sub, nick, iss, exp, ... }) или бросает исключение.
export async function verifyIdentityToken(token, { jwks, issuer } = {}) {
  if (typeof token !== 'string') {
    throw new Error('token must be a string');
  }

  const parts = token.split('.');

  if (parts.length !== 3) {
    throw new Error('malformed token');
  }

  const [headerSeg, payloadSeg, signatureSeg] = parts;
  const header = JSON.parse(base64UrlToString(headerSeg));
  const payload = JSON.parse(base64UrlToString(payloadSeg));

  if (header.alg !== 'RS256') {
    throw new Error(`unsupported alg: ${header.alg}`);
  }

  if (issuer && payload.iss !== issuer) {
    throw new Error('unknown issuer');
  }

  if (typeof payload.exp !== 'number' || Date.now() >= payload.exp * 1000) {
    throw new Error('token expired');
  }

  if (typeof payload.nick !== 'string' || !payload.nick) {
    throw new Error('token has no nick');
  }

  const jwk = jwks?.keys?.find(k => k.kid === header.kid);

  if (!jwk) {
    throw new Error('unknown key id');
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signatureSeg),
    new TextEncoder().encode(`${headerSeg}.${payloadSeg}`),
  );

  if (!valid) {
    throw new Error('invalid signature');
  }

  return payload;
}
