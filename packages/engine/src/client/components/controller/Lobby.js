import Publisher from '../../../lib/Publisher.js';

// Singleton LobbyCtrl

let lobbyCtrl;

// Контроллер лобби: связывает view-события с моделью. Пинг видимых карточек
// дросселирует модель (pingHost возвращает false, если пинговали недавно).
// Leaderboard (lobby-page-plan): контроллер сам fetch не делает (как и модель) —
// пробрасывает смену активной игры и первое открытие вкладки Leaderboard
// через собственный publisher, который main.js слушает, чтобы вызвать
// fetchLeaderboard/fetchPlacement и вернуть результат в model.setLeaderboard/setPlacement
export default class LobbyCtrl {
  constructor(model, view, clock = () => performance.now()) {
    if (lobbyCtrl) {
      return lobbyCtrl;
    }

    lobbyCtrl = this;

    this._model = model;
    this._view = view;
    this._clock = clock;
    this._leaderboardLoaded = false;
    this._currentGameId = null;

    this.publisher = new Publisher();

    const vp = view.publisher;

    vp.on('search', 'search', this);
    vp.on('more', 'loadMore', this);
    vp.on('visible', 'pingHost', this);
    vp.on('join', 'join', this);
    vp.on('show-tab', 'showTab', this);
  }

  // показывает лобби и запрашивает первую страницу
  open() {
    this._view.show();
    this._model.refresh();
  }

  close() {
    this._view.hide();
  }

  search(text) {
    this._model.setSearch(text);
  }

  loadMore() {
    this._model.loadMore();
  }

  pingHost(hostId) {
    this._model.pingHost(hostId, this._clock());
  }

  join(hostId) {
    this._model.join(hostId);
  }

  showTab(tab) {
    this._view.showTab(tab);

    // ленивая загрузка: данные для текущей игры запрашиваются не раньше
    // первого показа вкладки Leaderboard, дальше их держит свежими
    // gameChanged() (main.js вызывает его при смене #lobby-game)
    if (tab === 'leaderboard' && !this._leaderboardLoaded) {
      this._leaderboardLoaded = true;
      this.publisher.emit('leaderboard-needed', this._currentGameId);
    }
  }

  // вызывается main.js при смене #lobby-game (селектор игры вне этого MVC),
  // а также один раз при открытии лобби для активной по умолчанию игры —
  // всегда фетчит заново (не только при первом открытии вкладки), чтобы
  // Leaderboard был готов, если пользователь откроет вкладку позже
  gameChanged(gameId, title) {
    this._currentGameId = gameId;
    this._leaderboardLoaded = true;
    this._view.setGameTitle(title);

    this.publisher.emit('leaderboard-needed', gameId);
  }
}
