import Publisher from '../../../lib/Publisher.js';

// Singleton LobbyCtrl

let lobbyCtrl;

// Контроллер лобби: связывает view-события с моделью. Пинг видимых карточек
// дросселирует модель (pingHost возвращает false, если пинговали недавно).
// Leaderboard (lobby-page-plan): контроллер сам fetch не делает (как и модель) —
// пробрасывает смену активной игры через собственный publisher, который
// main.js слушает, чтобы вызвать fetchLeaderboard/fetchPlacement и вернуть
// результат в model.setLeaderboard/setPlacement. Единственный источник
// 'leaderboard-needed' — gameChanged() (main.js вызывает его один раз при
// открытии лобби для игры по умолчанию и на каждый change #lobby-game), не
// открытие вкладки — так пока в контроллере не завёлся второй, дублирующий
// путь загрузки (code review L4/L5: ветка "первое открытие вкладки" не могла
// сработать раньше gameChanged() при старте и рисковала уйти в fetch с
// gameId=null)
export default class LobbyCtrl {
  constructor(model, view, clock = () => performance.now()) {
    if (lobbyCtrl) {
      return lobbyCtrl;
    }

    lobbyCtrl = this;

    this._model = model;
    this._view = view;
    this._clock = clock;
    this._periods = [];

    this.publisher = new Publisher();

    const vp = view.publisher;

    vp.on('search', 'search', this);
    vp.on('more', 'loadMore', this);
    vp.on('visible', 'pingHost', this);
    vp.on('join', 'join', this);
    vp.on('show-tab', 'showTab', this);
    vp.on('show-period', 'showPeriod', this);

    // активная игра и открытый срез рейтинга (rank-periods): запрос за
    // лидербордом всегда несёт обе координаты, а меняется каждый раз одна
    this._gameId = null;
    this._period = null;
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
  }

  // срез рейтинга: подсветить кнопку и перезапросить список. Данных за день
  // и за месяц у клиента нет — это другой ответ сервера, а не другая
  // сортировка того же (rank-periods)
  showPeriod(period) {
    if (period === this._period) {
      return;
    }

    this._period = period;
    this._view.setPeriod(period, this._titleOf(period));

    if (this._gameId !== null) {
      this.publisher.emit('leaderboard-needed', {
        gameId: this._gameId,
        period,
      });
    }
  }

  // подпись среза для заголовка списка; неизвестный id остаётся без подписи
  _titleOf(period) {
    return this._periods.find(item => item.id === period)?.title ?? '';
  }

  // вызывается main.js при смене #lobby-game (селектор игры вне этого MVC),
  // а также один раз при открытии лобби для активной по умолчанию игры —
  // Leaderboard всегда готов заранее, до того как пользователь откроет
  // вкладку (см. класс-комментарий выше)
  gameChanged(gameId, title) {
    this._gameId = gameId;
    this._view.setGameTitle(title);

    this.publisher.emit('leaderboard-needed', { gameId, period: this._period });
  }

  // срезы рейтинга и открытый по умолчанию (main.js передаёт их из
  // lobbyConfig): контроллер не знает их наизусть, чтобы список срезов
  // правился в конфиге, а не здесь
  setPeriods(periods, defaultPeriod) {
    this._periods = periods || [];
    this._period = defaultPeriod;
    this._view.setPeriod(defaultPeriod, this._titleOf(defaultPeriod));
  }
}
