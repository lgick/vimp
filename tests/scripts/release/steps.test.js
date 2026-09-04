import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readFile } from 'node:fs/promises';

import {
  packGame,
  checkManifest,
  checkGameStructure,
  extractDist,
  withPublishedGame,
  simVersion,
  gameCommitPaths,
  publishEngine,
  publishScaffold,
  rollOutProduction,
  unpushedTags,
} from '../../../scripts/release/steps.js';
import { CommandError } from '../../../scripts/release/shell.js';
import { tarballOf, variants, writeDist } from '../../fixtures/gamePackages.js';

let root;

// npm pack --json пишет ответ в stdout, а предупреждения — в stderr:
// проверяем именно то разделение, ради которого потоки разъехались
function fakeShell(stdout, stderr = '') {
  return {
    check: async () => ({ code: 0, stdout, stderr, output: stdout + stderr }),
  };
}

// Формы ответа `npm pack --json`, снятые с живого вывода и подписанные
// версией инструмента, для которой сняты: npm 12.0.2 отдаёт объект «имя
// пакета → пакет», npm 11 и старше — массив пакетов. Разбор обязан принимать
// обе — устаревшая фикстура уже сделала эти тесты зелёными и ложными, и
// релиз игры упал там, где тест ничего не заметил (кодревью
// master-game-registry, находка 2)
const packEntry = files => ({
  id: '@vimp-games/snakes@0.4.0',
  name: '@vimp-games/snakes',
  filename: 'vimp-games-snakes-0.4.0.tgz',
  files: files.map(file => ({ path: file })),
});

const PACK_FORMS = [
  [
    'npm 12 (объект «имя → пакет»)',
    files => JSON.stringify({ '@vimp-games/snakes': packEntry(files) }),
  ],
  ['npm 11 (массив пакетов)', files => JSON.stringify([packEntry(files)])],
];

const FULL = [
  'package.json',
  'dist/manifest.json',
  'dist/core-node/vimp_tanks_core.js',
  'dist/core-node/vimp_tanks_core_bg.wasm',
];

