import config from '../config/auth.js';
import dbPool from './pool.js';

// snakes-v3 (stage_2.md, 2.4): all-time считается РАЗ В СУТКИ, а не на
// каждой записи результата — и список, и своя строка показывают снимок на
// 00:00 UTC. Курсор инкремента — ratings.updated_at: суммируются только
// события, пришедшие после последнего прогона, поэтому стоимость задачи
// зависит от суток, а не от всей истории.
//
// ***** ПОЧЕМУ КУРСОР — MAX(created_at), А НЕ now() *****
//
// now() в Postgres это время НАЧАЛА транзакции, а её снимок видит только то,
// что закоммичено к этому моменту. Курсор now() терял бы события в узком, но
// реальном окне: параллельный PUT /rank со своим created_at = tc чуть РАНЬШЕ
// начала прогона, закоммиченный чуть ПОЗЖЕ, в снимок не попадает (не
// закоммичен) и в следующее окно тоже (tc < сохранённого now()). Строка
// выпадает из all-time навсегда и чинится только полным recomputeRank.
//
// Курсором поэтому служит максимальный created_at, который прогон РЕАЛЬНО
// учёл, а сравнение строгое (>). События, закоммиченные позже снимка, но с
// более ранней меткой, подхватывает следующий прогон.
//
// Остаточный риск — два события одной пары (user, game) с совпадающим до
// микросекунды created_at: второе потерялось бы. Это на порядки менее
// вероятно прежнего окна (одна пара пишется одной комнатой не чаще
// minFlushInterval), и оно чинится тем же recomputeRank.
const REFRESH_SQL = `
  INSERT INTO ratings (user_id, game_id, rank, updated_at)
  SELECT e.user_id, e.game_id,
         LEAST($2, GREATEST($1, COALESCE(r.rank, 0) + SUM(e.delta)))::int,
         MAX(e.created_at)
  FROM rank_events e
  LEFT JOIN ratings r ON r.user_id = e.user_id AND r.game_id = e.game_id
  WHERE e.voided = false
    AND e.created_at > COALESCE(r.updated_at, '-infinity'::timestamptz)
  GROUP BY e.user_id, e.game_id, r.rank
  ON CONFLICT (user_id, game_id)
  DO UPDATE SET rank = EXCLUDED.rank, updated_at = EXCLUDED.updated_at`;

const DAY_MS = 24 * 60 * 60 * 1000;

// прогон в 00:05 UTC, а не в 00:00: дневной срез (MAX(best)) обнуляется
// ровно в полночь, и пять минут форы разводят два события в логах
const RUN_AT_MINUTE = 5;

// Ключ консультативной блокировки прогона. Произвольное число, важна только
// его уникальность в пределах базы — pg_advisory_lock живёт в общем для всей
// БД пространстве ключей.
const LOCK_KEY = 0x72617469; // 'rati'

// Прогон обязан быть ОДИН. Запрос инкрементный (prev + SUM новых событий), и
// два параллельных прогона не «сделают лишнюю работу», а удвоят суточные
// очки каждому игроку: второй читает то же самое ratings.updated_at, потому
// что первый ещё не закоммитил своё now(). Восстановить это можно только
// полным recomputeRank по всем парам.
//
// Параллельность здесь не гипотетическая: реплик auth может быть больше
// одной (startRatingsJob зовётся при старте КАЖДОГО процесса), ручной
// `npm run db:ratings` может совпасть с плановым, а перезапуск процесса —
// попасть ровно в окно прогона.
//
// Блокировка сессионная, поэтому ей нужно ОДНО соединение на всё время
// прогона: через пул каждый запрос мог бы уйти в разное соединение, и
// разблокировка не нашла бы своего замка.
export async function refreshRatings(db) {
  const client = await db.connect();

  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY]);

    if (!lock.rows?.[0]?.got) {
      console.info('[ratings] another run holds the lock, skipping');

      return 0;
    }

    try {
      const started = Date.now();
      const result = await client.query(REFRESH_SQL, [config.rank.min, config.rank.max]);
      const rows = result?.rowCount ?? 0;

      console.info(`[ratings] refreshed ${rows} rows in ${Date.now() - started} ms`);

      return rows;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release?.();
  }
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

// планировщика в auth нет — минимальный свой: таймаут до ближайших 00:05 UTC
// и новый таймаут после каждого прогона. Именно таймаут, а не суточный
// setInterval: интервал отсчитывает сутки от предыдущего СРАБАТЫВАНИЯ, а
// таймеры Node точности не обещают — за месяцы прогон уехал бы с 00:05 на
// произвольное время. Пересчёт от календаря возвращает его на место после
// каждой задержки. Таймер .unref(), чтобы задача не держала процесс
export function startRatingsJob(db) {
  let timer = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      refreshRatings(db)
        .catch(err => console.error('[ratings] refresh failed', err))
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

// ручной прогон: npm -w @vimp/auth run db:ratings
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  refreshRatings(dbPool.getPool())
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[ratings] failed', err);
      process.exit(1);
    });
}
