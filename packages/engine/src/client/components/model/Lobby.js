import Publisher from '../../../lib/Publisher.js';

// Singleton LobbyModel

let lobbyModel;

// Модель лобби: список серверов (реестр мастера), пагинация, поиск и умный
// пинг. Сетевого I/O не делает — публикует события, а controller/main.js
// выполняют fetch REST и сигнальный ping (как остальные модели шлют 'socket').
export default class LobbyModel {
  constructor(params) {
    if (lobbyModel) {
      return lobbyModel;
    }

    lobbyModel = this;

    this._pageSize = params.pageSize;
    this._pingInterval = params.pingInterval;

    this._servers = new Map(); // hostId -> { ...server, latency }
    this._order = []; // hostId в порядке выдачи мастером
    this._total = 0; // всего серверов у мастера (для «Загрузить ещё»)
    this._offset = 0;
    this._search = '';

    this._pingCounter = 0;
    this._pending = new Map(); // pingId -> { hostId, time }
    this._lastPing = new Map(); // hostId -> time последнего пинга
    this._latencies = new Map(); // hostId -> latency (переживает refresh)

    this.publisher = new Publisher();
  }

  // запрашивает первую страницу с текущим поиском (сброс пагинации)
  refresh() {
    this._offset = 0;
    this._emitFetch();
  }

  // задаёт поиск по имени и запрашивает список заново
  setSearch(text) {
    this._search = typeof text === 'string' ? text.trim() : '';
    this._offset = 0;
    this._emitFetch();
  }

  // подгружает следующую страницу
  loadMore() {
    this._offset += this._pageSize;
    this._emitFetch();
  }

  // применяет ответ REST; append=false заменяет список, true — дополняет
  setList({ total, servers } = {}, append = false) {
    if (!append) {
      this._servers.clear();
      this._order = [];
    }

    this._total = total || 0;

    (servers || []).forEach(server => {
      if (!this._servers.has(server.hostId)) {
        this._order.push(server.hostId);
      }

      // latency живёт в _latencies и переживает refresh/пагинацию
      this._servers.set(server.hostId, {
        ...server,
        latency: this._latencies.get(server.hostId) ?? null,
      });
    });

    this._emitList();
  }

  // пользователь выбрал сервер — во внешнего подписчика (P2P-подключение)
  join(hostId) {
    if (this._servers.has(hostId)) {
      this.publisher.emit('join', hostId);
    }
  }

  // готовит пинг видимого сервера; false — если пинговали недавно/сервер ушёл
  pingHost(hostId, now) {
    const last = this._lastPing.get(hostId);

    if (last !== undefined && now - last < this._pingInterval) {
      return false;
    }

    if (!this._servers.has(hostId)) {
      return false;
    }

    this._lastPing.set(hostId, now);
    this._pingCounter = (this._pingCounter + 1) >>> 0;

    const pingId = this._pingCounter;

    this._pending.set(pingId, { hostId, time: now });
    this.publisher.emit('ping-request', { hostId, pingId });

    return true;
  }

  // pong: считает приблизительную задержку, обновляет карточку
  resolvePong(pingId, now) {
    const pending = this._pending.get(pingId);

    if (!pending) {
      return;
    }

    this._pending.delete(pingId);

    const server = this._servers.get(pending.hostId);

    if (!server) {
      return;
    }

    server.latency = Math.round(now - pending.time);
    this._latencies.set(pending.hostId, server.latency);

    this.publisher.emit('ping-update', {
      hostId: pending.hostId,
      latency: server.latency,
    });
  }

  reset() {
    this._servers.clear();
    this._order = [];
    this._total = 0;
    this._offset = 0;
    this._search = '';
    this._pending.clear();
    this._lastPing.clear();
    this._latencies.clear();
  }

  _emitFetch() {
    this.publisher.emit('fetch', {
      offset: this._offset,
      limit: this._pageSize,
      search: this._search,
      append: this._offset > 0,
    });
  }

  _emitList() {
    this.publisher.emit('list', {
      servers: this._order.map(id => this._servers.get(id)),
      hasMore: this._order.length < this._total,
    });
  }
}
