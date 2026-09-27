import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDiagnostics } from '../../../packages/engine/src/client/lib/diagnostics.js';

// Журнал клиентских ошибок (plan/client-reports, этап 3): репортёр не
// должен шуметь (дедуп, потолок сессии, пачки дельтами) и не должен сам
// становиться источником падений.

const URL_ = '/client-reports';

function setup(opts = {}) {
  const sent = [];
  const send = vi.fn((url, json) => sent.push(JSON.parse(json)));
  const diagnostics = createDiagnostics({
    url: URL_,
    context: { mode: 'lobby', role: 'client' },
    send,
    ...opts,
  });

  return { diagnostics, send, sent };
}

function makeError(message, frame = 'at f (https://box/client.js:1:2)') {
  const error = new Error(message);

  error.stack = `Error: ${message}\n    ${frame}`;

  return error;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('diagnostics: выключенный', () => {
  it('url: null — send не вызывается, install не вешает слушатели', () => {
    const send = vi.fn();
    const target = { addEventListener: vi.fn(), document: null };
    const diagnostics = createDiagnostics({ url: null, send });

    diagnostics.capture(new Error('x'));
    diagnostics.warn('a.b');
    diagnostics.flush();
    diagnostics.install(target)();

    expect(send).not.toHaveBeenCalled();
    expect(target.addEventListener).not.toHaveBeenCalled();
  });
});

describe('diagnostics: дедуп и дельты', () => {
  it('три одинаковые ошибки — одна запись с count 3, повтор уходит дельтой', () => {
    let time = 100;
    const { diagnostics, sent } = setup({ now: () => time });

    for (let i = 0; i < 3; i++) {
      diagnostics.capture(makeError('boom'));
      time += 10;
    }

    diagnostics.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      v: 1,
      context: { mode: 'lobby', role: 'client' },
    });
    expect(typeof sent[0].sessionId).toBe('string');
    expect(sent[0].items).toHaveLength(1);
    expect(sent[0].items[0]).toMatchObject({
      kind: 'error',
      source: 'client',
      code: null,
      message: 'boom',
      details: null,
      count: 3,
      firstAt: 100,
      lastAt: 120,
    });

    time = 500;
    diagnostics.capture(makeError('boom'));
    diagnostics.flush();

    expect(sent).toHaveLength(2);
    expect(sent[1].items[0]).toMatchObject({
      count: 1,
      firstAt: 500,
      lastAt: 500,
    });
    expect(sent[1].sessionId).toBe(sent[0].sessionId);
  });

  it('то же сообщение из другого места — другая запись', () => {
    const { diagnostics, sent } = setup();

    diagnostics.capture(makeError('boom', 'at f (https://box/a.js:1:2)'));
    diagnostics.capture(makeError('boom', 'at g (https://box/a.js:9:9)'));
    diagnostics.flush();

    expect(sent[0].items).toHaveLength(2);
  });

  it('без новых событий flush ничего не шлёт', () => {
    const { diagnostics, send } = setup();

    diagnostics.capture(makeError('boom'));
    diagnostics.flush();
    diagnostics.flush();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('не-Error: строка и объект из reject — через String', () => {
    const { diagnostics, sent } = setup();

    diagnostics.capture('plain');
    diagnostics.capture({ toString: () => 'obj' });
    diagnostics.flush();

    expect(sent[0].items.map(item => item.message)).toEqual(['plain', 'obj']);
    expect(sent[0].items[0].stack).toBeNull();
  });

  it('обрезки: message 500, stack 4000', () => {
    const { diagnostics, sent } = setup();
    const error = new Error('m'.repeat(900));

    error.stack = 's'.repeat(9000);
    diagnostics.capture(error);
    diagnostics.flush();

    expect(sent[0].items[0].message).toHaveLength(500);
    expect(sent[0].items[0].stack).toHaveLength(4000);
  });
});

describe('diagnostics: потолок сессии', () => {
  it('51-й ключ не отправляется, повторы старых — да', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { diagnostics, sent } = setup();

    for (let i = 0; i < 51; i++) {
      diagnostics.capture(makeError(`e${i}`));
    }

    diagnostics.capture(makeError('e52'));
    diagnostics.capture(makeError('e0'));
    diagnostics.flush();

    const items = sent.flatMap(body => body.items);

    expect(items).toHaveLength(50);
    expect(items.some(item => item.message === 'e50')).toBe(false);
    expect(items.find(item => item.message === 'e0').count).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[vimp] diagnostics: session cap reached');
  });

  it('пачки не больше 10 записей', () => {
    const { diagnostics, sent } = setup();

    for (let i = 0; i < 23; i++) {
      diagnostics.capture(makeError(`e${i}`));
    }

    diagnostics.flush();

    expect(sent.map(body => body.items.length)).toEqual([10, 10, 3]);
  });
});

