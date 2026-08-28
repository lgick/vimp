import config from './config/auth.js';

// доступ к БД auth-сервиса (users/ratings/states). Принимает объект с
// методом query({text, values}) в конструкторе (реальный pg.Pool или мок в
// тестах) — так класс не тянет реальное соединение в юнит-тестах
export class NickTakenError extends Error {
  constructor(nick) {
    super(`nick "${nick}" is already taken`);
    this.name = 'NickTakenError';
    this.nick = nick;
  }
}

// F6: пользователь уже имеет ник — POST /nick не переименование
export class NickAlreadySetError extends Error {
  constructor(userId) {
    super(`user ${userId} already has a nick`);
    this.name = 'NickAlreadySetError';
    this.userId = userId;
  }
}

// rank-periods: срезы лидерборда. 'all' — денормализованный кэш ratings,
// остальные — окно по created_at в леджере rank_events. Границы
// КАЛЕНДАРНЫЕ и в UTC (date_trunc), а не скользящие: «топ за сегодня»
// должен означать одно и то же для всех, кто на него смотрит.
export const RANK_PERIODS = ['day', 'month', 'all'];

// Оконный срез в терминах агрегата rank_periods (миграция 008), или null
// для 'all' (окна нет — там читается кэш ratings).
//
//   kind   строка запроса: 'd' сутки UTC, 'm' календарный месяц UTC;
//   start  кусок SQL с началом окна;
//   column КОЛОНКА агрегата, по которой ранжирует срез: день — лучшая
//          одиночная игра, месяц — сумма игр.
//
// `column` возвращается литералом, а не параметром: это идентификатор, а не
// значение сравнения, и подставить его через $n нельзя в принципе. Значение
// приходит только отсюда, то есть из кода, — ровно как и `start`.
function periodSlice(period) {
  if (period === 'day') {
    return {
      kind: 'd',
      start: "date_trunc('day', now() AT TIME ZONE 'utc')::date",
      column: 'best',
    };
  }

  if (period === 'month') {
    return {
      kind: 'm',
      start: "date_trunc('month', now() AT TIME ZONE 'utc')::date",
      column: 'points',
    };
  }

  return null;
}

export default class UserRepository {
  constructor(db) {
    this._db = db;
  }

  // находит пользователя по (provider, providerUid) или создаёт нового
  // без ника (ник выбирается отдельным шагом, POST /nick)
  async findOrCreateByProvider(provider, providerUid) {
    const existing = await this._db.query(
      'SELECT * FROM users WHERE provider = $1 AND provider_uid = $2',
      [provider, providerUid],
    );

    if (existing.rows[0]) {
      return existing.rows[0];
    }

    const created = await this._db.query(
      'INSERT INTO users (provider, provider_uid) VALUES ($1, $2) RETURNING *',
      [provider, providerUid],
    );

    return created.rows[0];
  }

  // глобальная уникальность ника (заменяет пер-комнатный checkName хоста).
  // "AND nick IS NULL" (F6) — защищает от переименования уже зарегистрированного
  // пользователя; 0 обновлённых строк трактуется как "ник уже задан"
  async setNick(userId, nick) {
    try {
      const result = await this._db.query(
        'UPDATE users SET nick = $1 WHERE id = $2 AND nick IS NULL RETURNING *',
        [nick, userId],
      );

      if (!result.rows[0]) {
        throw new NickAlreadySetError(userId);
      }

      return result.rows[0];
    } catch (err) {
      // unique_violation — ник заняли между проверкой и записью
      if (err.code === '23505') {
        throw new NickTakenError(nick);
      }

      throw err;
    }
  }

  async getRank(userId, gameId) {
    const result = await this._db.query(
      'SELECT rank FROM ratings WHERE user_id = $1 AND game_id = $2',
      [userId, gameId],
    );

    return result.rows[0]?.rank ?? 0;
  }

