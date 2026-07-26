import Publisher from '../../../lib/Publisher.js';

// Singleton LobbyView

let lobbyView;

// неизвестная задержка сортируется в конец списка
const UNKNOWN_LATENCY = Infinity;

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

    this._cards = new Map(); // hostId -> { card, latencyEl, latency }

    this.publisher = new Publisher();

    const makeObserver =
      observerFactory ||
      (cb => new IntersectionObserver(cb, { root: this._list }));

    // видимая карточка → запрос пинга (hostId в data-атрибуте)
    this._observer = makeObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          this.publisher.emit('visible', entry.target.dataset.hostId);
        }
      });
    });

    this._search.oninput = () => this.publisher.emit('search', this._search.value);
    this._more.onclick = () => this.publisher.emit('more');

    this._mPublic = model.publisher;
    this._mPublic.on('list', 'renderList', this);
    this._mPublic.on('ping-update', 'updatePing', this);
  }

  show() {
    this._lobby.style.display = 'block';
  }

  hide() {
    this._lobby.style.display = 'none';
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
  updatePing({ hostId, latency }) {
    const entry = this._cards.get(hostId);

    if (!entry) {
      return;
    }

    entry.latency = latency;
    entry.latencyEl.textContent = `${latency} ms`;

    this._reorderCard(hostId);
  }

  _appendCard(server) {
    const card = document.createElement('li');

    card.className = 'lobby-card';
    card.dataset.hostId = server.hostId;

    const name = document.createElement('span');

    name.className = 'lobby-card-name';
    name.textContent = server.name;

    const info = document.createElement('span');

    info.className = 'lobby-card-info';
    info.textContent = `${server.mapName} · ${server.currentPlayers}/${server.maxPlayers} · ${server.region}`;

    // рейтинг хостера (server-rating этап 3) — сервер уже отдаёт кэшированное
    // значение в GET /servers, диапазон известен из конфига движка
    const ratingEl = document.createElement('span');

    ratingEl.className = 'lobby-card-rating';
    ratingEl.textContent = server.rating > 0 ? `+${server.rating}` : `${server.rating}`;

    const latencyEl = document.createElement('span');

    latencyEl.className = 'lobby-card-latency';
    latencyEl.textContent =
      server.latency === null ? '…' : `${server.latency} ms`;

    card.appendChild(name);
    card.appendChild(info);
    card.appendChild(ratingEl);
    card.appendChild(latencyEl);

    card.onclick = () => this.publisher.emit('join', server.hostId);

    this._list.appendChild(card);
    this._observer.observe(card);

    this._cards.set(server.hostId, {
      card,
      latencyEl,
      latency: server.latency === null ? UNKNOWN_LATENCY : server.latency,
    });
  }

  // вставляет карточку перед первым соседом с большей задержкой
  _reorderCard(hostId) {
    const entry = this._cards.get(hostId);
    const { card } = entry;

    let before = null;

    for (const sibling of this._list.children) {
      if (sibling === card) {
        continue;
      }

      const other = this._cards.get(sibling.dataset.hostId);

      if (other && other.latency > entry.latency) {
        before = sibling;
        break;
      }
    }

    this._list.insertBefore(card, before);
  }
}
