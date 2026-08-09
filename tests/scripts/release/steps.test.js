import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkTarball, checkManifest } from '../../../scripts/release/steps.js';

let root;

// npm pack --json пишет ответ в stdout, а предупреждения — в stderr:
// проверяем именно то разделение, ради которого потоки разъехались
function fakeShell(stdout, stderr = '') {
  return {
    check: async () => ({ code: 0, stdout, stderr, output: stdout + stderr }),
  };
}

function packJson(files) {
  return JSON.stringify([{ files: files.map(file => ({ path: file })) }]);
}

const FULL = [
  'package.json',
  'dist/manifest.json',
  'dist/core-node/vimp_tanks_core.js',
  'dist/core-node/vimp_tanks_core_bg.wasm',
];

async function writeManifest(name, manifest) {
  const dir = path.join(root, name);
  await mkdir(path.join(dir, 'dist'), { recursive: true });
  await writeFile(
    path.join(dir, 'dist', 'manifest.json'),
    JSON.stringify(manifest),
  );
  return dir;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vimp-steps-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('checkTarball', () => {
  it('пропускает тарбол с манифестом и node-ядром', async () => {
    const count = await checkTarball({ shell: fakeShell(packJson(FULL)), dir: root });

    expect(count).toBe(4);
  });

  it('не спотыкается о предупреждение npm в stderr', async () => {
    const shell = fakeShell(packJson(FULL), 'npm warn deprecated foo@1: use [bar]\n');

    await expect(checkTarball({ shell, dir: root })).resolves.toBe(4);
  });

  it('падает без dist/manifest.json', async () => {
    const shell = fakeShell(packJson(FULL.filter(f => f !== 'dist/manifest.json')));

    await expect(checkTarball({ shell, dir: root })).rejects.toThrow(
      /dist\/manifest\.json/,
    );
  });

  it('падает без wasm рядом с глюe', async () => {
    const shell = fakeShell(packJson(FULL.filter(f => !f.endsWith('.wasm'))));

    await expect(checkTarball({ shell, dir: root })).rejects.toThrow(/\.wasm/);
  });

  it('внятно падает на неразбираемом выводе', async () => {
    await expect(
      checkTarball({ shell: fakeShell('не json'), dir: root }),
    ).rejects.toThrow(/npm pack --json/);
  });
});

describe('checkManifest', () => {
  it('пропускает манифест с совпадающим engineApi и путём внутри dist/', async () => {
    const dir = await writeManifest('ok', {
      engineApi: 3,
      entries: { wasmNode: './core-node/vimp_tanks_core.js' },
    });

    await expect(checkManifest({ dir, engineApi: 3 })).resolves.toBeUndefined();
  });

  it('ловит расхождение engineApi', async () => {
    const dir = await writeManifest('api', {
      engineApi: 2,
      entries: { wasmNode: './core-node/core.js' },
    });

    await expect(checkManifest({ dir, engineApi: 3 })).rejects.toThrow(
      /engineApi=2/,
    );
  });

  it('ловит путь наружу из dist/', async () => {
    const dir = await writeManifest('outside', {
      engineApi: 3,
      entries: { wasmNode: '../core/pkg-node/core.js' },
    });

    await expect(checkManifest({ dir, engineApi: 3 })).rejects.toThrow(/wasmNode/);
  });

  it('ловит отсутствующий wasmNode вместо TypeError', async () => {
    const dir = await writeManifest('missing', { engineApi: 3, entries: {} });

    await expect(checkManifest({ dir, engineApi: 3 })).rejects.toThrow(/wasmNode/);
  });
});
