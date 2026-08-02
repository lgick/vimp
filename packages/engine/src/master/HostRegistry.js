import { v4 as uuidv4 } from 'uuid';
import { sanitizeMessage } from '../lib/sanitizers.js';

// приводит значение к целому в диапазоне [min, max] или возвращает fallback
const toInt = (value, fallback, min, max) => {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(num), min), max);
};

// Реестр активных комнат (браузерных хостов) мастер-сервера.
// Единственный источник истины для GET /servers и сигналинга.
export default class HostRegistry {
  constructor(options = {}) {
    this._regionThreshold = options.regionThreshold ?? 15;
    this._defaultLimit = options.defaultLimit ?? 10;
    this._maxLimit = options.maxLimit ?? 50;
    this._maxNameLength = options.maxNameLength ?? 30;
    this._maxPlayersLimit = options.maxPlayersLimit ?? 8;

    this._hosts = new Map(); // hostId -> HostSession
  }

  get size() {
    return this._hosts.size;
  }

  // регистрирует комнату; null — если с этого IP комната уже создана.
  // hosterUserId — идентичность хостера из его identity-токена
  // (server-rating этап 2): атрибуция голосов /like·/unlike и (этап 4)
  // аннулирования rank/skills; блокировку хостера по рейтингу проверяет
  // вызывающий (SignalingServer) до add(), т.к. это асинхронный запрос к auth
  add({ name, maxPlayers, mapName, region, ip, gameId, gameVersion, hosterUserId }, now = Date.now()) {
    if (this.getByIp(ip)) {
      return null;
    }

    const hostId = uuidv4();
    // per-room секрет (server-rating кодревью №1, доработка): возвращается
    // только регистрирующей сессии в host_registered и служит доказательством
    // владения комнатой при атрибуции rank/state (verifiedAttribution). Живёт
    // ровно столько, сколько запись комнаты — как остальное её состояние
    const secret = uuidv4();

    const session = {
      hostId,
      secret,
      name: this._sanitizeName(name) || 'unnamed',
      maxPlayers: toInt(maxPlayers, this._maxPlayersLimit, 1, this._maxPlayersLimit),
      currentPlayers: 0,
      mapName: sanitizeMessage(mapName) || 'unknown',
      region: sanitizeMessage(region) || 'unknown',
      // какую игру и версию её манифеста хост поднял (Этап 6.2 плана
      // отделения) — задел под фильтр по игре в лобби (6.3) и per-game
      // сверку версий при эстафете (6.5); хосты до Этапа 6.4 (статическая
      // композиция) их не присылают — null
      gameId: gameId ?? null,
      gameVersion: gameVersion ?? null,
      hosterUserId: hosterUserId ?? null,
      // рейтинг хостера, закэшированный из auth (server-rating этап 3):
      // выставляется SignalingServer сразу после add() и обновляется по
      // голосам/таймеру — GET /servers не ходит в БД на каждый запрос
      rating: 0,
      ip,
      status: 'online',
      lastSeen: now,
    };

    this._hosts.set(hostId, session);

    return session;
  }

  get(hostId) {
    return this._hosts.get(hostId);
  }

  getByIp(ip) {
    for (const host of this._hosts.values()) {
      if (host.ip === ip) {
        return host;
      }
    }

    return undefined;
  }

  remove(hostId) {
    return this._hosts.delete(hostId);
  }

  // обновляет закэшированный рейтинг одной комнаты (server-rating этап 3) —
  // после регистрации хоста и после каждого голоса
  setRating(hostId, rating) {
    const host = this._hosts.get(hostId);

    if (host) {
      host.rating = rating;
    }
  }

  // обновляет рейтинг во всех активных комнатах данного хостера (обычно одна,
  // но технически хостер может держать несколько с разных IP) — используется
  // периодическим опросом auth, где известен только hosterUserId
  setRatingForHoster(hosterUserId, rating) {
    for (const host of this._hosts.values()) {
      if (host.hosterUserId === hosterUserId) {
        host.rating = rating;
      }
    }
  }

