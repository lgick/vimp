// Бюджет НОВЫХ строк журнала клиентских ошибок (plan/client-reports,
// решение 9). Повтор известного отпечатка стоит один UPDATE count и не
// ограничивается; ограничивается появление новых строк — по IP отправителя,
// общим часовым бюджетом и потолком таблицы.
//
// В памяти процесса: auth-сервис — один процесс, после рестарта бюджеты
// начинаются заново, это допустимо. Окна фиксированные часовые — скользящее
// здесь ничего не даёт, а Map по IP при смене часа очищается целиком, то
// есть память не растёт.

const HOUR_MS = 60 * 60 * 1000;

export default class ClientReportBudget {
  /**
   * @param {Object} opts - config.clientReports.budget
   * @param {number} opts.newPerIpPerHour
   * @param {number} opts.newGlobalPerHour
   * @param {number} opts.maxRows
   * @param {Function} [opts.now]
   */
  constructor({ newPerIpPerHour, newGlobalPerHour, maxRows, now = Date.now }) {
    this._perIp = newPerIpPerHour;
    this._global = newGlobalPerHour;
    this._maxRows = maxRows;
    this._now = now;

    this._hour = Math.floor(now() / HOUR_MS);
    this._byIp = new Map();
    this._globalUsed = 0;
    this._rows = 0;
    this._throttled = { ip: 0, global: 0, maxRows: 0 };
  }

  // текущее число строк: задаёт вход (пересчёт count(*)), растёт от take()
  setRows(n) {
    this._rows = n;
  }

  // сколько из wanted новых строк разрешено ключу ip прямо сейчас;
  // разрешённое сразу списывается из обоих бюджетов и прибавляется к строкам
  take(ip, wanted) {
    this._rollHour();

    const limits = {
      ip: this._perIp - (this._byIp.get(ip) ?? 0),
      global: this._global - this._globalUsed,
      maxRows: this._maxRows - this._rows,
    };
    const allowed = Math.max(0, Math.min(wanted, limits.ip, limits.global, limits.maxRows));

    if (allowed > 0) {
      this._byIp.set(ip, (this._byIp.get(ip) ?? 0) + allowed);
      this._globalUsed += allowed;
      this._rows += allowed;
    }

    if (allowed < wanted) {
      // причина — тот бюджет, что ограничил сильнее
      const reason = Object.keys(limits).reduce((a, b) => (limits[b] < limits[a] ? b : a));

      this._throttled[reason] += wanted - allowed;
    }

    return allowed;
  }

  // { reason, skipped } — сводка отсечённого с прошлого вызова, для журнала;
  // reason — причина, по которой отсечено больше всего
  drainThrottled() {
    const counts = this._throttled;
    const skipped = counts.ip + counts.global + counts.maxRows;
    const reason = skipped > 0
      ? Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a))
      : null;

    this._throttled = { ip: 0, global: 0, maxRows: 0 };

    return { reason, skipped };
  }

  _rollHour() {
    const hour = Math.floor(this._now() / HOUR_MS);

    if (hour !== this._hour) {
      this._hour = hour;
      this._byIp.clear();
      this._globalUsed = 0;
    }
  }
}
