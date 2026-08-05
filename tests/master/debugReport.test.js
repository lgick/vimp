import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import DebugReportStore from '../../packages/engine/src/master/DebugReportStore.js';

// Приёмник выгрузок браузерной половины отладочного контура (этап 6 плана
// plan/done/ai-debug): записанный вкладкой хоста сценарий должен лечь в `.debug/`
// в том же виде, в каком его читает `npm run sim:replay`.

const scenario = {
  version: 1,
  seed: 3812,
  participants: [{ id: 'p1', name: 'P1', model: 'm1' }],
  timeline: [{ tick: 0, op: 'join', who: 'p1' }],
  ticks: 120,
};

describe('DebugReportStore', () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vimp-debug-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('сохраняет сценарий и отдаёт имя файла', async () => {
    const store = new DebugReportStore(root);
    const { file, bytes } = await store.save(
      { kind: 'scenario', payload: scenario, note: 'tank in wall' },
      { stamp: 'now' },
    );

    expect(file).toBe('scenario-now-1.json');
    expect(bytes).toBeGreaterThan(0);

    const saved = JSON.parse(await readFile(path.join(root, file), 'utf8'));

    expect(saved.kind).toBe('scenario');
    expect(saved.note).toBe('tank in wall');
    expect(saved.payload).toEqual(scenario);
    expect(typeof saved.receivedAt).toBe('string');
  });

  it('имена файлов не сталкиваются в пределах одной метки времени', async () => {
    const store = new DebugReportStore(root);

    await store.save({ kind: 'dump', payload: { a: 1 } }, { stamp: 'now' });
    await store.save({ kind: 'dump', payload: { a: 2 } }, { stamp: 'now' });

    expect((await readdir(root)).sort()).toEqual([
      'dump-now-1.json',
      'dump-now-2.json',
    ]);
  });

  it('неизвестный kind и пустой payload отклоняются с кодом 400', async () => {
    const store = new DebugReportStore(root);

    await expect(store.save({ kind: 'evil', payload: {} })).rejects.toMatchObject({
      status: 400,
    });
    await expect(store.save({ kind: 'scenario' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(store.save(null)).rejects.toMatchObject({ status: 400 });

    expect(await readdir(root)).toEqual([]);
  });

  it('превышение лимита размера отклоняется с кодом 413', async () => {
    const store = new DebugReportStore(root, { maxBytes: 64 });

    await expect(
      store.save({ kind: 'scenario', payload: scenario }),
    ).rejects.toMatchObject({ status: 413 });

    expect(await readdir(root)).toEqual([]);
  });

  it('вид выгрузки задаёт префикс файла', async () => {
    const store = new DebugReportStore(root);

    const { file } = await store.save(
      { kind: 'divergence', payload: { samples: 0 } },
      { stamp: 'now' },
    );

    expect(file).toBe('divergence-now-1.json');
  });
});
