import config from '../config/auth.js';
import dbPool from './pool.js';
import UserRepository from '../UserRepository.js';

// Полное удаление игр, пролежавших в графе Deleted дольше
// config.games.deleteRetentionDays. Отдельная задача, а не работа удаляющего
// запроса: срок обязан быть одинаковым для всех, и очистить графу руками
// нельзя — восстановление должно быть возможно всё это время.
const DAY_MS = 24 * 60 * 60 * 1000;

// прогон в 00:15 UTC: суточный пересчёт рейтингов идёт в 00:05, и разводить
// две задачи по времени дешевле, чем разбирать их логи вперемешку
const RUN_AT_MINUTE = 15;

// Ключ консультативной блокировки. Произвольное число, важна только его
// уникальность в пределах базы (у ratingsJob свой) — pg_advisory_lock живёт
// в общем для всей БД пространстве ключей.
const LOCK_KEY = 0x67707267; // 'gprg'

/**
 * Один прогон очистки.
 *
 * Блокировка нужна по той же причине, что и в ratingsJob: реплик auth может
 * быть больше одной, и параллельные прогоны читали бы один список игр,
 * дублируя удаления. Здесь это не портит данные (удаление идемпотентно), но
 * стоит лишних проходов по большим таблицам.
 *
 * Блокировка сессионная, поэтому ей нужно ОДНО соединение на всё время
 * прогона: через пул каждый запрос мог бы уйти в разное соединение, и
 * разблокировка не нашла бы своего замка.
 * @param {Object} db - Пул соединений (pg.Pool или совместимый мок).
 * @param {Object} [options] - Настройки прогона.
 * @param {number} [options.now] - Момент отсчёта срока (для тестов).
 * @returns {Promise<string[]>} Идентификаторы вычищенных игр.
 */
export async function purgeDeletedGames(db, { now = Date.now() } = {}) {
  const client = await db.connect();

  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY]);

    if (!lock.rows?.[0]?.got) {
      console.info('[games] another purge holds the lock, skipping');

      return [];
    }

    try {
      const before = new Date(now - config.games.deleteRetentionDays * DAY_MS);
      const ids = await new UserRepository(client).purgeGames(before);

      if (ids.length > 0) {
        console.info(`[games] purged ${ids.length} game(s): ${ids.join(', ')}`);
      }

      return ids;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release?.();
  }
}

// миллисекунды до ближайших 00:15 UTC
export function msUntilNextRun(now = Date.now()) {
  const next = new Date(now);

  next.setUTCHours(0, RUN_AT_MINUTE, 0, 0);

  if (next.getTime() <= now) {
    next.setTime(next.getTime() + DAY_MS);
  }

  return next.getTime() - now;
}

// планировщик — таймаут до ближайших 00:15 UTC и новый таймаут после каждого
// прогона, как в ratingsJob: суточный setInterval отсчитывает сутки от
// предыдущего СРАБАТЫВАНИЯ и за месяцы уехал бы на произвольное время.
// Таймер .unref(), чтобы задача не держала процесс
export function startGamesPurgeJob(db) {
  let timer = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      purgeDeletedGames(db)
        .catch(err => console.error('[games] purge failed', err))
        .finally(schedule);
    }, msUntilNextRun());

    timer.unref?.();
  };

  schedule();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// ручной прогон: npm -w @vimp/auth run db:games-purge
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  purgeDeletedGames(dbPool.getPool())
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[games] purge failed', err);
      process.exit(1);
    });
}
