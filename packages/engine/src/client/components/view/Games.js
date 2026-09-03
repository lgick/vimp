import Publisher from '../../../lib/Publisher.js';
import { renderFormErrors } from '../../lib/formBuilder.js';

// Singleton GamesView

let gamesView;

// коды отказов мастера/auth — человеческая формулировка живёт здесь, как в
// LobbyAuthView: модель кодов не переводит, view не ходит в сеть.
// Язык интерфейса — английский, как и в остальном лобби
const ERROR_MESSAGES = {
  unauthorized: 'Please sign in again',
  forbidden: 'Not enough rights',
  network: 'Network unavailable, try again',
  requestFailed: 'Request failed',
  // лимитер мастера (5 заявок в минуту на пользователя) считает и заявки,
  // отклонённые по формату, — без своей строки код уезжал бы в интерфейс сырым
  tooManyRequests: 'Too many requests, try again in a minute',
  gameExists: 'A game with this id already exists',
  tooManyGames: 'Too many submissions from one author',
  unknownGame: 'Game is not in the registry',
  gamePublished: 'Published game — ask an admin to disable it first',
  unknownUser: 'No player with this nick',
  invalidGameId: 'Invalid game id',
  invalidPackageName: 'Invalid npm package name',
  invalidVersion: 'Invalid version',
  invalidTitle: 'Invalid title',
  invalidRepoUrl: 'Invalid repository URL',
  invalidMaxGameScore: 'Invalid score cap',
  authServiceUnavailable: 'Registry service unavailable',
};

// предупреждения: решение принято, отказа не было, но состояние платформы
// стоит назвать вслух
const WARNING_MESSAGES = {
  catalogEmpty:
    'No published games left — the lobby cannot create rooms until one is published',
};

