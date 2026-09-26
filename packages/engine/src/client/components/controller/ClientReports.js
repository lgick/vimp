// Singleton ClientReportsCtrl

let clientReportsCtrl;

// Контроллер журнала клиентских ошибок (plan/client-reports, этап 5):
// связывает view-события с моделью, собственного сетевого I/O не делает
export default class ClientReportsCtrl {
  constructor(model, view) {
    if (clientReportsCtrl) {
      return clientReportsCtrl;
    }

    clientReportsCtrl = this;

    this._model = model;
    this._view = view;

    const vp = view.publisher;

    vp.on('open', 'open', this);
    vp.on('filter', 'filter', this);
    vp.on('game', 'game', this);
    vp.on('more', 'more', this);
    vp.on('set-status', 'setStatus', this);
  }

  // роль решает только видимость кнопки «Errors»: доступ к данным проверяет
  // мастер, а auth перечитывает роль из БД
  setAdmin(isAdmin) {
    this._view.setAdmin(isAdmin);
  }

  // журнал живой — каждое открытие панели перечитывает его с первой страницы
  open() {
    this._view.show();
    this._model.load({ reset: true });
  }

  filter(status) {
    this._model.setFilter({ status });
  }

  game(gameId) {
    this._model.setFilter({ gameId });
  }

  more() {
    this._model.load();
  }

  setStatus({ id, status, note }) {
    this._model.setStatus(id, status, note);
  }
}
