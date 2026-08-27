import config from '../config/auth.js';
import dbPool from './pool.js';

// snakes-v3 (stage_2.md, 2.4): all-time считается РАЗ В СУТКИ, а не на
// каждой записи результата — и список, и своя строка показывают снимок на
// 00:00 UTC. Курсор инкремента — ratings.updated_at: суммируются только
// события, пришедшие после последнего прогона, поэтому стоимость задачи
// зависит от суток, а не от всей истории.
//
// Граничный случай «событие ровно в момент updated_at» разрешён в пользу
// ПОВТОРНОГО учёта: сравнение нестрогое (>=), а updated_at переставляется на
// now(). Двойного начисления это не даёт — следующее окно стартует уже с
// нового updated_at, и такое совпадение стоит одной лишней суммы в одном
// прогоне. Строгий `>` от последнего учтённого created_at был бы точнее, но
// требовал бы второго курсора; цена ошибки здесь ниже цены лишней колонки.
const REFRESH_SQL = `
  INSERT INTO ratings (user_id, game_id, rank, updated_at)
  SELECT e.user_id, e.game_id,
         LEAST($2, GREATEST($1, COALESCE(r.rank, 0) + SUM(e.delta)))::int,
         now()
  FROM rank_events e
  LEFT JOIN ratings r ON r.user_id = e.user_id AND r.game_id = e.game_id
  WHERE e.voided = false
    AND e.created_at >= COALESCE(r.updated_at, '-infinity'::timestamptz)
  GROUP BY e.user_id, e.game_id, r.rank
  ON CONFLICT (user_id, game_id)
  DO UPDATE SET rank = EXCLUDED.rank, updated_at = now()`;

const DAY_MS = 24 * 60 * 60 * 1000;

// прогон в 00:05 UTC, а не в 00:00: дневной срез (MAX(best)) обнуляется
// ровно в полночь, и пять минут форы разводят два события в логах
const RUN_AT_MINUTE = 5;

export async function refreshRatings(db) {
  const started = Date.now();
  const result = await db.query(REFRESH_SQL, [config.rank.min, config.rank.max]);
  const rows = result?.rowCount ?? 0;

  console.info(`[ratings] refreshed ${rows} rows in ${Date.now() - started} ms`);

  return rows;
}

// миллисекунды до ближайших 00:05 UTC
export function msUntilNextRun(now = Date.now()) {
  const next = new Date(now);

  next.setUTCHours(0, RUN_AT_MINUTE, 0, 0);

  if (next.getTime() <= now) {
    next.setTime(next.getTime() + DAY_MS);
  }

  return next.getTime() - now;
}

// планировщика в auth нет — минимальный свой: таймаут до ближайших 00:05 UTC,
// дальше сутки. Оба таймера .unref(), чтобы задача не держала процесс
export function startRatingsJob(db) {
  const run = () => {
    refreshRatings(db).catch(err => console.error('[ratings] refresh failed', err));
  };

  let interval = null;
  const timeout = setTimeout(() => {
    run();
    interval = setInterval(run, DAY_MS);
    interval.unref?.();
  }, msUntilNextRun());

  timeout.unref?.();

  return () => {
    clearTimeout(timeout);

    if (interval) {
      clearInterval(interval);
    }
  };
}

// ручной прогон: npm -w @vimp/auth run db:ratings
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  refreshRatings(dbPool.getPool())
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[ratings] failed', err);
      process.exit(1);
    });
}
