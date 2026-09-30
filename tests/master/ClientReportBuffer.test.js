import { describe, it, expect } from 'vitest';
import ClientReportBuffer from '../../packages/engine/src/master/clientReports/ClientReportBuffer.js';

// Агрегат журнала клиентских ошибок в памяти бокса (plan/client-reports,
// этап 2): повторы известных принимаются всегда, новые — в пределах бюджета

const entry = (fingerprint, over = {}) => ({
  fingerprint,
  source: 'client',
  kind: 'error',
  message: fingerprint,
  count: 1,
  firstSeen: 100,
  lastSeen: 100,
  ...over,
});

const makeBuffer = (opts = {}) => {
  const clock = { t: 0 };
  const buffer = new ClientReportBuffer({ now: () => clock.t, ...opts });

  return { buffer, clock };
};

describe('ClientReportBuffer: агрегация', () => {
  it('повторы складываются, isNew — один раз', () => {
    const { buffer } = makeBuffer();

    expect(
      buffer.add(entry('a', { count: 2, firstSeen: 50, lastSeen: 60 })),
    ).toEqual({
      accepted: true,
      isNew: true,
    });
    expect(
      buffer.add(entry('a', { count: 3, firstSeen: 40, lastSeen: 90 })),
    ).toEqual({
      accepted: true,
      isNew: false,
    });

    const [merged] = buffer.drain(10);

    expect(merged).toMatchObject({ count: 5, firstSeen: 40, lastSeen: 90 });
  });

  it('drain отдаёт старые по lastSeen первыми и снимает их', () => {
    const { buffer } = makeBuffer();

    buffer.add(entry('new', { lastSeen: 300 }));
    buffer.add(entry('old', { lastSeen: 100 }));
    buffer.add(entry('mid', { lastSeen: 200 }));

    expect(buffer.drain(2).map(e => e.fingerprint)).toEqual(['old', 'mid']);
    expect(buffer.size).toBe(1);
  });

  it('isNew переживает drain: отпечаток уже печатался', () => {
    const { buffer } = makeBuffer();

    buffer.add(entry('a'));
    buffer.drain(10);

    expect(buffer.add(entry('a')).isNew).toBe(false);
  });

  it('переполнение «уже печатал» очищает множество целиком', () => {
    const { buffer } = makeBuffer({ logSeenMax: 2 });

    buffer.add(entry('a'));
    buffer.add(entry('b'));
    buffer.add(entry('c'));
    buffer.drain(10);

    expect(buffer.add(entry('a')).isNew).toBe(true);
  });
});

describe('ClientReportBuffer: бюджет новых отпечатков', () => {
  it('61-й новый за минуту — budget, повтор известного принимается', () => {
    const { buffer } = makeBuffer({ newPerMinute: 60 });

    for (let i = 0; i < 60; i += 1) {
      expect(buffer.add(entry(`f${i}`)).accepted).toBe(true);
    }

    expect(buffer.canAcceptNew()).toBe('budget');
    expect(buffer.add(entry('f60')).accepted).toBe(false);
    expect(buffer.add(entry('f0')).accepted).toBe(true);
    expect(buffer.drainDropped()).toEqual({ budget: 1, bufferFull: 0 });
  });

  it('смена минуты возвращает бюджет', () => {
    const { buffer, clock } = makeBuffer({ newPerMinute: 1 });

    buffer.add(entry('a'));
    expect(buffer.canAcceptNew()).toBe('budget');

    clock.t = 60000;
    expect(buffer.canAcceptNew()).toBeNull();
    expect(buffer.add(entry('b')).accepted).toBe(true);
  });

  it('canAcceptNew бюджет не списывает', () => {
    const { buffer } = makeBuffer({ newPerMinute: 1 });

    buffer.canAcceptNew();
    buffer.canAcceptNew();

    expect(buffer.add(entry('a')).accepted).toBe(true);
  });
});

describe('ClientReportBuffer: известный после пересылки', () => {
  it('повтор после drain не тратит бюджет и не печатает new', () => {
    const { buffer } = makeBuffer({ newPerMinute: 1 });

    buffer.add(entry('a'));
    buffer.drain(10);

    expect(buffer.isKnown('a')).toBe(true);
    expect(buffer.has('a')).toBe(false);
    expect(buffer.canAcceptNew()).toBe('budget');
    expect(buffer.add(entry('a'))).toEqual({ accepted: true, isNew: false });
    expect(buffer.size).toBe(1);
    expect(buffer.drainDropped()).toEqual({ budget: 0, bufferFull: 0 });
  });

  it('повтор после drain при полном буфере — bufferFull', () => {
    const { buffer } = makeBuffer({ maxPending: 1 });

    buffer.add(entry('a'));
    buffer.drain(10);
    buffer.add(entry('b'));

    expect(buffer.add(entry('a'))).toEqual({ accepted: false, isNew: false });
    expect(buffer.drainDropped()).toEqual({ budget: 0, bufferFull: 1 });
  });

  it('после очистки переполненного «уже печатал» отпечаток снова новый', () => {
    const { buffer } = makeBuffer({ logSeenMax: 2 });

    buffer.add(entry('a'));
    buffer.add(entry('b'));
    buffer.add(entry('c'));
    buffer.drain(10);

    expect(buffer.isKnown('a')).toBe(false);
    expect(buffer.isKnown('c')).toBe(true);
  });
});

describe('ClientReportBuffer: переполнение', () => {
  it('при size === maxPending новый — bufferFull, повтор известного принят', () => {
    const { buffer } = makeBuffer({ maxPending: 2 });

    buffer.add(entry('a'));
    buffer.add(entry('b'));

    expect(buffer.canAcceptNew()).toBe('bufferFull');
    expect(buffer.add(entry('c')).accepted).toBe(false);
    expect(buffer.add(entry('a')).accepted).toBe(true);
  });

  it('drainDropped отдаёт счётчики по причинам и обнуляет', () => {
    const { buffer } = makeBuffer();

    buffer.countDropped('budget');
    buffer.countDropped('budget');
    buffer.countDropped('bufferFull');

    expect(buffer.drainDropped()).toEqual({ budget: 2, bufferFull: 1 });
    expect(buffer.drainDropped()).toEqual({ budget: 0, bufferFull: 0 });
  });
});

describe('ClientReportBuffer: restore', () => {
  it('возвращает принятое в обход исчерпанного бюджета', () => {
    const { buffer } = makeBuffer({ newPerMinute: 1 });

    buffer.add(entry('a'));
    const batch = buffer.drain(10);

    expect(buffer.canAcceptNew()).toBe('budget');

    buffer.restore([...batch, entry('b')]);

    expect(buffer.size).toBe(2);
    expect(buffer.drainDropped()).toEqual({ budget: 0, bufferFull: 0 });
  });

  it('не больше maxPending', () => {
    const { buffer } = makeBuffer({ maxPending: 1 });

    buffer.restore([entry('a'), entry('b')]);

    expect(buffer.size).toBe(1);
  });

  it('складывает count и даты с записью в буфере', () => {
    const { buffer } = makeBuffer();

    buffer.add(entry('a', { count: 1, firstSeen: 100, lastSeen: 100 }));
    buffer.restore([entry('a', { count: 4, firstSeen: 10, lastSeen: 50 })]);

    expect(buffer.drain(1)[0]).toMatchObject({
      count: 5,
      firstSeen: 10,
      lastSeen: 100,
    });
  });
});
