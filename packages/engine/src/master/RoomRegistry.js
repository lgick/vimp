import crypto from 'crypto';
import { generateRoomId } from '../lib/roomId.js';
import { sanitizeRoomSettings } from '../lib/roomSettings.js';
import { sanitizeMessage } from '../lib/sanitizers.js';
import { deriveRoomSecret, verifyRoomSecret } from './roomSecret.js';

// приводит значение к целому в диапазоне [min, max] или возвращает fallback
const toInt = (value, fallback, min, max) => {
  const num = Number(value);

  if (!Number.isFinite(num)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(num), min), max);
};

const ICE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
const MAX_FPS = 1000;
const MAX_GAME_VERSION = 64;

// версию игры комнаты актуализирует хост новой эпохи и вернувшийся хост:
// эстафета Worker'ов могла поднять матч на новой версии, а бета сверяет с
// ней точку. Мусор — версия не трогается; hidden не пересчитывается
function setGameVersion(room, gameVersion) {
  if (
    typeof gameVersion === 'string' &&
    gameVersion !== '' &&
    gameVersion.length <= MAX_GAME_VERSION
  ) {
    room.gameVersion = gameVersion;
  }
}

/**
 * Возможности участника (host-migration этап 6) из недоверенного сообщения:
 * только известные поля и типы, остальное отбрасывается.
 * @param {*} caps
 * @returns {{ canHost: boolean, mobile: boolean, hidden: boolean,
 *   iceType: string|null, fps: number|null }}
 */
export function sanitizeCaps(caps) {
  const source = caps && typeof caps === 'object' ? caps : {};

  return {
    canHost: source.canHost === true,
    mobile: source.mobile === true,
    hidden: source.hidden === true,
    iceType: ICE_TYPES.has(source.iceType) ? source.iceType : null,
    // FPS рендера гостя (этап 9c); нет или мусор — неизвестен
    fps:
      Number.isFinite(source.fps) && source.fps >= 0 && source.fps <= MAX_FPS
        ? Math.round(source.fps)
        : null,
  };
}

// Реестр комнат мастер-сервера (host-migration, этап 2). Единственный
// источник истины для GET /servers и сигналинга. Комната — не вкладка хоста:
// у неё стабильный roomId, номер эпохи хоста и список участников, и живёт она,
// пока в ней есть участник.
export default class RoomRegistry {
  constructor(options = {}) {
    this._regionThreshold = options.regionThreshold ?? 15;
    this._defaultLimit = options.defaultLimit ?? 10;
    this._maxLimit = options.maxLimit ?? 50;
    // потолок вместимости комнаты задаёт игра, не движок: резолвер
    // возвращает roomDefaults.maxPlayers манифеста по gameId (мастер берёт
    // его из GameCatalog — того же источника, что и лобби). maxPlayersLimit
    // остаётся только санитарной рамкой для комнаты, чья игра неизвестна
    // (gameId: null у хостов до статической композиции или незнакомый id)
    this._gameMaxPlayers = options.gameMaxPlayers ?? null;
    this._maxPlayersLimit = options.maxPlayersLimit ?? 8;
    // потолок строки карточки лобби (её текст задаёт игра хоста)
    this._maxInfoLength = options.maxInfoLength ?? 48;

    // ключ HMAC секрета комнаты (config/env.js → VIMP_ROOM_SECRET_KEY)
    this._secretKey = options.secretKey ?? crypto.randomBytes(32);
    this._randomBytes = options.randomBytes ?? crypto.randomBytes;

    this._heartbeatTimeout = options.heartbeatTimeout ?? 30000;
    // отсоединённый участник ещё считается в комнате (реконнект сигналинга)
    this._memberGraceMs = options.memberGraceMs ?? 15000;
    // хост, чей сигналинг закрылся, успевает вернуться reclaim_host
    this._hostReclaimGraceMs = options.hostReclaimGraceMs ?? 10000;

    this._rooms = new Map(); // roomId -> Room
    // индексы (ревью F16): регистрация хоста и закрытие WS не проходят по
    // всем комнатам. IP хоста -> roomId его комнат (обычно одна: add/restore
    // её гарантируют, а смена хоста — нет); sessionId -> ключи участников
    // "roomId\u0000memberId", привязанных к этой сессии
    this._hostIpIndex = new Map();
    this._sessionIndex = new Map();
  }

