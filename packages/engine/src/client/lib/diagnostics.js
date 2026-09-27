// Журнал клиентских ошибок (plan/client-reports, этап 3): неперехваченные
// ошибки и отклонения страницы, ошибки Worker'а хоста, нарушения CSP и явные
// warn/capture плагинов уходят на свой же бокс (POST /client-reports), а тот
// пересылает их в центральный журнал.
//
// Репортёр не должен стать новым источником падений и шума: каждая
// публичная функция глушит свои исключения, повтор известной ошибки — только
// счётчик, разных ошибок за сессию не больше maxKeysPerSession, отправка —
// пачками с дельтами счётчиков: первая через 2 с, следующие не чаще раза в
// 10 с. console.* не перехватывается осознанно: там шум и случайные данные в
// аргументах.

// обрезки — те же числа, что у приёма на боксе (stage_2.md, контракт)
const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
const MAX_CODE = 64;
const MAX_DETAILS_BYTES = 2048;

// пачка: не больше 10 записей (лимит бокса) и заметно меньше его 16 КБ тела
const MAX_BATCH_ITEMS = 10;
const MAX_BATCH_BYTES = 15000;
const SHRUNK_STACK = 1000;

const CODE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// кадр стека с позицией «:строка:колонка» — он и различает одинаковые
// сообщения из разных мест
const FRAME_RE = /:\d+:\d+/;

// расширения браузера игрока внедряют скрипты и стили — их нарушения CSP
// утопили бы журнал в чужом шуме
const EXTENSION_PREFIXES = [
  'chrome-extension:',
  'moz-extension:',
  'safari-extension:',
  'safari-web-extension:',
];

// служебные значения blockedURI — не URL, берутся как есть
const CSP_KEYWORDS = new Set(['', 'inline', 'eval', 'wasm-eval', 'data', 'blob']);

const encoder = new TextEncoder();

function byteLength(str) {
  return encoder.encode(str).length;
}

function makeSessionId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    // нет безопасного контекста — ниже фолбэк
  }

  return (
    Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
  );
}