  // snakes-v3 (stage_2.md, 2.2): леджер хранит РЕЗУЛЬТАТ ИГРЫ, а не дельту
  // ранга. points — сумма очков игр, попавших в запись (движок вправе
  // склеить несколько завершённых игр одного игрока в один запрос), best —
  // лучшая одиночная игра среди них. Пересчёта ratings здесь НЕТ: all-time
  // считает суточная задача (src/db/ratingsJob.js), а горячий путь остаётся
  // одним INSERT — иначе каждая запись тянула бы SUM по всей истории игрока.
  // Атрибуция к серверу/сессии (server-rating этап 1) сохраняется: этап 4
  // гасит вклад забаненного сервера, не трогая остальную историю
  async recordGameResult(userId, gameId, { points, best }, attribution = {}) {
    const { hosterUserId = null, sessionId = null } = attribution;

    if (points <= 0 && best <= 0) {
      return; // защита в глубину: пустую запись не пишем (движок и так не шлёт)
    }

    // ОДИН запрос и один round-trip: строка леджера и обе строки агрегата
    // (сутки + месяц) пишутся вместе. Агрегат — производная от леджера
    // (миграция 008), и держать их в разных запросах значило бы оставить
    // окно, в котором они расходятся.
    //
    // Окно берётся от created_at САМОЙ строки, а не от now() второго
    // запроса: на границе суток эти два значения разъезжаются, и результат
    // ушёл бы в чужие сутки.
    await this._db.query(
      `WITH event AS (
         INSERT INTO rank_events (user_id, game_id, hoster_user_id, session_id, delta, best)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING created_at)
       INSERT INTO rank_periods (user_id, game_id, kind, period, best, points)
       SELECT $1, $2, k.kind,
              date_trunc(k.unit, event.created_at AT TIME ZONE 'utc')::date, $6, $5
       FROM event CROSS JOIN (VALUES ('d', 'day'), ('m', 'month')) AS k(kind, unit)
       ON CONFLICT (user_id, game_id, kind, period)
       DO UPDATE SET best = GREATEST(rank_periods.best, EXCLUDED.best),
                     points = rank_periods.points + EXCLUDED.points`,
      [userId, gameId, hosterUserId, sessionId, points, best],
    );
  }

  // Пересчитывает агрегат срезов (миграция 008) одной пары (игрок, игра) из
  // леджера. Нужен там же, где и recomputeRank: аннулирование вклада
  // забаненного хостера нельзя «вычесть» из агрегата — `best` это МАКСИМУМ, и
  // обратной операции у него нет.
  //
  // Присваивание, а не приращение, поэтому повторный вызов безвреден. Окна,
  // от которых после аннулирования не осталось ни одного события, удаляются
  // отдельно — ON CONFLICT их бы не тронул, и игрок остался бы в топе с
  // погашенными очками
  async recomputePeriods(userId, gameId) {
    await this._db.query(
      `INSERT INTO rank_periods (user_id, game_id, kind, period, best, points)
       SELECT e.user_id, e.game_id, k.kind,
              date_trunc(k.unit, e.created_at AT TIME ZONE 'utc')::date,
              MAX(e.best), SUM(e.delta)
       FROM rank_events e
       CROSS JOIN (VALUES ('d', 'day'), ('m', 'month')) AS k(kind, unit)
       WHERE e.user_id = $1 AND e.game_id = $2 AND e.voided = false
       GROUP BY e.user_id, e.game_id, k.kind, k.unit,
                date_trunc(k.unit, e.created_at AT TIME ZONE 'utc')
       ON CONFLICT (user_id, game_id, kind, period)
       DO UPDATE SET best = EXCLUDED.best, points = EXCLUDED.points`,
      [userId, gameId],
    );

    await this._db.query(
      `DELETE FROM rank_periods p
       WHERE p.user_id = $1 AND p.game_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM rank_events e
           WHERE e.user_id = p.user_id AND e.game_id = p.game_id AND e.voided = false
             AND date_trunc(CASE p.kind WHEN 'd' THEN 'day' ELSE 'month' END,
                            e.created_at AT TIME ZONE 'utc')::date = p.period)`,
      [userId, gameId],
    );
  }