  // атрибуция записи rank/state к комнате (server-rating кодревью №1,
  // доработка): возвращает { hosterUserId, sessionId } только если секрет из
  // тела PUT совпал с секретом комнаты — доказательство, что запрашивающий
  // владеет hostId, а не подставил чужой (публичный) hostId из GET /servers.
  // Секрет 122-битный (uuidv4), поэтому подбор нереален и простого === хватает
  // (тайминг-атака нерелевантна). Иначе — {} (атрибуции нет, событие без хостера)
  verifiedAttribution(hostId, secret) {
    const host = typeof hostId === 'string' ? this._hosts.get(hostId) : undefined;

    return host && host.hosterUserId !== null && host.secret === secret
      ? { hosterUserId: host.hosterUserId, sessionId: host.hostId }
      : {};
  }

  // hostId всех активных комнат данного хостера — эвакуация при глобальном
  // блоке (server-rating кодревью №2): обычно одна, но хостер технически
  // может держать несколько комнат с разных IP
  getHostIdsForHoster(hosterUserId) {
    const ids = [];

    for (const host of this._hosts.values()) {
      if (host.hosterUserId === hosterUserId) {
        ids.push(host.hostId);
      }
    }

    return ids;
  }

  // уникальные hosterUserId активных комнат — чтобы периодически опросить
  // auth за актуальным рейтингом каждого (server-rating этап 3)
  getHosterUserIds() {
    const ids = new Set();

    for (const host of this._hosts.values()) {
      if (host.hosterUserId !== null) {
        ids.add(host.hosterUserId);
      }
    }

    return ids;
  }

  // обновляет состояние комнаты; любое обновление — heartbeat
  update(hostId, { currentPlayers, mapName } = {}, now = Date.now()) {
    const host = this._hosts.get(hostId);

    if (!host) {
      return false;
    }

    host.lastSeen = now;

    if (currentPlayers !== undefined) {
      host.currentPlayers = toInt(
        currentPlayers,
        host.currentPlayers,
        0,
        host.maxPlayers,
      );
    }

    if (typeof mapName === 'string' && mapName !== '') {
      host.mapName = sanitizeMessage(mapName);
    }

    return true;
  }

  // удаляет комнаты без heartbeat дольше timeout; возвращает удалённые id
  sweepStale(timeout, now = Date.now()) {
    const removed = [];

    for (const [hostId, host] of this._hosts) {
      if (now - host.lastSeen >= timeout) {
        this._hosts.delete(hostId);
        removed.push(hostId);
      }
    }

    return removed;
  }

  // список серверов; приоритет: поиск > малый реестр целиком > регион + срез
  getList({ offset, limit, region, search } = {}) {
    const online = [...this._hosts.values()].filter(
      host => host.status === 'online',
    );

    // прямой поиск по имени (или "gameId/name" — lobby-page-plan, формат
    // карточки в лобби) игнорирует регионы и пагинацию
    if (typeof search === 'string' && search.trim() !== '') {
      const needle = search.trim().toLowerCase();
      const slashAt = needle.indexOf('/');

      const found =
        slashAt === -1
          ? online.filter(host => host.name.toLowerCase().includes(needle))
          : online.filter(host => {
              const gamePart = needle.slice(0, slashAt);
              const namePart = needle.slice(slashAt + 1);

              return (
                (host.gameId ?? '').toLowerCase().includes(gamePart) &&
                host.name.toLowerCase().includes(namePart)
              );
            });

      return { total: found.length, servers: found.map(this._toPublic) };
    }

    // серверов мало — региональный фильтр и пагинация не нужны
    if (online.length <= this._regionThreshold) {
      return { total: online.length, servers: online.map(this._toPublic) };
    }

    const filtered =
      typeof region === 'string' && region !== ''
        ? online.filter(host => host.region === region)
        : online;

    const off = toInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const lim = toInt(limit, this._defaultLimit, 1, this._maxLimit);

    return {
      total: filtered.length,
      servers: filtered.slice(off, off + lim).map(this._toPublic),
    };
  }

  // публичное представление комнаты (без ip и служебных полей)
  _toPublic({ hostId, name, mapName, currentPlayers, maxPlayers, region, gameId, rating }) {
    return { hostId, name, mapName, currentPlayers, maxPlayers, region, gameId, rating };
  }

  _sanitizeName(name) {
    return sanitizeMessage(name).trim().slice(0, this._maxNameLength).trim();
  }
}