  get size() {
    return this._rooms.size;
  }

  // создаёт комнату с новым roomId; null — если с этого IP уже хостится
  // другая комната. host — { sessionId, memberId, userId, nick }: userId
  // взят вызывающим (SignalingServer) из проверенного identity-токена
  add(fields, now = Date.now()) {
    if (this.getByIp(fields.ip)) {
      return null;
    }

    let roomId;

    // коллизия 8 символов base32 на живом реестре практически невозможна,
    // но повтор дешевле, чем отдать одну комнату двум хостам
    do {
      roomId = generateRoomId(this._randomBytes);
    } while (this._rooms.has(roomId));

    return this._create(roomId, 1, fields, now);
  }

  // восстанавливает комнату с известными roomId/epoch (reclaim_host после
  // рестарта мастера: реестр в памяти пуст, а секрет хоста уже проверен).
  // null — id занят или IP хостит другую комнату
  restore(roomId, epoch, fields, now = Date.now()) {
    if (this._rooms.has(roomId) || this.getByIp(fields.ip)) {
      return null;
    }

    return this._create(roomId, epoch, fields, now);
  }

  _create(
    roomId,
    epoch,
    {
      maxPlayers,
      info,
      region,
      ip,
      gameId,
      gameVersion,
      hidden,
      settings,
      host,
    },
    now,
  ) {
    const ceiling = this._ceilingFor(gameId);

    const room = {
      roomId,
      epoch,
      // 'online' | 'migrating' (этап 7) | 'handing_off' (этап 8)
      status: 'online',
      // миграция (этап 7, MigrationCoordinator): эпоха, которую займёт
      // преемник, и описание текущей попытки промоушена
      pendingEpoch: null,
      migration: null,
      // последняя принудительная (по отчётам/пробе) миграция — анти-флаппинг
      lastForcedMigrationAt: null,
      // автотриггеры (этап 9c): последняя успешная авто-смена хоста
      // (overload/hidden/network) — общий кулдаун правила лага; с какого
      // момента текущий хост в роли; окно лага хоста ({ since, lastAt })
      lastAutoMigrationAt: null,
      // последняя сорванная передача по правилу лага — его кулдаун
      lastLagHandoffFailedAt: null,
      // голосование «Change host» (этап 10): userId -> до какого момента он
      // ни преемник, ни хост комнаты (переживает перезагрузку вкладки), и
      // эпоха, хоста которой сняли голосованием (его передача — причина vote)
      demotedUsers: new Map(),
      votedOutEpoch: null,
      hostSince: now,
      lag: null,
      // отчёты host_unreachable: userId -> время последнего (кворум — по
      // аккаунтам, не по вкладкам)
      reports: new Map(),
      // когда хост последний раз прислал room_peers (подключённые по WebRTC
      // участники); null — отчётов нет (хост старше их), и подтверждёнными
      // считаются все
      peersReportedAt: null,
      // memberId из последнего room_peers этой эпохи: отчёт обычно
      // опережает join_room нового гостя (тот шлёт его после входа в матч),
      // и подтверждение не должно ждать следующего отчёта
      reportedPeerIds: new Set(),
      maxPlayers: toInt(maxPlayers, ceiling, 1, ceiling),
      // строка карточки лобби (gameConfig.lobbyInfo игры): null — игра её
      // не задаёт, и карточка ничего не показывает
      info: this._sanitizeInfo(info),
      region: sanitizeMessage(region) || 'unknown',
      // какую игру и версию её манифеста хост поднял; хосты до статической
      // композиции их не присылают — null
      gameId: gameId ?? null,
      gameVersion: gameVersion ?? null,
      // комната на застейдженной версии игры (master-game-registry, этап
      // 3.5): админ тестирует новую версию, и его комната не должна
      // появляться в общем списке. Флаг считает SignalingServer по
      // gameVersion (хеш бандла), сверяя его с каталогом
      hidden: hidden === true,
      // настройки комнаты для холодного перезапуска (этап 7.6); в
      // публичное представление не попадают
      settings: sanitizeRoomSettings(settings),
      createdAt: now,
      lastSeen: now, // heartbeat хоста
      // текущий хост; секрет не хранится — deriveRoomSecret(roomId, epoch,
      // host.userId)
      host: {
        sessionId: host.sessionId,
        memberId: host.memberId,
        userId: host.userId ?? null,
        ip,
        detachedAt: null,
      },
      members: new Map(),
      // преемник (host-migration этап 6): memberId беты, кандидат на её
      // замену ({ memberId, since } — гистерезис) и свежесть её точки
      // ({ memberId, checkpointId, createdAt, receivedAt } из standby_status;
      // receivedAt — когда бета получила точку, по часам мастера)
      successorMemberId: null,
      successorChallenger: null,
      standby: null,
    };

    this._rooms.set(roomId, room);
    this._indexHostIp(room);
    // хост — участник своей комнаты
    this.joinMember(roomId, host, now);

    return room;
  }

