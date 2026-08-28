import lobbyConfig from '../../../config/lobby.js';
import { nickKey } from '../../../lib/validators.js';

// Кто из участников комнаты сейчас в глобальном топ-10 — дневном и
// месячном (snakes-v3 этап 4). Источник — тот же публичный топ, что рисует
// лобби, поэтому награда одинакова на любом сервере: она про игрока, а не
// про комнату. Движок при этом не знает, ЧТО игра нарисует за место, — он
// раздаёт только числа, а знак рисует part игры.
//
// Ник глобально уникален (users.nick в auth) и это единственный ключ, по
// которому глобальный топ сопоставим с участником комнаты. Боты и гости в
// топ не попадают никогда — у них нет записи в auth, их место null, и это
// нормальный, а не аварийный случай.
//
// Запросы идут с If-None-Match: топ меняется медленно, совпал валидатор —
// 304 без тела, схлопнутый TTL-кэшем мастера на всю сеть.
//
// ***** ЗА ТОПОМ ХОДИТ КОМНАТА, А НЕ ИГРОК *****
//
// Тот же топ рисуется клиенту по Tab (`modules.stat.params.mode:
// 'leaderboard'`), и рисуется он ИЗ ЭТОЙ РАССЫЛКИ, а не собственным запросом
// клиента. Так это и должно быть: игрок разговаривает со своим игровым
// сервером, а не с мастером. Арифметика на целевом масштабе (100 игр × 100
// серверов × 8 игроков = 80 000 игроков) объясняет, почему это не вкусовщина:
//
//   клиент сам      — 80 000 игроков / 15 с троттлинга = 5300 запросов/с,
//                     причём место игрока (`/auth/placement`) персонально и
//                     общим кэшем мастера не схлопывается вовсе;
//   комната за всех — 10 000 комнат × 2 среза / 45 с = 440 запросов/с, и все
//                     они попадают в один TTL-кэш мастера на (игру, срез),
//                     то есть в БД доходит 100 игр × 2 среза за TTL.
//
// Разница — четыре порядка на самом дорогом запросе схемы.
export default class Accolades {
  // fetchImpl обёрнут стрелкой по той же причине, что и в PlayerDataSync:
  // голый `fetch` из поля объекта вызывался бы с чужим `this` и падал на
  // brand-check ещё до сети
  constructor({
    participants,
    gameId,
    // место и очки самого участника в срезе: их привозит PlayerDataSync на
    // входе игрока (GET /auth/placements). Нужны для строки «я» в списке —
    // игрок вне топа-10 видит собственное место вместо десятой строки
    getRating = () => null,
    fetchImpl = (...args) => fetch(...args),
    config = lobbyConfig,
    now = () => Date.now(),
  }) {
    this._participants = participants;
    this._gameId = gameId;
    this._getRating = getRating;
    this._fetch = fetchImpl;
    this._url = config.leaderboardUrl;
    this._limit = config.leaderboardLimit;
    this._interval = config.accolades.refreshInterval;
    this._periods = config.accolades.periods;
    this._now = now;

    // последний известный топ каждого среза: ключ награды -> Map(ник в
    // нижнем регистре -> место). 304 оставляет прошлый
    this._tops = new Map();
    // и он же строками, как их рисует клиент: ключ СРЕЗА ('day'/'month') ->
    // [{ place, nick, score }]. Два представления одного ответа: по нику
    // ищут знаки, по порядку — таблица
    this._boards = {};
    // ETag прошлого ответа среза — валидатор следующего запроса
    this._etags = new Map();

    this._payload = { places: {}, boards: {}, self: {} };
    // слепок ПУСТОЙ рассылки, а не '{}': иначе первый же _recompute в
    // пустой комнате считал бы её изменившейся и слал бы пустоту
    this._serialized = JSON.stringify(this._payload);
    this._dirty = false;

    // null, а не 0: первый опрос обязан пройти, каким бы ни было начало
    // отсчёта времени
    this._lastRefreshAt = null;
    this._inFlight = false;
  }

  // периодический опрос: зовётся каждый игровой тик, работает не чаще
  // refreshInterval. Промис наружу не отдаётся — это фон, а не шаг кадра, —
  // но именно поэтому он обязан быть пойман здесь: непойманный reject в
  // игровом цикле воркера кладёт комнату целиком
  tick() {
    this.refresh().catch(err =>
      console.warn('[accolades] tick failed:', err?.message),
    );
  }

  // состав комнаты изменился (вход участника): места пересчитываются
  // ЛОКАЛЬНО — срезы уже лежат в _tops, и ходить за ними ради новичка
  // незачем. Ходили бы: по два запроса на каждый вход, а при уже летящем
  // опросе новичок ещё и терялся бы до следующего refreshInterval, потому
  // что _inFlight глушит вызов целиком
  noteRoster() {
    this._recompute();
  }

  async refresh() {
    const now = this._now();

    if (this._inFlight) {
      return;
    }

    if (this._lastRefreshAt !== null && now - this._lastRefreshAt < this._interval) {
      return;
    }

    this._lastRefreshAt = now;
    this._inFlight = true;

    try {
      await Promise.all(
        Object.entries(this._periods).map(([award, period]) =>
          this._load(award, period),
        ),
      );
      this._recompute();
    } finally {
      this._inFlight = false;
    }
  }

