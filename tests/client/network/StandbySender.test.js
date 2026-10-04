import { describe, it, expect, beforeEach, vi } from 'vitest';
import StandbySender from '../../../packages/engine/src/client/network/StandbySender.js';
import {
  STANDBY_HEADER_BYTES,
  decodeStandbyChunk,
} from '../../../packages/engine/src/client/network/standbyChunks.js';

class FakeChannel {
  constructor(label, options) {
    this.label = label;
    this.options = options;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = false;
  }

  send(data) {
    this.sent.push(data);
  }

  open() {
    this.readyState = 'open';
    this.onopen?.();
  }

  close() {
    this.closed = true;
    this.readyState = 'closed';
  }
}

class FakePc {
  constructor() {
    this.channels = [];
  }

  createDataChannel(label, options) {
    const channel = new FakeChannel(label, options);

    this.channels.push(channel);

    return channel;
  }

  get last() {
    return this.channels[this.channels.length - 1];
  }
}

const createController = () => {
  const listeners = new Set();

  return {
    startCheckpoints: vi.fn(),
    stopCheckpoints: vi.fn(),
    onCheckpoint: cb => {
      listeners.add(cb);

      return () => listeners.delete(cb);
    },
    emit: checkpoint => {
      for (const cb of listeners) {
        cb(checkpoint);
      }
    },
  };
};

const checkpoint = (size, overrides = {}) => ({
  checkpointId: 'cp-1',
  seq: 42,
  createdAt: 1000,
  final: false,
  mode: 'midRound',
  bytes: new Uint8Array(size).fill(7),
  ...overrides,
});

let controller;
let peers;
let sender;
let diagnostics;

beforeEach(() => {
  controller = createController();
  peers = new Map();
  diagnostics = { warn: vi.fn() };
  sender = new StandbySender({
    controller,
    connections: { peerConnectionOf: memberId => peers.get(memberId) ?? null },
    intervalMs: 500,
    chunkBytes: 1024,
    highWaterBytes: 4096,
    diagnostics,
    now: () => 1500,
  });
});

describe('StandbySender: канал и точки', () => {
  it('назначение беты открывает канал standby и включает точки', () => {
    const pc = new FakePc();

    peers.set('m1', pc);
    sender.setSuccessor('m1');

    expect(pc.last.label).toBe('standby');
    expect(pc.last.options).toEqual({ ordered: true });
    expect(controller.startCheckpoints).toHaveBeenCalledWith(500);
  });

  it('бета подключилась позже назначения — канал на refresh', () => {
    sender.setSuccessor('m1');
    expect(controller.startCheckpoints).not.toHaveBeenCalled();

    const pc = new FakePc();

    peers.set('m1', pc);
    sender.refresh();

    expect(pc.channels).toHaveLength(1);
    expect(controller.startCheckpoints).toHaveBeenCalledTimes(1);
  });

  it('смена беты закрывает прежний канал; null — точки выключаются', () => {
    const a = new FakePc();
    const b = new FakePc();

    peers.set('a', a);
    peers.set('b', b);
    sender.setSuccessor('a');
    sender.setSuccessor('b');

    expect(a.last.closed).toBe(true);
    expect(b.last.label).toBe('standby');

    sender.setSuccessor(null);

    expect(b.last.closed).toBe(true);
    expect(controller.stopCheckpoints).toHaveBeenCalledTimes(1);
  });

  it('пир переподключился (новый pc) — канал переоткрывается', () => {
    const first = new FakePc();
    const second = new FakePc();

    peers.set('m1', first);
    sender.setSuccessor('m1');
    peers.set('m1', second);
    sender.refresh();

    expect(first.last.closed).toBe(true);
    expect(second.channels).toHaveLength(1);
  });

  it('нарезка: куски ≤ chunkBytes, заголовок несёт номер, seq и счёт', () => {
    const pc = new FakePc();

    peers.set('m1', pc);
    sender.setSuccessor('m1');
    pc.last.open();
    controller.emit(checkpoint(3000));

    const chunks = pc.last.sent.map(decodeStandbyChunk);

    expect(pc.last.sent.every(chunk => chunk.byteLength <= 1024)).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(chunk => chunk.index)).toEqual(
      chunks.map((_chunk, index) => index),
    );
    expect(chunks[0]).toMatchObject({
      wireId: 1,
      count: chunks.length,
      seq: 42,
      final: false,
    });
    expect(STANDBY_HEADER_BYTES).toBe(24);
    expect(sender.stats).toMatchObject({
      sent: 1,
      lastBytes: 3000,
      lastChunks: chunks.length,
      lastLatencyMs: 500,
    });
  });

  it('канал не открыт — периодическая точка не уходит', () => {
    const pc = new FakePc();

    peers.set('m1', pc);
    sender.setSuccessor('m1');
    controller.emit(checkpoint(100));

    expect(pc.last.sent).toEqual([]);
  });

  it('backpressure: периодическая точка пропускается, пропуск в журнале', () => {
    const pc = new FakePc();

    peers.set('m1', pc);
    sender.setSuccessor('m1');
    pc.last.open();
    pc.last.bufferedAmount = 5000;
    controller.emit(checkpoint(100));

    expect(pc.last.sent).toEqual([]);
    expect(sender.stats.skipped).toBe(1);
    expect(diagnostics.warn).toHaveBeenCalledWith(
      'engine.standby.skipped',
      { bufferedAmount: 5000 },
      { source: 'host' },
    );
  });

  it('финальная точка не пропускается, а ждёт bufferedamountlow', () => {
    const pc = new FakePc();

    peers.set('m1', pc);
    sender.setSuccessor('m1');
    pc.last.open();
    pc.last.bufferedAmount = 5000;
    controller.emit(checkpoint(100, { final: true }));

    expect(pc.last.sent).toEqual([]);

    pc.last.bufferedAmount = 0;
    pc.last.onbufferedamountlow();

    expect(decodeStandbyChunk(pc.last.sent[0]).final).toBe(true);
  });

  it('финальная точка до открытия канала уходит на open', () => {
    const pc = new FakePc();

    peers.set('m1', pc);
    sender.setSuccessor('m1');
    controller.emit(checkpoint(100, { final: true }));
    pc.last.open();

    expect(pc.last.sent).toHaveLength(1);
  });

  it('приоритет финальной: периодическая не обгоняет её и не идёт следом устаревшей', () => {
    const pc = new FakePc();

    peers.set('m1', pc);
    sender.setSuccessor('m1');
    pc.last.open();
    pc.last.bufferedAmount = 5000;
    controller.emit(checkpoint(100, { final: true, seq: 42 }));

    // канал разгрузился, но событие ещё не пришло: финальная ждёт —
    // периодическая вперёд неё не уходит
    pc.last.bufferedAmount = 0;
    controller.emit(checkpoint(100, { seq: 43 }));
    expect(pc.last.sent).toEqual([]);

    pc.last.onbufferedamountlow();
    expect(pc.last.sent).toHaveLength(1);

    // снята до финальной (кодирование асинхронно) — отбрасывается
    controller.emit(checkpoint(100, { seq: 42 }));
    expect(pc.last.sent).toHaveLength(1);

    // после разморозки — новее финальной, уходит
    controller.emit(checkpoint(100, { seq: 44 }));
    expect(pc.last.sent).toHaveLength(2);
    expect(decodeStandbyChunk(pc.last.sent[1]).seq).toBe(44);
  });

  it('канал закрылся — точки выключаются до следующего refresh', () => {
    const pc = new FakePc();

    peers.set('m1', pc);
    sender.setSuccessor('m1');
    pc.last.onclose();

    expect(controller.stopCheckpoints).toHaveBeenCalledTimes(1);

    sender.refresh();

    expect(pc.channels).toHaveLength(2);
  });

  it('destroy: отписка, канал закрыт, точки выключены', () => {
    const pc = new FakePc();

    peers.set('m1', pc);
    sender.setSuccessor('m1');
    sender.destroy();
    controller.emit(checkpoint(100));

    expect(pc.last.closed).toBe(true);
    expect(controller.stopCheckpoints).toHaveBeenCalledTimes(1);
  });
});