  // пересчитывает денормализованный кэш ratings.rank из непогашенных
  // (voided = false) событий леджера; клампит в rank.min/max (config/auth.js).
  // snakes-v3: с горячего пути ушёл — остались voidHosterContributions
  // (полный пересчёт задетых пар) и ручной прогон суточной задачи
  async recomputeRank(userId, gameId) {
    // MAX(created_at) вместе с суммой: ratings.updated_at это КУРСОР
    // суточной задачи — «учтено по эту метку», а не «посчитано в этот
    // момент» (см. ratingsJob.js). Полный пересчёт обязан оставить его в той
    // же системе координат, иначе событие, закоммиченное позже снимка
    // пересчёта, но с более ранней меткой, выпало бы из инкремента навсегда.
    // Пустой леджер (всё аннулировано) метки не даёт — тогда now(), и
    // курсор просто честно стоит на «сейчас»
    const sum = await this._db.query(
      `SELECT COALESCE(SUM(delta), 0) AS total, MAX(created_at) AS through
       FROM rank_events
       WHERE user_id = $1 AND game_id = $2 AND voided = false`,
      [userId, gameId],
    );

    const rank = Math.min(config.rank.max, Math.max(config.rank.min, Number(sum.rows[0].total)));

    await this._db.query(
      `INSERT INTO ratings (user_id, game_id, rank, updated_at)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
       ON CONFLICT (user_id, game_id)
       DO UPDATE SET rank = EXCLUDED.rank, updated_at = EXCLUDED.updated_at`,
      [userId, gameId, rank, sum.rows[0].through ?? null],
    );

    return rank;
  }

  // топ-N игроков игры (lobby-page-plan): только ранжированные (rank > 0) и
  // с установленным ником — незалогиненные/нулевые не засоряют выдачу.
  // Один запрос вместо отдельного COUNT(*) (code review L1): оконные функции
  // считаются над всем набором, прошедшим WHERE, ДО того как ORDER BY/LIMIT
  // урезают вывод — так `total`/`place` в каждой строке верны для всей игры,
  // а не только для отданной страницы. `place` — competition ranking (как
  // и getPlacement ниже: игроки с одинаковым rank делят место, следующее
  // отличное значение перескакивает на число разделивших) — согласовано с
  // тем, что показывает плашка позиции вызывающего (code review M3)
  //
  // rank-periods / snakes-v3 (stage_2.md, 2.3): `period` выбирает не только
  // окно, но и АГРЕГАЦИЮ — три среза считаются тремя разными способами:
  //   day   — MAX(best): лучшая одиночная игра за сутки UTC;
  //   month — SUM(delta): сумма очков всех игр за календарный месяц UTC;
  //   all   — кэш ratings, снимок суточной задачи (src/db/ratingsJob.js).
  // Срез передаётся параметром $3 (а не литералом, как окно): в отличие от
  // границы окна это не кусок SQL, а значение сравнения, и параметру здесь
  // ничто не мешает. Индекс rank_events_game_created_idx (миграция 006)
  // обслуживает оба оконных среза — отдельный под MAX(best) не нужен
  async getLeaderboard(gameId, limit, period = 'all') {
    const slice = periodSlice(period);

    const result = slice
      ? await this._db.query(
          `WITH scores AS (
             SELECT p.user_id, p.${slice.column} AS rank
             FROM rank_periods p
             WHERE p.game_id = $1 AND p.kind = $3 AND p.period = ${slice.start}
               AND p.${slice.column} > 0)
           SELECT u.nick, s.rank,
                  COUNT(*) OVER() AS total,
                  RANK() OVER (ORDER BY s.rank DESC) AS place
           FROM scores s JOIN users u ON u.id = s.user_id
           WHERE u.nick IS NOT NULL
           ORDER BY s.rank DESC, u.nick ASC
           LIMIT $2`,
          [gameId, limit, slice.kind],
        )
      : await this._db.query(
          `SELECT u.nick, r.rank,
                  COUNT(*) OVER() AS total,
                  RANK() OVER (ORDER BY r.rank DESC) AS place
           FROM ratings r JOIN users u ON u.id = r.user_id
           WHERE r.game_id = $1 AND r.rank > 0 AND u.nick IS NOT NULL
           ORDER BY r.rank DESC, u.nick ASC
           LIMIT $2`,
          [gameId, limit],
        );

    return {
      leaderboard: result.rows.map(row => ({
        nick: row.nick,
        rank: row.rank,
        place: Number(row.place),
      })),
      total: Number(result.rows[0]?.total ?? 0),
    };
  }

