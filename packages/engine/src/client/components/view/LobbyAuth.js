import Publisher from '../../../lib/Publisher.js';

// Singleton LobbyAuthView

let lobbyAuthView;

const NICK_ERROR_MESSAGES = {
  nickTaken: 'This nick is already taken',
  invalidNick: 'Invalid nick',
  sessionExpired: 'Session expired, please sign in again',
  network: 'Network error, try again',
};

// Представление логина лобби: переключает login/nick секции lobbyAuth.pug и
// бейдж пользователя в lobby.pug (#lobby-user), скрывает/показывает #lobby
// целиком — до авторизации список серверов недоступен (B2)
export default class LobbyAuthView {
  constructor(model, config) {
    if (lobbyAuthView) {
      return lobbyAuthView;
    }

    lobbyAuthView = this;

    const { elems, providerButtonClass } = config;

    this._elems = elems;
    this._providerButtons = document.querySelectorAll(`.${providerButtonClass}`);

    this._container = document.getElementById(elems.containerId);
    this._loginSection = document.getElementById(elems.loginSectionId);
    this._loginError = document.getElementById(elems.loginErrorId);
    this._nickSection = document.getElementById(elems.nickSectionId);
    this._nickInput = document.getElementById(elems.nickInputId);
    this._nickError = document.getElementById(elems.nickErrorId);
    this._nickSubmit = document.getElementById(elems.nickSubmitId);
    this._lobby = document.getElementById(elems.lobbyId);
    this._user = document.getElementById(elems.userId);
    this._userNick = document.getElementById(elems.userNickId);
    this._userLogout = document.getElementById(elems.userLogoutId);

    this.publisher = new Publisher();

    this._providerButtons.forEach(btn => {
      btn.onclick = () => this.publisher.emit('login', btn.dataset.provider);
    });

    this._nickSubmit.onclick = () => this._emitNick();
    this._nickInput.onkeydown = e => {
      if (e.key === 'Enter') {
        this._emitNick();
      }
    };

    this._userLogout.onclick = () => this.publisher.emit('logout');

    const mp = model.publisher;

    mp.on('login-required', 'showLogin', this);
    mp.on('nick-required', 'showNick', this);
    mp.on('authenticated', 'showLobby', this);
    mp.on('login-error', 'renderLoginError', this);
    mp.on('nick-error', 'renderNickError', this);
  }

  showLogin(providers = []) {
    this._container.style.display = 'block';
    this._loginSection.style.display = 'block';
    this._nickSection.style.display = 'none';
    this._lobby.style.display = 'none';
    this._user.style.display = 'none';

    this._providerButtons.forEach(btn => {
      btn.style.display = providers.includes(btn.dataset.provider) ? '' : 'none';
    });
  }

  showNick() {
    this._loginSection.style.display = 'none';
    this._nickSection.style.display = 'block';
    this._nickError.textContent = '';
    this._nickInput.value = '';
    this._nickInput.focus();
  }

  showLobby({ nick }) {
    this._container.style.display = 'none';
    this._lobby.style.display = 'block';
    this._user.style.display = 'block';
    this._userNick.textContent = nick;
  }

  renderLoginError(code) {
    this._loginError.textContent = NICK_ERROR_MESSAGES[code] || code || 'Sign-in failed';
  }

  renderNickError(code) {
    this._nickError.textContent = NICK_ERROR_MESSAGES[code] || 'Something went wrong';
  }

  _emitNick() {
    this.publisher.emit('nick', this._nickInput.value.trim());
  }
}
