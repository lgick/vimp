// Проксирует GET/PUT /rank и /state central auth-сервиса под мастером
// (Этап B4): в отличие от JwksProxy, эти данные per-user — Bearer identity-
// токен участника перекладывается как есть, ответ не кэшируется мастером.
export default class PlayerDataProxy {
  constructor(authServiceUrl, { fetchImpl = fetch } = {}) {
    this._url = authServiceUrl;
    this._fetch = fetchImpl;
  }

  async _request(path, token, { method = 'GET', game, params, body } = {}) {
    const query = new URLSearchParams({ game, ...params });
    const res = await this._fetch(
      `${this._url}${path}?${query}`,
      {
        method,
        headers: {
          // lobby-page-plan: getLeaderboard — публичный эндпоинт, вызывается
          // без Bearer-токена (как HostRatingProxy.getPublic)
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );

    const json = await res.json().catch(() => null);

    return { status: res.status, json };
  }

  getRank(token, game) {
    return this._request('/rank', token, { game });
  }

  // lobby-page-plan: публичный топ-N рейтинга игры — без Bearer-токена.
  // rank-periods: `period` (day|month|all) едет дальше как есть; auth
  // отвечает 400 badPeriod на всё остальное, а отсутствие означает 'all'
  getLeaderboard(game, limit, period) {
    return this._request('/leaderboard', null, {
      game,
      params: period ? { limit, period } : { limit },
    });
  }

  // lobby-page-plan: позиция вызывающего в рейтинге игры (в том же срезе,
  // что и список рядом с ней)
  getPlacement(token, game, period) {
    return this._request('/placement', token, {
      game,
      params: period ? { period } : {},
    });
  }

  // snakes-v3 этап 3: /rank принимает результат игры — `points` (сумма
  // завершённых игр с прошлой синхронизации) и `best` (лучшая среди них),
  // не дельту и не абсолют. attribution ({ hosterUserId, sessionId },
  // кодревью №1) — проставлена мастером из проверенного register_host, не
  // из тела хоста
  putRank(token, game, { points, best }, attribution = {}) {
    return this._request('/rank', token, {
      method: 'PUT',
      game,
      body: { points, best, ...attribution },
    });
  }

  getState(token, game) {
    return this._request('/state', token, { game });
  }

  putState(token, game, state, attribution = {}) {
    return this._request('/state', token, {
      method: 'PUT',
      game,
      body: { state, ...attribution },
    });
  }
}
