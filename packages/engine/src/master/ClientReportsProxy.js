// Проксирует журнал клиентских ошибок central auth-сервиса под мастером
// (plan/client-reports, этап 5): Bearer админа перекладывается как есть,
// роль перепроверяет сам auth (requireAdmin читает её из БД). Как и другие
// прокси мастера, ничего не кэширует и не интерпретирует: отдаёт
// {status, json}, код ответа решает обработчик роута.
export default class ClientReportsProxy {
  constructor(authServiceUrl, { fetchImpl = fetch, timeout = 15000 } = {}) {
    this._url = authServiceUrl;
    this._fetch = fetchImpl;
    this._timeout = timeout;
  }

  async _request(path, token, { method = 'GET', body } = {}) {
    const res = await this._fetch(`${this._url}${path}`, {
      method,
      // зависший auth не должен держать запрос админки — тот же приём, что
      // у GameRegistryProxy
      signal: this._timeout ? AbortSignal.timeout(this._timeout) : undefined,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = await res.json().catch(() => null);

    return { status: res.status, json };
  }

  // страница журнала; незаданный фильтр в query не попадает — умолчания
  // (status=open, limit=50) решает auth
  list(token, { status, gameId, limit, offset } = {}) {
    const query = new URLSearchParams();

    Object.entries({ status, gameId, limit, offset }).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        query.set(key, String(value));
      }
    });

    const search = query.toString();

    return this._request(`/admin/client-reports${search ? `?${search}` : ''}`, token);
  }

  // решение админа по строке журнала
  setStatus(token, id, { status, note }) {
    return this._request(`/admin/client-reports/${encodeURIComponent(id)}`, token, {
      method: 'PATCH',
      body: { status, note },
    });
  }
}
