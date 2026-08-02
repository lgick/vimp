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

  // lobby-page-plan: публичный топ-N рейтинга игры — без Bearer-токена
  getLeaderboard(game, limit) {
    return this._request('/leaderboard', null, { game, params: { limit } });
  }

  // lobby-page-plan: позиция вызывающего в рейтинге игры
  getPlacement(token, game) {
    return this._request('/placement', token, { game });
  }

  // server-rating этап 1: /rank принимает дельту матча, не абсолют.
  // attribution ({ hosterUserId, sessionId }, кодревью №1) — проставлена
  // мастером из проверенного register_host, не из тела хоста
  putRank(token, game, delta, attribution = {}) {
    return this._request('/rank', token, { method: 'PUT', game, body: { delta, ...attribution } });
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
