import Publisher from '../../../lib/Publisher.js';

// Singleton ClientReportsModel

let clientReportsModel;

// Модель журнала клиентских ошибок в лобби (plan/client-reports, этап 5):
// страницы журнала, фильтры и решение админа по строке. Как GamesModel,
// сетевые запросы делает сама (простой REST к мастеру) и DOM не трогает.
// Наружу — одно событие 'changed' с полным состоянием: список, счётчик,
// фильтры и код ошибки (человеческая формулировка — во view)
export default class ClientReportsModel {
  /**
   * @param {Object} config - Блок `clientReports` конфига лобби.
   * @param {Function} getToken - Возвращает identity-токен лобби.
   */
  constructor(config, getToken) {
    if (clientReportsModel) {
      return clientReportsModel;
    }

    clientReportsModel = this;

    this._config = config;
    this._getToken = getToken;

    this._status = config.defaultStatus ?? 'open';
    this._gameId = null;
    this._items = [];
    this._total = 0;
    this._loading = false;
    this._error = null;
    // номер последнего запроса страницы: ответ, обогнанный сменой фильтра,
    // не должен дописаться к списку другой графы
    this._seq = 0;

    this.publisher = new Publisher();
  }

  getState() {
    return {
      status: this._status,
      gameId: this._gameId,
      items: this._items,
      total: this._total,
      loading: this._loading,
      error: this._error,
    };
  }

  // смена графы или игры: список начинается заново
  setFilter({ status, gameId } = {}) {
    if (status !== undefined) {
      this._status = status;
    }

    if (gameId !== undefined) {
      this._gameId = gameId || null;
    }

    return this.load({ reset: true });
  }

  /**
   * Страница журнала. Смещение — длина уже загруженного списка: запись,
   * убранная из графы решением админа, уменьшает и total на сервере, так что
   * следующая страница не пропускает строк.
   * @param {Object} [options]
   * @param {boolean} [options.reset] - Начать список заново.
   */
  async load({ reset = false } = {}) {
    const seq = ++this._seq;

    if (reset) {
      this._items = [];
      this._total = 0;
    }

    const query = new URLSearchParams({
      status: this._status,
      limit: String(this._config.pageSize),
      offset: String(this._items.length),
    });

    if (this._gameId) {
      query.set('gameId', this._gameId);
    }

    this._loading = true;
    this._error = null;
    this._emit();

    const { ok, json } = await this._request(`${this._config.urls.list}?${query}`);

    if (seq !== this._seq) {
      return;
    }

    this._loading = false;

    if (!ok || !Array.isArray(json?.reports)) {
      this._error = json?.error ?? 'requestFailed';
      this._emit();
      return;
    }

    this._items = this._items.concat(json.reports);
    this._total = Number(json.total) || 0;
    this._emit();
  }

  // решение админа: строка заменяется ответом auth, а если она больше не
  // подходит под графу (например, «Open» → fixed) — уходит из списка
  async setStatus(id, status, note) {
    const { ok, json } = await this._request(this._config.urls.setStatus(id), {
      method: 'PATCH',
      body: { status, note },
    });

    if (!ok || !json?.report) {
      this._error = json?.error ?? 'requestFailed';
      this._emit();
      return;
    }

    const { report } = json;

    this._error = null;

    if (this._status === 'all' || report.status === this._status) {
      this._items = this._items.map(item => (item.id === report.id ? report : item));
    } else {
      const before = this._items.length;

      this._items = this._items.filter(item => item.id !== report.id);
      this._total = Math.max(0, this._total - (before - this._items.length));
    }

    this._emit();
  }

  _emit() {
    this.publisher.emit('changed', this.getState());
  }

  // ошибки сети и отказы мастера/auth возвращаются кодом, без исключений
  async _request(url, { method = 'GET', body } = {}) {
    const token = this._getToken();

    if (!token) {
      return { ok: false, json: { error: 'unauthorized' } };
    }

    try {
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => null);

      return { ok: res.ok, json };
    } catch {
      return { ok: false, json: { error: 'network' } };
    }
  }
}
