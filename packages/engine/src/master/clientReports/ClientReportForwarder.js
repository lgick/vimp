// Пересылка журнала клиентских ошибок из буфера бокса в auth-сервис
// (plan/client-reports, этап 2): раз в intervalMs пачками по batchSize,
// Bearer — общий секрет VIMP_CLIENT_REPORTS_TOKEN. Сбой auth не ломает бокс:
// пачка возвращается в буфер до следующего тика

const LOG_PREFIX = '[vimp:client-report]';
const THROTTLE_LOG_MS = 60 * 60 * 1000;

export default class ClientReportForwarder {
  constructor({
    buffer,
    authServiceUrl,
    token,
    fetchImpl = fetch,
    intervalMs = 30000,
    batchSize = 50,
    timeoutMs = 5000,
    log = console,
    // служебные записи тика (reports.dropped): зовётся в начале каждого
    // flush, результат идёт первой пачкой в обход бюджета буфера
    extraEntries = () => [],
    now = Date.now,
  }) {
    this._buffer = buffer;
    this._url = authServiceUrl;
    this._token = token;
    this._fetch = fetchImpl;
    this._intervalMs = intervalMs;
    this._batchSize = batchSize;
    this._timeoutMs = timeoutMs;
    this._log = log;
    this._extraEntries = extraEntries;
    this._now = now;

    this._timer = null;
    this._flushing = null;
    // одна строка журнала на серию отказов, сбрасывается первым успехом
    this._failureReported = false;
    // отсечённое auth копится и печатается не чаще раза в час
    this._throttled = 0;
    this._throttleLoggedAt = null;
  }

  get enabled() {
    return Boolean(this._token && this._url);
  }

  // при выключенной пересылке тик зовёт extraEntries() (строку об
  // отброшенном уже написал makeDroppedEntry, а счётчики не копятся вечно) и
  // опустошает буфер
  start() {
    if (this._timer) {
      return;
    }

    this._timer = setInterval(() => {
      this.flush().catch(err =>
        this._log.error(`${LOG_PREFIX} flush failed:`, err.message),
      );
    }, this._intervalMs);

    this._timer.unref?.();
  }

  // параллельные flush не допускаются: второй вызов ждёт идущий
  flush() {
    if (!this._flushing) {
      this._flushing = this._flush().finally(() => {
        this._flushing = null;
      });
    }

    return this._flushing;
  }

  async _flush() {
    const extra = this._extraEntries();

    // пересылки нет — буфер всё равно опустошается: строки `new …` уже
    // напечатаны при приёме, а переполненный буфер отсёк бы новые отпечатки
    // как bufferFull и заглушил бы журнал процесса
    if (!this.enabled) {
      this._buffer.drain(Infinity);
      return;
    }

    let pending = extra.slice();

    while (pending.length > 0 || this._buffer.size > 0) {
      const room = Math.max(this._batchSize - pending.length, 0);
      const batch = [...pending, ...this._buffer.drain(room)];

      pending = [];

      if (!(await this._send(batch))) {
        return;
      }
    }
  }

  // → true, если можно продолжать цикл
  async _send(batch) {
    let res;

    try {
      res = await this._fetch(`${this._url}/client-reports`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this._token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ items: batch }),
        signal: AbortSignal.timeout(this._timeoutMs),
      });
    } catch (err) {
      this._buffer.restore(batch);
      this._reportFailure(err.message);
      return false;
    }

    // 400 — пачку auth не примет и в следующий раз: вернуть её значило бы
    // вечный цикл
    if (res.status === 400) {
      this._log.warn(
        `${LOG_PREFIX} auth rejected a batch of ${batch.length}: 400`,
      );
      return false;
    }

    if (res.status < 200 || res.status >= 300) {
      this._buffer.restore(batch);
      this._reportFailure(res.status);
      return false;
    }

    this._failureReported = false;

    const json = await res.json().catch(() => null);

    // отсечённое бюджетом auth — не сбой, а решение auth: не возвращается
    if (json?.throttled > 0) {
      this._noteThrottled(json.throttled);
    }

    return true;
  }

  _reportFailure(reason) {
    if (this._failureReported) {
      return;
    }

    this._failureReported = true;
    this._log.warn(`${LOG_PREFIX} forward failed: ${reason}`);
  }

  _noteThrottled(count) {
    this._throttled += count;

    const now = this._now();

    if (
      this._throttleLoggedAt !== null &&
      now - this._throttleLoggedAt < THROTTLE_LOG_MS
    ) {
      return;
    }

    this._log.warn(
      `${LOG_PREFIX} auth throttled ${this._throttled} new reports`,
    );
    this._throttled = 0;
    this._throttleLoggedAt = now;
  }

  // для graceful shutdown: без таймера и с последним flush
  async stop() {
    clearInterval(this._timer);
    this._timer = null;

    await this.flush();
  }
}
