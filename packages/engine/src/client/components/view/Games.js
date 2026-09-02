import Publisher from '../../../lib/Publisher.js';
import { renderFormErrors } from '../../lib/formBuilder.js';

// Singleton GamesView

let gamesView;

// коды отказов мастера/auth — человеческая формулировка живёт здесь, как в
// LobbyAuthView: модель кодов не переводит, view не ходит в сеть
const ERROR_MESSAGES = {
  unauthorized: 'Нужно войти заново',
  forbidden: 'Недостаточно прав',
  network: 'Сеть недоступна, попробуйте ещё раз',
  requestFailed: 'Запрос не прошёл',
  gameExists: 'Игра с таким идентификатором уже есть',
  tooManyGames: 'Слишком много заявок от одного автора',
  unknownGame: 'Игра не найдена в реестре',
  invalidGameId: 'Неверный идентификатор игры',
  invalidPackageName: 'Неверное имя npm-пакета',
  invalidVersion: 'Неверная версия',
  invalidTitle: 'Неверное название',
  invalidRepoUrl: 'Неверная ссылка на репозиторий',
  authServiceUnavailable: 'Сервис реестра недоступен',
};

const STATUS_TITLES = {
  pending: 'на модерации',
  approved: 'опубликована',
  rejected: 'отклонена',
  disabled: 'отключена',
};

// Представление реестра игр: списки заявок и очереди модерации, фильтры,
// строки ошибок. В сеть не ходит и состояния не держит — рисует то, что
// пришло событием модели, и публикует намерения пользователя
export default class GamesView {
  /**
   * @param {Object} model - GamesModel (источник событий).
   * @param {Object} config - Блок `games` конфига лобби.
   */
  constructor(model, config) {
    if (gamesView) {
      return gamesView;
    }

    gamesView = this;

    const { elems } = config;

    this._config = config;
    this._elems = elems;

    this._panel = document.getElementById(elems.panelId);
    this._lobby = document.getElementById(elems.lobbyId);
    this._openMine = document.getElementById(elems.openMineBtnId);
    this._openModeration = document.getElementById(elems.openModerationBtnId);
    this._close = document.getElementById(elems.closeBtnId);

    this._mineList = document.getElementById(elems.mineListId);
    this._submitForm = document.getElementById(elems.submitFormId);
    this._submitError = document.getElementById(elems.submitErrorId);

    this._moderation = document.getElementById(elems.moderationId);
    this._adminList = document.getElementById(elems.adminListId);
    this._adminError = document.getElementById(elems.adminErrorId);
    this._filters = document.getElementById(elems.filtersId);

    this._fields = new Map(
      Object.entries(elems.fieldIds).map(([name, id]) => [
        name,
        document.getElementById(id),
      ]),
    );

    this.publisher = new Publisher();

    this._openMine.onclick = () => this.publisher.emit('open-mine');
    this._openModeration.onclick = () => this.publisher.emit('open-moderation');
    this._close.onclick = () => this.hide();

    this._submitForm.onsubmit = e => {
      e.preventDefault();
      this.publisher.emit('submit', this._readForm());
    };

    this._renderFilters();

    const mp = model.publisher;

    mp.on('mine-changed', 'renderMine', this);
    mp.on('admin-changed', 'renderAdmin', this);
    mp.on('error', 'renderError', this);
  }

  // кнопку модерации показывает не сама панель, а роль вызывающего
  // (main.js по LobbyAuthModel.getRole())
  setAdmin(isAdmin) {
    this._openModeration.style.display = isAdmin ? '' : 'none';
  }

  show(moderation = false) {
    this._panel.style.display = 'flex';
    this._lobby.style.display = 'none';
    this._moderation.style.display = moderation ? 'block' : 'none';
  }

  hide() {
    // закрытой панели закрывать нечего: возврат черновиков после
    // перезагрузки идёт тем же событием 'staged', что и «Тест», и не должен
    // трогать разметку лобби
    if (this._panel.style.display === 'none') {
      return;
    }

    this._panel.style.display = 'none';
    this._lobby.style.display = 'flex';
  }