  // верхняя граница вместимости комнаты: манифест игры, а при неизвестной
  // игре (или манифесте без вменяемого roomDefaults.maxPlayers) —
  // санитарный дефолт мастера
  _ceilingFor(gameId) {
    const declared =
      gameId === null || gameId === undefined
        ? undefined
        : this._gameMaxPlayers?.(gameId);
    const num = Number(declared);

    return Number.isFinite(num) && num >= 1
      ? Math.trunc(num)
      : this._maxPlayersLimit;
  }

  // все комнаты (плановый пересчёт преемников)
  *rooms() {
    yield* this._rooms.values();
  }

  get(roomId) {
    return typeof roomId === 'string' ? this._rooms.get(roomId) : undefined;
  }

  // комната, которую хостит этот IP (лимит «одна комната на IP»)
  getByIp(ip) {
    const roomIds = this._hostIpIndex.get(ip);

    if (!roomIds) {
      return undefined;
    }

    if (roomIds.size === 1) {
      return this._rooms.get(roomIds.values().next().value);
    }

    // редкий случай (преемник с IP другого хоста): первая по реестру, как
    // при полном проходе
    for (const room of this._rooms.values()) {
      if (roomIds.has(room.roomId)) {
        return room;
      }
    }

    return undefined;
  }

  remove(roomId) {
    const room = this._rooms.get(roomId);

    if (!room) {
      return false;
    }

    this._deleteRoom(room);

    return true;
  }

  _deleteRoom(room) {
    for (const member of room.members.values()) {
      this._unindexMember(room.roomId, member);
    }

    this._unindexHostIp(room);
    this._rooms.delete(room.roomId);
  }

  _indexHostIp(room) {
    const roomIds = this._hostIpIndex.get(room.host.ip);

    if (roomIds) {
      roomIds.add(room.roomId);
    } else {
      this._hostIpIndex.set(room.host.ip, new Set([room.roomId]));
    }
  }

  _unindexHostIp(room) {
    const roomIds = this._hostIpIndex.get(room.host.ip);

    if (roomIds?.delete(room.roomId) && roomIds.size === 0) {
      this._hostIpIndex.delete(room.host.ip);
    }
  }

  _indexMember(roomId, member) {
    if (member.sessionId === null) {
      return;
    }

    const key = `${roomId}\u0000${member.memberId}`;
    const keys = this._sessionIndex.get(member.sessionId);

    if (keys) {
      keys.add(key);
    } else {
      this._sessionIndex.set(member.sessionId, new Set([key]));
    }
  }

  _unindexMember(roomId, member) {
    if (member.sessionId === null) {
      return;
    }

    const keys = this._sessionIndex.get(member.sessionId);

    if (keys?.delete(`${roomId}\u0000${member.memberId}`) && keys.size === 0) {
      this._sessionIndex.delete(member.sessionId);
    }
  }

