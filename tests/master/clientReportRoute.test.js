import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import RateLimiter from '../../packages/engine/src/lib/rateLimiter.js';
import ClientReportBuffer from '../../packages/engine/src/master/clientReports/ClientReportBuffer.js';
import { createClientReportRoute } from '../../packages/engine/src/master/clientReports/createClientReportRoute.js';

// Приём POST /client-reports на боксе (plan/client-reports, этап 2). lobby.js
// и dedicated/main.js из теста не поднимаются, поэтому маршрут собирается в
// отдельном express() ровно так, как его подключают входы, — с настоящим
// парсером тела (413 отдаёт он)

const ALLOWED = 'https://vimp.example';
const NOW = Date.now();

const item = (over = {}) => ({
  kind: 'error',
  source: 'client',
  message: 'boom',
  stack: '    at f (https://vimp.example/assets/client-abc.js:1:10)',
  count: 1,
  firstAt: NOW,
  lastAt: NOW,
  ...over,
});

const report = (items = [item()]) => ({
  v: 1,
  sessionId: '0f8c2b1e-1111-4222-8333-444455556666',
  context: { mode: 'lobby', role: 'client', gameId: 'tanks', gameVersion: '0.22.7' },
  items,
});

let server;

afterEach(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
    server = null;
  }
});

async function start({ limit = 100, trustProxy = false, buffer, symbolicate = null } = {}) {
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const buf = buffer ?? new ClientReportBuffer();
  const app = express();

  app.post(
    '/client-reports',
    ...createClientReportRoute({
      buffer: buf,
      limiter: new RateLimiter({ limit, windowMs: 60000 }),
      checkOrigin: (origin, cb) => process.nextTick(() => cb(origin === ALLOWED ? null : 'no')),
      trustProxy,
      box: { domain: 'vimp.example', mode: 'lobby', engineVersion: '0.34.8' },
      symbolicate,
      log,
    }),
  );

  server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const url = `http://127.0.0.1:${server.address().port}/client-reports`;

  const post = (body, headers = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  return { buffer: buf, log, post };
}

describe('POST /client-reports: приём', () => {
  it('204 и запись в буфере с engineVersion и доменом бокса', async () => {
    const { buffer, post } = await start();

    const res = await post({ ...report(), engineVersion: '9.9.9' });

    expect(res.status).toBe(204);

    const [entry] = buffer.drain(10);

    expect(entry).toMatchObject({
      source: 'client',
      kind: 'error',
      message: 'boom',
      engineVersion: '0.34.8',
      gameId: 'tanks',
      gameVersion: '0.22.7',
      box: 'vimp.example',
      mode: 'lobby',
    });
    expect(entry.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('role и page из контекста уходят в буфер', async () => {
    const { buffer, post } = await start();
    const body = report();

    body.context = { ...body.context, role: 'host', page: '/room/abc' };

    expect((await post(body)).status).toBe(204);
    expect(buffer.drain(10)[0]).toMatchObject({ role: 'host', page: '/room/abc' });
  });

  it('строка журнала только на новый отпечаток', async () => {
    const { log, post } = await start();

    await post(report());
    await post(report());

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(
      /^\[vimp:client-report\] new [0-9a-f]{8} error\/client boom \(tanks@0\.22\.7, engine 0\.34\.8\)$/,
    );
  });

  it('перевод строки в message не подделывает строку журнала процесса', async () => {
    const { log, post } = await start();

    await post(report([item({ message: 'boom\n[vimp:client-report] new deadbeef fake' })]));

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).not.toContain('\n');
  });

  it('без заголовка Origin — принимается', async () => {
    const { post } = await start();

    expect((await post(report(), { origin: '' })).status).toBe(204);
  });
});

describe('POST /client-reports: отказы', () => {
  it('403 на чужой Origin', async () => {
    const { buffer, post } = await start();
    const res = await post(report(), { origin: 'https://evil.example' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbiddenOrigin' });
    expect(buffer.size).toBe(0);
  });

  it('400 на мусор', async () => {
    const { post } = await start();
    const res = await post({ v: 1, items: [{ kind: 'x' }] });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'badRequest' });
  });

  it('413 на тело больше 16 КБ', async () => {
    const { post } = await start();

    expect((await post(report([item({ message: 'x'.repeat(17 * 1024) })]))).status).toBe(413);
  });

  it('битый JSON: короткий JSON 400, без стека в журнале процесса', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { post } = await start();
      const res = await post('{bad');

      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({ error: 'badRequest' });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('тело больше лимита: короткий JSON 413, без стека в журнале процесса', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { post } = await start();
      const res = await post('x'.repeat(20000));

      expect(res.status).toBe(413);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({ error: 'payloadTooLarge' });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('429 после лимита', async () => {
    const { post } = await start({ limit: 2 });

    expect((await post(report())).status).toBe(204);
    expect((await post(report())).status).toBe(204);

    const res = await post(report());

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rateLimited' });
  });

  it('адреса одной /64 делят один бакет, соседняя /64 — свой', async () => {
    const { post } = await start({ limit: 1, trustProxy: true });

    expect((await post(report(), { 'x-real-ip': '2001:db8:0:1::a' })).status).toBe(204);
    expect((await post(report(), { 'x-real-ip': '2001:db8:0:1:ffff::1' })).status).toBe(429);
    expect((await post(report(), { 'x-real-ip': '2001:db8:0:2::1' })).status).toBe(204);
  });
});

describe('POST /client-reports: расшифровка и бюджет', () => {
  it('symbolicate зовётся только для нового отпечатка', async () => {
    const symbolicate = vi.fn(async stack => `decoded ${stack}`);
    const { buffer, post } = await start({ symbolicate });

    await post(report());
    await post(report());

    expect(symbolicate).toHaveBeenCalledTimes(1);
    expect(buffer.drain(10)[0].stack).toMatch(/^decoded /);
  });

  it('повтор после пересылки: без symbolicate, без new, без бюджета', async () => {
    const symbolicate = vi.fn(async stack => stack);
    const buffer = new ClientReportBuffer({ newPerMinute: 1 });
    const { log, post } = await start({ buffer, symbolicate });

    await post(report());
    buffer.drain(10);

    expect((await post(report())).status).toBe(204);
    expect(symbolicate).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(buffer.size).toBe(1);
    expect(buffer.drainDropped()).toEqual({ budget: 0, bufferFull: 0 });
  });

  it('ошибка расшифровки не ломает приём — остаётся сырой стек', async () => {
    const symbolicate = vi.fn(async () => {
      throw new Error('no map');
    });
    const { buffer, post } = await start({ symbolicate });

    expect((await post(report())).status).toBe(204);
    expect(buffer.drain(10)[0].stack).toBe(item().stack);
  });

  it('исчерпан бюджет: новый не в буфере, symbolicate не зовётся, ответ 204', async () => {
    const symbolicate = vi.fn(async stack => stack);
    const buffer = new ClientReportBuffer({ newPerMinute: 1 });
    const { post } = await start({ buffer, symbolicate });

    expect((await post(report([item({ message: 'first' })]))).status).toBe(204);
    expect((await post(report([item({ message: 'second' })]))).status).toBe(204);
    // повтор известного принимается
    expect((await post(report([item({ message: 'first' })]))).status).toBe(204);

    expect(symbolicate).toHaveBeenCalledTimes(1);
    expect(buffer.size).toBe(1);
    expect(buffer.drain(10)[0].count).toBe(2);
    expect(buffer.drainDropped()).toEqual({ budget: 1, bufferFull: 0 });
  });
});
