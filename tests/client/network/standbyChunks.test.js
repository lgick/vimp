import { describe, it, expect } from 'vitest';
import {
  STANDBY_HEADER_BYTES,
  decodeStandbyChunk,
  encodeStandbyChunks,
  parseStandbyStream,
} from '../../../packages/engine/src/client/network/standbyChunks.js';

// собирает логический поток из кусков одной точки
const roundTrip = checkpoint => {
  const chunks = encodeStandbyChunks(checkpoint, 1, 64).map(decodeStandbyChunk);
  const stream = new Uint8Array(chunks[0].totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    stream.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }

  return parseStandbyStream(stream);
};

const checkpoint = game => ({
  checkpointId: 'cp-1',
  createdAt: 1000,
  mode: 'periodic',
  seq: 7,
  final: false,
  game,
  bytes: new Uint8Array(100).fill(3),
});

describe('standbyChunks: игра в дескрипторе (ревью F15)', () => {
  it('game проходит туда и обратно', () => {
    const parsed = roundTrip(checkpoint({ id: 'tanks', version: '1.2.0' }));

    expect(parsed.game).toEqual({ id: 'tanks', version: '1.2.0' });
    expect(parsed.checkpointId).toBe('cp-1');
    expect(parsed.bytes).toEqual(new Uint8Array(100).fill(3));
  });

  it.each([
    ['нет поля', undefined],
    ['null', null],
    ['строка', 'tanks@1.0.0'],
    ['пустой id', { id: '', version: '1.0.0' }],
    ['версия не строка', { id: 'tanks', version: 1 }],
    ['длинный id', { id: 'x'.repeat(65), version: '1.0.0' }],
  ])('мусор (%s) → null', (_, game) => {
    expect(roundTrip(checkpoint(game)).game).toBeNull();
  });

  it('лишние поля игры отбрасываются', () => {
    const parsed = roundTrip(
      checkpoint({ id: 'tanks', version: '1.0.0', hostEntryUrl: '/x.js' }),
    );

    expect(parsed.game).toEqual({ id: 'tanks', version: '1.0.0' });
  });

  it('дескриптор без game от старого хоста → null', () => {
    const desc = new TextEncoder().encode(
      JSON.stringify({ checkpointId: 'cp', createdAt: 1, mode: null }),
    );
    const stream = new Uint8Array(2 + desc.byteLength + 1);

    new DataView(stream.buffer).setUint16(0, desc.byteLength, true);
    stream.set(desc, 2);

    expect(parseStandbyStream(stream).game).toBeNull();
    expect(STANDBY_HEADER_BYTES).toBe(24);
  });
});
