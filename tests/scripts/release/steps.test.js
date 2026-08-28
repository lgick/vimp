import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readFile } from 'node:fs/promises';

import {
  checkTarball,
  checkManifest,
  gameCommitPaths,
  publishEngine,
  publishScaffold,
  rollOutProduction,
} from '../../../scripts/release/steps.js';
import { CommandError } from '../../../scripts/release/shell.js';

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

  // при workspace-раскладке (snakes) шаг B переписывает корневой Cargo.toml —
  // без него в списке правка осталась бы вне релизного коммита
  it('добавляет файл пина, когда он вне core/', async () => {
    const dir = path.join(root, 'workspace-pin');
    await mkdir(dir, { recursive: true });

    expect(await gameCommitPaths(dir, 'Cargo.toml')).toEqual([
      'package.json',
      'core/Cargo.toml',
      'Cargo.lock',
      'Cargo.toml',
    ]);
  });

  it('не дублирует пин, лежащий в core/Cargo.toml', async () => {
    const dir = path.join(root, 'core-pin');
    await mkdir(dir, { recursive: true });

    expect(await gameCommitPaths(dir, 'core/Cargo.toml')).toEqual([
      'package.json',
      'core/Cargo.toml',
      'Cargo.lock',
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

// Общий мок shell для шагов A2/A3: записывает команды в порядке вызова —
// проверяется именно он, а не побочные эффекты (dryRun гасит их).
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

// Скаффолдер уезжает в npm вместе с движком: prepack вшивает в его тарбол
// версии из packages/engine, и шаг обязан гнать E2E — unit-тесты шаблон не
// собирают, сломанный он всплыл бы у пользователя на `npm create vimp-game`.
describe('publishScaffold', () => {
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

  // холостой прогон не пишет версию в package.json, поэтому npm отвечает
  // «нельзя опубликовать поверх уже опубликованной». Отказ относится к
  // пропущенному бампу, а не к тарболу, и валить прогон не должен
  it('в dry-run не падает на «поверх опубликованной»', async () => {
    const shell = recordingShell();
    const failing = shell.check;

    shell.check = async (label, command, args, options) => {
      if (args.includes('--dry-run')) {
        shell.calls.push(`check ${command} ${args.join(' ')}`);
        throw new CommandError({
          command: 'npm publish',
          cwd: '.',
          code: 1,
          output: 'npm error You cannot publish over the previously published versions: 0.1.3.',
        });
      }

      return failing(label, command, args, options);
    };

    await expect(
      publishScaffold({
        shell,
        root: scaffoldRoot,
        decision: { target: '0.1.4', bump: true },
        report: { published: [], tags: [] },
      }),
    ).resolves.toBeUndefined();
  });

  // а вот боевой прогон обязан упасть: там версия поднята, и такой отказ —
  // след уже случившейся публикации
  it('в боевом прогоне тот же отказ валит шаг', async () => {
    const shell = recordingShell(false);
    const passing = shell.check;

    shell.check = async (label, command, args, options) => {
      if (args.includes('--dry-run')) {
        throw new CommandError({
          command: 'npm publish',
          cwd: '.',
          code: 1,
          output: 'npm error You cannot publish over the previously published versions: 0.1.4.',
        });
      }

      return passing(label, command, args, options);
    };

    await expect(
      publishScaffold({
        shell,
        root: scaffoldRoot,
        decision: { target: '0.1.4', bump: false },
        report: { published: [], tags: [] },
      }),
    ).rejects.toBeInstanceOf(CommandError);
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

// Шаг A1 бампает крейт, а снимок пинов шаблона пишет только шаг A3 — между
// ними стоит корневой `npm test` шага A2, который сверяет снимок с версиями
// репозитория. Снимок обязан обновиться до прогона.
describe('publishEngine', () => {
  let engineRoot;

  beforeAll(async () => {
    engineRoot = await mkdtemp(path.join(tmpdir(), 'vimp-engine-step-'));
    const dir = path.join(engineRoot, 'packages', 'engine');

    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'vimp-engine', version: '0.10.2' }, null, 2),
    );
    await writeFile(
      path.join(dir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- что-то\n',
    );
  });

  afterAll(async () => {
    await rm(engineRoot, { recursive: true, force: true });
  });

  it('обновляет снимок пинов до корневых тестов и коммитит его', async () => {
    const shell = recordingShell();
    const report = { published: [], tags: [] };

    await publishEngine({
      shell,
      root: engineRoot,
      decision: { target: '0.10.3', bump: true },
      games: [],
      report,
    });

    expect(shell.calls.indexOf(
      'write node packages/create-vimp-game/scripts/write-versions.js',
    )).toBeLessThan(shell.calls.indexOf('check npm test -- --reporter=dot'));

    expect(shell.calls).toContain(
      'write git add -- packages/engine/package.json packages/engine/CHANGELOG.md package-lock.json packages/create-vimp-game/src/versions.generated.json',
    );
  });

  // и после бампа: иначе в коммите с версией 0.10.3 лежит снимок с 0.10.2 —
  // ровно тот красный `npm test`, который ловит versions.test.js
  it('переписывает снимок после бампа, до коммита', async () => {
    const shell = recordingShell();

    await publishEngine({
      shell,
      root: engineRoot,
      decision: { target: '0.10.3', bump: true },
      games: [],
      report: { published: [], tags: [] },
    });

    const snapshots = shell.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.endsWith('write-versions.js'))
      .map(({ index }) => index);
    const bumpAt = shell.calls.indexOf('write npm install');
    const commitAt = shell.calls.findIndex(call => call.startsWith('write git add --'));

    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toBeGreaterThan(bumpAt);
    expect(snapshots[1]).toBeLessThan(commitAt);
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

// ***** ПОДНЯТЫЙ ENGINE_API_VERSION *****
//
// Релиз идёт на копиях ИЗ РЕЕСТРА (links.js снимает локальные линки), а
// поднятый ENGINE_API_VERSION делает несовместимой каждую уже опубликованную
// игру. На шаге движка её ещё физически не существует под новый API — это
// невозможность проверки, а не её провал; на шаге прода игра уже
// переопубликована, и то же расхождение значит выпуск без пересборки.
describe('sim игры при поднятом ENGINE_API_VERSION', () => {
  let simRoot;

  const installGame = async (name, engineApi) => {
    const dir = path.join(simRoot, 'node_modules', name, 'dist');

    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id: name, engineApi }),
    );
  };

  const simCalls = shell =>
    shell.calls.filter(call => call.includes('run sim --'));

  beforeAll(async () => {
    simRoot = await mkdtemp(path.join(tmpdir(), 'vimp-sim-step-'));

    const engine = path.join(simRoot, 'packages', 'engine');

    await mkdir(engine, { recursive: true });
    await writeFile(
      path.join(engine, 'package.json'),
      JSON.stringify({ name: 'vimp-engine', version: '0.10.2' }),
    );
    await writeFile(
      path.join(engine, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- что-то\n',
    );

    await installGame('@vimp-games/stale', 3);
    await installGame('@vimp-games/fresh', 4);
  });

  afterAll(async () => {
    await rm(simRoot, { recursive: true, force: true });
  });

  it('шаг движка пропускает игру, собранную под прошлую версию API', async () => {
    const shell = recordingShell();

    await publishEngine({
      shell,
      root: simRoot,
      decision: { target: '0.10.3', bump: false },
      games: [{ name: '@vimp-games/stale' }],
      report: { published: [], tags: [] },
      engineApi: 4,
    });

    // копии под новый API ещё не существует: её выпустит следующий шаг
    expect(simCalls(shell)).toEqual([]);
  });

  it('шаг движка прогоняет игру, совпадающую по версии API', async () => {
    const shell = recordingShell();

    await publishEngine({
      shell,
      root: simRoot,
      decision: { target: '0.10.3', bump: false },
      games: [{ name: '@vimp-games/fresh' }],
      report: { published: [], tags: [] },
      engineApi: 4,
    });

    expect(simCalls(shell)).toHaveLength(1);
    expect(simCalls(shell)[0]).toContain('node_modules/@vimp-games/fresh');
  });

  // без версии движка (шаг вызван отдельно) поведение прежнее: sim решает сам
  it('без engineApi шаг движка ничего не пропускает', async () => {
    const shell = recordingShell();

    await publishEngine({
      shell,
      root: simRoot,
      decision: { target: '0.10.3', bump: false },
      games: [{ name: '@vimp-games/stale' }],
      report: { published: [], tags: [] },
    });

    expect(simCalls(shell)).toHaveLength(1);
  });

  it('шаг прода на том же расхождении ОТКАЗЫВАЕТ: игра выпущена без пересборки', async () => {
    const shell = recordingShell();

    await expect(
      rollOutProduction({
        shell,
        root: simRoot,
        games: [{ name: '@vimp-games/stale', target: '0.7.5' }],
        report: { published: [], tags: [] },
        tags: [],
        engineApi: 4,
      }),
    ).rejects.toThrow(/engineApi=3, у движка 4/);
  });
});
