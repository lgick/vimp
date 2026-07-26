import Publisher from '../../../lib/Publisher.js';
import { decodeJwtPayload } from '../../../lib/jwt.js';

// Singleton LobbyAuthModel

let lobbyAuthModel;

// Модель логина лобби (Этап B2): OAuth-редирект на central auth-сервис
// (packages/auth), выбор ника при первом входе, identity JWT в localStorage.
// Хранит состояние сессии и делает единственный сетевой вызов сама (POST
// /nick) — в отличие от Lobby/Auth-моделей это простой fetch без сигнального
// сокета, отдельный REST-канал к другому домену.
export default class LobbyAuthModel {
  constructor(config) {
    if (lobbyAuthModel) {
      return lobbyAuthModel;
    }

    lobbyAuthModel = this;

    this._config = config;
    this._pendingToken = null;
    this._identityToken = null;
    this._nick = null;

    this.publisher = new Publisher();
  }

  // разбирает query-параметры OAuth-редиректа (?token=/?pendingToken=/
  // ?authError=); при их отсутствии — восстанавливает сессию из localStorage.
  // Возвращает true, если параметры были найдены и вызывающий должен
  // подчистить адресную строку (history.replaceState)
  boot(search) {
    const { queryParams, tokenStorageKey } = this._config;
    const params = new URLSearchParams(search);

    const error = params.get(queryParams.error);
    const token = params.get(queryParams.token);
    const pendingToken = params.get(queryParams.pendingToken);

    if (error) {
      this.publisher.emit('login-error', error);
      this._restore(tokenStorageKey);
      return true;
    }

    if (token) {
      this._setIdentity(token, tokenStorageKey);
      return true;
    }

    if (pendingToken) {
      this._pendingToken = pendingToken;
      this.publisher.emit('nick-required');
      return true;
    }

    this._restore(tokenStorageKey);
    return false;
  }

  // URL редиректа на старт OAuth-потока auth-сервиса; вызывающий должен сам
  // сделать переход (window.location.href) — модель не трогает location
  loginUrl(provider) {
    const returnUrl = `${window.location.origin}${window.location.pathname}`;

    return `${this._config.serviceUrl}/oauth/${provider}/start?returnUrl=${encodeURIComponent(returnUrl)}`;
  }

  async submitNick(nick) {
    if (!this._pendingToken) {
      this.publisher.emit('nick-error', 'sessionExpired');
      return;
    }

    let res;
    let data;

    try {
      res = await fetch(`${this._config.serviceUrl}/nick`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this._pendingToken}`,
        },
        body: JSON.stringify({ nick }),
      });
      data = await res.json().catch(() => ({}));
    } catch {
      this.publisher.emit('nick-error', 'network');
      return;
    }

    if (!res.ok) {
      this.publisher.emit('nick-error', data.error || 'unknown');
      return;
    }

    this._pendingToken = null;
    this._setIdentity(data.token, this._config.tokenStorageKey);
  }

  logout() {
    delete localStorage[this._config.tokenStorageKey];

    this._identityToken = null;
    this._nick = null;

    this.publisher.emit('login-required', this._config.providers);
  }

  getToken() {
    return this._identityToken;
  }

  getNick() {
    return this._nick;
  }

  _restore(tokenStorageKey) {
    const token = localStorage[tokenStorageKey];

    if (token) {
      this._setIdentity(token, tokenStorageKey, false);
    } else {
      this.publisher.emit('login-required', this._config.providers);
    }
  }

  // payload JWT не проверяется подписью на клиенте (только для отображения
  // ника) — авторитетная проверка по /jwks на хосте (Этап B3). exp
  // проверяется (F5 кодревью) — иначе восстановленная из localStorage сессия
  // показывает «залогинен» токеном, который хост уже отклонит при входе в игру
  _setIdentity(token, tokenStorageKey, persist = true) {
    const payload = decodeJwtPayload(token);
    const isExpired = typeof payload?.exp === 'number' && Date.now() >= payload.exp * 1000;

    if (!payload || !payload.nick || isExpired) {
      delete localStorage[tokenStorageKey];

      if (isExpired) {
        this.publisher.emit('login-error', 'tokenExpired');
      } else {
        this.publisher.emit('login-error', 'invalidToken');
      }

      this.publisher.emit('login-required', this._config.providers);
      return;
    }

    this._identityToken = token;
    this._nick = payload.nick;

    if (persist) {
      localStorage[tokenStorageKey] = token;
    }

    this.publisher.emit('authenticated', { nick: this._nick });
  }
}
