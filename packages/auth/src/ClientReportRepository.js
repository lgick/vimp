// Журнал клиентских ошибок (plan/client-reports): таблица client_reports,
// строка — отпечаток, повторы копятся в count. Отдельный класс, а не часть
// UserRepository: у журнала своя таблица и свои потребители (приём от
// боксов, панель админа, суточная очистка).

export class ClientReportNotFoundError extends Error {
  constructor(id) {
    super(`client report ${id} not found`);
    this.name = 'ClientReportNotFoundError';
  }
}

// колонки наружу: все, кроме status_by — вместо него ник через JOIN
const REPORT_COLUMNS = `
  r.id, r.fingerprint, r.source, r.kind, r.code, r.message, r.stack, r.details,
  r.engine_version, r.game_id, r.game_version, r.box, r.mode, r.user_agent,
  r.count, r.first_seen, r.last_seen, r.status, r.status_note, r.status_at,
  u.nick AS status_by_nick`;

const iso = value => (value ? new Date(value).toISOString() : null);

function mapReport(row) {
  return {
    id: Number(row.id),
    fingerprint: row.fingerprint,
    source: row.source,
    kind: row.kind,
    code: row.code,
    message: row.message,
    stack: row.stack,
    details: row.details,
    engineVersion: row.engine_version,
    gameId: row.game_id,
    gameVersion: row.game_version,
    box: row.box,
    mode: row.mode,
    userAgent: row.user_agent,
    // pg отдаёт BIGINT строкой
    count: Number(row.count),
    firstSeen: iso(row.first_seen),
    lastSeen: iso(row.last_seen),
    status: row.status,
    statusNote: row.status_note,
    statusByNick: row.status_by_nick ?? null,
    statusAt: iso(row.status_at),
  };
}

// дубликаты отпечатка внутри пачки сливаются заранее: INSERT … ON CONFLICT
// DO UPDATE падает, если одна команда задевает одну строку дважды
function mergeDuplicates(items) {
  const byFingerprint = new Map();

  for (const item of items) {
    const seen = byFingerprint.get(item.fingerprint);

    if (!seen) {
      byFingerprint.set(item.fingerprint, { ...item });
      continue;
    }

    seen.count += item.count;
    seen.firstSeen = item.firstSeen < seen.firstSeen ? item.firstSeen : seen.firstSeen;
    seen.lastSeen = item.lastSeen > seen.lastSeen ? item.lastSeen : seen.lastSeen;
  }

  return [...byFingerprint.values()];
}

const toRecord = item => ({
  fingerprint: item.fingerprint,
  source: item.source,
  kind: item.kind,
  code: item.code,
  message: item.message,
  stack: item.stack,
  details: item.details,
  'engine_version': item.engineVersion,
  'game_id': item.gameId,
  'game_version': item.gameVersion,
  box: item.box,
  mode: item.mode,
  'user_agent': item.userAgent,
  count: item.count,
  'first_seen': item.firstSeen.toISOString(),
  'last_seen': item.lastSeen.toISOString(),
});

export default class ClientReportRepository {
  // db — pg Pool или заглушка { query }
  constructor(db) {
    this._db = db;
  }