  _deleteMember(room, memberId) {
    const member = room.members.get(memberId);

    if (!member) {
      return false;
    }

    this._unindexMember(room.roomId, member);
    // отчёт описывал прежнее членство: повторный вход ждёт нового отчёта
    room.reportedPeerIds.delete(memberId);

    return room.members.delete(memberId);
  }

  // секрет текущей эпохи — уходит только хосту в host_registered
  roomSecret(room) {
    return deriveRoomSecret(this._secretKey, {
      roomId: room.roomId,
      epoch: room.epoch,
      userId: room.host.userId,
    });
  }

  // проверка секрета без обращения к реестру: годится и для комнаты, которой
  // после рестарта мастера ещё нет
  verifySecret(secret, { roomId, epoch, userId }) {
    return verifyRoomSecret(this._secretKey, secret, {
      roomId,
      epoch,
      userId,
    });
  }

  // атрибуция записи rank/state к комнате: { sessionId: roomId } только если
  // секрет из тела PUT — секрет текущей эпохи комнаты. Это доказательство,
  // что запрашивающий хостит комнату, а не подставил чужой (публичный)
  // roomId из GET /servers. Проверенная комната — ключ per-room rate-limit
  // записей и session_id в auth. Иначе — {} (запись без комнаты)
  verifiedAttribution(roomId, secret) {
    const room = this.get(roomId);

    if (
      room &&
      this.verifySecret(secret, {
        roomId: room.roomId,
        epoch: room.epoch,
        userId: room.host.userId,
      })
    ) {
      return { sessionId: room.roomId };
    }

    return {};
  }

  // хост вернулся (reclaim_host): перепривязать сессию, снять отсоединение
  attachHost(
    roomId,
    { sessionId, memberId, ip, gameVersion },
    now = Date.now(),
  ) {
    const room = this._rooms.get(roomId);

    if (!room) {
      return null;
    }

    const previous = room.members.get(room.host.memberId);

    // memberId — id вкладки; reclaim из той же вкладки его не меняет, но
    // старая запись не должна остаться висеть, если он всё же другой
    if (previous && room.host.memberId !== memberId) {
      this._deleteMember(room, room.host.memberId);
    }

    this._unindexHostIp(room);
    room.host.sessionId = sessionId;
    room.host.memberId = memberId;
    room.host.ip = ip;
    this._indexHostIp(room);
    room.host.detachedAt = null;
    room.lastSeen = now;
    setGameVersion(room, gameVersion);

    this.joinMember(
      roomId,
      {
        memberId,
        userId: room.host.userId,
        nick: previous?.nick ?? null,
        sessionId,
      },
      now,
    );

    return room;
  }

  // сигналинг хоста закрылся: комната ждёт reclaim_host hostReclaimGraceMs
  detachHost(roomId, now = Date.now()) {
    const room = this._rooms.get(roomId);

    if (room) {
      room.host.sessionId = null;
      room.host.detachedAt = now;
    }
  }

  // преемник занял комнату (этап 7): новый хост новой эпохи. Бета
  // назначается заново — прежняя теперь хост. previousMemberId — запись
  // участника-преемника до перезагрузки страницы (холодный промоушен меняет
  // memberId вкладки), она удаляется
  promoteHost(
    roomId,
    {
      epoch,
      sessionId,
      memberId,
      userId,
      nick,
      ip,
      caps,
      previousMemberId,
      gameVersion,
    },
    now = Date.now(),
  ) {
    const room = this._rooms.get(roomId);

    if (!room) {
      return null;
    }

    if (previousMemberId && previousMemberId !== memberId) {
      this._deleteMember(room, previousMemberId);
    }

    this._unindexHostIp(room);

    room.epoch = epoch;
    room.status = 'online';
    room.pendingEpoch = null;
    room.migration = null;
    room.reports.clear();
    room.host = {
      sessionId,
      memberId,
      userId: userId ?? null,
      ip,
      detachedAt: null,
    };
    this._indexHostIp(room);
    room.lastSeen = now;
    room.hostSince = now;
    room.lag = null;
    room.successorMemberId = null;
    room.successorChallenger = null;
    room.standby = null;
    // к новому хосту пиры подключаются заново — он пришлёт свой room_peers
    room.peersReportedAt = null;
    room.reportedPeerIds = new Set();

    for (const member of room.members.values()) {
      member.peerConfirmed = false;
    }

    setGameVersion(room, gameVersion);

    this.joinMember(roomId, { memberId, userId, nick, sessionId, caps }, now);

    return room;
  }