// каталог с распакованным содержимым package/dist — то, что проверяют
// checkManifest и checkGameStructure
async function writeManifest(name, manifest) {
  const distDir = path.join(root, name, 'dist');
  await mkdir(distDir, { recursive: true });
  await writeFile(
    path.join(distDir, 'manifest.json'),
    JSON.stringify(manifest),
  );
  return distDir;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vimp-steps-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const pack = (shell, destDir = root) => packGame({ shell, dir: root, destDir });

describe.each(PACK_FORMS)('packGame: %s', (_form, packJson) => {
  it('пропускает тарбол с манифестом и node-ядром', async () => {
    const { files, tarball } = await pack(fakeShell(packJson(FULL)));

    expect(files).toHaveLength(4);
    expect(tarball).toBe(path.join(root, 'vimp-games-snakes-0.4.0.tgz'));
  });

  it('не спотыкается о предупреждение npm в stderr', async () => {
    const shell = fakeShell(
      packJson(FULL),
      'npm warn deprecated foo@1: use [bar]\n',
    );

    await expect(pack(shell)).resolves.toMatchObject({ files: FULL });
  });

  it('падает без dist/manifest.json', async () => {
    const shell = fakeShell(
      packJson(FULL.filter(f => f !== 'dist/manifest.json')),
    );

    await expect(pack(shell)).rejects.toThrow(/dist\/manifest\.json/);
  });

  it('падает без wasm рядом с глюe', async () => {
    const shell = fakeShell(packJson(FULL.filter(f => !f.endsWith('.wasm'))));

    await expect(pack(shell)).rejects.toThrow(/\.wasm/);
  });
});

describe('packGame: неразбираемый вывод', () => {
  it('внятно падает на не-JSON', async () => {
    await expect(pack(fakeShell('не json'))).rejects.toThrow(/npm pack --json/);
  });

  // третья форма ответа обязана давать ТУ ЖЕ внятную строку, а не
  // `Cannot read properties of undefined (reading 'files')`: именно это
  // сообщение и стоило разбора при отказе релиза
  it.each([
    ['пустой объект', '{}'],
    ['пустой массив', '[]'],
    ['null', 'null'],
    ['пакет без files', '{"@vimp-games/snakes":{"id":"x"}}'],
  ])('внятно падает на форме «%s»', async (_name, stdout) => {
    const promise = pack(fakeShell(stdout));

    await expect(promise).rejects.toThrow(/npm pack --json/);
    await expect(promise).rejects.not.toThrow(/Cannot read properties/);
  });
});

describe('checkManifest', () => {
  it('пропускает манифест с совпадающим engineApi и путём внутри dist/', async () => {
    const distDir = await writeManifest('ok', {
      engineApi: 3,
      entries: { wasmNode: './core-node/vimp_tanks_core.js' },
    });

    await expect(
      checkManifest({ distDir, engineApi: 3 }),
    ).resolves.toBeUndefined();
  });

  it('ловит расхождение engineApi', async () => {
    const distDir = await writeManifest('api', {
      engineApi: 2,
      entries: { wasmNode: './core-node/core.js' },
    });

    await expect(checkManifest({ distDir, engineApi: 3 })).rejects.toThrow(
      /engineApi=2/,
    );
  });

  it('ловит путь наружу из dist/', async () => {
    const distDir = await writeManifest('outside', {
      engineApi: 3,
      entries: { wasmNode: '../core/pkg-node/core.js' },
    });

    await expect(checkManifest({ distDir, engineApi: 3 })).rejects.toThrow(
      /wasmNode/,
    );
  });

  it('ловит отсутствующий wasmNode вместо TypeError', async () => {
    const distDir = await writeManifest('missing', {
      engineApi: 3,
      entries: {},
    });

    await expect(checkManifest({ distDir, engineApi: 3 })).rejects.toThrow(
      /wasmNode/,
    );
  });
});

// ***** ПРОВЕРКА ПАКЕТА ЛОГИКОЙ МАСТЕРА *****
//
// Мастер встречает пакет тем же checkGamePackage на POST /games/submit и
// POST /games/mine/:id/version и отвечает 400 со списком проблем. Версия в
// npm неперезаписываема: узнать об отказе надо ДО публикации, а не от
// реестра после.
describe('checkGameStructure', () => {
  it('валидный dist проходит и отдаёт вердикт совместимости', async () => {
    const distDir = writeDist(
      await mkdtemp(path.join(root, 'valid-')),
      variants.valid.files,
    );

    await expect(checkGameStructure({ distDir })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('отказывает списком проблем мастера, а не первой из них', async () => {
    const distDir = writeDist(
      await mkdtemp(path.join(root, 'broken-')),
      variants.missingMap.files,
    );

    const promise = checkGameStructure({ distDir });

    await expect(promise).rejects.toThrow(/gamePackageCheck/);
    await expect(promise).rejects.toThrow(/nowhere/);
  });
});

describe('extractDist', () => {
  it('распаковывает только package/dist и срезает префикс', async () => {
    const tmp = await mkdtemp(path.join(root, 'tgz-'));
    const tarball = path.join(tmp, 'game.tgz');

    await writeFile(tarball, await tarballOf('extraFiles'));

    const distDir = path.join(tmp, 'dist');

    await extractDist(tarball, distDir);

    const manifest = JSON.parse(
      await readFile(path.join(distDir, 'manifest.json'), 'utf8'),
    );

    expect(manifest.id).toBe('tanks');
    // README и src/ пакета в раздаче не существуют — как и у мастера
    expect(existsSync(path.join(distDir, 'README.md'))).toBe(false);
    expect(existsSync(path.join(tmp, 'package'))).toBe(false);
  });
});

// Пина игр в корневом package.json больше нет, а линки на время релиза
// сняты: копию, которую поставят пользователи, шаг ставит себе сам
describe('withPublishedGame', () => {
  it('ставит копию из npm во временный каталог и убирает его', async () => {
    const calls = [];
    const shell = {
      check: async label => {
        calls.push(label);
        return { code: 0, stdout: '', stderr: '', output: '' };
      },
    };

    let handed;

    await withPublishedGame(
      shell,
      { name: '@vimp-games/tanks', version: '0.17.0' },
      async dir => {
        handed = dir;
      },
    );

    expect(calls).toEqual(['npm install @vimp-games/tanks@0.17.0']);
    expect(
      handed.endsWith(path.join('node_modules', '@vimp-games/tanks')),
    ).toBe(true);
    // каталог живёт ровно на время прогона: релиз не оставляет мусора
    expect(existsSync(path.dirname(path.dirname(handed)))).toBe(false);
  });

  // игра, которой в реестре ещё нет вовсе (её первый релиз идёт прямо
  // сейчас): на шаге движка это невозможность проверки, а не её провал
  it('optional: отсутствие пакета в реестре — пропуск, а не падение шага', async () => {
    const shell = {
      check: async () => {
        throw new CommandError({
          command: 'npm install',
          cwd: '/tmp',
          code: 1,
          output: 'npm error code E404',
        });
      },
    };

    let called = false;

    await expect(
      withPublishedGame(
        shell,
        { name: '@vimp-games/new', version: 'latest', optional: true },
        async () => {
          called = true;
        },
      ),
    ).rejects.toThrow(/не ставится/);

    expect(called).toBe(false);
  });

  it('без optional отказ установки остаётся отказом', async () => {
    const shell = {
      check: async () => {
        throw new CommandError({
          command: 'npm install',
          cwd: '/tmp',
          code: 1,
          output: 'npm error code E404',
        });
      },
    };

    await expect(
      withPublishedGame(
        shell,
        { name: '@vimp-games/new', version: '0.1.0' },
        async () => {},
      ),
    ).rejects.toThrow(CommandError);
  });

  it('с готовым installRoot ничего не ставит и не удаляет', async () => {
    const shell = {
      check: async () => {
        throw new Error('ставить не должно');
      },
    };

    const dir = await withPublishedGame(
      shell,
      { name: '@vimp-games/tanks', version: '0.17.0', installRoot: root },
      async handed => handed,
    );

    expect(dir).toBe(path.join(root, 'node_modules', '@vimp-games/tanks'));
    expect(existsSync(root)).toBe(true);
  });
});

describe('simVersion', () => {
  const game = { name: '@vimp-games/tanks', target: '0.17.1' };

  it('шаг прода гоняет ровно выпущенную версию', () => {
    expect(simVersion(game, { strict: true })).toBe('0.17.1');
  });

  it('шаг движка — ту, что стоит у пользователей', () => {
    expect(simVersion(game, {})).toBe('latest');
  });

  // холостой прогон ничего не публикует: 0.17.1 в реестре не появится, и
  // установка упала бы на E404 — репетиция обязана доходить до конца
  it('в холостом прогоне даже на проде — latest', () => {
    expect(simVersion(game, { strict: true, dryRun: true })).toBe('latest');
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

// Шелл, отвечающий на `git tag` заранее заданными списками: `read` в
// recordingShell всегда возвращает код 1 (это форма ответа `diff --cached`),
// а здесь нужен именно вывод
function tagShell(byCommand) {
  return {
    dryRun: true,
    read: async (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      const stdout = byCommand[key];

      return stdout === undefined
        ? { code: 1, stdout: '', stderr: '', output: '' }
        : { code: 0, stdout, stderr: '', output: stdout };
    },
  };
}

// Прерванный прогон ставит тег и падает следующим шагом: report.tags нового
// запуска о нём не знает, и без досбора тег остался бы лежать локально —
// сводка сказала бы «прод: запушен», а движок в origin приехал бы без тега
describe('unpushedTags', () => {
  it('добавляет теги на коммитах, не уехавших в upstream', async () => {
    const shell = tagShell({
      'git tag --contains @{u}':
        'vimp-engine-core@0.10.0\nvimp-engine@0.29.0\n',
      'git tag --points-at @{u}': '',
    });

    const tags = await unpushedTags(shell, '/repo', ['create-vimp-game@0.4.7']);

    expect(tags).toEqual([
      'create-vimp-game@0.4.7',
      'vimp-engine-core@0.10.0',
      'vimp-engine@0.29.0',
    ]);
  });

  it('не берёт тег самого upstream: --contains считает коммит своим предком', async () => {
    const shell = tagShell({
      'git tag --contains @{u}': 'vimp-engine@0.28.0\nvimp-engine@0.29.0\n',
      'git tag --points-at @{u}': 'vimp-engine@0.28.0\n',
    });

    expect(await unpushedTags(shell, '/repo', [])).toEqual([
      'vimp-engine@0.29.0',
    ]);
  });

  it('без upstream отдаёт только теги текущего прогона', async () => {
    const shell = tagShell({});

    expect(await unpushedTags(shell, '/repo', ['vimp-engine@0.29.0'])).toEqual([
      'vimp-engine@0.29.0',
    ]);
  });
});

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
    expect(
      shell.calls.indexOf(
        'write node packages/create-vimp-game/scripts/write-versions.js',
      ),
    ).toBeLessThan(shell.calls.indexOf('check npx eslint .'));

    const publishAt = shell.calls.findIndex(call =>
      call.startsWith('publish '),
    );

    expect(publishAt).toBeGreaterThan(
      shell.calls.indexOf('check npm run test:scaffold'),
    );
    expect(shell.calls[publishAt]).toBe(
      'publish npm publish -w create-vimp-game',
    );
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
          output:
            'npm error You cannot publish over the previously published versions: 0.1.3.',
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
          output:
            'npm error You cannot publish over the previously published versions: 0.1.4.',
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

    expect(
      shell.calls.indexOf(
        'write node packages/create-vimp-game/scripts/write-versions.js',
      ),
    ).toBeLessThan(shell.calls.indexOf('check npm test -- --reporter=dot'));

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
    // startsWith, а не точное равенство: у install есть флаги (--no-audit и
    // прочие), и сверка по полной строке молча превратила бы bumpAt в -1 —
    // тогда проверка порядка проходит при любом порядке
    const bumpAt = shell.calls.findIndex(call =>
      call.startsWith('write npm install'),
    );
    const commitAt = shell.calls.findIndex(call =>
      call.startsWith('write git add --'),
    );

    expect(snapshots).toHaveLength(2);
    expect(bumpAt).toBeGreaterThan(-1);
    expect(commitAt).toBeGreaterThan(-1);
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
      installRoot: simRoot,
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
      installRoot: simRoot,
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
      installRoot: simRoot,
    });

    expect(simCalls(shell)).toHaveLength(1);
  });

  // Публикация игры не меняет в этом репозитории ни файла (игры едут через
  // реестр auth-сервиса), поэтому пуш в main был бы деплоем без изменений —
  // за подтверждением «это ДЕПЛОЙ прода». Проверить выпущенную игру против
  // текущего движка всё равно надо, и ради неё шаг и выполняется
  it('релиз одних игр: только sim, без пуша, снимка пинов и npm test', async () => {
    const shell = recordingShell();

    await rollOutProduction({
      shell,
      root: simRoot,
      games: [{ name: '@vimp-games/fresh', target: '0.7.5' }],
      report: { published: [], tags: [], remaining: [] },
      tags: [],
      engineApi: 4,
      push: false,
      installRoot: simRoot,
    });

    expect(simCalls(shell)).toHaveLength(1);
    expect(shell.calls.filter(call => call.includes('git push'))).toEqual([]);
    expect(shell.calls.filter(call => call.includes('npm test'))).toEqual([]);
    expect(shell.calls.filter(call => call.includes('git commit'))).toEqual([]);
  });

  // деплоем шаг скаффолдера не является, но коммит `chore: bump
  // create-vimp-game` и тег он делает В ЭТОМ репозитории: без пуша они
  // остаются локальными, и сводка обязана это назвать — иначе «прод: не
  // пушился» умалчивает, что на ветке лежит незапушенное
  it('незапушенные теги репозитория попадают в «осталось»', async () => {
    const shell = recordingShell();
    const report = { published: [], tags: [], remaining: [] };

    // адрес лобби дописывается к напоминанию: у разработчика он может быть
    // выставлен, и тогда строка другая
    vi.stubEnv('VIMP_LOBBY_URL', '');

    await rollOutProduction({
      shell,
      root: simRoot,
      games: [{ name: '@vimp-games/fresh', target: '0.7.5' }],
      report,
      tags: ['create-vimp-game@0.4.4'],
      engineApi: 4,
      push: false,
      installRoot: simRoot,
    });

    // сперва напоминание о каталоге: без подачи версии и одобрения игра до
    // игроков не доедет вовсе, пуш тегов рядом с этим — мелочь
    expect(report.remaining).toEqual([
      '@vimp-games/fresh@0.7.5: подать версию в лобби ' +
        '(«Мои игры» → «Обновить») и подтвердить в «Модерации»',
      'пуш локальных коммитов и тегов этого репозитория',
    ]);
    expect(shell.calls.filter(call => call.includes('git push'))).toEqual([]);

    vi.unstubAllEnvs();
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
        installRoot: simRoot,
      }),
    ).rejects.toThrow(/engineApi=3, у движка 4/);

    expect(
      shell.calls.filter(call => call.includes('@vimp-games/stale@')),
    ).toEqual([]);
  });
});
