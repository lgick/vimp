import config from '../config/auth.js';
import dbPool from './pool.js';
import ClientReportRepository from '../ClientReportRepository.js';
import { msUntilNextRun } from './gamesPurgeJob.js';

// Удаление строк журнала клиентских ошибок (plan/client-reports), не
// повторявшихся дольше config.clientReports.retentionDays. Ошибка, которая
// не случается три месяца, либо исправлена, либо ушла вместе со старой
// версией — держать её незачем, а таблица без очистки растёт до потолка
// бюджета (lib/ClientReportBudget.js).
const DAY_MS = 24 * 60 * 60 * 1000;

// Ключ консультативной блокировки: уникален в пределах базы (у ratingsJob и
// gamesPurgeJob свои) — pg_advisory_lock живёт в общем пространстве ключей.
const LOCK_KEY = 0x63727067; // 'crpg'

/**
 * Один прогон очистки. Блокировка и одно соединение на весь прогон — по тем
 * же причинам, что в gamesPurgeJob: реплик auth может быть больше одной, а
 * сессионный замок снимается только из своего соединения.
 * @param {Object} db - Пул соединений (pg.Pool или совместимый мок).
 * @param {Object} [options] - Настройки прогона.
 * @param {number} [options.now] - Момент отсчёта срока (для тестов).
 * @returns {Promise<number>} Число удалённых строк.
 */
export async function purgeOldClientReports(db, { now = Date.now() } = {}) {
  const client = await db.connect();

  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS got', [
      LOCK_KEY,
    ]);

    if (!lock.rows?.[0]?.got) {
      console.info('[client-reports] another purge holds the lock, skipping');

      return 0;
    }

    try {
      const before = new Date(
        now - config.clientReports.retentionDays * DAY_MS,
      );
      const purged = await new ClientReportRepository(client).purge(before);

      if (purged > 0) {
        console.info(`[client-reports] purged ${purged}`);
      }

      return purged;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release?.();
  }
}

// планировщик — как в gamesPurgeJob: таймаут до ближайших 00:15 UTC и новый
// таймаут после каждого прогона; таймер .unref(), чтобы не держать процесс
export function startClientReportsPurgeJob(db) {
  let timer = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      purgeOldClientReports(db)
        .catch(err => console.error('[client-reports] purge failed', err))
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

// ручной прогон: node packages/auth/src/db/clientReportsPurgeJob.js
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  purgeOldClientReports(dbPool.getPool())
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[client-reports] purge failed', err);
      process.exit(1);
    });
}
