// Singleton LobbyAuthCtrl

let lobbyAuthCtrl;

export default class LobbyAuthCtrl {
  constructor(model, view) {
    if (lobbyAuthCtrl) {
      return lobbyAuthCtrl;
    }

    lobbyAuthCtrl = this;

    this._model = model;
    this._view = view;

    const vp = view.publisher;

    vp.on('login', 'login', this);
    vp.on('nick', 'submitNick', this);
    vp.on('logout', 'logout', this);
  }

  // разбирает query string текущего location (OAuth-редиректы) либо
  // восстанавливает сессию из localStorage; возвращает true, если query
  // содержала auth-параметры (вызывающий должен подчистить адресную строку)
  init(search) {
    return this._model.boot(search);
  }

  login(provider) {
    window.location.href = this._model.loginUrl(provider);
  }

  submitNick(nick) {
    this._model.submitNick(nick);
  }

  logout() {
    this._model.logout();
  }
}
