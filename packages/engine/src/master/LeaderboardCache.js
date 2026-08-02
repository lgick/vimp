// Короткий TTL-кэш GET /auth/leaderboard (code review L2). Лидерборд —
// медленно меняющаяся игро-скопная выборка, но самый частый анонимный
// запрос лобби (каждое открытие + переключение игры/вкладки); TTL
// схлопывает шквал одинаковых запросов в один поход к auth-сервису.
// placement (per-user, Bearer-токен) через этот кэш НЕ идёт.
export default class LeaderboardCache {
  constructor(proxy, { ttlMs = 15000, now = () => Date.now() } = {}) {
    this._proxy = proxy; // PlayerDataProxy
    this._ttlMs = ttlMs;
    this._now = now;
    this._cache = new Map(); // `${game}:${limit}` -> { at, result }
  }

  async get(game, limit) {
    const key = `${game}:${limit}`;
    const now = this._now();
    const hit = this._cache.get(key);

    if (hit && now - hit.at < this._ttlMs) {
      return hit.result;
    }

    const result = await this._proxy.getLeaderboard(game, limit);

    // только успешный ответ — иначе 5xx/сбой auth «залипнет» на весь TTL
    if (result.status === 200) {
      this._cache.set(key, { at: now, result });
    }

    return result;
  }
}
