import { describe, it, expect, beforeEach, vi } from 'vitest';
import StandbyReceiver from '../../../packages/engine/src/client/network/StandbyReceiver.js';
import { encodeStandbyChunks } from '../../../packages/engine/src/client/network/standbyChunks.js';

const checkpoint = (size, overrides = {}) => ({
  checkpointId: 'cp-1',
  seq: 7,
  createdAt: 1000,
  final: false,
  mode: 'midRound',
  bytes: Uint8Array.from({ length: size }, (_v, i) => i % 251),
  ...overrides,
});

// куски точки как ArrayBuffer'ы канала
const chunksOf = (cp, wireId, chunkBytes = 256) =>
  encodeStandbyChunks(cp, wireId, chunkBytes).map(chunk => chunk.buffer);

let receiver;

beforeEach(() => {
  receiver = new StandbyReceiver({ now: () => 5000 });
});

describe('StandbyReceiver: сборка', () => {
  it('собирает точку из кусков и отдаёт событие', () => {
    const events = [];
    const cp = checkpoint(1000);

    receiver.publisher.on('checkpoint', latest => events.push(latest));

    for (const chunk of chunksOf(cp, 1)) {
      receiver.receive(chunk);
    }

    expect(events).toHaveLength(1);
    expect(receiver.latest()).toMatchObject({
      checkpointId: 'cp-1',
      createdAt: 1000,
      mode: 'midRound',
      wireId: 1,
      seq: 7,
      final: false,
      receivedAt: 5000,
    });
    expect(Array.from(receiver.latest().bytes)).toEqual(Array.from(cp.bytes));
  });

  it('незавершённая точка выбрасывается, когда пошла более новая', () => {
    const older = chunksOf(checkpoint(1000, { checkpointId: 'old' }), 1);
    const newer = chunksOf(checkpoint(600, { checkpointId: 'new' }), 2);

    receiver.receive(older[0]);
    receiver.receive(older[1]);

    for (const chunk of newer) {
      receiver.receive(chunk);
    }

    // хвост старой точки после новой — устаревший, игнорируется
    for (const chunk of older.slice(2)) {
      receiver.receive(chunk);
    }

    expect(receiver.latest().checkpointId).toBe('new');
  });

  it('точка не новее собранной игнорируется', () => {
    for (const chunk of chunksOf(checkpoint(100, { checkpointId: 'b' }), 5)) {
      receiver.receive(chunk);
    }

    for (const chunk of chunksOf(checkpoint(100, { checkpointId: 'a' }), 4)) {
      receiver.receive(chunk);
    }

    expect(receiver.latest().checkpointId).toBe('b');
  });

  it('дыра в кусках — точка отброшена', () => {
    const chunks = chunksOf(checkpoint(1000), 1);

    receiver.receive(chunks[0]);
    receiver.receive(chunks[2]);

    for (const chunk of chunks.slice(3)) {
      receiver.receive(chunk);
    }

    expect(receiver.latest()).toBeNull();
  });

  it('точка больше maxBytes и мусор игнорируются', () => {
    const small = new StandbyReceiver({ maxBytes: 100 });

    for (const chunk of chunksOf(checkpoint(1000), 1)) {
      small.receive(chunk);
    }

    small.receive(new ArrayBuffer(3));

    expect(small.latest()).toBeNull();
  });

  it('attach: куски из канала; закрытие канала точку не теряет', () => {
    const channel = { close: vi.fn() };

    receiver.attach(channel);

    for (const chunk of chunksOf(checkpoint(300), 1)) {
      channel.onmessage({ data: chunk });
    }

    channel.onclose();

    expect(receiver.latest().wireId).toBe(1);
    expect(channel.binaryType).toBe('arraybuffer');
  });
});

describe('StandbyReceiver: seq кадров хоста', () => {
  const frame = (port, seq) => {
    const buffer = new ArrayBuffer(16);
    const view = new DataView(buffer);

    view.setUint8(0, port);
    view.setUint32(2, seq, false);

    return buffer;
  };

  it('помнит seq последнего кадра SHOT_DATA', () => {
    expect(receiver.lastSeenSeq).toBeNull();

    receiver.noteFrame(frame(5, 1234567));
    receiver.noteFrame(frame(9, 1));
    receiver.noteFrame(new ArrayBuffer(2));

    expect(receiver.lastSeenSeq).toBe(1234567);
  });
});

