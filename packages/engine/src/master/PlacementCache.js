import crypto from 'crypto';

// TTL-кэш GET /auth/placement (snakes-v3 этап 3.3), устроенный как
// LeaderboardCache: место игрока меняется медленно, а один вход участника
// стоит трёх срезов (day/month/all) при сотнях хостов у популярной игры.
//
// Тяжесть самого запроса с этого кэша снята на стороне auth: место считается
// по кэшированной лестнице значений среза (auth/src/db/RankDistribution.js),
// а не свёрткой окна. Здесь остаётся то, чего тот кэш не убирает, — сетевой
// round-trip мастер → auth на повторный вопрос об одном и том же игроке.
//
// Ключ кэша содержит хеш токена, а не сам токен: значения этой Map живут в
// памяти мастера дольше запроса, и держать в них Bearer-токены незачем.
export default class PlacementCache {
  constructor(proxy, { ttlMs = 30000, now = () => Date.now() } = {}) {
    this._proxy = proxy; // PlayerDataProxy
    this._ttlMs = ttlMs;
    this._now = now;
    this._cache = new Map(); // `${sha1(token)}:${game}:${period}` -> { at, result }
  }

  async get(token, game, period = 'all') {
    const key = `${crypto.createHash('sha1').update(String(token)).digest('hex')}:${game}:${period}`;
    const now = this._now();
    const hit = this._cache.get(key);

    if (hit && now - hit.at < this._ttlMs) {
      return hit.result;
    }

    const result = await this._proxy.getPlacement(token, game, period);

    // только успешный ответ — иначе 5xx/сбой auth «залипнет» на весь TTL
    if (result.status === 200) {
      this._cache.set(key, { at: now, result });
    }

    return result;
  }

  // уборка протухших записей: комната живёт часами, участники приходят и
  // уходят, и без неё Map растёт по числу увиденных токенов
  sweep(now = this._now()) {
    for (const [key, hit] of this._cache) {
      if (now - hit.at >= this._ttlMs) {
        this._cache.delete(key);
      }
    }
  }
}
