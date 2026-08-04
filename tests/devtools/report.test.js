import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  writeReport,
  formatMarkdown,
} from '../../packages/engine/src/devtools/report.js';

const report = () => ({
  scenario: { ticks: 60, seed: 1 },
  game: { id: 'miniGame', source: 'fixture:miniGame' },
  seed: 3812,
  stepMs: 8,
  durationMs: 480,
  currentMap: 'arena',
  participants: [{ id: 'p1', socketId: 's1', gameId: 0 }],
  frameCounts: { sendShot: 60, sendPanel: 1 },
  mapChanges: [{ tick: 30, map: 'arena2' }],
  clients: [
    {
      socketId: 's1',
      gameId: 0,
      camera: [1, 2],
      frameCount: 60,
      entities: { a1: { 0: [1, 2, 0, 1] } },
      decodeErrors: [{ message: 'snapshot key ghost is missing' }],
      divergence: {
        samples: 30,
        violations: 1,
        dropped: 0,
        maxDelta: [12.5, 0],
        records: [
          {
            source: 'state',
            serverTime: 1200,
            delta: [12.5, 0],
            exceeded: [0],
          },
        ],
      },
    },
  ],
  scenes: [
    { tick: 6, core: null, clients: [] },
    {
      tick: 60,
      core: {
        bodies: [{ handle: 0 }, { handle: 1 }],
        colliders: [{ handle: 0 }],
        map: { setId: 'arena2' },
        nav: { nodes: 12 },
        spatial: { entities: 2 },
        rng: { state: '7' },
        step: { accumulator: 0 },
      },
      clients: [],
    },
  ],
  invariants: [
    {
      id: 3,
      name: 'fieldWidths',
      title: 'decoded field count matches the schema',
      status: 'fail',
      violations: ["s1: 'a1' decoded 3 field(s), schema declares 4"],
    },
    {
      id: 9,
      name: 'predictionDrift',
      title: 'client prediction drift below the threshold',
      status: 'fail',
      violations: ["s1: serverTime 1200, offset 0, source 'state': #0 Δ12.5 > 1"],
    },
  ],
  invariantSummary: { passed: 0, failed: 2, skipped: 0, violations: 2 },
});

let dir;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = null;
  }
});

describe('formatMarkdown', () => {
  it('печатает сводку прогона и нарушения контракта', () => {
    const md = formatMarkdown(report());

    expect(md).toContain('# Simulation report — miniGame');
    expect(md).toContain('seed: `3812`');
    expect(md).toContain('| sendShot | 60 |');
    expect(md).toContain('a1×1');
    expect(md).toContain('snapshot key ghost is missing');
    expect(md).toContain('tick 30: `arena2`');
  });

  it('печатает сводку дампа мира последнего среза', () => {
    const md = formatMarkdown(report());

    expect(md).toContain('## World (core dump)');
    expect(md).toContain('Tick 60 — `scene-60.json`');
    expect(md).toContain('- bodies: 2');
    expect(md).toContain('- colliders: 1');
    expect(md).toContain('nav nodes: 12');
    expect(md).toContain('rng state: `7`');
  });

  it('печатает дрейф предикта: агрегаты и записи', () => {
    const md = formatMarkdown(report());

    expect(md).toContain('## Prediction drift');
    expect(md).toContain('30 reconciliation(s), 1 over threshold');
    expect(md).toContain('max |Δ| per component: [12.5, 0]');
    expect(md).toContain('serverTime 1200 (source `state`)');
  });

  it('печатает вердикт по инвариантам с именем нарушенного контракта', () => {
    const md = formatMarkdown(report());

    expect(md).toContain('0 passed, 2 failed, 0 skipped');
    expect(md).toContain('❌ 3. `fieldWidths`');
    expect(md).toContain("s1: 'a1' decoded 3 field(s), schema declares 4");
    expect(md).toContain('❌ 9. `predictionDrift`');
    expect(md).toContain("#0 Δ12.5 > 1");
  });
});

describe('writeReport', () => {
  it('раскладывает отчёт и срезы сцены по файлам', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vimp-sim-'));

    const runDir = await writeReport(report(), {
      outDir: dir,
      stamp: 'test',
    });

    expect(path.basename(runDir)).toBe('run-test');
    expect((await readdir(runDir)).sort()).toEqual([
      'report.json',
      'report.md',
      'scene-6.json',
      'scene-60.json',
    ]);

    const json = JSON.parse(await readFile(path.join(runDir, 'report.json'), 'utf8'));

    // сцены вынесены в отдельные файлы — в report.json остаются только их тики
    expect(json.scenes).toBeUndefined();
    expect(json.sceneTicks).toEqual([6, 60]);
    expect(json.seed).toBe(3812);

    const scene = JSON.parse(
      await readFile(path.join(runDir, 'scene-60.json'), 'utf8'),
    );

    expect(scene.tick).toBe(60);
  });
});