describe('StandbyReceiver: waitForFinal', () => {
  it('ждёт финальную точку', async () => {
    const waiting = receiver.waitForFinal(1, 1000);

    for (const chunk of chunksOf(checkpoint(100), 1)) {
      receiver.receive(chunk);
    }

    for (const chunk of chunksOf(checkpoint(100, { final: true }), 2)) {
      receiver.receive(chunk);
    }

    await expect(waiting).resolves.toMatchObject({ final: true, wireId: 2 });
  });

  it('уже полученная финальная подходит сразу', async () => {
    for (const chunk of chunksOf(checkpoint(100, { final: true }), 3)) {
      receiver.receive(chunk);
    }

    await expect(receiver.waitForFinal(3)).resolves.toMatchObject({
      wireId: 3,
    });
  });

  it('таймаут', async () => {
    vi.useFakeTimers();

    try {
      const waiting = receiver.waitForFinal(0, 100);

      vi.advanceTimersByTime(100);

      await expect(waiting).rejects.toThrow('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('периодическая не новее финальной её не вытесняет, новее — вытесняет', () => {
    const feed = (cp, wireId) => {
      for (const chunk of chunksOf(cp, wireId)) {
        receiver.receive(chunk);
      }
    };

    feed(checkpoint(100, { final: true, seq: 10 }), 1);
    feed(checkpoint(100, { seq: 10 }), 2);

    expect(receiver.latest()).toMatchObject({ final: true, wireId: 1 });

    feed(checkpoint(100, { seq: 11 }), 3);

    expect(receiver.latest()).toMatchObject({ final: false, wireId: 3 });
  });

  it('discardFinal: сорвавшаяся передача не завершает следующую', async () => {
    vi.useFakeTimers();

    try {
      for (const chunk of chunksOf(checkpoint(100, { final: true }), 1)) {
        receiver.receive(chunk);
      }

      receiver.discardFinal();

      expect(receiver.latest()).toMatchObject({ wireId: 1, final: false });

      const waiting = receiver.waitForFinal(0, 100);

      vi.advanceTimersByTime(100);

      await expect(waiting).rejects.toThrow('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('финальная сорвавшейся передачи, доехавшая после discardFinal, — периодическая', async () => {
    vi.useFakeTimers();

    try {
      const feed = (cp, wireId) => {
        for (const chunk of chunksOf(cp, wireId)) {
          receiver.receive(chunk);
        }
      };

      feed(checkpoint(100, { seq: 10 }), 1);
      receiver.discardFinal();
      // застряла у хоста за backpressure и доехала после отмены
      feed(checkpoint(100, { final: true, seq: 12 }), 2);

      expect(receiver.latest()).toMatchObject({ wireId: 2, final: false });

      // следующая передача её не берёт, а ждёт новую финальную
      const stale = receiver.waitForFinal(0, 100);

      vi.advanceTimersByTime(100);
      await expect(stale).rejects.toThrow('timed out');

      // периодическая после разморозки не отброшена
      feed(checkpoint(100, { seq: 13 }), 3);
      expect(receiver.latest()).toMatchObject({ wireId: 3 });

      const waiting = receiver.waitForFinal(0, 1000);

      feed(checkpoint(100, { final: true, seq: 20 }), 4);
      await expect(waiting).resolves.toMatchObject({ final: true, wireId: 4 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('после discardFinal без финальной ожидание снимает первая периодическая', async () => {
    const feed = (cp, wireId) => {
      for (const chunk of chunksOf(cp, wireId)) {
        receiver.receive(chunk);
      }
    };

    receiver.discardFinal();
    feed(checkpoint(100, { seq: 13 }), 1);

    const waiting = receiver.waitForFinal(0, 1000);

    feed(checkpoint(100, { final: true, seq: 20 }), 2);
    await expect(waiting).resolves.toMatchObject({ final: true, wireId: 2 });
  });

  it('destroy выбрасывает точки и отклоняет ожидание', async () => {
    for (const chunk of chunksOf(checkpoint(100), 1)) {
      receiver.receive(chunk);
    }

    const waiting = receiver.waitForFinal(5, 1000);

    receiver.destroy();

    expect(receiver.latest()).toBeNull();
    await expect(waiting).rejects.toThrow('standby released');
  });
});
