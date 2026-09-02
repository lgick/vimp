// Клиент реестра игр auth-сервиса (master-game-registry, этап 3).
//
// Реестр живёт в Postgres auth-сервиса, а мастер БД не получает и ходит
// REST'ом — тем же способом, каким уже ходит за rank/state/jwks
// (PlayerDataProxy, HostRatingProxy). Как и они, прокси ничего не кэширует и
// не интерпретирует: отдаёт {status, json}, решение принимает вызывающий
// (GameSync — каталог, lobby.js — код ответа админского роута).
export default class GameRegistryProxy {
  constructor(authServiceUrl, { fetchImpl = fetch } = {}) {
    this._url = authServiceUrl;
    this._fetch = fetchImpl;
  }

  async _request(path, token, { method = 'GET', body } = {}) {
    const res = await this._fetch(`${this._url}${path}`, {
      method,
      headers: {
        // GET /games публичный (как /leaderboard): каталог платформы и так
        // виден в лобби до логина
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = await res.json().catch(() => null);

    return { status: res.status, json };
  }

  // каталог для мастера: одобренные игры с раздаваемой версией
  list() {
    return this._request('/games', null);
  }

  // очередь модерации целиком (админ)
  listAll(token) {
    return this._request('/admin/games', token);
  }

  // заявки вызывающего со статусами и замечаниями модератора
  mine(token) {
    return this._request('/games/mine', token);
  }

  // заявка разработчика на новую игру платформы
  submit(token, body) {
    return this._request('/games', token, { method: 'POST', body });
  }

  // заявка на новую версию уже заведённой игры
  requestVersion(token, id, version) {
    return this._request(`/games/${encodeURIComponent(id)}/version`, token, {
      method: 'POST',
      body: { version },
    });
  }

  // решение модератора (статус, раздаваемая версия, замечание, потолок счёта)
  moderate(token, id, patch) {
    return this._request(`/admin/games/${encodeURIComponent(id)}`, token, {
      method: 'PATCH',
      body: patch,
    });
  }
}