  // позиция игрока в рейтинге игры (lobby-page-plan): placement === null,
  // если игрок ещё не ранжирован (rank === 0, т.е. записи в ratings нет или
  // rank оказался 0 после клампа/аннулирования). rank-periods: `period` —
  // тот же срез, что и у getLeaderboard, и считается он тем же способом
  // (та же CASE-агрегация), иначе плашка позиции противоречила бы списку
  // рядом с ней
  async getPlacement(userId, gameId, period = 'all') {
    const slice = periodSlice(period);

    const result = slice
      ? await this._db.query(
          `WITH scores AS (
             SELECT p.user_id, p.${slice.column} AS rank
             FROM rank_periods p
             WHERE p.game_id = $2 AND p.kind = $3 AND p.period = ${slice.start}
               AND p.${slice.column} > 0),
           me AS (
             SELECT COALESCE((SELECT rank FROM scores WHERE user_id = $1), 0) AS rank)
           SELECT
             (SELECT COUNT(*) FROM scores s JOIN users u ON u.id = s.user_id
                WHERE u.nick IS NOT NULL) AS total,
             me.rank AS rank,
             CASE WHEN me.rank > 0 THEN
               (SELECT COUNT(*) FROM scores s JOIN users u ON u.id = s.user_id
                  WHERE u.nick IS NOT NULL AND s.rank > me.rank) + 1
             END AS placement
           FROM me`,
          [userId, gameId, slice.kind],
        )
      : await this._db.query(
          `WITH me AS (
             SELECT COALESCE(
               (SELECT rank FROM ratings WHERE user_id = $1 AND game_id = $2), 0) AS rank)
           SELECT
             (SELECT COUNT(*) FROM ratings r JOIN users u ON u.id = r.user_id
                WHERE r.game_id = $2 AND r.rank > 0 AND u.nick IS NOT NULL) AS total,
             me.rank AS rank,
             CASE WHEN me.rank > 0 THEN
               (SELECT COUNT(*) FROM ratings r JOIN users u ON u.id = r.user_id
                  WHERE r.game_id = $2 AND u.nick IS NOT NULL AND r.rank > me.rank) + 1
             END AS placement
           FROM me`,
          [userId, gameId],
        );

    const row = result.rows[0];

    return {
      placement: row.placement === null ? null : Number(row.placement),
      total: Number(row.total),
      rank: Number(row.rank),
    };
  }

  async getState(userId, gameId) {
    const result = await this._db.query(
      'SELECT state FROM states WHERE user_id = $1 AND game_id = $2',
      [userId, gameId],
    );

    return result.rows[0]?.state ?? {};
  }

  // снапшот state "на вход в сессию" (stage_1.md, 1.3) — MVP-откат для
  // этапа 4; ON CONFLICT DO NOTHING делает вызов идемпотентным на
  // (user, game, session), так что "до" не затирается повторными вызовами
  // в рамках одной и той же сессии
  async snapshotState(userId, gameId, sessionId, hosterUserId = null) {
    const current = await this.getState(userId, gameId);

    await this._db.query(
      `INSERT INTO state_snapshots (user_id, game_id, session_id, hoster_user_id, state_before)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, game_id, session_id) DO NOTHING`,
      [userId, gameId, sessionId, hosterUserId, JSON.stringify(current)],
    );
  }