  // настройки комнаты обновились (register_host преемника, reclaim_host);
  // undefined — не трогать
  setSettings(roomId, settings) {
    const room = this._rooms.get(roomId);

    if (room && settings !== undefined) {
      room.settings = sanitizeRoomSettings(settings);
    }
  }

  // добавляет участника или перепривязывает его (тот же memberId после
  // реконнекта сигналинга)
  joinMember(
    roomId,
    { memberId, userId, nick, sessionId, caps },
    now = Date.now(),
  ) {
    const room = this._rooms.get(roomId);

    if (!room) {
      return null;
    }

    const existing = room.members.get(memberId);
    const member = {
      memberId,
      userId: userId ?? null,
      nick: nick ?? null,
      sessionId: sessionId ?? null,
      joinedAt: existing?.joinedAt ?? now,
      detachedAt: null,
      caps: caps === undefined ? (existing?.caps ?? {}) : sanitizeCaps(caps),
      // смещён голосованием (этап 10) — до этого момента не кандидат в беты;
      // отметка — по пользователю, а не по вкладке
      demotedUntil: room.demotedUsers.get(userId) ?? null,
      // к хосту-ему не смогли подключиться (этап 7) — ярус relay до конца
      // членства
      relayPenalty: existing?.relayPenalty ?? false,
      // хост подтвердил WebRTC-соединение с ним (room_peers)
      // (или был в его отчёте ещё до join_room)
      peerConfirmed:
        existing?.peerConfirmed ?? room.reportedPeerIds.has(memberId),
    };

    if (existing) {
      this._unindexMember(roomId, existing);
    }

    room.members.set(memberId, member);
    this._indexMember(roomId, member);

    return member;
  }

  // WS участника закрылся: он ещё в комнате memberGraceMs (реконнект)
  detachMember(sessionId, now = Date.now()) {
    const keys = this._sessionIndex.get(sessionId);

    if (!keys) {
      return;
    }

    this._sessionIndex.delete(sessionId);

    for (const key of keys) {
      const split = key.indexOf('\u0000');
      const member = this._rooms
        .get(key.slice(0, split))
        ?.members.get(key.slice(split + 1));

      // запись могли удалить мимо реестра — сверка по самой сессии
      if (member?.sessionId === sessionId) {
        member.sessionId = null;
        member.detachedAt = now;
      }
    }
  }

  // возможности участника изменились (member_update: вкладка спрятана,
  // сменился тип ICE-кандидата)
  setMemberCaps(roomId, memberId, caps) {
    const member = this._rooms.get(roomId)?.members.get(memberId);

    if (!member) {
      return null;
    }

    member.caps = sanitizeCaps(caps);

    return member;
  }

  // отчёт хоста room_peers: участники с открытыми каналами к нему. Остальные
  // — самозаявленные (сигнальная сессия без пира) и не считаются игроками
  setConfirmedPeers(roomId, memberIds, now = Date.now()) {
    const room = this._rooms.get(roomId);

    if (!room) {
      return;
    }

    const confirmed = new Set(memberIds);

    room.peersReportedAt = now;
    room.reportedPeerIds = confirmed;

    for (const member of room.members.values()) {
      member.peerConfirmed = confirmed.has(member.memberId);
    }
  }