describe('StandbySender: повторное открытие канала (ревью F8)', () => {
  let timers;

  // таймеры вручную: run() исполняет взведённый и возвращает его задержку
  const createTimers = () => {
    const pending = new Map();
    let next = 0;

    return {
      pending,
      setTimeout: (fn, ms) => {
        next += 1;
        pending.set(next, { fn, ms });

        return next;
      },
      clearTimeout: id => pending.delete(id),
      run() {
        const [[id, { fn, ms }]] = pending;

        pending.delete(id);
        fn();

        return ms;
      },
    };
  };

  beforeEach(() => {
    timers = createTimers();
    sender = new StandbySender({
      controller,
      connections: {
        peerConnectionOf: memberId => peers.get(memberId) ?? null,
      },
      intervalMs: 500,
      chunkBytes: 1024,
      highWaterBytes: 4096,
      reopenDelayMs: 1000,
      reopenMaxDelayMs: 10000,
      timers,
      now: () => 1500,
    });
  });

  it('канал закрылся при живом пире — через задержку открыт новый, точки включены', () => {
    const pc = new FakePc();

    peers.set('m1', pc);
    sender.setSuccessor('m1');
    pc.last.onclose();

    expect(controller.stopCheckpoints).toHaveBeenCalledTimes(1);
    expect(pc.channels).toHaveLength(1);
    expect(timers.run()).toBe(1000);
    expect(pc.channels).toHaveLength(2);
    expect(controller.startCheckpoints).toHaveBeenCalledTimes(2);
  });

  it('задержка растёт до потолка, open её сбрасывает', () => {
    const pc = new FakePc();
    const delays = [];

    peers.set('m1', pc);
    sender.setSuccessor('m1');

    for (let i = 0; i < 6; i++) {
      pc.last.onclose();
      delays.push(timers.run());
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);

    pc.last.open();
    pc.last.onclose();

    expect(timers.run()).toBe(1000);
  });

  it('пира нет — канала нет', () => {
    const pc = new FakePc();

    peers.set('m1', pc);
    sender.setSuccessor('m1');
    peers.delete('m1');
    pc.last.onclose();
    timers.run();

    expect(pc.channels).toHaveLength(1);
    expect(controller.startCheckpoints).toHaveBeenCalledTimes(1);
  });

  it('destroy и смена беты снимают таймер', () => {
    const pc = new FakePc();

    peers.set('m1', pc);
    sender.setSuccessor('m1');
    pc.last.onclose();
    sender.setSuccessor('m2');
    expect(timers.pending.size).toBe(0);

    sender.setSuccessor('m1');
    pc.last.onclose();
    sender.destroy();
    expect(timers.pending.size).toBe(0);
  });
});
