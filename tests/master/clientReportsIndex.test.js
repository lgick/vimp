import fs from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { ENGINE_VERSION } from '../../packages/engine/src/master/clientReports/engineVersion.js';
import {
  createClientReports,
  makeDroppedEntry,
} from '../../packages/engine/src/master/clientReports/index.js';

// Сборка журнала клиентских ошибок для входов бокса и служебная запись
// reports.dropped (plan/client-reports, этап 2)

const BOX = { domain: 'a.example', mode: 'lobby', engineVersion: '0.34.8' };
const makeLog = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });

describe('ENGINE_VERSION', () => {
  it('читается из packages/engine/package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../../packages/engine/package.json', import.meta.url), 'utf8'),
    );

    expect(ENGINE_VERSION).toBe(pkg.version);
  });
});

describe('makeDroppedEntry', () => {
  it('нули — null и без строки журнала', () => {
    const log = makeLog();

    expect(makeDroppedEntry({ budget: 0, bufferFull: 0 }, { box: BOX, windowMs: 30000, log }))
      .toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("запись source: 'box' с суммой и строкой журнала", () => {
    const log = makeLog();
    const entry = makeDroppedEntry(
      { budget: 3, bufferFull: 2 },
      { box: BOX, windowMs: 30000, log, now: 1000 },
    );

    expect(entry).toMatchObject({
      source: 'box',
      kind: 'warn',
      code: 'reports.dropped',
      message: 'dropped 5 new client reports',
      details: { budget: 3, bufferFull: 2, windowMs: 30000 },
      count: 5,
      firstSeen: 1000,
      lastSeen: 1000,
      engineVersion: '0.34.8',
      box: 'a.example',
      mode: 'lobby',
      gameId: null,
      gameVersion: null,
      stack: null,
      userAgent: null,
    });
    expect(entry.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(log.warn.mock.calls[0][0]).toBe(
      '[vimp:client-report] dropped 5 new reports (budget: 3, bufferFull: 2)',
    );
  });

  it('отпечаток зависит от домена бокса, но не от числа отброшенного', () => {
    const log = makeLog();
    const fp = (box, n) =>
      makeDroppedEntry({ budget: n, bufferFull: 0 }, { box, windowMs: 1, log }).fingerprint;

    expect(fp(BOX, 1)).toBe(fp(BOX, 7));
    expect(fp({ ...BOX, domain: 'b.example' }, 1)).not.toBe(fp(BOX, 1));
  });
});

describe('createClientReports', () => {
  const makeConfig = token => {
    const values = {
      'master:clientReports': {
        token,
        flushIntervalMs: 30000,
        forwardBatch: 50,
        forwardTimeoutMs: 5000,
        maxPending: 500,
        logSeenMax: 5000,
        newFingerprintsPerMinute: 60,
        rateLimit: { limit: 10, windowMs: 60000 },
        bodyLimit: '16kb',
        maxItemsPerRequest: 10,
      },
      'master:security:authServiceUrl': 'http://auth.test',
    };

    return { get: key => values[key] };
  };

  it('без токена — пересылка выключена и строка об этом', () => {
    const log = makeLog();
    const { route, forwarder } = createClientReports({
      config: makeConfig(''),
      box: BOX,
      trustProxy: false,
      checkOrigin: (o, cb) => cb(null),
      log,
    });

    expect(route).toHaveLength(3);
    expect(forwarder.enabled).toBe(false);
    expect(log.warn.mock.calls[0][0]).toMatch(/forwarding disabled/);
  });

  it('служебная запись отброшенного уходит первой в пересылку', async () => {
    const log = makeLog();
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => ({}) }));
    const { forwarder, buffer } = createClientReports({
      config: makeConfig('secret'),
      box: BOX,
      trustProxy: false,
      checkOrigin: (o, cb) => cb(null),
      fetchImpl,
      log,
    });

    buffer.countDropped('budget');
    await forwarder.flush();

    const items = JSON.parse(fetchImpl.mock.calls[0][1].body).items;

    expect(items[0]).toMatchObject({ code: 'reports.dropped', count: 1 });
    // счётчики обнулены — второй тик без служебной записи
    await forwarder.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
