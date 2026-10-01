import Publisher from '../../../lib/Publisher.js';
import { ENGINE_PROJECT_URL, ENGINE_VERSION } from '../../lib/engineVersion.js';
import { renderProjectLink } from '../../lib/footerLink.js';
import { absoluteLink, formatRoomLink } from '../../lib/roomLink.js';

// Singleton LobbyView

let lobbyView;

// неизвестная задержка сортируется в конец списка
const UNKNOWN_LATENCY = Infinity;

// 'unknown' мастер ставит, когда заголовка региона нет: в карточке это шум
const knownRegion = region =>
  typeof region === 'string' && region !== '' && region !== 'unknown'
    ? region
    : null;

// Представление лобби: рендер списка серверов, поиск, «Загрузить ещё» и
// умный пинг через IntersectionObserver (пинг шлётся только для карточек,
// попавших в видимую область). Observer инъектируется ради тестируемости.

export default class LobbyView {
  constructor(model, elems, observerFactory) {
    if (lobbyView) {
      return lobbyView;
    }

    lobbyView = this;

    this._lobby = document.getElementById(elems.lobbyId);
    this._list = document.getElementById(elems.listId);
    this._search = document.getElementById(elems.searchId);
    this._more = document.getElementById(elems.moreId);
    this._empty = document.getElementById(elems.emptyId);

    // вкладки правой панели (lobby-page-plan)
    this._tabServersBtn = document.getElementById(elems.tabServersBtnId);
    this._tabLeaderboardBtn = document.getElementById(
      elems.tabLeaderboardBtnId,
    );
    this._serversContent = document.getElementById(elems.serversContentId);
    this._leaderboardContent = document.getElementById(
      elems.leaderboardContentId,
    );
    this._leaderboardList = document.getElementById(elems.leaderboardListId);
    this._leaderboardTitle = document.getElementById(elems.leaderboardTitleId);
    this._leaderboardTotal = document.getElementById(elems.leaderboardTotalId);
    this._myPlacement = document.getElementById(elems.myPlacementId);

    // кнопки срезов рейтинга (rank-periods): id периода -> элемент. Кнопки
    // объявлены конфигом, а не захардкожены здесь, чтобы срез можно было
    // убрать или добавить в одном месте
    this._periodBtns = new Map(
      Object.entries(elems.periodBtnIds || {})
        .map(([period, id]) => [period, document.getElementById(id)])
        .filter(([, el]) => el),
    );

    // футер лобби: содержимое статично на всё время жизни вкладки, поэтому
    // пишется здесь, а не через модель и publisher
    const version = document.getElementById(elems.versionId);

    if (version) {
      version.textContent = ENGINE_VERSION;
    }

    renderProjectLink(
      document.getElementById(elems.linkId),
      ENGINE_PROJECT_URL,
    );

    // заголовок игры для "<TITLE> TOP-N" (SVG-ориентир) — задаётся controller'ом
    // при выборе игры (сама модель не хранит title манифеста)
    this._gameTitle = '';

    // N в "TOP-N" (code review lobby-page: настроенный лимит, а не
    // leaderboard.length — иначе заголовок мелькал бы TOP-0 до первого
    // ответа и показывал бы TOP-2 вместо TOP-10, когда ранжировано меньше
    // игроков, чем лимит)
    this._leaderboardLimit = 0;

    // заголовок открытого среза ("<TITLE> TOP-N — TODAY"): подпись, а не
    // источник правды, срез хранит модель
    this._periodTitle = '';

    // ник вызывающего (lobby-page-plan, code review M4-остаток) — задаётся
    // main.js один раз при открытии лобби; используется, чтобы решить,
    // виден ли вызывающий уже в отрисованном топе (по нику, не по числу
    // placement/leaderboard.length — их шкалы расходятся при ничьих на
    // границе LIMIT, см. комментарий в renderLeaderboard)
    this._selfNick = '';

    this._cards = new Map(); // roomId -> { card, latencyEl, latency }

    this.publisher = new Publisher();

    const makeObserver =
      observerFactory ||
      (cb => new IntersectionObserver(cb, { root: this._list }));

    // видимая карточка → запрос пинга (roomId в data-атрибуте)
    this._observer = makeObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          this.publisher.emit('visible', entry.target.dataset.roomId);
        }
      });
    });

    this._search.oninput = () =>
      this.publisher.emit('search', this._search.value);
    this._more.onclick = () => this.publisher.emit('more');

    this._tabServersBtn.onclick = () =>
      this.publisher.emit('show-tab', 'servers');
    this._tabLeaderboardBtn.onclick = () =>
      this.publisher.emit('show-tab', 'leaderboard');

    for (const [period, btn] of this._periodBtns) {
      btn.onclick = () => this.publisher.emit('show-period', period);
    }

    this._mPublic = model.publisher;
    this._mPublic.on('list', 'renderList', this);
    this._mPublic.on('ping-update', 'updatePing', this);
    this._mPublic.on('leaderboard', 'renderLeaderboard', this);
  }

  show() {
    this._lobby.style.display = 'flex';
  }

  hide() {
    this._lobby.style.display = 'none';
  }

  // название активной игры для заголовка Leaderboard ("<TITLE> TOP-N");
  // применится следующим renderLeaderboard (после смены игры main.js тут же
  // запрашивает свежий leaderboard)
  setGameTitle(title) {
    this._gameTitle = title || '';
  }

  // N в "TOP-N" (main.js вызывает один раз из lobbyConfig.leaderboardLimit)
  setLeaderboardLimit(limit) {
    this._leaderboardLimit = limit || 0;
  }

  // ник вызывающего (main.js вызывает один раз при открытии лобби) — по
  // нему решается видимость плашки "You" в renderLeaderboard
  setSelfNick(nick) {
    this._selfNick = nick || '';
  }

  // подсвечивает открытый срез рейтинга и запоминает его подпись
  // (rank-periods). Рисовать список здесь нечем: данные среза приезжают
  // отдельным запросом, и до ответа список чистится моделью
  setPeriod(period, title) {
    this._periodTitle = title || '';

    for (const [id, btn] of this._periodBtns) {
      btn.classList.toggle('active', id === period);
    }
  }

  // переключает вкладки Active Servers / Leaderboard (lobby-page-plan)
  showTab(tab) {
    const showLeaderboard = tab === 'leaderboard';

    this._tabServersBtn.classList.toggle('active', !showLeaderboard);
    this._tabLeaderboardBtn.classList.toggle('active', showLeaderboard);
    this._serversContent.style.display = showLeaderboard ? 'none' : 'flex';
    this._leaderboardContent.style.display = showLeaderboard ? 'flex' : 'none';
  }

  // рендер топ-N + позиции вызывающего (lobby-page-plan)
  renderLeaderboard({ leaderboard, total, myPlacement, loaded = true }) {
    const period = this._periodTitle ? ` — ${this._periodTitle}` : '';

    this._leaderboardTitle.textContent = `${this._gameTitle.toUpperCase()} TOP-${this._leaderboardLimit}${period}`;
    this._leaderboardTotal.textContent = `Total: ${total} players`;

    this._leaderboardList.textContent = '';

    // code review L7 + мелочь из review-status: пока ответ не пришёл
    // (clearLeaderboard уже обнулила список — M1), список пуст, но это не
    // то же самое, что "пусто и ответ уже пришёл" — не показывать заглушку
    // раньше времени
    if (leaderboard.length === 0) {
      const empty = document.createElement('li');

      empty.className = 'lobby-leaderboard-empty';
      empty.textContent = loaded ? 'No ranked players yet' : 'Loading…';
      this._leaderboardList.appendChild(empty);
    }

    // code review M3: номер строки — серверный competition-ranking `place`
    // (RANK() OVER(ORDER BY rank DESC) в UserRepository.getLeaderboard), не
    // index+1 — иначе ничьи по rank давали бы расхождение со строкой "You"
    leaderboard.forEach(entry => {
      const li = document.createElement('li');

      const name = document.createElement('span');

      name.textContent = `${entry.place}. ${entry.nick}`;

      const pts = document.createElement('span');

      pts.textContent = `${entry.rank} pts`;

      li.append(name, pts);
      this._leaderboardList.appendChild(li);
    });

    if (!myPlacement) {
      this._myPlacement.textContent = '';
      this._myPlacement.classList.remove('lobby-placement-gap');
      return;
    }

    if (myPlacement.placement === null) {
      this._myPlacement.textContent = 'Not ranked yet';
      this._myPlacement.classList.remove('lobby-placement-gap');
      return;
    }

    // code review M4 (доработка): видимость плашки решается членством
    // собственного ника в отрисованном списке, а не сравнением
    // myPlacement.placement с leaderboard.length — это разные шкалы
    // (placement — competition ranking с разрывами при ничьих,
    // leaderboard.length — просто число строк после LIMIT) и при ничьих на
    // границе страницы могли разойтись так, что игрок не находил себя ни в
    // списке, ни в плашке. Ники уникальны (users_nick_lower_unique_idx),
    // так что membership по нику однозначен
    const inTop =
      this._selfNick !== '' &&
      leaderboard.some(entry => entry.nick === this._selfNick);

    if (inTop) {
      this._myPlacement.textContent = '';
      this._myPlacement.classList.remove('lobby-placement-gap');
      return;
    }

    const name = document.createElement('span');

    name.textContent = `${myPlacement.placement}. You`;

    const pts = document.createElement('span');

    pts.textContent = `${myPlacement.rank} pts`;

    this._myPlacement.textContent = '';
    this._myPlacement.append(name, pts);
    // разделитель «…» перед плашкой, показанной только вне топа (SVG-ориентир)
    this._myPlacement.classList.add('lobby-placement-gap');
  }

  // полный рендер списка серверов
  renderList({ servers, hasMore }) {
    this._observer.disconnect();
    this._cards.clear();
    this._list.textContent = '';

    servers.forEach(server => this._appendCard(server));

    this._empty.style.display = servers.length === 0 ? 'block' : 'none';
    this._more.style.display = hasMore ? 'block' : 'none';
  }

  // обновляет задержку карточки и переставляет её по возрастанию latency
  updatePing({ roomId, latency }) {
    const entry = this._cards.get(roomId);

    if (!entry) {
      return;
    }

    entry.latency = latency;
    entry.latencyEl.textContent = `${latency} ms`;

    this._reorderCard(roomId);
  }

  _appendCard(server) {
    const card = document.createElement('li');

    card.className = 'lobby-card';
    card.dataset.roomId = server.roomId;

    const name = document.createElement('span');

    name.className = 'lobby-card-name';
    // формат "gameId/roomId": серверный поиск понимает ровно то, что видно
    // на карточке; gameId nullable для хостов до Этапа 6.4 (code review L6)
    name.textContent = `${server.gameId ?? '?'}/${server.roomId}`;

    const info = document.createElement('span');

    info.className = 'lobby-card-info';
    // пустые сегменты не выводятся: строку карточки игра может не задавать
    // (gameConfig.lobbyInfo), а регион мастер не знает без заголовка CDN
    info.textContent = [
      server.info,
      `${server.currentPlayers}/${server.maxPlayers}`,
      knownRegion(server.region),
    ]
      .filter(Boolean)
      .join(' · ');

    const latencyEl = document.createElement('span');

    latencyEl.className = 'lobby-card-latency';
    latencyEl.textContent =
      server.latency === null ? '…' : `${server.latency} ms`;

    card.appendChild(name);

    // прямая ссылка на комнату (host-migration, этап 3); без gameId (хост до
    // Этапа 6.4) ссылку не собрать
    if (server.gameId) {
      card.appendChild(this._copyLinkButton(server));
    }

    card.appendChild(info);
    card.appendChild(latencyEl);

    card.onclick = () => this.publisher.emit('join', server.roomId);

    this._list.appendChild(card);
    this._observer.observe(card);

    this._cards.set(server.roomId, {
      card,
      latencyEl,
      latency: server.latency === null ? UNKNOWN_LATENCY : server.latency,
    });
  }

  // вставляет карточку перед первым соседом с большей задержкой
  // «Copy link» карточки: клик не должен всплыть до карточки (вход в комнату)
  _copyLinkButton(server) {
    const btn = document.createElement('input');
    const label = 'Copy link';

    btn.type = 'button';
    btn.className = 'lobby-card-copy';
    btn.value = label;
    btn.onclick = event => {
      event.stopPropagation();

      const link = absoluteLink(formatRoomLink(server.gameId, server.roomId));
      const feedback = text => {
        btn.value = text;
        setTimeout(() => {
          btn.value = label;
        }, 1500);
      };

      Promise.resolve()
        .then(() => navigator.clipboard.writeText(link))
        .then(
          () => feedback('Copied'),
          () => feedback('Copy failed'),
        );
    };

    return btn;
  }

  _reorderCard(roomId) {
    const entry = this._cards.get(roomId);
    const { card } = entry;

    let before = null;

    for (const sibling of this._list.children) {
      if (sibling === card) {
        continue;
      }

      const other = this._cards.get(sibling.dataset.roomId);

      if (other && other.latency > entry.latency) {
        before = sibling;
        break;
      }
    }

    this._list.insertBefore(card, before);
  }
}
