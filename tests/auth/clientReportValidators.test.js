import { normalizeReportItem } from '../../packages/auth/src/lib/clientReportValidators.js';
import config from '../../packages/auth/src/config/auth.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const FP = 'a'.repeat(64);
const limits = config.clientReports.limits;
const opts = { limits, gameIdRules: config.games, now: NOW };

const item = extra => ({
  fingerprint: FP,
  source: 'client',
  kind: 'error',
  message: 'boom',
  ...extra,
});

describe('normalizeReportItem', () => {
  it('годная запись нормализуется целиком', () => {
    const result = normalizeReportItem(item({
      code: 'level.missing',
      stack: 'at x',
      details: { a: 1 },
      count: 3,
      firstSeen: NOW - 1000,
      lastSeen: new Date(NOW).toISOString(),
      engineVersion: '0.34.8',
      gameId: 'tanks',
      gameVersion: '1.2.3-beta.1',
      box: 'vimp.example.com:443',
      mode: 'dedicated',
      userAgent: 'UA',
    }), opts);

    expect(result).toEqual({
      fingerprint: FP,
      source: 'client',
      kind: 'error',
      message: 'boom',
      code: 'level.missing',
      stack: 'at x',
      details: { a: 1 },
      count: 3,
      firstSeen: new Date(NOW - 1000),
      lastSeen: new Date(NOW),
      engineVersion: '0.34.8',
      gameId: 'tanks',
      gameVersion: '1.2.3-beta.1',
      box: 'vimp.example.com:443',
      mode: 'dedicated',
      userAgent: 'UA',
    });
  });

  it.each([
    ['короткий отпечаток', { fingerprint: 'abc' }],
    ['отпечаток в верхнем регистре', { fingerprint: 'A'.repeat(64) }],
    ['неизвестный источник', { source: 'server' }],
    ['неизвестный вид', { kind: 'fatal' }],
    ['пустое сообщение', { message: '' }],
    ['сообщение не строка', { message: 42 }],
  ])('%s — null', (_, extra) => {
    expect(normalizeReportItem(item(extra), opts)).toBeNull();
  });

  it('не объект — null', () => {
    expect(normalizeReportItem(null, opts)).toBeNull();
    expect(normalizeReportItem([item()], opts)).toBeNull();
  });

  it('обрезает message, stack и userAgent', () => {
    const result = normalizeReportItem(item({
      message: 'm'.repeat(limits.message + 10),
      stack: 's'.repeat(limits.stack + 10),
      userAgent: 'u'.repeat(limits.userAgent + 10),
    }), opts);

    expect(result.message).toHaveLength(limits.message);
    expect(result.stack).toHaveLength(limits.stack);
    expect(result.userAgent).toHaveLength(limits.userAgent);
  });

  it('details: сверх лимита — truncated, массив и не объект — null', () => {
    const big = { text: 'x'.repeat(limits.details) };

    expect(normalizeReportItem(item({ details: big }), opts).details).toEqual({ truncated: true });
    expect(normalizeReportItem(item({ details: [1, 2] }), opts).details).toBeNull();
    expect(normalizeReportItem(item({ details: 'str' }), opts).details).toBeNull();
  });

  it('count: clamp и мусор', () => {
    expect(normalizeReportItem(item({ count: 0 }), opts).count).toBe(1);
    expect(normalizeReportItem(item({ count: 5e9 }), opts).count).toBe(1_000_000);
    expect(normalizeReportItem(item({ count: '7' }), opts).count).toBe(1);
    expect(normalizeReportItem(item({ count: 2.9 }), opts).count).toBe(2);
  });

  it('даты вне окна и мусор — now, перепутанные меняются местами', () => {
    const stale = normalizeReportItem(item({
      firstSeen: NOW - 8 * 24 * 3600 * 1000,
      lastSeen: NOW + 10 * 60 * 1000,
    }), opts);

    expect(stale.firstSeen.getTime()).toBe(NOW);
    expect(stale.lastSeen.getTime()).toBe(NOW);
    expect(normalizeReportItem(item({ firstSeen: 'nope' }), opts).firstSeen.getTime()).toBe(NOW);

    const swapped = normalizeReportItem(item({ firstSeen: NOW, lastSeen: NOW - 5000 }), opts);

    expect(swapped.firstSeen.getTime()).toBe(NOW - 5000);
    expect(swapped.lastSeen.getTime()).toBe(NOW);
  });

  it('мусор в версиях, gameId, code, box и mode — null', () => {
    const result = normalizeReportItem(item({
      engineVersion: '1.0 <script>',
      gameVersion: 'v'.repeat(limits.version + 1),
      gameId: 'Bad_Id',
      code: '-bad code',
      box: 'evil.com/path',
      mode: 'server',
    }), opts);

    expect(result.engineVersion).toBeNull();
    expect(result.gameVersion).toBeNull();
    expect(result.gameId).toBeNull();
    expect(result.code).toBeNull();
    expect(result.box).toBeNull();
    expect(result.mode).toBeNull();
    expect(normalizeReportItem(item({ gameId: 'mine' }), opts).gameId).toBeNull();
  });

  it('неизвестные поля не проходят', () => {
    const result = normalizeReportItem(item({ nick: 'Player1', ip: '1.2.3.4', status: 'fixed' }), opts);

    expect(result).not.toHaveProperty('nick');
    expect(result).not.toHaveProperty('ip');
    expect(result).not.toHaveProperty('status');
  });
});
