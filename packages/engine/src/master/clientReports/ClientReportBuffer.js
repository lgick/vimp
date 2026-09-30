// Агрегат отчётов в памяти бокса до пересылки в auth (plan/client-reports,
// этап 2): одна запись на отпечаток, повторы складываются в count.
//
// Главный ресурс — НОВЫЕ строки (решение 9 плана): повтор известного
// отпечатка (в буфере или уже принимавшегося процессом) бюджет не тратит, а
// новый проходит только в пределах бюджета минуты и места в буфере. Отказы
// считаются и уходят в журнал служебной записью reports.dropped — атака
// видна, а не тиха
export default class ClientReportBuffer {
  constructor({
    maxPending = 500,
    logSeenMax = 5000,
    newPerMinute = 60,
    now = Date.now,
  } = {}) {
    this._maxPending = maxPending;
    this._logSeenMax = logSeenMax;
    this._newPerMinute = newPerMinute;
    this._now = now;

    this._entries = new Map(); // fingerprint -> entry
    this._logged = new Set(); // отпечатки, о которых процесс уже писал в журнал
    this._minute = null;
    this._spent = 0;
    this._dropped = { budget: 0, bufferFull: 0 };
  }

  get size() {
    return this._entries.size;
  }

  has(fingerprint) {
    return this._entries.has(fingerprint);
  }

  // известный = лежит в буфере или уже принимался процессом (ушёл пересылкой).
  // В _logged попадают только принятые записи, поэтому спамер пополняет его
  // не быстрее бюджета новых
  isKnown(fingerprint) {
    return this._entries.has(fingerprint) || this._logged.has(fingerprint);
  }

  // фиксированное окно: бюджет обнуляется со сменой минуты
  _budgetLeft() {
    const minute = Math.floor(this._now() / 60000);

    if (minute !== this._minute) {
      this._minute = minute;
      this._spent = 0;
    }

    return this._newPerMinute - this._spent;
  }

  // можно ли сейчас принять НОВЫЙ отпечаток (бюджет и место), без списания —
  // маршрут спрашивает ДО расшифровки стека, чтобы спам не жёг CPU
  canAcceptNew() {
    if (this._budgetLeft() <= 0) {
      return 'budget';
    }

    if (this._entries.size >= this._maxPending) {
      return 'bufferFull';
    }

    return null;
  }

  // учесть отброшенный новый отпечаток (маршрут, получив отказ canAcceptNew)
  countDropped(reason) {
    if (reason in this._dropped) {
      this._dropped[reason] += 1;
    }
  }

  _merge(target, entry) {
    target.count += entry.count;
    target.firstSeen = Math.min(target.firstSeen, entry.firstSeen);
    target.lastSeen = Math.max(target.lastSeen, entry.lastSeen);
  }

  // запоминает отпечаток как «уже печатал»; при переполнении множество
  // чистится целиком — лучше повторная строка в журнале, чем растущая память
  _markLogged(fingerprint) {
    if (this._logged.has(fingerprint)) {
      return false;
    }

    if (this._logged.size >= this._logSeenMax) {
      this._logged.clear();
    }

    this._logged.add(fingerprint);

    return true;
  }

  /**
   * @param {Object} entry - Полная запись для auth (fingerprint, source, kind,
   *   code, message, stack, details, count, firstSeen, lastSeen,
   *   engineVersion, gameId, gameVersion, box, mode, userAgent).
   * @returns {{ accepted: boolean, isNew: boolean }} isNew — процесс видит
   *   отпечаток впервые (для строки в журнале).
   */
  add(entry) {
    const known = this._entries.get(entry.fingerprint);

    if (known) {
      this._merge(known, entry);
      return { accepted: true, isNew: this._markLogged(entry.fingerprint) };
    }

    // уже принимался, но ушёл пересылкой: бюджет не тратит, строки `new` нет,
    // но место в буфере ему всё равно нужно
    if (this._logged.has(entry.fingerprint)) {
      if (this._entries.size >= this._maxPending) {
        this.countDropped('bufferFull');
        return { accepted: false, isNew: false };
      }

      this._entries.set(entry.fingerprint, { ...entry });

      return { accepted: true, isNew: false };
    }

    const reason = this.canAcceptNew();

    if (reason) {
      this.countDropped(reason);
      return { accepted: false, isNew: false };
    }

    this._spent += 1;
    this._entries.set(entry.fingerprint, { ...entry });

    return { accepted: true, isNew: this._markLogged(entry.fingerprint) };
  }

  // снимает до max записей, старые по lastSeen — первыми
  drain(max) {
    const batch = [...this._entries.values()]
      .sort((a, b) => a.lastSeen - b.lastSeen)
      .slice(0, max);

    for (const entry of batch) {
      this._entries.delete(entry.fingerprint);
    }

    return batch;
  }

  // вернуть неотправленное: это уже принятые записи, поэтому в обход
  // бюджета, но не больше maxPending
  restore(entries) {
    for (const entry of entries) {
      const known = this._entries.get(entry.fingerprint);

      if (known) {
        this._merge(known, entry);
      } else if (this._entries.size < this._maxPending) {
        this._entries.set(entry.fingerprint, { ...entry });
      }
    }
  }

  // { budget, bufferFull } с прошлого вызова, счётчики обнуляются
  drainDropped() {
    const dropped = this._dropped;

    this._dropped = { budget: 0, bufferFull: 0 };

    return dropped;
  }
}
