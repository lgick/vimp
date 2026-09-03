import Publisher from '../../../lib/Publisher.js';

// Singleton GamesCtrl

let gamesCtrl;

// Контроллер реестра игр: связывает view-события с моделью, как LobbyCtrl.
// Собственного сетевого I/O не делает. Наружу (main.js) пробрасывает только
// 'staged' — манифест застейдженной версии, который нужно положить в каталог
// вкладки, чтобы админ мог поднять по нему комнату
export default class GamesCtrl {
  constructor(model, view) {
    if (gamesCtrl) {
      return gamesCtrl;
    }

    gamesCtrl = this;

    this._model = model;
    this._view = view;

    this.publisher = new Publisher();

    const vp = view.publisher;

    vp.on('open-mine', 'openMine', this);
    vp.on('open-moderation', 'openModeration', this);
    vp.on('lookup', 'lookup', this);
    vp.on('submit', 'submit', this);
    vp.on('update-version', 'updateVersion', this);
    vp.on('filter', 'filter', this);
    vp.on('stage', 'stage', this);
    vp.on('approve', 'approve', this);
    vp.on('reject', 'reject', this);
    vp.on('disable', 'disable', this);
    vp.on('load-versions', 'loadVersions', this);
    vp.on('set-author', 'setAuthor', this);

    model.publisher.on('staged', 'staged', this);
  }

  // роль решает только видимость кнопки модерации: доступ к данным
  // проверяет мастер, а запись — auth-сервис по роли из БД
  setAdmin(isAdmin) {
    this._view.setAdmin(isAdmin);

    // черновики, уже скачанные этим мастером, возвращаются в каталог вкладки
    // сразу: после матча лобби перезагружает страницу, и без этого админ
    // терял бы из селектора версию, которую сам же поставил на тест
    if (isAdmin) {
      this._model.loadStaged();
    }
  }

  openMine() {
    this._view.show(false);
    this._model.loadMine();
  }

  openModeration() {
    this._view.show(true);
    this._model.loadMine();
    this._model.loadAdmin();
  }

  lookup({ packageName, version }) {
    this._model.lookup(packageName, version);
  }

  submit(form) {
    this._model.submit(form);
  }

  updateVersion({ id, version }) {
    this._model.requestVersion(id, version);
  }

  filter(status) {
    this._model.setFilter(status);
  }

  stage({ id, version }) {
    this._model.stage(id, version);
  }

  approve({ id }) {
    this._model.moderate(id, { status: 'approved' });
  }

  reject({ id, note }) {
    this._model.moderate(id, { status: 'rejected', note });
  }

  disable({ id }) {
    this._model.moderate(id, { status: 'disabled' });
  }

  loadVersions({ id }) {
    this._model.loadVersions(id);
  }

  setAuthor({ id, nick }) {
    this._model.setAuthor(id, nick);
  }

  staged(data) {
    this.publisher.emit('staged', data);
  }
}