  // Текущая рассылка целиком — для участника, который ТОЛЬКО ЧТО стал готов
  // принимать данные. Рассылка через shift() ему не досталась бы: она
  // уходит только тем, кто уже в getNetworkedReady(), а места новичка
  // считаются на входе, за всю загрузку карты до его готовности. Один раз
  // отданный shift() второй раз не повторится (места с тех пор не менялись),
  // и ни знак, ни таблица не появились бы до первого чужого входа
  current() {
    return this._payload;
  }

  // Рассылка или null, если с прошлого вызова ничего не изменилось. Обычно
  // именно null — и сообщения не будет вовсе.
  //
  //   places — { [gameId]: { daily, monthly } }: место участника в топе-10
  //            каждого среза или null. По ним part игры рисует знак;
  //   boards — { day: [{ place, nick, score }], month: [...] }: сам топ, как
  //            его рисует по Tab режим stat 'leaderboard';
  //   self   — { [gameId]: { day: { place, score }, month: {...} } }: место и
  //            очки самого участника, чтобы игрок ВНЕ топа видел свою строку.
  //
  // Всё три пересчитываются только в _recompute (опрос раз в refreshInterval
  // и вход участника), поэтому очки в `self` отстают от только что законченной
  // игры не больше чем на один интервал опроса. Это осознанно: они меняются с
  // каждой смертью, и рассылать их сразу значило бы слать сообщение на каждую
  // смерть каждого из восьми — ровно то, что «не изменилось — не отправляем»
  // и запрещает. Свой ТЕКУЩИЙ счёт игрок и так видит на HUD
  shift() {
    if (!this._dirty) {
      return null;
    }

    this._dirty = false;

    return this._payload;
  }

  async _load(award, period) {
    const query = new URLSearchParams({
      game: this._gameId,
      limit: this._limit,
      period,
    });
    const etag = this._etags.get(award);

    try {
      const res = await this._fetch(`${this._url}?${query}`, {
        headers: etag ? { 'if-none-match': etag } : {},
      });

      // 304 — топ тот же: прошлый срез остаётся как есть
      if (res.status === 304) {
        return;
      }

      if (!res.ok) {
        console.warn(`[accolades] GET leaderboard ${res.status} (${period})`);

        return;
      }

      const { leaderboard } = (await res.json()) ?? {};
      const places = new Map();
      const rows = [];

      for (const row of leaderboard ?? []) {
        // уникальность ника в auth регистронезависимая (миграция 002) —
        // сопоставлять надо так же, иначе «Alice» и «alice» разъедутся
        if (row?.nick) {
          places.set(nickKey(row.nick), Number(row.place));
          rows.push({
            place: Number(row.place),
            nick: row.nick,
            score: Number(row.rank) || 0,
          });
        }
      }

      this._tops.set(award, places);
      this._boards[period] = rows;
      this._etags.set(award, res.headers?.get?.('etag') ?? null);
    } catch (err) {
      // недоступность мастера — остаёмся на прошлых местах: пропавший на
      // одну минуту знак хуже, чем чуть устаревший
      console.warn(`[accolades] refresh failed (${period}):`, err.message);
    }
  }

  _recompute() {
    const places = {};
    const self = {};
    // срезы, за которыми ходит хост, в терминах auth ('day'/'month') — по
    // ним же клиент выбирает таблицу под свой stat.params.period
    const periods = Object.values(this._periods);

    for (const participant of this._participants.getAll()) {
      const entry = {};
      const gameId = String(participant.gameId);

      for (const award of Object.keys(this._periods)) {
        entry[award] = null;
      }

      // Знак — только участнику с проверенной личностью. В лобби это ничего
      // не меняет: там `name` и есть claim проверенного identity-токена
      // (host/identity.js: createTokenIdentity.resolve возвращает
      // payload.nick, и PortMachine передаёт в createUser именно его), а не
      // то, что игрок написал в форме.
      //
      // Меняет это в гостевом контуре (standalone/dedicated), где ник —
      // поле формы и «не защищён от подмены» по прямому признанию
      // createGuestIdentity. Токена у гостя нет, и сопоставление по нику
      // выдало бы ему чужую корону — стоит она ровно того, что значит.
      if (participant.token) {
        const nick = nickKey(participant.name);

        for (const award of Object.keys(this._periods)) {
          entry[award] = this._tops.get(award)?.get(nick) ?? null;
        }

        // место и очки этого участника в каждом срезе: их привёз
        // PlayerDataSync на входе. Игрок вне топа-10 видит по Tab свою
        // строку вместо десятой, и взять её больше неоткуда — топ его не
        // содержит по определению
        const mine = {};

        for (const period of periods) {
          const rating = this._getRating(gameId, period);

          if (rating) {
            mine[period] = {
              place: rating.placement ?? null,
              score: rating.value ?? 0,
            };
          }
        }

        if (Object.keys(mine).length) {
          self[gameId] = mine;
        }
      }

      places[gameId] = entry;
    }

    const payload = { places, boards: this._boards, self };
    const serialized = JSON.stringify(payload);

    // «не изменилось — не отправляем»: и 304, и неизменившийся состав
    // комнаты оставляют рассылку пустой
    if (serialized === this._serialized) {
      return;
    }

    this._serialized = serialized;
    this._payload = payload;
    this._dirty = true;
  }
}