  async upsertState(userId, gameId, state, { hosterUserId = null, sessionId = null } = {}) {
    if (sessionId) {
      await this.snapshotState(userId, gameId, sessionId, hosterUserId);
    }

    await this._db.query(
      `INSERT INTO states (user_id, game_id, state, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, game_id)
       DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [userId, gameId, JSON.stringify(state)],
    );
  }

  async getHostRating(hosterUserId) {
    const result = await this._db.query(
      'SELECT score, blocked FROM host_ratings WHERE hoster_user_id = $1',
      [hosterUserId],
    );

    return result.rows[0]
      ? { score: result.rows[0].score, blocked: result.rows[0].blocked }
      : { score: 0, blocked: false };
  }

  // пересчитывает денормализованный кэш host_ratings из текущих host_votes
  // (не леджер: одна строка на голосующего, "переставляется" при смене мнения)
  async _recomputeHostRating(hosterUserId) {
    const before = await this.getHostRating(hosterUserId);

    const sum = await this._db.query(
      'SELECT COALESCE(SUM(value), 0) AS total FROM host_votes WHERE hoster_user_id = $1',
      [hosterUserId],
    );

    const score = Math.min(
      config.rating.max,
      Math.max(config.rating.min, Number(sum.rows[0].total)),
    );
    const blocked = score <= config.rating.blockAt;

    // server-rating этап 4 (stage_4.md, 4.1): только на первом переходе в
    // blocked — повторные голоса, держащие хостера заблокированным, не
    // должны раз за разом гасить одни и те же (уже voided) события.
    // Кодревью №6: void выполняется ДО записи host_ratings.blocked — если он
    // упадёт на середине, кэш остаётся blocked=false, и следующий голос
    // (before.blocked снова false) повторит void начисто на непогашенном
    // остатке (voidHosterContributions идемпотентен по voided=false)
    if (blocked && !before.blocked) {
      await this.voidHosterContributions(hosterUserId);
    }

    await this._db.query(
      `INSERT INTO host_ratings (hoster_user_id, score, blocked, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (hoster_user_id)
       DO UPDATE SET score = EXCLUDED.score, blocked = EXCLUDED.blocked, updated_at = now()`,
      [hosterUserId, score, blocked],
    );

    return { score, blocked };
  }

  // server-rating этап 4 (stage_4.md): аннулирует вклад забаненного хостера
  // в профиль игроков. Не обёрнуто в SQL BEGIN/COMMIT (этот класс нигде не
  // держит транзакции — тот же уровень гарантий, что у recomputeRank), а
  // сделано идемпотентным: rank-часть гасит только ещё не погашенные события,
  // но пересчитывает кэш для *всех* когда-либо задетых (user, game) — так
  // повтор после сбоя на середине не пропускает пересчёт кэша. Skills-часть
  // раз за разом переписывает state тем же самым «до первой сессии»
  // снапшотом — тоже no-op при повторе.
  async voidHosterContributions(hosterUserId) {
    const rankTargets = await this._db.query(
      'SELECT DISTINCT user_id, game_id FROM rank_events WHERE hoster_user_id = $1',
      [hosterUserId],
    );

    await this._db.query(
      'UPDATE rank_events SET voided = true WHERE hoster_user_id = $1 AND voided = false',
      [hosterUserId],
    );

    for (const { user_id: userId, game_id: gameId } of rankTargets.rows) {
      await this.recomputeRank(userId, gameId);
      // агрегат срезов — производная того же леджера, и аннулирование обязано
      // дойти и до него: иначе забаненный сервер продолжал бы держать игрока
      // в дневном и месячном топе (миграция 008)
      await this.recomputePeriods(userId, gameId);
    }

    const stateTargets = await this._db.query(
      'SELECT DISTINCT user_id, game_id FROM state_snapshots WHERE hoster_user_id = $1',
      [hosterUserId],
    );

    for (const { user_id: userId, game_id: gameId } of stateTargets.rows) {
      // самый ранний снапшот этого хостера для (user, game) — состояние до
      // первого контакта с ним, даже если сессий с ним было несколько
      const earliest = await this._db.query(
        `SELECT state_before FROM state_snapshots
         WHERE hoster_user_id = $1 AND user_id = $2 AND game_id = $3
         ORDER BY created_at ASC LIMIT 1`,
        [hosterUserId, userId, gameId],
      );

      if (!earliest.rows[0]) {
        continue;
      }

      await this._db.query(
        `INSERT INTO states (user_id, game_id, state, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, game_id)
         DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        [userId, gameId, JSON.stringify(earliest.rows[0].state_before)],
      );
    }
  }

  // голос гостя за/против хостера комнаты (server-rating этап 2,
  // stage_2.md): один голос на пару (hoster, voter), мнение меняемо —
  // ON CONFLICT перезаписывает value/reason, а не копит дубликаты. Тот же
  // повторный голос — no-op (counted: false), смена мнения даёт Δ=∓2 при
  // пересчёте SUM ниже, как того требует правило (like→unlike переставляет)
  async voteHost(hosterUserId, voterUserId, value, reason = null) {
    const existing = await this._db.query(
      'SELECT value FROM host_votes WHERE hoster_user_id = $1 AND voter_user_id = $2',
      [hosterUserId, voterUserId],
    );

    if (existing.rows[0]?.value === value) {
      return { ...(await this.getHostRating(hosterUserId)), counted: false };
    }

    await this._db.query(
      `INSERT INTO host_votes (hoster_user_id, voter_user_id, value, reason, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (hoster_user_id, voter_user_id)
       DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason, updated_at = now()`,
      [hosterUserId, voterUserId, value, reason],
    );

    return { ...(await this._recomputeHostRating(hosterUserId)), counted: true };
  }
}
