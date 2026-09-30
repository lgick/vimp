import { describe, it, expect, vi } from 'vitest';
import ClientReportBuffer from '../../packages/engine/src/master/clientReports/ClientReportBuffer.js';
import ClientReportForwarder from '../../packages/engine/src/master/clientReports/ClientReportForwarder.js';

// Пересылка журнала клиентских ошибок бокса в auth (plan/client-reports,
// этап 2): сбой auth не теряет принятое и не ломает бокс

const entry = (fingerprint, lastSeen = 100) => ({
  fingerprint,
  source: 'client',
  kind: 'error',
  message: fingerprint,
  count: 1,
  firstSeen: lastSeen,
  lastSeen,
});

const reply = (status, json = { accepted: 1, throttled: 0, rejected: 0 }) => ({
  status,
  json: async () => json,
});

const makeLog = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });

const setup = ({ fetchImpl, count = 0, ...opts } = {}) => {
  const buffer = new ClientReportBuffer({ newPerMinute: 1000 });

  for (let i = 0; i < count; i += 1) {
    buffer.add(entry(`f${i}`, i));
  }

  const log = makeLog();
  const forwarder = new ClientReportForwarder({
    buffer,
    authServiceUrl: 'http://auth.test',
    token: 'secret',
    fetchImpl,
    batchSize: 2,
    log,
    ...opts,
  });

  return { buffer, forwarder, log };
};

const sentItems = call => JSON.parse(call[1].body).items;

describe('ClientReportForwarder: успех', () => {
  it('опустошает буфер пачками по batchSize с Bearer-секретом', async () => {
    const fetchImpl = vi.fn(async () => reply(200));
    const { buffer, forwarder } = setup({ fetchImpl, count: 5 });

    await forwarder.flush();

    expect(buffer.size).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(c => sentItems(c).length)).toEqual([
      2, 2, 1,
    ]);

    const [url, init] = fetchImpl.mock.calls[0];

    expect(url).toBe('http://auth.test/client-reports');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer secret');
    expect(init.headers['content-type']).toBe('application/json');
  });

  it('extraEntries уходят первыми, в пределах batchSize', async () => {
    const fetchImpl = vi.fn(async () => reply(200));
    const { forwarder } = setup({
      fetchImpl,
      count: 3,
      extraEntries: () => [entry('dropped')],
    });

    await forwarder.flush();

    const first = sentItems(fetchImpl.mock.calls[0]);

    expect(first.map(e => e.fingerprint)).toEqual(['dropped', 'f0']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('пустой буфер без служебных записей — в auth не ходит', async () => {
    const fetchImpl = vi.fn(async () => reply(200));
    const { forwarder } = setup({ fetchImpl });

    await forwarder.flush();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throttled > 0 — без restore, строка журнала не чаще раза в час', async () => {
    const clock = { t: 0 };
    const fetchImpl = vi.fn(async () =>
      reply(200, { accepted: 0, throttled: 2, rejected: 0 }),
    );
    const { buffer, forwarder, log } = setup({
      fetchImpl,
      count: 2,
      now: () => clock.t,
    });

    await forwarder.flush();
    expect(buffer.size).toBe(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/auth throttled 2 new reports/);

    buffer.add(entry('x'));
    clock.t = 30 * 60 * 1000;
    await forwarder.flush();
    expect(log.warn).toHaveBeenCalledTimes(1);

    buffer.add(entry('y'));
    clock.t = 61 * 60 * 1000;
    await forwarder.flush();
    expect(log.warn).toHaveBeenCalledTimes(2);
    // сумма за час: 2 из второго тика + 2 из третьего
    expect(log.warn.mock.calls[1][0]).toMatch(/auth throttled 4 new reports/);
  });
});

describe('ClientReportForwarder: отказы', () => {
  it('500 — restore и одна строка журнала на серию', async () => {
    const fetchImpl = vi.fn(async () => reply(500));
    const { buffer, forwarder, log } = setup({ fetchImpl, count: 3 });

    await forwarder.flush();
    await forwarder.flush();

    expect(buffer.size).toBe(3);
    // цикл выходит на первом отказе до следующего тика
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/forward failed: 500/);
  });

  it('исключение fetch — restore; первый успех сбрасывает серию', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(reply(200))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { buffer, forwarder, log } = setup({ fetchImpl, count: 1 });

    await forwarder.flush();
    expect(buffer.size).toBe(1);

    await forwarder.flush();
    expect(buffer.size).toBe(0);

    buffer.add(entry('z'));
    await forwarder.flush();

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1][0]).toMatch(/forward failed: ECONNREFUSED/);
  });

  it('400 — пачка не возвращается (иначе вечный цикл)', async () => {
    const fetchImpl = vi.fn(async () => reply(400));
    const { buffer, forwarder, log } = setup({ fetchImpl, count: 2 });

    await forwarder.flush();

    expect(buffer.size).toBe(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('ClientReportForwarder: выключенная пересылка', () => {
  it('без токена fetch не зовётся, но extraEntries вызывается', async () => {
    const fetchImpl = vi.fn(async () => reply(200));
    const extraEntries = vi.fn(() => [entry('dropped')]);
    const { forwarder } = setup({
      fetchImpl,
      count: 1,
      token: '',
      extraEntries,
    });

    expect(forwarder.enabled).toBe(false);

    await forwarder.flush();

    expect(extraEntries).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('ClientReportForwarder: выключенная пересылка и буфер', () => {
  it('без токена буфер пустеет каждый тик', async () => {
    const { buffer, forwarder } = setup({
      fetchImpl: vi.fn(),
      count: 3,
      token: '',
    });

    await forwarder.flush();

    expect(buffer.size).toBe(0);
  });

  it('без токена новые отпечатки не упираются в maxPending', async () => {
    const buffer = new ClientReportBuffer({
      maxPending: 500,
      newPerMinute: 10000,
    });
    const forwarder = new ClientReportForwarder({
      buffer,
      authServiceUrl: 'http://auth.test',
      token: '',
      fetchImpl: vi.fn(),
      log: makeLog(),
    });

    for (let i = 0; i < 500; i += 1) {
      buffer.add(entry(`f${i}`));
    }

    expect(buffer.canAcceptNew()).toBe('bufferFull');

    await forwarder.flush();

    expect(buffer.add(entry('f500'))).toEqual({ accepted: true, isNew: true });
  });
});

describe('ClientReportForwarder: flush и stop', () => {
  it('параллельные flush не допускаются', async () => {
    let release;
    const fetchImpl = vi.fn(
      () =>
        new Promise(resolve => {
          release = () => resolve(reply(200));
        }),
    );
    const { forwarder } = setup({ fetchImpl, count: 1 });

    const a = forwarder.flush();
    const b = forwarder.flush();

    await Promise.resolve();
    release();
    await Promise.all([a, b]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stop() снимает таймер и делает последний flush', async () => {
    vi.useFakeTimers();

    try {
      const fetchImpl = vi.fn(async () => reply(200));
      const { buffer, forwarder } = setup({
        fetchImpl,
        count: 1,
        intervalMs: 1000,
      });

      forwarder.start();
      await forwarder.stop();

      expect(buffer.size).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      buffer.add(entry('late'));
      await vi.advanceTimersByTimeAsync(5000);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() шлёт по таймеру', async () => {
    vi.useFakeTimers();

    try {
      const fetchImpl = vi.fn(async () => reply(200));
      const { forwarder } = setup({ fetchImpl, count: 1, intervalMs: 1000 });

      forwarder.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await forwarder.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
