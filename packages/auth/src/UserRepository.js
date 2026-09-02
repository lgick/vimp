import config from './config/auth.js';
import RankDistribution from './db/RankDistribution.js';

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

// ***** РЕЕСТР ИГР (направление master-game-registry, этап 1) *****

// заявка на уже занятый id или уже зарегистрированный npm-пакет
export class GameExistsError extends Error {
  constructor(id) {
    super(`game "${id}" already exists`);
    this.name = 'GameExistsError';
    this.id = id;
  }
}

export class GameNotFoundError extends Error {
  constructor(id) {
    super(`game "${id}" not found`);
    this.name = 'GameNotFoundError';
    this.id = id;
  }
}

// игра существует, но вызывающий ей не автор и не админ
export class GameForbiddenError extends Error {
  constructor(id) {
    super(`game "${id}" belongs to another author`);
    this.name = 'GameForbiddenError';
    this.id = id;
  }
}

// потолок заявок на одного разработчика (config.games.maxPerUser)
export class GameLimitError extends Error {
  constructor(userId) {
    super(`user ${userId} reached the game limit`);
    this.name = 'GameLimitError';
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

// Строка games наружу: snake_case БД → camelCase REST. Ники автора и
// модератора приходят из LEFT JOIN и равны null у игр платформы (автора нет)
// и у неотмодерированных
function mapGame(row) {
  return row
    ? {
        id: row.id,
        packageName: row.package_name,
        title: row.title,
        repoUrl: row.repo_url,
        authorUserId: row.author_user_id,
        authorNick: row.author_nick ?? null,
        status: row.status,
        version: row.version,
        pendingVersion: row.pending_version,
        maxGameScore: row.max_game_score,
        moderatorNote: row.moderator_note,
        moderatorNick: row.moderator_nick ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

// Публичная форма строки: GET /games читает и мастер, и любой прохожий
// (сервис выставлен наружу отдельным доменом), поэтому наружу едет только
// то, что нужно каталогу мастера и футеру лобби. Внутренняя переписка
// модерации (moderator_note), внутренний id автора и очередь версий
// остаются на полном mapGame
function mapPublicGame(row) {
  return {
    id: row.id,
    packageName: row.package_name,
    title: row.title,
    repoUrl: row.repo_url,
    authorNick: row.author_nick ?? null,
    version: row.version,
    maxGameScore: row.max_game_score,
  };
}

// колонки игры + ники автора и модератора одним списком: все запросы реестра,
// отдающие полную строку (mapGame), — и выборки, и пишущие — обязаны отдавать
// ОДНУ форму, иначе ответ POST/PATCH расходится со списком того же ресурса
const GAME_JOINS = `LEFT JOIN users a ON a.id = g.author_user_id
       LEFT JOIN users m ON m.id = g.moderator_user_id`;
const GAME_FIELDS = `g.*, a.nick AS author_nick, m.nick AS moderator_nick`;
const GAME_FROM = `FROM games g ${GAME_JOINS}`;

// публичная выборка (mapPublicGame) джойнит только автора: ник модератора —
// внутренняя переписка модерации, и выбирать его в строку, которая едет
// наружу, незачем даже с последующим отбрасыванием
const PUBLIC_GAME_FIELDS = `g.*, a.nick AS author_nick`;
const PUBLIC_GAME_FROM = `FROM games g LEFT JOIN users a ON a.id = g.author_user_id`;

// та же проекция поверх результата INSERT/UPDATE: пишущий запрос заворачивается
// в CTE, джойны идут по нему, а не по games. Без этого ответ на запись отдавал
// бы authorNick/moderatorNick: null там, где список отдаёт ники, и первый же
// потребитель, поверивший ответу, напечатал бы внутренний id
const gameProject = cte => `SELECT ${GAME_FIELDS} FROM ${cte} g ${GAME_JOINS}`;

// поля, которые вправе менять модератор: белый список ключей patch →
// колонок. Ключ, которого здесь нет, в SET не попадает вовсе — так значение
// из тела запроса не может стать куском SQL
const MODERATABLE = {
  status: 'status',
  version: 'version',
  pendingVersion: 'pending_version',
  note: 'moderator_note',
  maxGameScore: 'max_game_score',
};

export default class UserRepository {
  // `distribution` — кэш лестницы значений среза (db/RankDistribution.js), из
  // которой считается место. Инжектируется для тестов; по умолчанию свой,
  // с загрузчиком, который умеет и оконные срезы, и кэш ratings
  constructor(db, { distribution } = {}) {
    this._db = db;
    this._distribution =
      distribution ??
      new RankDistribution(
        (gameId, period, maxSteps) => this._loadDistribution(gameId, period, maxSteps),
        { ttlMs: config.rank.distributionTtl, maxSteps: config.rank.distributionSteps },
      );
  }

  // фоновая уборка кэша распределений (main.js вешает на интервал)
  sweepDistributions() {
    this._distribution.sweep();
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

  /**
   * Удаляет строку пользователя, у которой так и не появился ник.
   *
   * ВНИМАНИЕ: `nick IS NULL` — легальное состояние OAuth-входа между
   * `/oauth/:provider/callback` и `POST /nick`, и такая строка принадлежит
   * живому пользователю. Метод рассчитан на dev-логин, где ник ставится
   * сразу за созданием: звать его можно только по id, который вызывающий
   * создал сам и вход по которому только что провалился.
   * @param {number} userId - Идентификатор пользователя.
   * @returns {Promise<boolean>} Была ли строка удалена.
   */
  async deleteIfAnonymous(userId) {
    const result = await this._db.query(
      'DELETE FROM users WHERE id = $1 AND nick IS NULL RETURNING id',
      [userId],
    );

    return Boolean(result.rows[0]);
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

  // ***** МЕСТО ИГРОКА *****
  //
  // placement === null, если игрок в этом срезе не ранжирован (нет строки или
  // значение 0 после клампа/аннулирования).
  //
  // Считается ДВУМЯ дешёвыми частями вместо одного тяжёлого запроса:
  //
  //   своё значение — точечный поиск по первичному ключу (0.17 мс);
  //   место         — бинарный поиск по лестнице среза, общей для всех
  //                   игроков игры и кэшированной на `rank.distributionTtl`.
  //
  // Раньше это была свёртка всего окна с join к users на КАЖДЫЙ вход
  // участника — 6 мс на 8 000 игроков в окне, то есть семь ядер на целевом
  // масштабе. Определение места не изменилось: оно то же competition
  // ranking, что и `place` в getLeaderboard, иначе плашка позиции
  // противоречила бы списку рядом с ней.
  //
  // Глубокий хвост игры, чья лестница не уместилась в потолок ступеней,
  // уходит на точный запрос — редкий случай, оплаченный тем, что все
  // остальные его не делают.
  async getPlacement(userId, gameId, period = 'all') {
    const rank = await this._ownScore(userId, gameId, period);
    const distribution = await this._distribution.get(gameId, period);
    const placement = RankDistribution.placementOf(distribution, rank);

    if (rank > 0 && placement === null) {
      return this._placementExactly(userId, gameId, period, rank);
    }

    return {
      placement: rank > 0 ? placement : null,
      total: RankDistribution.totalOf(distribution) ?? 0,
      rank,
    };
  }

  // своё значение в срезе: строка агрегата для оконных срезов, кэш ratings
  // для all-time. И то и другое — попадание в первичный ключ
  async _ownScore(userId, gameId, period) {
    const slice = periodSlice(period);

    const result = slice
      ? await this._db.query(
          `SELECT p.${slice.column} AS rank FROM rank_periods p
           WHERE p.user_id = $1 AND p.game_id = $2 AND p.kind = $3
             AND p.period = ${slice.start}`,
          [userId, gameId, slice.kind],
        )
      : await this._db.query(
          'SELECT r.rank FROM ratings r WHERE r.user_id = $1 AND r.game_id = $2',
          [userId, gameId],
        );

    return Math.max(Number(result.rows[0]?.rank) || 0, 0);
  }

  // Лестница РАЗЛИЧНЫХ значений среза по убыванию и число игроков «на этой
  // ступени и выше». Один запрос на (игру, срез) за TTL — за него платят все
  // игроки сразу, а не каждый по отдельности.
  //
  // `total` считается оконной функцией по ВСЕМ ступеням, до LIMIT, поэтому
  // обрезание хвоста его не портит. Лишняя ступень сверх потолка запрашивается
  // затем, чтобы отличить «уместилось целиком» от «хвост обрезан»
  async _loadDistribution(gameId, period, maxSteps) {
    const slice = periodSlice(period);
    const source = slice
      ? `SELECT p.${slice.column} AS score
         FROM rank_periods p JOIN users u ON u.id = p.user_id
         WHERE p.game_id = $1 AND p.kind = '${slice.kind}' AND p.period = ${slice.start}
           AND p.${slice.column} > 0 AND u.nick IS NOT NULL`
      : `SELECT r.rank AS score
         FROM ratings r JOIN users u ON u.id = r.user_id
         WHERE r.game_id = $1 AND r.rank > 0 AND u.nick IS NOT NULL`;

    const result = await this._db.query(
      `SELECT score, at_or_above, total FROM (
         SELECT g.score,
                SUM(g.players) OVER (ORDER BY g.score DESC) AS at_or_above,
                SUM(g.players) OVER () AS total
         FROM (SELECT score, COUNT(*) AS players FROM (${source}) rows GROUP BY score) g
       ) ladder
       ORDER BY score DESC
       LIMIT $2`,
      [gameId, maxSteps + 1],
    );

    const complete = result.rows.length <= maxSteps;

    return {
      steps: result.rows.slice(0, maxSteps).map(row => ({
        score: Number(row.score),
        atOrAbove: Number(row.at_or_above),
      })),
      total: Number(result.rows[0]?.total ?? 0),
      complete,
    };
  }

  // Точный запрос места — запасной путь для игрока ниже обрезанного хвоста
  // лестницы. Один проход по индексу: своё значение уже известно, оба
  // счётчика считаются одним сканом через FILTER, join к users нужен по той
  // же причине, что и в списке — незаполненный ник в рейтинг не входит
  async _placementExactly(userId, gameId, period, rank) {
    const slice = periodSlice(period);
    const source = slice
      ? `FROM rank_periods p JOIN users u ON u.id = p.user_id
         WHERE p.game_id = $1 AND p.kind = '${slice.kind}' AND p.period = ${slice.start}
           AND p.${slice.column} > 0 AND u.nick IS NOT NULL`
      : `FROM ratings p JOIN users u ON u.id = p.user_id
         WHERE p.game_id = $1 AND p.rank > 0 AND u.nick IS NOT NULL`;
    const column = slice ? `p.${slice.column}` : 'p.rank';

    const result = await this._db.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE ${column} > $2) AS above
       ${source}`,
      [gameId, rank],
    );

    const row = result.rows[0];

    return {
      placement: Number(row.above) + 1,
      total: Number(row.total),
      rank,
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

  // ***** РОЛИ (master-game-registry, этап 1) *****

  // Синхронизация роли по списку из окружения. Одним запросом и через CASE —
  // чтобы не гасить роль, назначенную из БД (будущее назначение модераторов
  // из админки): понижаем только того, кто получил superadmin из этого же
  // списка и в нём больше не значится.
  async syncRole(userId, isEnvAdmin) {
    const { rows } = await this._db.query(
      `UPDATE users
          SET role = CASE WHEN $2 THEN 'superadmin'
                          WHEN role = 'superadmin' THEN 'user'
                          ELSE role END
        WHERE id = $1
        RETURNING role`,
      [userId, isEnvAdmin],
    );

    return rows[0]?.role ?? 'user';
  }

  // роль читается из БД на каждом админском запросе (не из клейма токена):
  // identity-токен живёт 4 часа, а разжалование обязано действовать сразу
  async getRole(userId) {
    const result = await this._db.query('SELECT role FROM users WHERE id = $1', [userId]);

    return result.rows[0]?.role ?? 'user';
  }

  // ***** РЕЕСТР ИГР (master-game-registry, этап 1) *****

  // каталог для мастеров: только одобренные и только с раздаваемой версией.
  // Сортировка по id, а не по updated_at: порядок каталога обязан быть
  // детерминированным — первая игра становится активной в лобби
  async listApprovedGames() {
    const result = await this._db.query(
      `SELECT ${PUBLIC_GAME_FIELDS} ${PUBLIC_GAME_FROM}
        WHERE g.status = 'approved' AND g.version IS NOT NULL
        ORDER BY g.id`,
    );

    return result.rows.map(mapPublicGame);
  }

  // сколько игр платформа сейчас раздаёт. Нужно ровно одному потребителю —
  // решению модератора: снятая с раздачи последняя игра оставляет лобби без
  // каталога (состояние законное, но неочевидное), и панель обязана сказать
  // об этом в момент решения
  async countApprovedGames() {
    const result = await this._db.query(
      `SELECT count(*)::int AS count FROM games
        WHERE status = 'approved' AND version IS NOT NULL`,
    );

    return result.rows[0]?.count ?? 0;
  }

  // очередь модерации: всё, включая отклонённое и выключенное, свежее сверху
  async listAllGames() {
    const result = await this._db.query(
      `SELECT ${GAME_FIELDS} ${GAME_FROM}
        ORDER BY g.updated_at DESC`,
    );

    return result.rows.map(mapGame);
  }

  async listGamesByAuthor(userId) {
    const result = await this._db.query(
      `SELECT ${GAME_FIELDS} ${GAME_FROM}
        WHERE g.author_user_id = $1
        ORDER BY g.updated_at DESC`,
      [userId],
    );

    return result.rows.map(mapGame);
  }

  async getGame(id) {
    const result = await this._db.query(
      `SELECT ${GAME_FIELDS} ${GAME_FROM} WHERE g.id = $1`,
      [id],
    );

    return mapGame(result.rows[0]);
  }

  // Заявка разработчика. Игра появляется сразу в статусе pending, а
  // запрошенная версия — в pending_version: одобрение переносит её в
  // version, до тех пор мастера игру не раздают.
  //
  // Потолок заявок считается до вставки: 23505 отличить от него нельзя, а
  // сообщение разработчику у них разное
  async createGame({ id, packageName, title = null, repoUrl = null, version, authorUserId }) {
    try {
      // Потолок считается ВНУТРИ вставки: отдельный COUNT(*) до INSERT —
      // гонка, параллельные заявки одного автора пролезали бы мимо лимита.
      // Пустой RETURNING (условие не выполнилось) и есть «лимит исчерпан»:
      // 23505 от него по-прежнему отличается, а сообщения у них разные
      const result = await this._db.query(
        `WITH created AS (
           INSERT INTO games (id, package_name, title, repo_url, author_user_id,
                              status, pending_version)
           SELECT $1, $2, $3, $4, $5, 'pending', $6
            WHERE (SELECT COUNT(*) FROM games WHERE author_user_id = $5) < $7
           RETURNING *
         )
         ${gameProject('created')}`,
        [id, packageName, title, repoUrl, authorUserId, version, config.games.maxPerUser],
      );

      if (result.rows.length === 0) {
        throw new GameLimitError(authorUserId);
      }

      return mapGame(result.rows[0]);
    } catch (err) {
      // 23505 — и первичный ключ id, и games_package_lower_idx: занят либо
      // сегмент URL, либо сам npm-пакет
      if (err.code === '23505') {
        throw new GameExistsError(id);
      }

      throw err;
    }
  }

  // Заявка на новую версию уже заведённой игры. Одобренная version не
  // трогается — игроки продолжают играть в неё, пока админ смотрит новую.
  // Отклонённая ранее игра возвращается в очередь (rejected → pending), а
  // замечание модератора снимается: оно относилось к прошлой версии
  async requestGameVersion(id, version, { userId = null, isAdmin = false } = {}) {
    const result = await this._db.query(
      `WITH updated AS (
         UPDATE games
            SET pending_version = $2,
                moderator_note = NULL,
                status = CASE WHEN status = 'rejected' THEN 'pending' ELSE status END,
                updated_at = now()
          WHERE id = $1 AND ($3 OR author_user_id = $4)
          RETURNING *
       )
       ${gameProject('updated')}`,
      [id, version, isAdmin, userId],
    );

    if (result.rows[0]) {
      return mapGame(result.rows[0]);
    }

    // ноль строк — либо игры нет, либо она чужая; различаем отдельным чтением
    if (await this.getGame(id)) {
      throw new GameForbiddenError(id);
    }

    throw new GameNotFoundError(id);
  }

  // Решение модератора: частичное обновление. SET собирается только из
  // ключей белого списка MODERATABLE, значения — всегда через $n (в текст
  // SQL из patch не попадает ничего)
  async moderateGame(id, patch, moderatorUserId) {
    const sets = ['moderator_user_id = $2', 'updated_at = now()'];
    const values = [id, moderatorUserId];

    for (const [key, column] of Object.entries(MODERATABLE)) {
      if (patch[key] !== undefined) {
        values.push(patch[key]);
        sets.push(`${column} = $${values.length}`);
      }
    }

    // ники дописываются теми же джойнами, что и в выборках: ответ PATCH —
    // проекция той же строки, и потребитель, доверившийся ему, не должен
    // получить null там, где список отдаёт ник. Модератора это касается
    // сильнее прочих: его id проставляет ровно этот запрос
    const result = await this._db.query(
      `WITH updated AS (
         UPDATE games SET ${sets.join(', ')} WHERE id = $1 RETURNING *
       )
       ${gameProject('updated')}`,
      values,
    );

    if (!result.rows[0]) {
      throw new GameNotFoundError(id);
    }

    return mapGame(result.rows[0]);
  }
}