  renderMine(games) {
    this._submitError.textContent = '';
    this._mineList.textContent = '';

    (games || []).forEach(game => {
      const item = document.createElement('li');

      item.className = 'games-item';
      item.appendChild(
        this._line(
          `${game.id} — ${game.packageName} @ ${game.version ?? '—'}`,
          'games-item-title',
        ),
      );
      item.appendChild(this._line(this._statusLine(game)));

      if (game.moderatorNote) {
        item.appendChild(this._line(`Замечание: ${game.moderatorNote}`));
      }

      // заявка на новую версию своей игры: поле рядом со строкой, а не
      // отдельной формой — версия относится к конкретной заявке
      const version = document.createElement('input');
      const send = document.createElement('input');

      version.type = 'text';
      version.className = 'field-text games-version-input';
      version.placeholder = 'Новая версия';
      send.type = 'button';
      send.value = 'Обновить версию';
      send.onclick = () =>
        this.publisher.emit('update-version', { id: game.id, version: version.value.trim() });

      item.appendChild(version);
      item.appendChild(send);
      this._mineList.appendChild(item);
    });
  }

  renderAdmin({ games, filter, versions }) {
    this._adminError.textContent = '';
    this._adminList.textContent = '';
    this._markFilter(filter);

    (games || []).forEach(game => {
      this._adminList.appendChild(this._adminItem(game, versions));
    });
  }

  renderError({ scope, errors }) {
    const container = scope === 'admin' ? this._adminError : this._submitError;

    renderFormErrors(
      container,
      errors.map(({ name, error }) => ({
        name,
        label: name,
        error: ERROR_MESSAGES[error] ?? error,
      })),
    );
  }

  _adminItem(game, versions) {
    const item = document.createElement('li');
    const published = versions?.get(game.id) ?? [];
    const latest = published[published.length - 1];

    item.className = 'games-item';
    item.appendChild(
      this._line(`${game.id} — ${game.packageName}`, 'games-item-title'),
    );
    item.appendChild(this._line(`Автор: ${game.authorNick ?? game.authorUserId}`));
    item.appendChild(
      this._line(
        `Раздаётся: ${game.version ?? '—'}; заявлена: ${game.pendingVersion ?? '—'}` +
          (latest ? `; в npm: ${latest}` : ''),
      ),
    );
    item.appendChild(this._line(this._statusLine(game)));

    if (game.local) {
      item.appendChild(
        this._line(
          `На этом мастере: ${game.local.downloaded ? 'скачана' : 'не скачана'}` +
            (game.local.stagedVersion ? `; на тесте ${game.local.stagedVersion}` : '') +
            (game.local.lastError ? `; ошибка: ${game.local.lastError}` : ''),
        ),
      );
    }

    const note = document.createElement('input');

    note.type = 'text';
    note.className = 'field-text games-note-input';
    note.placeholder = 'Причина отклонения';

    item.appendChild(note);
    item.appendChild(
      this._button('Тест', () =>
        this.publisher.emit('stage', {
          id: game.id,
          version: game.pendingVersion ?? game.version,
        }),
      ),
    );
    item.appendChild(
      this._button('Одобрить', () => this.publisher.emit('approve', { id: game.id })),
    );
    item.appendChild(
      this._button('Отклонить', () =>
        this.publisher.emit('reject', { id: game.id, note: note.value.trim() }),
      ),
    );
    item.appendChild(
      this._button('Отключить', () => this.publisher.emit('disable', { id: game.id })),
    );
    item.appendChild(
      this._button('Версии в npm', () =>
        this.publisher.emit('load-versions', { id: game.id }),
      ),
    );

    return item;
  }

  _statusLine(game) {
    const status = STATUS_TITLES[game.status] ?? game.status;
    const date = game.createdAt ? new Date(game.createdAt).toLocaleDateString() : '';

    return date ? `Статус: ${status} (заявка от ${date})` : `Статус: ${status}`;
  }

  _renderFilters() {
    this._filterButtons = new Map();

    this._config.statuses.forEach(({ id, title }) => {
      const btn = this._button(title, () => this.publisher.emit('filter', id));

      btn.className = 'games-filter-btn';
      this._filterButtons.set(id, btn);
      this._filters.appendChild(btn);
    });
  }

  _markFilter(filter) {
    this._filterButtons.forEach((btn, id) => {
      btn.classList.toggle('active', id === filter);
    });
  }

  _button(value, onclick) {
    const btn = document.createElement('input');

    btn.type = 'button';
    btn.value = value;
    btn.onclick = onclick;

    return btn;
  }

  _line(text, className) {
    const line = document.createElement('div');

    line.textContent = text;

    if (className) {
      line.className = className;
    }

    return line;
  }

  _readForm() {
    const form = {};

    this._fields.forEach((field, name) => {
      form[name] = field.value.trim();
    });

    return form;
  }
}