  // участник подтверждён хостом; без отчётов (хост старше room_peers) —
  // все, как раньше
  isConfirmed(room, member) {
    return (
      room.peersReportedAt === null ||
      member.memberId === room.host.memberId ||
      member.peerConfirmed === true
    );
  }

  // участник ушёл сам — без grace
  leaveMember(roomId, memberId) {
    const room = this._rooms.get(roomId);

    return room ? this._deleteMember(room, memberId) : false;
  }

  _isLive(member, now) {
    return (
      member.sessionId !== null || now - member.detachedAt < this._memberGraceMs
    );
  }

  // участники, которые сейчас в комнате (подключены или в grace)
  liveMembers(roomId, now = Date.now()) {
    const room = this._rooms.get(roomId);

    return room
      ? [...room.members.values()].filter(member => this._isLive(member, now))
      : [];
  }

  // heartbeat хоста; info актуализирует строку карточки (null очищает,
  // undefined оставляет как есть)
  update(roomId, { info } = {}, now = Date.now()) {
    const room = this._rooms.get(roomId);

    if (!room) {
      return false;
    }

    room.lastSeen = now;

    if (info !== undefined) {
      room.info = this._sanitizeInfo(info);
    }

    return true;
  }

  // уборка: (а) участник отсоединён дольше memberGraceMs — удаляется;
  // (б) комната без участников (кроме мигрирующей) удаляется; (в) хост
  // online-комнаты потерян — нет heartbeat дольше heartbeatTimeout или
  // отсоединён дольше hostReclaimGraceMs (обрыв WS хоста запускает миграцию
  // сразу, а если повысить было некого — комната ждёт reclaim_host).
  // Комната с потерянным хостом не закрывается — её мигрирует
  // MigrationCoordinator (этап 7); комнаты в миграции он ведёт сам.
  // Возвращает комнаты с потерянным хостом и id удалённых пустых
  sweep(now = Date.now()) {
    const lost = [];
    const removed = [];

    for (const [roomId, room] of this._rooms) {
      for (const [memberId, member] of room.members) {
        if (!this._isLive(member, now)) {
          this._deleteMember(room, memberId);
        }
      }

      // отметки голосования (этап 10) живут до срока — иначе копятся
      for (const [userId, until] of room.demotedUsers) {
        if (until <= now) {
          room.demotedUsers.delete(userId);
        }
      }

      // мигрирующую комнату не удалять, даже опустевшую: единственный
      // кандидат может перезагружать страницу (cold) дольше memberGraceMs.
      // Её закроет MigrationCoordinator по дедлайну промоушена
      if (room.members.size === 0 && room.status !== 'migrating') {
        this._deleteRoom(room);
        removed.push(roomId);
        continue;
      }

      const { host } = room;
      const hostLost =
        host.sessionId === null
          ? now - host.detachedAt >= this._hostReclaimGraceMs
          : now - room.lastSeen >= this._heartbeatTimeout;

      // плановая передача (этап 8) с молчащим хостом — тоже потеря: она
      // становится аварийной миграцией
      if (hostLost && room.status !== 'migrating') {
        lost.push(room);
      }
    }

    return { lost, removed };
  }