describe('diagnostics: дебаунс', () => {
  it('несколько capture — одна отправка через flushDelayMs', () => {
    vi.useFakeTimers();

    const { diagnostics, send } = setup({ flushDelayMs: 2000 });

    diagnostics.capture(makeError('a'));
    diagnostics.capture(makeError('b'));
    vi.advanceTimersByTime(1999);

    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('flush() — немедленно, таймер снимается', () => {
    vi.useFakeTimers();

    const { diagnostics, send } = setup();

    diagnostics.capture(makeError('a'));
    diagnostics.flush();

    expect(send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('diagnostics: каденс отправки', () => {
  it('следующие отправки по таймеру — не чаще minIntervalMs', () => {
    vi.useFakeTimers();

    const { diagnostics, send } = setup();

    diagnostics.capture(makeError('a'));
    vi.advanceTimersByTime(2000);

    expect(send).toHaveBeenCalledTimes(1);

    // t = 3 с: до прошлой отправки (t = 2 с) всего секунда
    vi.advanceTimersByTime(1000);
    diagnostics.capture(makeError('a'));
    vi.advanceTimersByTime(2000);

    expect(send).toHaveBeenCalledTimes(1);

    // t = 12 с: 10 с после прошлой отправки
    vi.advanceTimersByTime(7000);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('flush() вручную шлёт сразу, без ожидания интервала', () => {
    vi.useFakeTimers();

    const { diagnostics, send } = setup();

    diagnostics.capture(makeError('a'));
    vi.advanceTimersByTime(2000);
    diagnostics.capture(makeError('b'));
    diagnostics.flush();

    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('diagnostics: смена контекста', () => {
  it('накопленное уходит со старым контекстом, новое — с новым', () => {
    const { diagnostics, send, sent } = setup();

    diagnostics.setContext({ gameId: 'a' });
    diagnostics.capture(makeError('x'));
    diagnostics.setContext({ gameId: 'b' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(sent[0].context.gameId).toBe('a');

    diagnostics.capture(makeError('y'));
    diagnostics.flush();

    expect(sent[1].context.gameId).toBe('b');
  });

  it('те же значения — отправки нет', () => {
    const { diagnostics, send } = setup();

    diagnostics.setContext({ gameId: 'a' });
    diagnostics.capture(makeError('x'));
    diagnostics.setContext({ gameId: 'a', role: 'client' });

    expect(send).not.toHaveBeenCalled();
  });
});

describe('diagnostics: ужатие пачки', () => {
  it('> 15 000 байт — сперва без details, затем короткие стеки', () => {
    const { diagnostics, sent } = setup();

    for (let i = 0; i < 8; i++) {
      diagnostics.warn(`code.${i}`, { blob: 'd'.repeat(1900) });
    }

    diagnostics.flush();

    // 8 × ~2 КБ деталей не влезают в 15 000 байт — детали снимаются
    expect(sent).toHaveLength(1);
    expect(sent[0].items.every(item => item.details === null)).toBe(true);
  });

  it('стеки обрезаются до 1000, если деталей мало', () => {
    const { diagnostics, sent } = setup();

    for (let i = 0; i < 10; i++) {
      const error = new Error(`e${i}`);

      error.stack = `Error\n    at f (https://box/x.js:${i}:1)\n` + 's'.repeat(3900);
      diagnostics.capture(error);
    }

    diagnostics.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].items.every(item => item.stack.length <= 1000)).toBe(true);
  });

  it('всё ещё больше — по одной записи', () => {
    // 10 × 500 символов сообщения — 5 КБ, не хватит; раздуть контекст (сразу:
    // смена контекста отправила бы накопленное)
    const { diagnostics, sent } = setup({
      context: { mode: 'lobby', role: 'client', page: 'p'.repeat(12000) },
    });

    for (let i = 0; i < 10; i++) {
      diagnostics.capture(makeError(`${i}`.padEnd(500, 'm')));
    }

    diagnostics.flush();

    expect(sent).toHaveLength(10);
    expect(sent.every(body => body.items.length === 1)).toBe(true);
  });

  it('details больше 2048 байт — { truncated: true }', () => {
    const { diagnostics, sent } = setup();

    diagnostics.warn('big.one', { blob: 'x'.repeat(3000) });
    diagnostics.flush();

    expect(sent[0].items[0].details).toEqual({ truncated: true });
  });
});

describe('diagnostics: транспорт', () => {
  it('sendBeacon вернул false — fetch с keepalive', () => {
    const beacon = vi.fn(() => false);
    const fetchMock = vi.fn(() => Promise.resolve());

    vi.stubGlobal('navigator', { sendBeacon: beacon });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const diagnostics = createDiagnostics({ url: URL_ });

      diagnostics.capture(makeError('a'));
      diagnostics.flush();

      expect(beacon).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        URL_,
        expect.objectContaining({
          method: 'POST',
          keepalive: true,
          credentials: 'same-origin',
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sendBeacon бросил — fetch с keepalive', () => {
    const beacon = vi.fn(() => {
      throw new Error('SecurityError');
    });
    const fetchMock = vi.fn(() => Promise.resolve());

    vi.stubGlobal('navigator', { sendBeacon: beacon });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const diagnostics = createDiagnostics({ url: URL_ });

      diagnostics.capture(makeError('a'));
      diagnostics.flush();

      expect(beacon).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        URL_,
        expect.objectContaining({ method: 'POST', keepalive: true }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('исключение в транспорте не выходит наружу и не зацикливает', () => {
    const send = vi.fn(() => {
      throw new Error('transport down');
    });
    const diagnostics = createDiagnostics({ url: URL_, send });

    diagnostics.capture(makeError('a'));

    expect(() => diagnostics.flush()).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('send, который сам зовёт capture, не порождает новых отчётов', () => {
    let diagnostics = null;
    const send = vi.fn(() => {
      diagnostics.capture(makeError('from send'));
      throw new Error('again');
    });

    diagnostics = createDiagnostics({ url: URL_, send });
    diagnostics.capture(makeError('a'));
    diagnostics.flush();
    diagnostics.flush();

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('diagnostics: install', () => {
  it('ErrorEvent — запись; обычный Event(error) ресурса — нет', () => {
    const { diagnostics, sent } = setup();
    const uninstall = diagnostics.install(window);

    window.dispatchEvent(
      new ErrorEvent('error', { error: makeError('sync'), message: 'sync' }),
    );
    window.dispatchEvent(new Event('error'));
    diagnostics.flush();
    uninstall();

    expect(sent[0].items).toHaveLength(1);
    expect(sent[0].items[0]).toMatchObject({ kind: 'error', message: 'sync' });
  });

  it('unhandledrejection — kind: rejection', () => {
    const { diagnostics, sent } = setup();
    const uninstall = diagnostics.install(window);
    const event = new Event('unhandledrejection');

    event.reason = makeError('async');
    window.dispatchEvent(event);
    diagnostics.flush();
    uninstall();

    expect(sent[0].items[0]).toMatchObject({
      kind: 'rejection',
      message: 'async',
    });
  });

  it('снятие слушателей — события больше не ловятся', () => {
    const { diagnostics, send } = setup();

    diagnostics.install(window)();
    window.dispatchEvent(new ErrorEvent('error', { error: makeError('x') }));
    diagnostics.flush();

    expect(send).not.toHaveBeenCalled();
  });

  it('pagehide — немедленная отправка', () => {
    const { diagnostics, send } = setup();
    const uninstall = diagnostics.install(window);

    diagnostics.capture(makeError('a'));
    window.dispatchEvent(new Event('pagehide'));
    uninstall();

    expect(send).toHaveBeenCalledTimes(1);
  });

  // мобильный браузер убивает фоновую вкладку и без pagehide
  function setVisibility(state) {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
  }

  it('visibilitychange → hidden — немедленная отправка', () => {
    const { diagnostics, send } = setup();
    const uninstall = diagnostics.install(window);

    try {
      diagnostics.capture(makeError('a'));
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));

      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      delete document.visibilityState;
      uninstall();
    }
  });

  it('visibilitychange → visible — отправки нет', () => {
    const { diagnostics, send } = setup();
    const uninstall = diagnostics.install(window);

    try {
      diagnostics.capture(makeError('a'));
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      expect(send).not.toHaveBeenCalled();
    } finally {
      delete document.visibilityState;
      uninstall();
    }
  });

  it('после снятия visibilitychange → hidden не отправляет', () => {
    const { diagnostics, send } = setup();

    diagnostics.install(window)();

    try {
      diagnostics.capture(makeError('a'));
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));

      expect(send).not.toHaveBeenCalled();
    } finally {
      delete document.visibilityState;
    }
  });
});

describe('diagnostics: CSP', () => {
  function violation(fields) {
    const event = new Event('securitypolicyviolation', { bubbles: true });

    return Object.assign(event, {
      effectiveDirective: 'script-src-elem',
      blockedURI: 'https://cdn.example/x.js?t=1#h',
      sourceFile: 'https://box/client.js?v=2',
      lineNumber: 7,
      columnNumber: 3,
      disposition: 'enforce',
      sample: '',
      ...fields,
    });
  }

  it('запись kind: csp без query и hash', () => {
    const { diagnostics, sent } = setup();
    const uninstall = diagnostics.install(window);

    document.dispatchEvent(violation({ sample: 'y'.repeat(100) }));
    diagnostics.flush();
    uninstall();

    const item = sent[0].items[0];

    expect(item).toMatchObject({
      kind: 'csp',
      source: 'client',
      code: null,
      stack: null,
      message: 'CSP script-src-elem blocked https://cdn.example/x.js',
      details: {
        directive: 'script-src-elem',
        disposition: 'enforce',
        sourceFile: 'https://box/client.js',
        line: 7,
        column: 3,
      },
    });
    expect(item.details.sample).toHaveLength(40);
    expect(JSON.stringify(item)).not.toContain('t=1');
    expect(JSON.stringify(item)).not.toContain('v=2');
  });

  it('служебное blockedURI (inline) — как есть', () => {
    const { diagnostics, sent } = setup();
    const uninstall = diagnostics.install(window);

    document.dispatchEvent(violation({ blockedURI: 'inline' }));
    diagnostics.flush();
    uninstall();

    expect(sent[0].items[0].message).toBe('CSP script-src-elem blocked inline');
  });

  it('расширения браузера — записи нет', () => {
    const { diagnostics, send } = setup();
    const uninstall = diagnostics.install(window);

    document.dispatchEvent(
      violation({ blockedURI: 'chrome-extension://abc/x.js' }),
    );
    document.dispatchEvent(
      violation({ blockedURI: 'inline', sourceFile: 'moz-extension://abc/y.js' }),
    );
    diagnostics.flush();
    uninstall();

    expect(send).not.toHaveBeenCalled();
  });

  it('тысяча одинаковых нарушений — одна запись с count', () => {
    const { diagnostics, sent } = setup();
    const uninstall = diagnostics.install(window);

    for (let i = 0; i < 1000; i++) {
      document.dispatchEvent(violation());
    }

    diagnostics.flush();
    uninstall();

    expect(sent[0].items).toHaveLength(1);
    expect(sent[0].items[0].count).toBe(1000);
  });
});

describe('diagnostics: warn', () => {
  it('верный код — source plugin, message = code, стек места вызова', () => {
    const { diagnostics, sent } = setup();

    diagnostics.warn('tanks.camera.missing', { id: 3 });
    diagnostics.flush();

    expect(sent[0].items[0]).toMatchObject({
      kind: 'warn',
      source: 'plugin',
      code: 'tanks.camera.missing',
      message: 'tanks.camera.missing',
      details: { id: 3 },
    });
    expect(typeof sent[0].items[0].stack).toBe('string');
  });

  it('неверный код — invalid-code (и общий ключ дедупа)', () => {
    const { diagnostics, sent } = setup();

    diagnostics.warn('bad code!');
    diagnostics.warn(42);
    diagnostics.flush();

    expect(sent[0].items).toHaveLength(1);
    expect(sent[0].items[0]).toMatchObject({ code: 'invalid-code', count: 2 });
  });
});
