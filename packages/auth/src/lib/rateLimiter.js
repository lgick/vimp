// продублировано из packages/engine/src/lib/rateLimiter.js (тот же паттерн,
// что и validators.js — auth-сервис не тянет рантайм-зависимость на движок).
// Фиксированное окно: не более `limit` событий на ключ (IP) за `windowMs` мс
export default class RateLimiter {
  constructor({ limit, windowMs }) {
    this._limit = limit;
    this._windowMs = windowMs;
    this._buckets = new Map(); // key -> { count, windowStart }
  }

  // регистрирует событие; false — лимит для ключа исчерпан
  consume(key, now = Date.now()) {
    const bucket = this._buckets.get(key);

    if (!bucket || now - bucket.windowStart >= this._windowMs) {
      this._buckets.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (bucket.count >= this._limit) {
      return false;
    }

    bucket.count += 1;

    return true;
  }
}
