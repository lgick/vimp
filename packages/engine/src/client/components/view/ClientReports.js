import Publisher from '../../../lib/Publisher.js';

// Singleton ClientReportsView

let clientReportsView;

// коды отказов мастера/auth — человеческая формулировка живёт здесь, как в
// GamesView. Язык интерфейса — английский, как и в остальном лобби
const ERROR_MESSAGES = {
  unauthorized: 'Please sign in again',
  forbidden: 'Not enough rights',
  network: 'Network unavailable, try again',
  requestFailed: 'Request failed',
  badRequest: 'Bad request',
  unknownReport: 'Report not found',
  authServiceUnavailable: 'Journal service unavailable',
};

// кнопки решения админа: у записи видны все, кроме её текущего статуса
const STATUS_ACTIONS = [
  { status: 'fixed', title: 'Mark fixed' },
  { status: 'ignored', title: 'Ignore' },
  { status: 'open', title: 'Reopen' },
];

const MESSAGE_PREVIEW = 120;

// «5 min ago»: в журнале важнее давность, чем точная дата — она есть в
// развёрнутой части
function timeAgo(iso, now = Date.now()) {
  const time = Date.parse(iso);

  if (Number.isNaN(time)) {
    return '—';
  }

  const minutes = Math.max(0, Math.floor((now - time) / 60000));

  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours} h ago`;
  }

  return `${Math.floor(hours / 24)} d ago`;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Представление журнала клиентских ошибок (plan/client-reports, этап 5).
//
// ***** БЕЗОПАСНОСТЬ *****
//
// Каждое поле отчёта — данные злоумышленника: любой браузер может прислать
// любую строку, а бокс её только режет по длине. Поэтому текст отчёта
// попадает в DOM ТОЛЬКО через textContent — никакого innerHTML, шаблонных
// строк в разметку и insertAdjacentHTML в этом модуле быть не должно
export default class ClientReportsView {
  /**
   * @param {Object} model - ClientReportsModel (источник событий).
   * @param {Object} config - Блок `clientReports` конфига лобби.
   */
  constructor(model, config) {
    if (clientReportsView) {
      return clientReportsView;
    }

    clientReportsView = this;

    const { elems } = config;

    this._config = config;

    this._panel = document.getElementById(elems.panelId);
    this._lobby = document.getElementById(elems.lobbyId);
    this._open = document.getElementById(elems.openBtnId);
    this._close = document.getElementById(elems.closeBtnId);
    this._filters = document.getElementById(elems.filtersId);
    this._gameSelect = document.getElementById(elems.gameSelectId);
    this._list = document.getElementById(elems.listId);
    this._more = document.getElementById(elems.moreBtnId);
    this._error = document.getElementById(elems.errorId);

    // развёрнутые записи переживают перерисовку списка (решение по соседней
    // строке, «Load more»)
    this._expanded = new Set();

    this.publisher = new Publisher();

    this._open.onclick = () => this.publisher.emit('open');
    this._close.onclick = () => this.hide();
    this._more.onclick = () => this.publisher.emit('more');
    this._gameSelect.onchange = () =>
      this.publisher.emit('game', this._gameSelect.value || null);

    this._renderFilters();

    model.publisher.on('changed', 'render', this);
  }

  // кнопку показывает не сама панель, а роль вызывающего (main.js)
  setAdmin(isAdmin) {
    this._open.style.display = isAdmin ? '' : 'none';
  }

  /**
   * Игры фильтра: каталог вкладки. Первая опция («All games») — из разметки.
   * @param {Array<{id: string, title?: string}>} games
   */
  setGames(games) {
    while (this._gameSelect.options.length > 1) {
      this._gameSelect.remove(1);
    }

    (games || []).forEach(({ id, title }) => {
      const option = document.createElement('option');

      option.value = id;
      option.textContent = title ? `${title} (${id})` : id;
      this._gameSelect.appendChild(option);
    });
  }

  // та же механика, что у панели реестра игр: панель занимает место лобби
  show() {
    this._panel.style.display = 'flex';
    this._lobby.style.display = 'none';
  }

  hide() {
    if (this._panel.style.display === 'none') {
      return;
    }

    this._panel.style.display = 'none';
    this._lobby.style.display = 'flex';
  }

  render({ items, total, status, gameId, error }) {
    this._markFilter(status);
    this._gameSelect.value = gameId ?? '';

    this._list.textContent = '';
    (items || []).forEach(report => this._list.appendChild(this._item(report)));

    this._error.textContent = error ? (ERROR_MESSAGES[error] ?? error) : '';
    this._more.style.display = (items || []).length < total ? '' : 'none';
  }

  _item(report) {
    const item = document.createElement('li');
    const summary = document.createElement('div');
    const details = this._details(report);

    item.className = 'reports-item';
    summary.className = 'reports-summary';

    [
      [timeAgo(report.lastSeen), 'reports-when'],
      [`×${report.count}`, 'reports-count'],
      [`${report.kind}/${report.source}`, 'reports-kind'],
      [truncate(String(report.code ?? report.message ?? ''), MESSAGE_PREVIEW), 'reports-message'],
      [report.gameId ? `${report.gameId}@${report.gameVersion ?? '—'}` : '—'],
      [`engine ${report.engineVersion ?? '—'}`],
      [report.box ?? '—'],
      [report.status, `reports-status reports-status-${report.status}`],
    ].forEach(([text, className]) => summary.appendChild(this._span(text, className)));

    details.style.display = this._expanded.has(report.id) ? '' : 'none';
    summary.onclick = () => {
      const open = details.style.display === 'none';

      details.style.display = open ? '' : 'none';

      if (open) {
        this._expanded.add(report.id);
      } else {
        this._expanded.delete(report.id);
      }
    };

    item.appendChild(summary);
    item.appendChild(details);

    return item;
  }

  _details(report) {
    const details = document.createElement('div');

    details.className = 'reports-details';
    details.appendChild(this._line(report.message ?? '', 'reports-full-message'));

    if (report.stack) {
      details.appendChild(this._pre(report.stack));
    }

    if (report.details !== null && report.details !== undefined) {
      details.appendChild(this._pre(JSON.stringify(report.details, null, 2)));
    }

    details.appendChild(this._line(`User agent: ${report.userAgent ?? '—'}`));
    details.appendChild(
      this._line(
        `First seen: ${report.firstSeen ?? '—'}; last seen: ${report.lastSeen ?? '—'}` +
          `; mode: ${report.mode ?? '—'}`,
      ),
    );
    details.appendChild(
      this._line(`Fingerprint: ${String(report.fingerprint ?? '').slice(0, 12)}`),
    );

    if (report.statusAt) {
      details.appendChild(
        this._line(
          `Status ${report.status} by ${report.statusByNick ?? '—'} at ${report.statusAt}` +
            (report.statusNote ? `: ${report.statusNote}` : ''),
        ),
      );
    }

    // заметка едет с каждым решением: поле заполнено текущей, иначе
    // «Reopen» молча стёр бы объяснение прошлого решения
    const note = document.createElement('input');

    note.type = 'text';
    note.className = 'field-text reports-note-input';
    note.placeholder = 'Note';
    note.maxLength = 500;
    note.value = report.statusNote ?? '';
    details.appendChild(note);

    STATUS_ACTIONS.filter(({ status }) => status !== report.status).forEach(
      ({ status, title }) => {
        const btn = document.createElement('input');

        btn.type = 'button';
        btn.value = title;
        btn.className = 'reports-action-btn';
        btn.dataset.status = status;
        btn.onclick = () =>
          this.publisher.emit('set-status', {
            id: report.id,
            status,
            note: note.value.trim() || null,
          });
        details.appendChild(btn);
      },
    );

    return details;
  }

  _renderFilters() {
    this._filterButtons = new Map();

    this._config.statuses.forEach(({ id, title }) => {
      const btn = document.createElement('input');

      btn.type = 'button';
      btn.value = title;
      btn.className = 'games-filter-btn';
      btn.onclick = () => this.publisher.emit('filter', id);
      this._filterButtons.set(id, btn);
      this._filters.appendChild(btn);
    });
  }

  _markFilter(status) {
    this._filterButtons.forEach((btn, id) => {
      btn.classList.toggle('active', id === status);
    });
  }

  _span(text, className) {
    const span = document.createElement('span');

    span.textContent = text;

    if (className) {
      span.className = className;
    }

    return span;
  }

  _line(text, className) {
    const line = document.createElement('div');

    line.textContent = text;

    if (className) {
      line.className = className;
    }

    return line;
  }

  _pre(text) {
    const pre = document.createElement('pre');

    pre.className = 'reports-pre';
    pre.textContent = text;

    return pre;
  }
}
