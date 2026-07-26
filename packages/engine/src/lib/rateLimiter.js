// Rate limiter с фиксированным окном: не более `limit` событий
// на ключ (например, IP) за `windowMs` миллисекунд.
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

  // удаляет истёкшие окна (периодическая уборка памяти)
  sweep(now = Date.now()) {
    for (const [key, bucket] of this._buckets) {
      if (now - bucket.windowStart >= this._windowMs) {
        this._buckets.delete(key);
      }
    }
  }

  clear() {
    this._buckets.clear();
  }
}
