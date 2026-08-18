import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readFile } from 'node:fs/promises';

import {
  checkTarball,
  checkManifest,
  gameCommitPaths,
  publishScaffold,
} from '../../../scripts/release/steps.js';

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

describe('gameCommitPaths', () => {
  it('добавляет package-lock.json, когда он есть', async () => {
    const dir = path.join(root, 'with-lock');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package-lock.json'), '{}');

    expect(await gameCommitPaths(dir)).toEqual([
      'package.json',
      'core/Cargo.toml',
      'Cargo.lock',
      'package-lock.json',
    ]);
  });

  // `git add -- package-lock.json` по несуществующему пути падает, а это уже
  // после публикации: откатывать пришлось бы руками
  it('не просит git добавить отсутствующий lock-файл', async () => {
    const dir = path.join(root, 'no-lock');
    await mkdir(dir, { recursive: true });

    expect(await gameCommitPaths(dir)).not.toContain('package-lock.json');
  });
});

// Скаффолдер уезжает в npm вместе с движком: prepack вшивает в его тарбол
// версии из packages/engine, и шаг обязан гнать E2E — unit-тесты шаблон не
// собирают, сломанный он всплыл бы у пользователя на `npm create vimp-game`.
describe('publishScaffold', () => {
  function recordingShell(dryRun = true) {
    const calls = [];

    return {
      dryRun,
      calls,
      check: async (label, command, args) => {
        calls.push(`check ${command} ${args.join(' ')}`);
        return { code: 0, stdout: '', stderr: '', output: '' };
      },
      read: async (command, args) => {
        calls.push(`read ${command} ${args.join(' ')}`);
        // код 1 у `diff --cached --quiet` = есть что коммитить
        return { code: 1, stdout: '', stderr: '', output: '' };
      },
      write: async (command, args) => {
        calls.push(`write ${command} ${args.join(' ')}`);
        return { code: 0, stdout: '', stderr: '', output: '' };
      },
      publish: async (command, args) => {
        calls.push(`publish ${command} ${args.join(' ')}`);
        return { code: 0, stdout: '', stderr: '', output: '' };
      },
    };
  }

  let scaffoldRoot;

  beforeAll(async () => {
    scaffoldRoot = await mkdtemp(path.join(tmpdir(), 'vimp-scaffold-'));
    const dir = path.join(scaffoldRoot, 'packages', 'create-vimp-game');

    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'create-vimp-game', version: '0.1.0' }, null, 2),
    );
    await writeFile(
      path.join(dir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- что-то\n',
    );
  });

  afterAll(async () => {
    await rm(scaffoldRoot, { recursive: true, force: true });
  });

  it('гоняет eslint, тесты и E2E до публикации', async () => {
    const shell = recordingShell();
    const report = { published: [], tags: [] };

    await publishScaffold({
      shell,
      root: scaffoldRoot,
      decision: { target: '0.1.1', bump: true },
      report,
    });

    const checks = shell.calls.filter(call => call.startsWith('check '));

    expect(checks).toEqual([
      'check npx eslint .',
      'check npm test -- --reporter=dot',
      'check npm run test:scaffold',
      'check npm publish -w create-vimp-game --dry-run',
    ]);

    // снимок пинов снимается ДО проверок: шаг A2 уже поднял версию движка,
    // и versions.test.js сверяет снимок именно с ней
    expect(shell.calls.indexOf(
      'write node packages/create-vimp-game/scripts/write-versions.js',
    )).toBeLessThan(shell.calls.indexOf('check npx eslint .'));

    const publishAt = shell.calls.findIndex(call => call.startsWith('publish '));

    expect(publishAt).toBeGreaterThan(
      shell.calls.indexOf('check npm run test:scaffold'),
    );
    expect(shell.calls[publishAt]).toBe('publish npm publish -w create-vimp-game');
  });

  it('коммитит только свои файлы и ставит именованный тег', async () => {
    const shell = recordingShell();
    const report = { published: [], tags: [] };

    await publishScaffold({
      shell,
      root: scaffoldRoot,
      decision: { target: '0.1.1', bump: true },
      report,
    });

    expect(shell.calls).toContain(
      'write git add -- packages/create-vimp-game/package.json packages/create-vimp-game/CHANGELOG.md packages/create-vimp-game/src/versions.generated.json package-lock.json',
    );
    expect(shell.calls).toContain('write git tag create-vimp-game@0.1.1');
    expect(report.published).toEqual(['create-vimp-game@0.1.1 (npm)']);
    expect(report.tags).toEqual([
      { repo: scaffoldRoot, name: 'create-vimp-game@0.1.1' },
    ]);
  });
});

// Публикация обязана идти через shell.publish: с захваченными потоками npm и
// cargo при 2FA падают с EOTP, не успев спросить одноразовый код.
describe('режим запуска публикации', () => {
  it('ни одна publish-команда не уезжает в захваченный write', async () => {
    const source = await readFile(
      new URL('../../../scripts/release/steps.js', import.meta.url),
      'utf8',
    );

    expect(source.match(/shell\.write\([^)]*'publish'[^)]*\)/g)).toBe(null);
    expect(source.match(/shell\.publish\(/g)?.length).toBeGreaterThan(0);
  });
});
