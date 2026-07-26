// Singleton LobbyCtrl

let lobbyCtrl;

// Контроллер лобби: связывает view-события с моделью. Пинг видимых карточек
// дросселирует модель (pingHost возвращает false, если пинговали недавно).
export default class LobbyCtrl {
  constructor(model, view, clock = () => performance.now()) {
    if (lobbyCtrl) {
      return lobbyCtrl;
    }

    lobbyCtrl = this;

    this._model = model;
    this._view = view;
    this._clock = clock;

    const vp = view.publisher;

    vp.on('search', 'search', this);
    vp.on('more', 'loadMore', this);
    vp.on('visible', 'pingHost', this);
    vp.on('join', 'join', this);
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
}