  // список комнат; приоритет: поиск > малый реестр целиком > регион + срез.
  // includeHidden показывает и тестовые комнаты застейдженных версий — его
  // ставит только админский вызов. Сравнение строгое (=== true) намеренно:
  // lobby.js передаёт сюда req.query как есть, а из строки запроса булев
  // true не приходит никогда. now — вторым аргументом, не из query
  getList(
    { offset, limit, region, search, includeHidden } = {},
    now = Date.now(),
  ) {
    // комната в миграции или с отсоединённым хостом (этап 7.0) не
    // выдаётся: вход в неё упрётся в unknownRoom, а быстрая игра выбрала бы
    // её снова и снова
    const visible = [...this._rooms.values()].filter(
      room =>
        (includeHidden === true || !room.hidden) &&
        room.status === 'online' &&
        room.host.sessionId !== null,
    );
    const toPublic = room => this._toPublic(room, now);

    // прямой поиск игнорирует регионы и пагинацию: префикс roomId, подстрока
    // gameId или строки карточки, либо "gameId/<префикс roomId>" — формат карточки
    if (typeof search === 'string' && search.trim() !== '') {
      const needle = search.trim().toLowerCase();
      const slashAt = needle.indexOf('/');

      const found =
        slashAt === -1
          ? visible.filter(
              room =>
                room.roomId.startsWith(needle) ||
                (room.gameId ?? '').toLowerCase().includes(needle) ||
                (room.info ?? '').toLowerCase().includes(needle),
            )
          : visible.filter(
              room =>
                (room.gameId ?? '')
                  .toLowerCase()
                  .includes(needle.slice(0, slashAt)) &&
                room.roomId.startsWith(needle.slice(slashAt + 1)),
            );

      return { total: found.length, servers: found.map(toPublic) };
    }

    // комнат мало — региональный фильтр и пагинация не нужны
    if (visible.length <= this._regionThreshold) {
      return { total: visible.length, servers: visible.map(toPublic) };
    }

    const filtered =
      typeof region === 'string' && region !== ''
        ? visible.filter(room => room.region === region)
        : visible;

    const off = toInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const lim = toInt(limit, this._defaultLimit, 1, this._maxLimit);

    return {
      total: filtered.length,
      servers: filtered.slice(off, off + lim).map(toPublic),
    };
  }

  // быстрая игра (GET /quickplay/:gameId, ревью F16): среди видимых, как в
  // getList, комнат строго этой игры — неполная с максимумом игроков (при
  // равенстве — первая), как pickQuickPlayRoom клиента по полному списку.
  // Скрытые не выдаются: быстрая игра — не админский вызов
  bestRoom(gameId, now = Date.now()) {
    let best = null;
    let bestPlayers = -1;

    for (const room of this._rooms.values()) {
      if (
        room.hidden ||
        room.status !== 'online' ||
        room.host.sessionId === null ||
        room.gameId !== gameId
      ) {
        continue;
      }

      const players = this.currentPlayers(room, now);

      if (players < room.maxPlayers && players > bestPlayers) {
        best = room;
        bestPlayers = players;
      }
    }

    return best ? this._toPublic(best, now) : null;
  }

  // публичная форма одной комнаты по прямому id (GET /rooms/:roomId, прямая
  // ссылка): скрытые тоже — вход по id в скрытую комнату и так возможен
  // оффером; status нужен ссылке, чтобы отличить комнату в миграции.
  // Закрывающаяся (host_closing) — 404: войти в неё уже нельзя
  getPublic(roomId, now = Date.now()) {
    const room = this.get(roomId);

    return room && room.status !== 'closing'
      ? { ...this._toPublic(room, now), status: room.status }
      : null;
  }

  // строка карточки: санированная и обрезанная, пустая — null
  _sanitizeInfo(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const text = sanitizeMessage(value)
      .trim()
      .slice(0, this._maxInfoLength)
      .trim();

    return text === '' ? null : text;
  }

  // число людей в комнате — по участникам, подтверждённым хостом, а не по
  // самоотчёту хоста
  currentPlayers(room, now = Date.now()) {
    let count = 0;

    for (const member of room.members.values()) {
      if (this._isLive(member, now) && this.isConfirmed(room, member)) {
        count += 1;
      }
    }

    return Math.min(count, room.maxPlayers);
  }

  // публичное представление комнаты (без ip, участников и служебных полей)
  _toPublic(room, now) {
    return {
      roomId: room.roomId,
      // алиас на переходный период: страницы лобби, загруженные до деплоя,
      // адресуют комнату по hostId
      hostId: room.roomId,
      gameId: room.gameId,
      info: room.info,
      // алиас на переходный период: страницы лобби до host-migration этапа 2
      // рисуют карточку из mapName
      mapName: room.info ?? '',
      currentPlayers: this.currentPlayers(room, now),
      maxPlayers: room.maxPlayers,
      region: room.region,
    };
  }
}
