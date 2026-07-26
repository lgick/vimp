// Проксирует GET/PUT /host-rating central auth-сервиса под мастером
// (server-rating этап 2, plan/server-rating/stage_2.md): по образцу
// PlayerDataProxy — Bearer identity-токен участника перекладывается как
// есть, ответ не кэшируется мастером.
export default class HostRatingProxy {
  constructor(authServiceUrl, { fetchImpl = fetch } = {}) {
    this._url = authServiceUrl;
    this._fetch = fetchImpl;
  }

  async _request(path, token, { method = 'GET', body } = {}) {
    const res = await this._fetch(`${this._url}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = await res.json().catch(() => null);

    return { status: res.status, json };
  }

  // рейтинг хостера, каким его видит сам хостер (для проверки блокировки
  // при регистрации комнаты — token принадлежит хостеру)
  getRating(token) {
    return this._request('/host-rating', token);
  }

  // голос гостя (token принадлежит голосующему) за/против hosterUserId
  vote(token, hosterUserId, value, reason) {
    return this._request(`/host-rating/${hosterUserId}`, token, {
      method: 'PUT',
      body: { value, reason },
    });
  }

  // публичный (без токена) снимок { score, blocked } хостера — server-rating
  // этап 3: периодическое обновление кэша GET /servers, где мастер не держит
  // Bearer-токен конкретного хостера между запросами
  getPublic(hosterUserId) {
    return this._request(`/host-rating/${hosterUserId}`, null);
  }
}
