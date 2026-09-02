import Publisher from '../../../lib/Publisher.js';

// Singleton GamesModel

let gamesModel;

// коды отказов мастера и auth-сервиса — единственное, что приезжает вместо
// текста; человеческая формулировка живёт во view, как в LobbyAuthView
const REQUEST_FAILED = 'requestFailed';

// Модель реестра игр в лобби (master-game-registry, этап 4): заявки
// вызывающего, очередь модерации и «Test» новой версии. В отличие от
// LobbyModel сетевые запросы делает сама — это простой REST к мастеру,
// сигнальный сокет здесь ни при чём (тот же приём, что у LobbyAuthModel с
// POST /nick). DOM не трогает.
export default class GamesModel {
  /**
   * @param {Object} config - Блок `games` конфига лобби (urls, statuses).
   * @param {Function} getToken - Возвращает identity-токен лобби.
   */
  constructor(config, getToken) {
    if (gamesModel) {
      return gamesModel;
    }

    gamesModel = this;

    this._config = config;
    this._getToken = getToken;

    this._mine = [];
    this._all = [];
    this._versions = new Map(); // id игры -> версии, опубликованные в npm
    this._filter = config.defaultStatus;

    this.publisher = new Publisher();
  }

  getFilter() {
    return this._filter;
  }

  // фильтр очереди модерации: строки уже загружены, повторный запрос не нужен
  setFilter(status) {
    this._filter = status;
    this._emitAdmin();
  }

  async loadMine() {
    const { ok, json } = await this._request(this._config.urls.mine);

    if (!ok) {
      this._fail('mine', json);
      return;
    }

    this._mine = json.games ?? [];
    this.publisher.emit('mine-changed', this._mine);
  }

  // застейдженные версии, уже лежащие на этом мастере: после перезагрузки
  // вкладки (а lobby-режим перезагружает её после каждого матча) черновик
  // иначе исчезал бы из селектора, оставаясь скачанным
  async loadStaged() {
    const { ok, json } = await this._request(this._config.urls.staged);

    if (!ok) {
      return;
    }

    (json.manifests ?? []).forEach(({ id, version, manifest }) => {
      this.publisher.emit('staged', { id, version, manifest });
    });
  }

  async loadAdmin() {
    const { ok, json } = await this._request(this._config.urls.admin);

    if (!ok) {
      this._fail('admin', json);
      return;
    }

    this._all = json.games ?? [];
    this._emitAdmin();
  }

  // список опубликованных версий пакета: индикатор «есть версия новее
  // раздаваемой». Запрашивается по игре, а не для всей очереди сразу —
  // каждый ответ стоит похода мастера в npm registry
  async loadVersions(id) {
    const { ok, json } = await this._request(this._config.urls.versions(id));

    if (!ok) {
      return;
    }

    this._versions.set(id, json.versions ?? []);
    this._emitAdmin();
  }

  async submit(form) {
    const { ok, json } = await this._request(this._config.urls.submit, {
      method: 'POST',
      body: form,
    });

    if (!ok) {
      this._fail('mine', json);
      return;
    }

    // отдельным событием, а не внутри loadMine: список перерисовывается и
    // при открытии панели, а чистить форму нужно ровно на успехе отправки —
    // иначе повторная отправка того же содержимого выглядит как «кнопка не
    // сработала» (ответ gameExists при заполненных полях)
    this.publisher.emit('submitted');

    await this.loadMine();
  }

  async requestVersion(id, version) {
    const { ok, json } = await this._request(this._config.urls.version(id), {
      method: 'POST',
      body: { version },
    });

    if (!ok) {
      this._fail('mine', json);
      return;
    }

    await this.loadMine();
  }

  // «Test»: мастер качает версию и кладёт её в каталог не раздаваемой.
  // Манифест едет наружу — по нему вкладка админа поднимает комнату
  async stage(id, version) {
    const { ok, json } = await this._request(this._config.urls.stage(id), {
      method: 'POST',
      body: { version },
    });

    if (!ok) {
      this._fail('admin', json);
      return;
    }

    this.publisher.emit('staged', { id, version: json.version, manifest: json.manifest });
    await this.loadAdmin();
  }

  async moderate(id, patch) {
    const { ok, json } = await this._request(this._config.urls.moderate(id), {
      method: 'PATCH',
      body: patch,
    });

    if (!ok) {
      this._fail('admin', json);
      return;
    }

    await this.loadAdmin();

    // после loadAdmin, а не до: renderAdmin чистит строку отказа панели, и
    // предупреждение, показанное раньше, стёрлось бы тем же тиком
    if (json?.warning) {
      this.publisher.emit('warning', { scope: 'admin', code: json.warning });
    }
  }

  _emitAdmin() {
    this.publisher.emit('admin-changed', {
      games: this._all.filter(game => game.status === this._filter),
      filter: this._filter,
      versions: this._versions,
    });
  }

  // ошибки приезжают двумя формами: список проблем пакета от мастера
  // ({errors: [...]}, структурная проверка до записи в реестр) и код отказа
  // auth-сервиса ({error: '...'}). Наружу уходит одна
  _fail(scope, json) {
    const errors = Array.isArray(json?.errors)
      ? json.errors.map(error => ({ name: 'package', error }))
      : [{ name: 'request', error: json?.error ?? REQUEST_FAILED }];

    this.publisher.emit('error', { scope, errors });
  }

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
