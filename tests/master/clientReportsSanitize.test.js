import { describe, it, expect } from 'vitest';
import { sanitizeClientReport } from '../../packages/engine/src/master/clientReports/sanitize.js';

// Тело POST /client-reports от браузера (plan/client-reports, этап 2):
// форма режется до схемы, всё неизвестное не проходит

const NOW = 1_758_900_000_000;
const OPTS = { maxItemsPerRequest: 10, now: NOW };

const item = (over = {}) => ({
  kind: 'error',
  source: 'client',
  message: 'boom',
  count: 1,
  firstAt: NOW,
  lastAt: NOW,
  ...over,
});

const body = (over = {}) => ({
  v: 1,
  sessionId: '0f8c2b1e-1111-4222-8333-444455556666',
  context: { mode: 'lobby', role: 'client', gameId: 'tanks', gameVersion: '0.22.7' },
  items: [item()],
  ...over,
});

const status = fn => {
  try {
    fn();
  } catch (err) {
    return err.status;
  }

  return null;
};

describe('sanitizeClientReport: форма тела', () => {
  it('v !== 1 и не-объект — 400', () => {
    expect(status(() => sanitizeClientReport(body({ v: 2 }), OPTS))).toBe(400);
    expect(status(() => sanitizeClientReport(null, OPTS))).toBe(400);
    expect(status(() => sanitizeClientReport([], OPTS))).toBe(400);
  });

  it('пустые, не-массив и лишние items — 400', () => {
    expect(status(() => sanitizeClientReport(body({ items: [] }), OPTS))).toBe(400);
    expect(status(() => sanitizeClientReport(body({ items: 'x' }), OPTS))).toBe(400);
    expect(
      status(() => sanitizeClientReport(body({ items: Array(11).fill(item()) }), OPTS)),
    ).toBe(400);
  });

  it('все items отброшены — 400', () => {
    expect(
      status(() => sanitizeClientReport(body({ items: [item({ kind: 'nope' })] }), OPTS)),
    ).toBe(400);
  });

  it('кривой sessionId — null, а не 400', () => {
    expect(sanitizeClientReport(body({ sessionId: 'x' }), OPTS).sessionId).toBeNull();
  });
});

describe('sanitizeClientReport: items', () => {
  it("неизвестные kind/source отбрасываются, в том числе source: 'box'", () => {
    const { items } = sanitizeClientReport(
      body({
        items: [
          item({ kind: 'bogus' }),
          item({ source: 'bogus' }),
          item({ source: 'box' }),
          item({ message: '' }),
          item({ source: 'plugin', kind: 'warn' }),
        ],
      }),
      OPTS,
    );

    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('plugin');
  });

  it('обрезки длин, code по шаблону, count в рамках', () => {
    const [it0] = sanitizeClientReport(
      body({
        items: [
          item({
            message: 'm'.repeat(600),
            stack: 's'.repeat(5000),
            code: 'bad code!',
            count: 1e9,
          }),
        ],
      }),
      OPTS,
    ).items;

    expect(it0.message).toHaveLength(500);
    expect(it0.stack).toHaveLength(4000);
    expect(it0.code).toBeNull();
    expect(it0.count).toBe(10000);
  });

  it('details больше лимита — { truncated: true }, не объект — null', () => {
    const { items } = sanitizeClientReport(
      body({
        items: [item({ details: { big: 'x'.repeat(3000) } }), item({ details: [1] })],
      }),
      OPTS,
    );

    expect(items[0].details).toEqual({ truncated: true });
    expect(items[1].details).toBeNull();
  });

  it('даты вне окна [now − сутки, now + 5 мин] — now', () => {
    const [it0] = sanitizeClientReport(
      body({ items: [item({ firstAt: NOW - 2 * 86400000, lastAt: NOW + 3600000 })] }),
      OPTS,
    ).items;

    expect(it0.firstAt).toBe(NOW);
    expect(it0.lastAt).toBe(NOW);
  });

  it('engineVersion и неизвестные поля из тела не проходят', () => {
    const report = sanitizeClientReport(
      body({
        engineVersion: '9.9.9',
        items: [item({ engineVersion: '9.9.9', extra: 1 })],
      }),
      OPTS,
    );

    expect(JSON.stringify(report)).not.toContain('9.9.9');
    expect(report.items[0]).not.toHaveProperty('extra');
  });
});

describe('sanitizeClientReport: context', () => {
  it('неизвестные значения — null, строки режутся', () => {
    const { context } = sanitizeClientReport(
      body({
        context: {
          mode: 'hack',
          role: 'admin',
          gameId: 'Bad Id',
          gameVersion: '1.0 beta',
          page: '/'.repeat(200),
          userAgent: 'u'.repeat(300),
        },
      }),
      OPTS,
    );

    expect(context).toEqual({
      mode: null,
      role: null,
      gameId: null,
      gameVersion: null,
      page: '/'.repeat(128),
      userAgent: 'u'.repeat(256),
    });
  });
});
