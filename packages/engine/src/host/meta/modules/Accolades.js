import lobbyConfig from '../../../config/lobby.js';

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
export default class Accolades {
  // fetchImpl обёрнут стрелкой по той же причине, что и в PlayerDataSync:
  // голый `fetch` из поля объекта вызывался бы с чужим `this` и падал на
  // brand-check ещё до сети
  constructor({
    participants,
    gameId,
    fetchImpl = (...args) => fetch(...args),
    config = lobbyConfig,
    now = () => Date.now(),
  }) {
    this._participants = participants;
    this._gameId = gameId;
    this._fetch = fetchImpl;
    this._url = config.leaderboardUrl;
    this._limit = config.leaderboardLimit;
    this._interval = config.accolades.refreshInterval;
    this._periods = config.accolades.periods;
    this._now = now;

    // последний известный топ каждого среза: ключ награды -> Map(ник в
    // нижнем регистре -> место). 304 оставляет прошлый
    this._tops = new Map();
    // ETag прошлого ответа среза — валидатор следующего запроса
    this._etags = new Map();

    this._places = {};
    this._serialized = '{}';
    this._dirty = false;

    // null, а не 0: первый опрос обязан пройти, каким бы ни было начало
    // отсчёта времени
    this._lastRefreshAt = null;
    this._inFlight = false;
  }

  // периодический опрос: зовётся каждый игровой тик, работает не чаще
  // refreshInterval. Промис наружу не отдаётся — это фон, а не шаг кадра
  tick() {
    this.refresh();
  }

  // force — вход участника: у новичка знак должен появиться сразу, а не
  // через refreshInterval
  async refresh({ force = false } = {}) {
    const now = this._now();

    if (this._inFlight) {
      return;
    }

    if (
      !force &&
      this._lastRefreshAt !== null &&
      now - this._lastRefreshAt < this._interval
    ) {
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

  // { [gameId]: { daily, monthly } } или null, если с прошлого вызова
  // ничего не изменилось. Обычно именно null — и рассылки не будет вовсе
  shift() {
    if (!this._dirty) {
      return null;
    }

    this._dirty = false;

    return this._places;
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

      for (const row of leaderboard ?? []) {
        // уникальность ника в auth регистронезависимая (миграция 002) —
        // сопоставлять надо так же, иначе «Alice» и «alice» разъедутся
        if (row?.nick) {
          places.set(String(row.nick).toLowerCase(), Number(row.place));
        }
      }

      this._tops.set(award, places);
      this._etags.set(award, res.headers?.get?.('etag') ?? null);
    } catch (err) {
      // недоступность мастера — остаёмся на прошлых местах: пропавший на
      // одну минуту знак хуже, чем чуть устаревший
      console.warn(`[accolades] refresh failed (${period}):`, err.message);
    }
  }

  _recompute() {
    const places = {};

    for (const participant of this._participants.getAll()) {
      const nick = String(participant.name ?? '').toLowerCase();
      const entry = {};

      for (const award of Object.keys(this._periods)) {
        entry[award] = this._tops.get(award)?.get(nick) ?? null;
      }

      places[String(participant.gameId)] = entry;
    }

    const serialized = JSON.stringify(places);

    // «не изменилось — не отправляем»: и 304, и неизменившийся состав
    // комнаты оставляют рассылку пустой
    if (serialized === this._serialized) {
      return;
    }

    this._serialized = serialized;
    this._places = places;
    this._dirty = true;
  }
}