function safeString(value) {
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

function topFrame(stack) {
  if (!stack) {
    return '';
  }

  return stack.split('\n').find(line => FRAME_RE.test(line))?.trim() ?? '';
}

// снимок деталей: простой объект ≤ 2048 байт JSON, иначе пометка усечения
function normalizeDetails(details) {
  if (details === null || details === undefined) {
    return null;
  }

  try {
    const json = JSON.stringify(details);

    if (
      typeof details !== 'object' ||
      json === undefined ||
      byteLength(json) > MAX_DETAILS_BYTES
    ) {
      return { truncated: true };
    }

    return JSON.parse(json);
  } catch {
    return { truncated: true };
  }
}

// URL без query и hash: в них бывают токены и прочие личные данные
function stripUrl(value) {
  const str = typeof value === 'string' ? value : '';

  if (CSP_KEYWORDS.has(str)) {
    return str;
  }

  try {
    const url = new URL(str);

    return url.origin + url.pathname;
  } catch {
    return str.split(/[?#]/)[0];
  }
}

function isExtensionUrl(value) {
  return (
    typeof value === 'string' &&
    EXTENSION_PREFIXES.some(prefix => value.startsWith(prefix))
  );
}

// транспорт по умолчанию: beacon переживает закрытие вкладки; нет его или
// очередь переполнена — fetch с keepalive. Ответ не читается
function defaultSend(url, json) {
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    try {
      if (navigator.sendBeacon(url, new Blob([json], { type: 'application/json' }))) {
        return;
      }
    } catch {
      // старые Chromium бросали SecurityError на Blob с application/json
      // (crbug.com/490015) — тогда запасной fetch
    }
  }

  fetch(url, {
    method: 'POST',
    body: json,
    headers: { 'content-type': 'application/json' },
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => {});
}

function noop() {}

/**
 * Создаёт репортёр клиентских ошибок.
 * @param {Object} opts
 * @param {string|null} opts.url - адрес приёма; null — репортёр выключен
 * @param {Object} [opts.context] - { mode, role, gameId, gameVersion, page, userAgent }
 * @param {Function} [opts.send] - (url, json) => void; по умолчанию beacon/fetch
 * @param {Function} [opts.now]
 * @param {number} [opts.maxKeysPerSession=50]
 * @param {number} [opts.flushDelayMs=2000] - задержка первой отправки
 * @param {number} [opts.minIntervalMs=10000] - интервал между отправками по
 *   таймеру; прямой flush() его не ждёт
 * @returns {{ capture, warn, flush, setContext, install }}
 */
export function createDiagnostics({
  url,
  context = {},
  send = defaultSend,
  now = Date.now,
  maxKeysPerSession = 50,
  flushDelayMs = 2000,
  minIntervalMs = 10000,
} = {}) {
  if (!url) {
    return {
      capture: noop,
      warn: noop,
      flush: noop,
      setContext: noop,
      install: () => noop,
    };
  }

  const sessionId = makeSessionId();
  const ctx = { ...context };

  // ключ дедупа → запись со счётчиками: count — всего за сессию, sentCount —
  // сколько уже отправлено, deltaFirstAt — первое время в неотправленной дельте
  const records = new Map();

  let capWarned = false;
  let timer = null;
  let lastSentAt = null;

  // ошибка внутри самого репортёра не должна порождать новый отчёт
  let busy = false;

  function record(item) {
    const key = `${item.source}|${item.kind}|${item.code ?? item.message}|${topFrame(item.stack)}`;
    const at = now();
    const known = records.get(key);

    if (known) {
      known.count += 1;
      known.lastAt = at;

      if (known.count - known.sentCount === 1) {
        known.deltaFirstAt = at;
      }
    } else {
      if (records.size >= maxKeysPerSession) {
        if (!capWarned) {
          capWarned = true;
          console.warn('[vimp] diagnostics: session cap reached');
        }

        return;
      }

      records.set(key, {
        item,
        count: 1,
        sentCount: 0,
        deltaFirstAt: at,
        lastAt: at,
      });
    }

    schedule();
  }

  function schedule() {
    if (timer !== null) {
      return;
    }

    // первая отправка — через flushDelayMs, следующие — не чаще
    // minIntervalMs: бокс режет приём лимитом запросов с адреса, и 429
    // молча съедал бы приросты счётчиков непрерывно повторяющейся ошибки
    const sinceLast = lastSentAt === null ? Infinity : now() - lastSentAt;

    timer = setTimeout(flush, Math.max(flushDelayMs, minIntervalMs - sinceLast));
  }

  function guarded(fn) {
    if (busy) {
      return;
    }

    busy = true;

    try {
      fn();
    } catch {
      // репортёр молчит о своих сбоях — иначе он сам стал бы шумом
    } finally {
      busy = false;
    }
  }

  function capture(error, { source = 'client', kind = 'error' } = {}) {
    guarded(() => {
      const raw =
        error !== null && error !== undefined && error.message !== undefined
          ? error.message
          : error;
      const stack =
        error !== null && error !== undefined && typeof error.stack === 'string'
          ? error.stack.slice(0, MAX_STACK)
          : null;

      record({
        kind,
        source,
        code: null,
        message: safeString(raw).slice(0, MAX_MESSAGE),
        stack,
        details: null,
      });
    });
  }

  function warn(code, details = null, { source = 'plugin', message } = {}) {
    guarded(() => {
      const safeCode =
        typeof code === 'string' && CODE_RE.test(code)
          ? code.slice(0, MAX_CODE)
          : 'invalid-code';
      const stack = new Error().stack;

      record({
        kind: 'warn',
        source,
        code: safeCode,
        message: safeString(message ?? safeCode).slice(0, MAX_MESSAGE),
        stack: typeof stack === 'string' ? stack.slice(0, MAX_STACK) : null,
        details: normalizeDetails(details),
      });
    });
  }

  // нарушение CSP (только в проде: CSP ставит мастер) — одно правило,
  // сработавшее тысячу раз, одна запись со счётчиком
  function reportCsp(event) {
    guarded(() => {
      if (isExtensionUrl(event.blockedURI) || isExtensionUrl(event.sourceFile)) {
        return;
      }

      const blocked = stripUrl(event.blockedURI);

      record({
        kind: 'csp',
        source: 'client',
        code: null,
        message: `CSP ${event.effectiveDirective} blocked ${blocked}`.slice(
          0,
          MAX_MESSAGE,
        ),
        stack: null,
        details: normalizeDetails({
          directive: event.effectiveDirective,
          disposition: event.disposition,
          sourceFile: stripUrl(event.sourceFile),
          line: event.lineNumber,
          column: event.columnNumber,
          sample: (event.sample || '').slice(0, 40),
        }),
      });
    });
  }

  function body(items) {
    return JSON.stringify({ v: 1, sessionId, context: ctx, items });
  }

  // пачка больше предела: сперва без деталей, затем с короткими стеками;
  // не помогло — по одной записи
  function sendBatch(items) {
    let json = body(items);

    if (byteLength(json) > MAX_BATCH_BYTES) {
      items = items.map(item => ({ ...item, details: null }));
      json = body(items);
    }

    if (byteLength(json) > MAX_BATCH_BYTES) {
      items = items.map(item => ({
        ...item,
        stack: item.stack ? item.stack.slice(0, SHRUNK_STACK) : item.stack,
      }));
      json = body(items);
    }

    if (byteLength(json) > MAX_BATCH_BYTES && items.length > 1) {
      for (const item of items) {
        send(url, body([item]));
      }

      return;
    }

    send(url, json);
  }

  // уходят только записи, у которых с прошлой отправки вырос счётчик, —
  // приростом, а не итогом (бокс складывает)
  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    guarded(() => {
      const items = [];

      for (const rec of records.values()) {
        const delta = rec.count - rec.sentCount;

        if (delta > 0) {
          items.push({
            ...rec.item,
            count: delta,
            firstAt: rec.deltaFirstAt,
            lastAt: rec.lastAt,
          });
          rec.sentCount = rec.count;
        }
      }

      if (items.length > 0) {
        lastSentAt = now();
      }

      for (let i = 0; i < items.length; i += MAX_BATCH_ITEMS) {
        sendBatch(items.slice(i, i + MAX_BATCH_ITEMS));
      }
    });
  }

  // смена контекста (игра, роль): накопленное уходит СО СВОИМ контекстом —
  // иначе отчёт игры A, отправленный уже под игрой B, получил бы на боксе
  // отпечаток и source maps игры B
  function setContext(patch) {
    try {
      if (Object.keys(patch).some(key => ctx[key] !== patch[key])) {
        flush();
      }

      Object.assign(ctx, patch);
    } catch {
      // контекст — вспомогательный, его сбой отчёты не останавливает
    }
  }

  /**
   * Вешает глобальные перехватчики.
   * @param {Window} [target]
   * @returns {Function} снятие перехватчиков
   */
  function install(target = window) {
    const doc = target.document;
    // ошибки загрузки <img>/<script> приходят обычным Event на элементе —
    // это сбои ресурсов, а не исключения
    const onError = event => {
      if (typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent) {
        capture(event.error ?? event.message, { kind: 'error' });
      }
    };
    const onRejection = event => {
      capture(event.reason, { kind: 'rejection' });
    };
    const onPageHide = () => flush();
    // фоновую вкладку мобильный браузер убивает и без pagehide: скрытие —
    // последний надёжный момент отправить накопленное (по таймеру отчёты
    // ждут до minIntervalMs)
    const onVisibility = () => {
      if (doc?.visibilityState === 'hidden') {
        flush();
      }
    };

    try {
      target.addEventListener('error', onError);
      target.addEventListener('unhandledrejection', onRejection);
      target.addEventListener('pagehide', onPageHide);
      // событие всплывает к документу
      doc?.addEventListener('securitypolicyviolation', reportCsp);
      doc?.addEventListener('visibilitychange', onVisibility);
    } catch {
      // нет цели — просто не ловим
    }

    return () => {
      try {
        target.removeEventListener('error', onError);
        target.removeEventListener('unhandledrejection', onRejection);
        target.removeEventListener('pagehide', onPageHide);
        doc?.removeEventListener('securitypolicyviolation', reportCsp);
        doc?.removeEventListener('visibilitychange', onVisibility);
      } catch {
        // снятие не должно ронять вызывающего
      }
    };
  }

  return { capture, warn, flush, setContext, install };
}
