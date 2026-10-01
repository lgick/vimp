import { describe, it, expect } from 'vitest';
import {
  encodeCheckpoint,
  decodeCheckpoint,
} from '../../packages/engine/src/lib/checkpointCodec.js';

describe('checkpointCodec', () => {
  it('round-trip: мета и байты ядра возвращаются как были', async () => {
    const meta = { version: 4, seq: 12, name: 'карта' };
    const core = new Uint8Array([0, 1, 2, 250, 255]);

    const bytes = await encodeCheckpoint(meta, core);
    const decoded = await decodeCheckpoint(bytes);

    expect(decoded.meta).toEqual(meta);
    expect([...decoded.core]).toEqual([...core]);
  });

  it('без ядра (мягкий режим) core — null', async () => {
    const decoded = await decodeCheckpoint(await encodeCheckpoint({ a: 1 }));

    expect(decoded.core).toBeNull();
  });

  it('результат сжат и владеет своим буфером (список переноса)', async () => {
    const core = new Uint8Array(100000).fill(7);
    const bytes = await encodeCheckpoint({ v: 4 }, core);

    expect(bytes.byteLength).toBeLessThan(5000);
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.byteLength).toBe(bytes.buffer.byteLength);
  });

  it('предел распакованного размера отвергает «zip-бомбу»', async () => {
    const bytes = await encodeCheckpoint({}, new Uint8Array(200000));

    await expect(decodeCheckpoint(bytes, { maxBytes: 1000 })).rejects.toThrow(
      /exceeds 1000 bytes/,
    );
  });

  it('битый буфер — понятная ошибка', async () => {
    await expect(
      decodeCheckpoint(new Uint8Array([1, 2, 3, 4, 5])),
    ).rejects.toThrow(/corrupted/);
  });

  it('длина меты за пределами буфера — ошибка, а не мусор', async () => {
    const raw = new Uint8Array([255, 255, 0, 0, 123]);
    const gz = new Uint8Array(
      await new Response(
        new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip')),
      ).arrayBuffer(),
    );

    await expect(decodeCheckpoint(gz)).rejects.toThrow(/meta length/);
  });
});
