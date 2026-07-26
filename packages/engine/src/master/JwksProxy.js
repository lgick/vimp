// Проксирует GET /jwks central auth-сервиса (packages/auth) под мастером
// (Этап B3): Worker хоста живёт на origin мастера, а не auth-сервиса, и
// проверяет подпись identity-токена по этому кэшу, не завися от CORS/прямой
// доступности auth-сервиса из недоверенного хоста. Короткий TTL-кэш —
// JWKS меняется только при ротации ключа, дёргать auth-сервис на каждую
// комнату незачем.
export default class JwksProxy {
  constructor(authServiceUrl, { ttlMs = 600000, fetchImpl = fetch } = {}) {
    this._url = `${authServiceUrl}/jwks`;
    this._ttlMs = ttlMs;
    this._fetch = fetchImpl;

    this._cached = null;
    this._cachedAt = 0;
  }

  async get() {
    const now = Date.now();

    if (this._cached && now - this._cachedAt < this._ttlMs) {
      return this._cached;
    }

    const res = await this._fetch(this._url);

    if (!res.ok) {
      throw new Error(`jwks fetch failed: HTTP ${res.status}`);
    }

    this._cached = await res.json();
    this._cachedAt = now;

    return this._cached;
  }
}