  /**
   * Пачка нормализованных записей (lib/clientReportValidators.js).
   * Известные отпечатки проходят всегда, новые — сколько разрешит бюджет.
   * Статус при повторе не меняется: исправление выходит новой версией, а
   * версия входит в отпечаток.
   * @param {Object[]} items
   * @param {Object} [options]
   * @param {Function} [options.allowNew] - n → сколько НОВЫХ отпечатков
   *   разрешено вставить (lib/ClientReportBudget.js).
   * @returns {Promise<{accepted: number, throttled: number}>}
   */
  async ingest(items, { allowNew = n => n } = {}) {
    const merged = mergeDuplicates(items);
    const { rows } = await this._db.query(
      'SELECT fingerprint FROM client_reports WHERE fingerprint = ANY($1::text[])',
      [merged.map(item => item.fingerprint)],
    );
    const known = new Set(rows.map(row => row.fingerprint));
    const fresh = merged.filter(item => !known.has(item.fingerprint));
    const allowed = fresh.length > 0 ? Math.max(0, Math.min(fresh.length, allowNew(fresh.length))) : 0;
    const allowedFresh = new Set(fresh.slice(0, allowed));
    // порядок пачки сохраняется; гонку «между SELECT и INSERT отпечаток
    // вставил другой запрос» закрывает ON CONFLICT — запись обновит счётчик
    const passed = merged.filter(item => known.has(item.fingerprint) || allowedFresh.has(item));

    if (passed.length > 0) {
      await this._db.query(
        `INSERT INTO client_reports (fingerprint, source, kind, code, message, stack,
           details, engine_version, game_id, game_version, box, mode, user_agent,
           count, first_seen, last_seen)
         SELECT fingerprint, source, kind, code, message, stack, details,
           engine_version, game_id, game_version, box, mode, user_agent,
           count, first_seen, last_seen
         FROM jsonb_to_recordset($1::jsonb) AS r(
           fingerprint text, source text, kind text, code text, message text,
           stack text, details jsonb, engine_version text, game_id text,
           game_version text, box text, mode text, user_agent text,
           count bigint, first_seen timestamptz, last_seen timestamptz)
         ON CONFLICT (fingerprint) DO UPDATE SET
           count      = client_reports.count + EXCLUDED.count,
           first_seen = LEAST(client_reports.first_seen, EXCLUDED.first_seen),
           last_seen  = GREATEST(client_reports.last_seen, EXCLUDED.last_seen),
           stack      = COALESCE(client_reports.stack, EXCLUDED.stack),
           details    = COALESCE(client_reports.details, EXCLUDED.details)`,
        [JSON.stringify(passed.map(toRecord))],
      );
    }

    return { accepted: passed.length, throttled: fresh.length - allowed };
  }

  // точное число строк — для потолка таблицы (бюджет пересчитывает редко)
  async countRows() {
    const { rows } = await this._db.query('SELECT count(*)::bigint AS n FROM client_reports');

    return Number(rows[0].n);
  }

  /**
   * @param {Object} [filter]
   * @param {string} [filter.status] - 'open' | 'fixed' | 'ignored' | 'all'.
   * @param {string|null} [filter.gameId]
   * @param {number} [filter.limit]
   * @param {number} [filter.offset]
   * @returns {Promise<{reports: Object[], total: number}>}
   */
  async list({ status = 'open', gameId = null, limit = 50, offset = 0 } = {}) {
    const where = [];
    const values = [];

    if (status !== 'all') {
      values.push(status);
      where.push(`r.status = $${values.length}`);
    }

    if (gameId) {
      values.push(gameId);
      where.push(`r.game_id = $${values.length}`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this._db.query(
      `SELECT ${REPORT_COLUMNS}
       FROM client_reports r
       LEFT JOIN users u ON u.id = r.status_by
       ${whereSql}
       ORDER BY r.last_seen DESC, r.id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );
    const counted = await this._db.query(
      `SELECT count(*)::bigint AS n FROM client_reports r ${whereSql}`,
      values,
    );

    return { reports: rows.map(mapReport), total: Number(counted.rows[0].n) };
  }

  // строка или null
  async get(id) {
    const { rows } = await this._db.query(
      `SELECT ${REPORT_COLUMNS}
       FROM client_reports r
       LEFT JOIN users u ON u.id = r.status_by
       WHERE r.id = $1`,
      [id],
    );

    return rows[0] ? mapReport(rows[0]) : null;
  }

  /**
   * Решение админа по строке.
   * @returns {Promise<Object>} Обновлённая строка (та же проекция, что в list).
   * @throws {ClientReportNotFoundError}
   */
  async setStatus(id, { status, note = null, userId }) {
    // ник того, кто решил, — в том же запросе: панель заменяет строку ответом
    const result = await this._db.query(
      `WITH r AS (
         UPDATE client_reports
         SET status = $2, status_note = $3, status_by = $4, status_at = now()
         WHERE id = $1
         RETURNING *
       )
       SELECT ${REPORT_COLUMNS}
       FROM r
       LEFT JOIN users u ON u.id = r.status_by`,
      [id, status, note, userId],
    );

    if (!result.rowCount) {
      throw new ClientReportNotFoundError(id);
    }

    return mapReport(result.rows[0]);
  }

  // Date → число удалённых строк
  async purge(before) {
    const result = await this._db.query('DELETE FROM client_reports WHERE last_seen < $1', [before]);

    return result.rowCount ?? 0;
  }
}