const STATUS_TITLES = {
  pending: 'in review',
  approved: 'published',
  rejected: 'rejected',
  disabled: 'disabled',
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
    this._submitBtn = document.getElementById(elems.submitBtnId);
    this._lookupBtn = document.getElementById(elems.lookupBtnId);
    this._preview = document.getElementById(elems.previewId);
    this._versionList = document.getElementById(elems.versionListId);

    this._mine = document.getElementById(elems.mineId);
    this._title = document.getElementById(elems.titleId);
    this._switch = document.getElementById(elems.switchBtnId);
    // текущая страница панели: от неё зависит, куда уводит переключатель
    this._isModeration = false;
    // последний разобранный `${packageName}@${version}` — защита от парного
    // разбора одного и того же пакета, см. _emitLookup
    this._lastLookup = null;

    this._moderation = document.getElementById(elems.moderationId);
    this._adminList = document.getElementById(elems.adminListId);
    this._adminError = document.getElementById(elems.adminErrorId);
    this._filters = document.getElementById(elems.filtersId);

    this._fields = new Map(
      Object.entries(elems.fieldIds).map(([name, id]) => {
        const field = document.getElementById(id);

        // карта строится по конфигу, а используется из обработчиков событий:
        // разъехавшийся с games.pug id дал бы здесь null, а упал бы позже —
        // безымянным TypeError внутри clearForm или _readForm. Остальная
        // разметка панели проверяется тем же способом, только неявно: первое
        // же обращение к отсутствующему элементу бросает в конструкторе
        if (!field) {
          throw new Error(`GamesView: no element "#${id}" for field "${name}"`);
        }

        return [name, field];
      }),
    );

    this.publisher = new Publisher();

    this._openMine.onclick = () => this.publisher.emit('open-mine');
    this._openModeration.onclick = () => this.publisher.emit('open-moderation');
    this._close.onclick = () => this.hide();
    // переключатель страниц панели: без него выход из «Moderation» в
    // «My games» шёл бы только через лобби
    this._switch.onclick = () =>
      this.publisher.emit(this._isModeration ? 'open-mine' : 'open-moderation');

    this._submitForm.onsubmit = e => {
      e.preventDefault();
      this.publisher.emit('submit', this._readForm());
    };

    const packageField = this._fields.get('packageName');

    // разбор пакета по кнопке И по уходу из поля: заполнять форму
    // предпросмотром — обычный путь, а не отдельное действие
    this._lookupBtn.onclick = () => this._emitLookup();
    packageField.onblur = () => this._emitLookup();
    // правка пакета обесценивает показанный предпросмотр: заявка ушла бы с
    // разобранным ранее пакетом, а человек читал бы карточку другого
    packageField.oninput = () => this.clearPreview();

    this.clearPreview();

    this._renderFilters();

    const mp = model.publisher;

    mp.on('submitted', 'clearForm', this);
    mp.on('looked-up', 'renderPreview', this);
    mp.on('mine-changed', 'renderMine', this);
    mp.on('admin-changed', 'renderAdmin', this);
    mp.on('error', 'renderError', this);
    mp.on('warning', 'renderWarning', this);
  }

  // кнопку модерации показывает не сама панель, а роль вызывающего
  // (main.js по LobbyAuthModel.getRole())
  setAdmin(isAdmin) {
    this._openModeration.style.display = isAdmin ? '' : 'none';
    this._switch.style.display = isAdmin ? '' : 'none';
  }

  // Панель — две страницы, а не одна: «My games» и «Moderation»
  // показываются по одной. Общая шапка (заголовок, переключатель и
  // «Back to lobby») живёт над карточками и переживает переключение
  show(moderation = false) {
    this._isModeration = moderation;
    this._panel.style.display = 'flex';
    this._lobby.style.display = 'none';
    this._mine.style.display = moderation ? 'none' : 'block';
    this._moderation.style.display = moderation ? 'block' : 'none';
    this._title.textContent = moderation ? 'Moderation' : 'My games';
    // подпись переключателя называет ту страницу, куда он уводит
    this._switch.value = moderation ? 'My games' : 'Moderation';
  }

  hide() {
    // закрытой панели закрывать нечего: возврат черновиков после
    // перезагрузки идёт тем же событием 'staged', что и «Test», и не должен
    // трогать разметку лобби
    if (this._panel.style.display === 'none') {
      return;
    }

    this._panel.style.display = 'none';
    this._lobby.style.display = 'flex';
  }

  // заявка ушла — поля пустые: следующая отправка начинается с чистой формы
  clearForm() {
    this._fields.forEach(field => {
      field.value = '';
    });
    this.clearPreview();
  }

  // предпросмотра нет — отправлять нечего: мастер всё равно откажет, а
  // человек не увидит, за какую игру он ручается
  clearPreview() {
    this._preview.textContent = '';
    this._versionList.textContent = '';
    this._submitBtn.disabled = true;
    // предпросмотра нет — значит, и запрета на повторный разбор быть не
    // должно: правка поля обесценивает прошлый вердикт
    this._lastLookup = null;
  }

  /**
   * Карточка разобранного пакета: то, что раньше человек вводил руками.
   * @param {Object} data - Ответ мастера на /games/lookup.
   */
  renderPreview({ id, title, version, versions, repoUrl, engineApi, errors }) {
    this._preview.textContent = '';
    this._submitError.textContent = '';

    this._preview.appendChild(
      this._line(`${title ? `${title} · ` : ''}${id ?? '—'}`, 'games-item-title'),
    );
    this._preview.appendChild(this._line(`Version: ${version ?? '—'}`));
    this._preview.appendChild(this._line(`Engine API: ${engineApi ?? '—'}`));
    this._appendRepo(this._preview, repoUrl);

    // список опубликованных версий — подсказка поля, а не отдельный контрол
    this._versionList.textContent = '';
    (versions || []).forEach(value => {
      const option = document.createElement('option');

      option.value = value;
      this._versionList.appendChild(option);
    });

    // резолвнутая мастером версия: 'latest' в поле осталась бы ссылкой,
    // которая завтра означает другой пакет
    if (version) {
      this._fields.get('version').value = version;
    }

    // разрешённая версия в поле меняет `${packageName}@${version}`, и
    // следующий blur прошёл бы как «другой пакет»: запрет повтора обновляется
    // фактическим ответом мастера
    this._lastLookup = `${this._fields.get('packageName').value.trim()}@${
      this._fields.get('version').value.trim()
    }`;

    const problems = errors || [];

    if (problems.length) {
      renderFormErrors(
        this._submitError,
        problems.map(error => ({ name: 'package', label: 'package', error })),
      );
    }

    // заявка на заведомо нерабочий пакет реестру не нужна
    this._submitBtn.disabled = problems.length > 0 || !id;
  }

  renderMine(games) {
    this._submitError.textContent = '';
    this._mineList.textContent = '';

    (games || []).forEach(game => {
      const item = document.createElement('li');

      item.className = 'games-item';
      item.appendChild(
        this._line(
          `${game.title ? `${game.title} · ` : ''}${game.id} — ` +
            `${game.packageName} @ ${game.version ?? '—'}`,
          'games-item-title',
        ),
      );
      item.appendChild(this._line(this._statusLine(game)));
      this._appendRepo(item, game.repoUrl);

      if (game.moderatorNote) {
        item.appendChild(this._line(`Note: ${game.moderatorNote}`));
      }

      // заявка на новую версию своей игры: поле рядом со строкой, а не
      // отдельной формой — версия относится к конкретной заявке
      const version = document.createElement('input');
      const send = document.createElement('input');

      version.type = 'text';
      version.className = 'field-text games-version-input';
      version.placeholder = 'New version';
      send.type = 'button';
      send.value = 'Update version';
      send.onclick = () =>
        this.publisher.emit('update-version', { id: game.id, version: version.value.trim() });

      item.appendChild(version);
      item.appendChild(send);
      item.appendChild(
        this._button(
          'Delete',
          () => this.publisher.emit('delete', { id: game.id, scope: 'mine' }),
          'games-delete-btn',
        ),
      );
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

  renderWarning({ scope, code }) {
    const container = scope === 'admin' ? this._adminError : this._submitError;

    container.textContent = WARNING_MESSAGES[code] ?? code;
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
      this._line(
        `${game.title ? `${game.title} · ` : ''}${game.id} — ${game.packageName}`,
        'games-item-title',
      ),
    );

    // Мягко удалённая игра модерации не подлежит: у игроков её уже нет, а
    // решение по ней приняли. Из всей карточки ей нужны срок полного
    // удаления и возврат — остальные кнопки правили бы то, чего не видно
    if (game.deletedAt) {
      item.appendChild(this._line(`Author: ${game.authorNick ?? game.authorUserId ?? '—'}`));
      this._appendRepo(item, game.repoUrl);
      item.appendChild(this._line(this._statusLine(game), 'games-purge-line'));
      item.appendChild(
        this._button('Restore', () => this.publisher.emit('restore', { id: game.id })),
      );

      return item;
    }

    // у игр, засеянных миграцией, автора нет вовсе: без запасного прочерка
    // в строке печаталось бы литеральное "null"
    item.appendChild(this._line(`Author: ${game.authorNick ?? game.authorUserId ?? '—'}`));

    // переназначение автора: игры платформы засеяны без него, и «My games»
    // у их автора пуст, пока админ не проставит ник здесь. Пустое поле —
    // снять автора
    const author = document.createElement('input');

    author.type = 'text';
    author.className = 'field-text games-author-input';
    author.placeholder = 'Author nick';
    author.value = game.authorNick ?? '';

    item.appendChild(author);
    item.appendChild(
      this._button('Set author', () =>
        this.publisher.emit('set-author', { id: game.id, nick: author.value.trim() }),
      ),
    );
    this._appendRepo(item, game.repoUrl);
    item.appendChild(
      this._line(
        `Served: ${game.version ?? '—'}; requested: ${game.pendingVersion ?? '—'}` +
          (latest ? `; in npm: ${latest}` : ''),
      ),
    );
    item.appendChild(this._line(this._statusLine(game)));

    if (game.local) {
      item.appendChild(
        this._line(
          `On this master: ${game.local.downloaded ? 'downloaded' : 'not downloaded'}` +
            (game.local.stagedVersion ? `; staged ${game.local.stagedVersion}` : '') +
            (game.local.lastError ? `; error: ${game.local.lastError}` : ''),
        ),
      );
    }

    const note = document.createElement('input');

    note.type = 'text';
    note.className = 'field-text games-note-input';
    note.placeholder = 'Rejection reason';

    item.appendChild(note);
    item.appendChild(
      this._button('Test', () =>
        this.publisher.emit('stage', {
          id: game.id,
          version: game.pendingVersion ?? game.version,
        }),
      ),
    );
    item.appendChild(
      this._button('Approve', () => this.publisher.emit('approve', { id: game.id })),
    );
    item.appendChild(
      this._button('Reject', () =>
        this.publisher.emit('reject', { id: game.id, note: note.value.trim() }),
      ),
    );
    item.appendChild(
      this._button('Disable', () => this.publisher.emit('disable', { id: game.id })),
    );
    item.appendChild(
      this._button('npm versions', () =>
        this.publisher.emit('load-versions', { id: game.id }),
      ),
    );
    item.appendChild(
      this._button(
        'Delete',
        () => this.publisher.emit('delete', { id: game.id, scope: 'admin' }),
        'games-delete-btn',
      ),
    );

    return item;
  }

  // Ссылка на репозиторий игры. Протокол проверяется и здесь, хотя auth уже
  // принимает только http(s): href — единственное место представления, где
  // содержимое поля становится исполняемым (javascript:), и полагаться на
  // одну проверку на другой стороне сети тут не стоит
  _appendRepo(item, url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return;
    }

    const line = document.createElement('div');
    const link = document.createElement('a');

    link.href = url;
    link.textContent = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    line.appendChild(link);
    item.appendChild(line);
  }

  _statusLine(game) {
    const status = STATUS_TITLES[game.status] ?? game.status;
    const date = game.createdAt ? new Date(game.createdAt).toLocaleDateString() : '';

    // у удалённой игры прежний статус — след того, куда её вернёт Restore, —
    // а вести отсчёт человеку нужно от срока полного удаления: только он
    // ограничен во времени
    if (game.deletedAt) {
      const deleted = new Date(game.deletedAt).toLocaleDateString();
      const purge = game.purgeAt ? new Date(game.purgeAt).toLocaleDateString() : '—';

      return `Deleted ${deleted} (was ${status}); removed for good on ${purge}`;
    }

    return date ? `Status: ${status} (submitted ${date})` : `Status: ${status}`;
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

  _button(value, onclick, className) {
    const btn = document.createElement('input');

    btn.type = 'button';
    btn.value = value;
    btn.onclick = onclick;

    if (className) {
      btn.className = className;
    }

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

  // Один и тот же пакет не разбирается дважды: blur поля и клик по «Load»
  // приходят парой (mousedown → blur → click), а каждый разбор стоит мастеру
  // скачанного тарболла и единицы общего лимитера заявок (5/мин на человека)
  _emitLookup() {
    const packageName = this._fields.get('packageName').value.trim();
    const version = this._fields.get('version').value.trim();
    const ref = `${packageName}@${version}`;

    if (!packageName || ref === this._lastLookup) {
      return;
    }

    this._lastLookup = ref;
    this.publisher.emit('lookup', { packageName, version });
  }

  _readForm() {
    const form = {};

    this._fields.forEach((field, name) => {
      form[name] = field.value.trim();
    });

    return form;
  }
}
