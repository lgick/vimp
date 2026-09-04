import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { extract as tarExtract } from 'tar';

import { checkGamePackage } from '../../packages/engine/src/master/gamePackageCheck.js';

import * as ui from './ui.js';
import { parseUnreleased, releaseUnreleased } from './changelog.js';
import { waitForCrate, waitForNpm } from './registry.js';
import { isDirectory } from './games.js';
import { CRATE_NAME, ENGINE_NAME, SCAFFOLD_NAME } from './plan.js';

const REPO_URL = 'https://github.com/lgick/vimp';

// Снимок пинов шаблона (`prepack` скаффолдера) сверяется с версиями
// репозитория в tests/scaffold/versions.test.js. Любой бамп крейта или
// движка делает его устаревшим — а корневой `npm test` гоняют шаги A2 и C,
// то есть ДО скаффолдера: без обновления снимка прогон падает на чужой
// ошибке уже после публикации крейта.
const PIN_SNAPSHOT = 'packages/create-vimp-game/src/versions.generated.json';

async function writePinSnapshot(shell, root) {
  await shell.write(
    'node',
    ['packages/create-vimp-game/scripts/write-versions.js'],
    { cwd: root },
  );
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

// Что коммитится после сборки игры. package-lock.json правится шагом B
// (`npm i -D vimp-engine@…`), но есть не у всякой игры, а `git add --` по
// несуществующему пути падает — уже после публикации. corePinFile добавляется
// отдельно: при workspace-раскладке пин лежит в корневом Cargo.toml, и без
// него правка шага B осталась бы вне коммита.
export async function gameCommitPaths(dir, corePinFile = null) {
  const paths = ['package.json', 'core/Cargo.toml', 'Cargo.lock'];

  if (corePinFile && !paths.includes(corePinFile)) {
    paths.push(corePinFile);
  }

  if (await exists(path.join(dir, 'package-lock.json'))) {
    paths.push('package-lock.json');
  }

  return paths;
}

async function edit(file, transform, { dryRun }) {
  const before = await readFile(file, 'utf8');
  const after = transform(before);

  if (dryRun) {
    ui.log(`  · dry-run, не записан: ${file}`);
    return;
  }

  await writeFile(file, after);
  ui.log(`  · записан ${file}`);
}

function bumpJsonVersion(file, version, options) {
  return edit(
    file,
    text => text.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`),
    options,
  );
}

function bumpTomlVersion(file, version, options) {
  return edit(
    file,
    text => text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`),
    options,
  );
}

// Датирование делается по состоянию журнала, а не по факту бампа версии:
// версия могла быть поднята руками, а секция [Unreleased] остаться живой —
// тогда без датирования записи двух релизов склеятся в одну.
async function dateChangelog(file, { version, artifact, dryRun }) {
  const text = await readFile(file, 'utf8');
  const unreleased = parseUnreleased(text);

  if (!unreleased.present || unreleased.isEmpty) {
    ui.log(`  · [Unreleased] пуста, ${path.basename(file)} не датируется`);
    return;
  }

  await edit(
    file,
    source =>
      releaseUnreleased(source, {
        version,
        date: today(),
        repoUrl: REPO_URL,
        artifact,
      }),
    { dryRun },
  );
}

// Коммит только при наличии staged-изменений: на пути «версия уже поднята
// руками» править нечего, а `git commit` по пустому индексу падает и
// обрывает релиз. Пути перечисляются явно — `git add -A` затянул бы и
// побочные файлы, созданные проверками.
async function commit(shell, cwd, message, paths) {
  await shell.write('git', ['add', '--', ...paths], { cwd });

  // `git diff --cached --quiet`: 0 — индекс пуст, 1 — есть что коммитить
  const staged = await shell.read('git', ['diff', '--cached', '--quiet'], {
    cwd,
    allowFailure: true,
  });

  if (staged.code === 0) {
    ui.log('  · коммитить нечего, шаг пропущен');
    return false;
  }

  await shell.write('git', ['commit', '-m', message], { cwd });
  return true;
}

// Существующий тег — след прерванного прогона: `git tag` упал бы уже после
// публикации, поэтому спрашиваем заранее.
async function tag(shell, cwd, name) {
  const existing = await shell.read(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`],
    { cwd, allowFailure: true },
  );

  if (existing.code === 0) {
    ui.log(`  · тег ${name} уже существует, повторно не ставится`);
    return;
  }

  await shell.write('git', ['tag', name], { cwd });
}

async function awaitRegistry(wait, label) {
  if (await wait()) {
    return;
  }

  // без версии в реестре следующий шаг (cargo update --precise, npm i -D)
  // поставит старую копию и упадёт непонятно — это развилка, а не примечание
  const proceed = await ui.confirm(
    `${label} ещё не виден в реестре. Продолжать?`,
    false,
  );

  if (!proceed) {
    throw new Error(`прервано: ${label} не появился в реестре`);
  }
}

// engineApi установленной копии игры или null, если её манифест не читается
// (не собрана, битая) — тогда пусть падает сам sim, с его собственным
// сообщением.
async function installedEngineApi(gameDir) {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(gameDir, 'dist', 'manifest.json'), 'utf8'),
    );

    return typeof manifest.engineApi === 'number' ? manifest.engineApi : null;
  } catch {
    return null;
  }
}

// Опубликованная копия игры для sim. Пина игр в корневом package.json
// больше нет (master-game-registry, этап 5), и линки сняты на время
// релиза, — значит копию, которую поставят пользователи, релиз ставит себе
// сам: во временный каталог, не трогая ни node_modules репозитория, ни
// локальные линки. installRoot задают тесты (и он же позволяет прогнать
// сим по уже установленному дереву), тогда каталог не создаётся и не
// удаляется.
export async function withPublishedGame(
  shell,
  { name, version, installRoot = null, optional = false },
  fn,
) {
  if (installRoot) {
    return await fn(path.join(installRoot, 'node_modules', name));
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'vimp-release-sim-'));

  try {
    await writeFile(
      path.join(dir, 'package.json'),
      `${JSON.stringify({ name: 'vimp-release-sim', version: '0.0.0', private: true }, null, 2)}\n`,
    );

    try {
      await shell.check(
        `npm install ${name}@${version}`,
        'npm',
        [
          'install',
          '--no-save',
          '--no-audit',
          '--no-fund',
          `${name}@${version}`,
        ],
        { cwd: dir },
      );
    } catch (error) {
      // игра, которой в реестре ещё нет вовсе (её первый релиз идёт прямо
      // сейчас), — это невозможность проверки, а не её провал. Отказом
      // установка остаётся там, где копия обязана существовать: на проде
      if (!optional) {
        throw error;
      }

      throw new SkippedSim(`${name}@${version} не ставится: ${error.message}`);
    }

    return await fn(path.join(dir, 'node_modules', name));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Отдельный тип, чтобы «нечего гонять» на шаге движка не читалось как
// падение проверки: копии под этот движок может ещё физически не быть.
class SkippedSim extends Error {}

// Какую версию гонять симулятором. На шаге прода — ровно ту, что вышла в
// этом прогоне; на шаге движка её ещё нет, и смысл имеет то, что стоит у
// пользователей. Холостой прогон не публикует ничего, поэтому game.target в
// реестре не появится — репетиция иначе падала бы на E404 ровно там, где
// проверять нечего.
export function simVersion(game, { strict = false, dryRun = false } = {}) {
  return strict && !dryRun ? game.target : 'latest';
}

// Прогон vimp-sim по ОПУБЛИКОВАННОЙ копии игры: она ставится во временный
// каталог (withPublishedGame) и сносится после прогона. Шаг движка берёт
// то, что лежит в реестре сейчас (`latest`), шаг прода — версию, которую
// этот прогон только что выпустил.
//
// ***** РАСХОЖДЕНИЕ engineApi *****
//
// `ENGINE_API_VERSION` заморожен на 4 и гейтом совместимости больше НЕ
// является (этап 5 плана plugin-forward-compat): движок принимает пакет
// игры любого поколения, каталог мастера её не выкидывает, и путь ниже при
// замороженной константе недостижим. Проверка остаётся страховкой от
// рассинхрона сборки ВНУТРИ пакета — того же, что ловит правило контракта
// B2: `dist/manifest.json` собран не тем движком, которым пакет пинуется.
//
// На шаге движка это не провал, а невозможность проверки: копии под нужный
// движок в реестре ещё нет, и появится она только следующим шагом (games),
// который пересоберёт игру и сверит манифест (checkManifest). Поэтому здесь
// игра ПРОПУСКАЕТСЯ с объяснением, а на шаге прода (strict) — это отказ: там
// игра уже переопубликована, и расхождение значит, что её выпустили без
// пересборки. Покрытие при этом не теряется: прод гоняет те же игры.
async function simGame(
  shell,
  root,
  game,
  { engineApi = null, strict = false, installRoot = null } = {},
) {
  const version = simVersion(game, { strict, dryRun: shell.dryRun });

  try {
    await withPublishedGame(
      shell,
      { name: game.name, version, installRoot, optional: !strict },
      dir => simInstalledGame(shell, root, game, dir, { engineApi, strict }),
    );
  } catch (error) {
    if (!(error instanceof SkippedSim)) {
      throw error;
    }
  }
}

async function simInstalledGame(shell, root, game, dir, { engineApi, strict }) {
  if (!(await isDirectory(dir))) {
    const missing = `${game.name} не удалось поставить из npm`;

    if (strict) {
      throw new Error(
        `${missing}: прод обязан прогнать sim по опубликованной копии`,
      );
    }

    ui.log(`  · sim пропущен: ${missing}`);
    throw new SkippedSim(missing);
  }

  const installed = await installedEngineApi(dir);

  if (engineApi !== null && installed !== null && installed !== engineApi) {
    const mismatch = `${game.name}: engineApi=${installed}, у движка ${engineApi}`;

    if (strict) {
      throw new Error(
        `${mismatch}. Пакет игры собран не тем движком, которым пинуется: ` +
          `dist/manifest.json переопубликован без пересборки. Отказа в ` +
          `лобби это НЕ вызывает (движок принимает игру любого поколения), ` +
          `но прогон проверял бы не то, что установят пользователи`,
      );
    }

    ui.log(
      `  · sim пропущен: ${mismatch} — опубликованная копия собрана против ` +
        'другого движка. Её пересоберёт шаг games, а прогонит шаг prod',
    );

    return;
  }

  await shell.check(
    `npm run sim -- --game ${dir} --no-write`,
    'npm',
    ['run', 'sim', '--', '--game', dir, '--no-write'],
    { cwd: root },
  );
}

// `npm publish --dry-run` — проверка, поэтому идёт и в холостом прогоне. Но
// версию в package.json холостой прогон не пишет, и npm упирается в «нельзя
// опубликовать поверх уже опубликованной»: отказ относится к пропущенному
// бампу, а не к тарболу. Гасим только этот случай и только в dry-run —
// остальные падения (битый tarball, отсутствующие files) остаются отказом.
const ALREADY_PUBLISHED = /cannot publish over|previously published versions/i;

async function checkPublishable(shell, args, { cwd, bump }) {
  try {
    await shell.check('npm publish --dry-run', 'npm', args, { cwd });
  } catch (error) {
    if (!shell.dryRun || !bump || !ALREADY_PUBLISHED.test(error.output ?? '')) {
      throw error;
    }

    ui.log(
      '  · dry-run: npm отказал «поверх опубликованной» — версия не поднята, это ожидаемо',
    );
  }
}

// ── Step A1: крейт ─────────────────────────────────────────────────────────

export async function publishCrate({ shell, root, decision, report }) {
  const { target } = decision;

  ui.log(`крейт ${CRATE_NAME}: релиз ${target}`);

  await shell.check('npm run core:test', 'npm', ['run', 'core:test'], {
    cwd: root,
  });

  if (decision.bump) {
    await bumpTomlVersion(
      path.join(root, 'packages/engine/core/Cargo.toml'),
      target,
      { dryRun: shell.dryRun },
    );
  }

  await dateChangelog(path.join(root, 'packages/engine/core/CHANGELOG.md'), {
    version: target,
    artifact: CRATE_NAME,
    dryRun: shell.dryRun,
  });

  await shell.check('cargo build', 'cargo', ['build'], { cwd: root });
  await writePinSnapshot(shell, root);
  await commit(shell, root, `chore: bump ${CRATE_NAME} to ${target}`, [
    'packages/engine/core/Cargo.toml',
    'packages/engine/core/CHANGELOG.md',
    'Cargo.lock',
    PIN_SNAPSHOT,
  ]);

  await shell.check(
    'cargo publish --dry-run',
    'cargo',
    ['publish', '-p', CRATE_NAME, '--dry-run'],
    { cwd: root },
  );
  await shell.publish('cargo', ['publish', '-p', CRATE_NAME], { cwd: root });

  const tagName = `${CRATE_NAME}@${target}`;
  await tag(shell, root, tagName);

  if (!shell.dryRun) {
    await awaitRegistry(
      () => waitForCrate(CRATE_NAME, target, ui.log),
      `${CRATE_NAME}@${target}`,
    );
  }

  report.published.push(`${CRATE_NAME}@${target} (crates.io)`);
  report.tags.push({ repo: root, name: tagName });
}

// ── Step A2: движок ────────────────────────────────────────────────────────

export async function publishEngine({
  shell,
  root,
  decision,
  games,
  report,
  engineApi = null,
  installRoot = null,
}) {
  const { target } = decision;

  ui.log(`движок ${ENGINE_NAME}: релиз ${target}`);

  // до `npm test`: шаг A1 мог поднять крейт, снимок пинов уже расходится
  await writePinSnapshot(shell, root);

  await shell.check('npx eslint .', 'npx', ['eslint', '.'], { cwd: root });
  await shell.check('npm test', 'npm', ['test', '--', '--reporter=dot'], {
    cwd: root,
  });
  await shell.check('npm run core:test', 'npm', ['run', 'core:test'], {
    cwd: root,
  });
  await shell.check('npm run sim:check', 'npm', ['run', 'sim:check'], {
    cwd: root,
  });

  for (const game of games) {
    await simGame(shell, root, game, { engineApi, installRoot });
  }

  if (decision.bump) {
    await bumpJsonVersion(
      path.join(root, 'packages/engine/package.json'),
      target,
      { dryRun: shell.dryRun },
    );
    await shell.write(
      'npm',
      ['install', '--no-audit', '--no-fund', '--prefer-offline'],
      { cwd: root },
    );
    // второй раз: снимок обязан уехать в тот же коммит, что и новая версия
    // движка, иначе коммит сам себе противоречит и `npm test` на нём красный
    await writePinSnapshot(shell, root);
  }

  await dateChangelog(path.join(root, 'packages/engine/CHANGELOG.md'), {
    version: target,
    artifact: ENGINE_NAME,
    dryRun: shell.dryRun,
  });

  await commit(shell, root, `chore: bump ${ENGINE_NAME} to ${target}`, [
    'packages/engine/package.json',
    'packages/engine/CHANGELOG.md',
    'package-lock.json',
    PIN_SNAPSHOT,
  ]);

  await checkPublishable(shell, ['publish', '-w', ENGINE_NAME, '--dry-run'], {
    cwd: root,
    bump: decision.bump,
  });
  await shell.publish('npm', ['publish', '-w', ENGINE_NAME], { cwd: root });

  const tagName = `${ENGINE_NAME}@${target}`;
  await tag(shell, root, tagName);

  if (!shell.dryRun) {
    await awaitRegistry(
      () => waitForNpm(ENGINE_NAME, target, ui.log),
      `${ENGINE_NAME}@${target}`,
    );
  }

  report.published.push(`${ENGINE_NAME}@${target} (npm)`);
  report.tags.push({ repo: root, name: tagName });
}

// ── Step A3: скаффолдер ────────────────────────────────────────────────────

// Идёт после движка и крейта: хук prepack снимает пины с ЛОКАЛЬНЫХ
// packages/engine/package.json и core/Cargo.toml, то есть уже поднятых
// шагами A1 и A2. Публикация раньше вшила бы в тарбол прошлые версии.
export async function publishScaffold({ shell, root, decision, report }) {
  const { target } = decision;

  ui.log(`скаффолдер ${SCAFFOLD_NAME}: релиз ${target}`);

  // Снимок пинов пишет хук prepack — но он сработает только на publish, уже
  // после проверок. Пишем сейчас: тогда и `npm test`, и E2E судят шаблон по
  // тем самым пинам, которые уедут в тарбол.
  await writePinSnapshot(shell, root);

  await shell.check('npx eslint .', 'npx', ['eslint', '.'], { cwd: root });
  await shell.check('npm test', 'npm', ['test', '--', '--reporter=dot'], {
    cwd: root,
  });
  // единственная проверка, которая реально разворачивает шаблон и собирает
  // его ядро (cargo + wasm-pack): unit-тесты сломанный шаблон пропустят, а
  // всплывёт он у пользователя на первом же `npm create vimp-game`
  await shell.check('npm run test:scaffold', 'npm', ['run', 'test:scaffold'], {
    cwd: root,
  });

  if (decision.bump) {
    await bumpJsonVersion(
      path.join(root, 'packages/create-vimp-game/package.json'),
      target,
      { dryRun: shell.dryRun },
    );
    await shell.write(
      'npm',
      ['install', '--no-audit', '--no-fund', '--prefer-offline'],
      { cwd: root },
    );
  }

  await dateChangelog(
    path.join(root, 'packages/create-vimp-game/CHANGELOG.md'),
    {
      version: target,
      artifact: SCAFFOLD_NAME,
      dryRun: shell.dryRun,
    },
  );

  // versions.generated.json под версионным контролем: без него в списке
  // снимок пинов остался бы незакоммиченной правкой, и preflight следующего
  // релиза упёрся бы в «рабочее дерево не чистое»
  await commit(shell, root, `chore: bump ${SCAFFOLD_NAME} to ${target}`, [
    'packages/create-vimp-game/package.json',
    'packages/create-vimp-game/CHANGELOG.md',
    'packages/create-vimp-game/src/versions.generated.json',
    'package-lock.json',
  ]);

  await checkPublishable(shell, ['publish', '-w', SCAFFOLD_NAME, '--dry-run'], {
    cwd: root,
    bump: decision.bump,
  });
  await shell.publish('npm', ['publish', '-w', SCAFFOLD_NAME], { cwd: root });

  const tagName = `${SCAFFOLD_NAME}@${target}`;
  await tag(shell, root, tagName);

  if (!shell.dryRun) {
    await awaitRegistry(
      () => waitForNpm(SCAFFOLD_NAME, target, ui.log),
      `${SCAFFOLD_NAME}@${target}`,
    );
  }

  report.published.push(`${SCAFFOLD_NAME}@${target} (npm)`);
  report.tags.push({ repo: root, name: tagName });
}

// ── Step B: игра ───────────────────────────────────────────────────────────

// Тарбол обязан везти манифест и node-глюe ядра: манифест объявляет
// entries.wasmNode, а `dist/`, `core/pkg-*` в игре под .gitignore — npm
// применяет ignore-правила и внутри каталогов из files. Логика повторена
// здесь, чтобы не зависеть от наличия check:pack у конкретной игры.
//
// npm ≤ 11 отдавал массив пакетов, npm ≥ 12 — объект «имя пакета → пакет».
// Пакет здесь ровно один (npm pack в каталоге игры), поэтому берём первую
// запись любой из форм, а не индекс.
export function parsePackedEntry(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const entry = Array.isArray(parsed)
      ? parsed[0]
      : Object.values(parsed ?? {})[0];

    // проверка обязательна: без неё третья форма ответа даст то же невнятное
    // `Cannot read properties of undefined`, ради которого этот разбор и
    // переписан
    if (!entry || !Array.isArray(entry.files)) {
      throw new Error('в ответе нет списка files');
    }

    return {
      files: entry.files.map(item => item.path),
      filename: entry.filename,
    };
  } catch (error) {
    throw new Error(`не разобрать вывод npm pack --json: ${error.message}`);
  }
}

// Сборка тарбола — того самого файла, который уедет в npm и который мастер
// скачает к себе. Раньше здесь был `--dry-run`: список файлов он даёт, а
// содержимое — нет, и проверить манифест можно было только по рабочему
// dist/, то есть не по тому, что реально доедет.
export async function packGame({ shell, dir, destDir }) {
  const { stdout } = await shell.check(
    'npm pack',
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', destDir],
    { cwd: dir },
  );

  const { files, filename } = parsePackedEntry(stdout);
  const missing = [];

  if (!files.includes('dist/manifest.json')) {
    missing.push('dist/manifest.json');
  }
  if (!files.some(file => /^dist\/core-node\/.+\.js$/.test(file))) {
    missing.push('dist/core-node/*.js');
  }
  if (!files.some(file => /^dist\/core-node\/.+\.wasm$/.test(file))) {
    missing.push('dist/core-node/*.wasm');
  }

  if (missing.length) {
    throw new Error(
      `в тарболе нет ${missing.join(', ')} — нужен свежий npm run core:build && npm run build`,
    );
  }

  return {
    files,
    tarball: filename ? path.join(destDir, path.basename(filename)) : null,
  };
}

// Распаковка ровно как у мастера (GameStore → npmRegistry): наружу выходит
// содержимое package/dist, всё остальное в тарболе для раздачи не
// существует.
export async function extractDist(tarball, destDir) {
  await mkdir(destDir, { recursive: true });
  await tarExtract({
    file: tarball,
    cwd: destDir,
    strip: 2, // срезает 'package/dist'
    filter: entryPath => entryPath.startsWith('package/dist/'),
    preservePaths: false,
  });
}

export async function checkManifest({ distDir, engineApi }) {
  const manifest = JSON.parse(
    await readFile(path.join(distDir, 'manifest.json'), 'utf8'),
  );

  if (engineApi !== null && manifest.engineApi !== engineApi) {
    throw new Error(
      `dist/manifest.json: engineApi=${manifest.engineApi}, у движка ${engineApi}`,
    );
  }

  const wasmNode = manifest.entries?.wasmNode;

  // dist/ — единственный каталог, который пакет везёт: путь наружу означает
  // ERR_MODULE_NOT_FOUND у игрока, а не у нас
  if (
    typeof wasmNode !== 'string' ||
    !wasmNode.replace(/^\.\//, '').startsWith('core-node/')
  ) {
    throw new Error(
      `dist/manifest.json: entries.wasmNode=${JSON.stringify(wasmNode)} указывает вне dist/core-node/`,
    );
  }
}

// Та же структурная проверка, которой мастер встречает пакет на
// `POST /games/submit` и `POST /games/mine/:id/version`: entries внутри
// dist/, карты из maps.list на диске, roomForm против roomDefaults. Модуль
// импортируется, а не переписывается: разойтись этим двум проверкам нельзя,
// иначе релиз пропустит то, что реестр отвергнет. А версия в npm
// неперезаписываема — такой отказ сжигает её насовсем.
export async function checkGameStructure({ distDir }) {
  const verdict = checkGamePackage(distDir);

  if (!verdict.ok) {
    throw new Error(
      `пакет не пройдёт проверку мастера (тот же gamePackageCheck):\n  - ${verdict.errors.join('\n  - ')}`,
    );
  }

  return verdict.compat;
}

// Полная проверка того, что уедет в npm: pack → распаковка → манифест →
// структура. Возвращает вердикт совместимости manifest.requires с
// возможностями ЭТОГО чекаута движка.
export async function checkPackedGame({ shell, dir, engineApi }) {
  const tmp = await mkdtemp(path.join(tmpdir(), 'vimp-release-pack-'));

  try {
    const { files, tarball } = await packGame({ shell, dir, destDir: tmp });

    // холостой прогон shell.check не гасит, но фиктивный shell в тестах
    // тарбола не создаёт: без файла проверять нечего
    if (!tarball) {
      return null;
    }

    const distDir = path.join(tmp, 'dist');

    await extractDist(tarball, distDir);
    await checkManifest({ distDir, engineApi });

    const compat = await checkGameStructure({ distDir });

    ui.log(
      `  · тарбол проверен: ${files.length} файл(ов), структура как у мастера`,
    );

    return compat;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function publishGame({
  shell,
  game,
  crateVersion,
  engineVersion,
  engineApi,
  report,
  assumeYes = false,
}) {
  const dir = game.dir;

  ui.log(`игра ${game.name}: релиз ${game.target}`);

  if (crateVersion && game.corePinFile) {
    await edit(
      path.join(dir, game.corePinFile),
      text =>
        text.replace(
          /^(\s*vimp-engine-core\s*=\s*)"[^"]+"/m,
          `$1"${crateVersion}"`,
        ),
      { dryRun: shell.dryRun },
    );
    await shell.write(
      'cargo',
      ['update', '-p', CRATE_NAME, '--precise', crateVersion],
      { cwd: dir },
    );
  }

  if (engineVersion) {
    // без --prefer-offline: версия движка могла уехать в реестр секунды назад
    await shell.write(
      'npm',
      [
        'i',
        '-D',
        '--no-audit',
        '--no-fund',
        `${ENGINE_NAME}@^${engineVersion}`,
      ],
      { cwd: dir },
    );
  }

  // сборка всегда: `dist/` и `core/pkg-*` не в git, иначе уедет вчерашняя
  await shell.check('npm run core:build', 'npm', ['run', 'core:build'], {
    cwd: dir,
  });
  await shell.check('npm run build', 'npm', ['run', 'build'], { cwd: dir });

  await shell.check('npx eslint .', 'npx', ['eslint', '.'], { cwd: dir });

  // набор скриптов у игр разный (у street-fighters нет sim/sim:scenarios) —
  // гоняем то, что объявлено
  for (const script of ['test', 'core:test', 'sim', 'sim:scenarios']) {
    if (game.scripts[script]) {
      await shell.check(`npm run ${script}`, 'npm', ['run', script], {
        cwd: dir,
      });
    }
  }

  const compat = await checkPackedGame({ shell, dir, engineApi });

  // requires игры против capabilities этого чекаута. Отказом это не
  // является: мастер такую игру из каталога не выбрасывает (plugin-forward-
  // compat, этап 5), но в лобби она встанет неиграбельной — и узнать об
  // этом надо до неперезаписываемой версии в npm, а не от игроков
  if (compat && compat.ok === false) {
    // битый manifest.requires — дефект пакета, а не разница поколений:
    // публиковать его в неперезаписываемую версию нельзя ни с каким «да»
    if (compat.reason === 'bad-manifest') {
      throw new Error(`${game.name}: ${compat.text}`);
    }

    ui.error(
      `  ${game.name}: ${compat.text} (лобби покажет игру неиграбельной)`,
    );

    if (!assumeYes && !(await ui.confirm('Всё равно публиковать?', false))) {
      throw new Error('публикация отменена: игра несовместима с движком');
    }
  }

  if (game.bump !== false) {
    await bumpJsonVersion(path.join(dir, 'package.json'), game.target, {
      dryRun: shell.dryRun,
    });
  }

  await commit(
    shell,
    dir,
    `chore: release ${game.target}`,
    await gameCommitPaths(dir, game.corePinFile),
  );
  await tag(shell, dir, `v${game.target}`);

  await checkPublishable(shell, ['publish', '--dry-run'], {
    cwd: dir,
    // версия игры пишется тем же bumpJsonVersion, холостой прогон её не пишет
    bump: game.version !== game.target,
  });
  await shell.publish('npm', ['publish'], { cwd: dir });

  // пуш игрового репозитория ничего не деплоит — в отличие от vimp
  await shell.write('git', ['push'], { cwd: dir });
  await shell.write('git', ['push', '--tags'], { cwd: dir });

  if (!shell.dryRun) {
    await awaitRegistry(
      () => waitForNpm(game.name, game.target, ui.log),
      `${game.name}@${game.target}`,
    );
  }

  report.published.push(`${game.name}@${game.target} (npm)`);
  report.tags.push({ repo: dir, name: `v${game.target}` });
}

// ── Step C: прод ───────────────────────────────────────────────────────────

// Теги этого репозитория, которые ещё не уехали в origin. `known` — теги
// текущего прогона; после прерванного запуска их ставил прошлый, и он же
// оставил их лежать локально, поэтому одного report.tags мало. Сеть не
// нужна: релизный тег всегда стоит на релизном коммите, а незапушенные
// коммиты — ровно те, что не входят в upstream.
export async function unpushedTags(shell, root, known) {
  const names = new Set(known);

  const contains = await shell.read('git', ['tag', '--contains', '@{u}'], {
    cwd: root,
    allowFailure: true,
  });

  if (contains.code !== 0) {
    return [...names];
  }

  // тег на самом @{u} уже запушен: --contains считает коммит содержащим сам
  // себя, и без этого списка он попал бы в выдачу
  const pushed = await shell.read('git', ['tag', '--points-at', '@{u}'], {
    cwd: root,
    allowFailure: true,
  });
  const alreadyPushed = new Set(
    (pushed.code === 0 ? pushed.stdout : '')
      .split('\n')
      .map(line => line.trim()),
  );

  for (const line of contains.stdout.split('\n')) {
    const name = line.trim();

    if (name && !alreadyPushed.has(name)) {
      names.add(name);
    }
  }

  return [...names];
}

export async function rollOutProduction({
  shell,
  root,
  games,
  report,
  tags,
  engineApi = null,
  push = true,
  installRoot = null,
}) {
  ui.log(push ? 'прод: пуш в main' : 'прод: проверка выпущенных игр');

  report.remaining ??= [];

  // Пинов игр в корневом package.json больше нет (master-game-registry,
  // этап 5): каталог платформы приезжает из реестра auth-сервиса, а версию
  // раздачи поднимает не релиз движка
  if (games.length) {
    ui.raw('');
    ui.raw(
      '  прод: игры поднимает разработчик в лобби («My Games» → «Update»),',
    );
    ui.raw('  админ подтверждает в «Moderation»');
    ui.raw('');

    // подсказка выше уедет вверх экрана за прогонами sim, а до игроков
    // версия без этих двух действий не доедет вовсе — поэтому она же идёт
    // в итоговую сводку, последнее, что видит разработчик
    const lobby = process.env.VIMP_LOBBY_URL;

    for (const game of games) {
      report.remaining.push(
        `${game.name}@${game.target}: подать версию в лобби ` +
          '(«My games» → «Update») и подтвердить в «Moderation»' +
          (lobby ? ` — ${lobby}` : ''),
      );
    }
  }

  // strict: игры уже переопубликованы, поэтому расхождение версии API здесь —
  // не «ещё не время», а выпуск без пересборки. Проверка идёт первой и в
  // обеих ветках: она единственное, ради чего шаг вообще выполняется, когда
  // движок не публикуется
  for (const game of games) {
    await simGame(shell, root, game, { engineApi, strict: true, installRoot });
  }

  // релиз одних игр в этом репозитории не меняет ни файла: снимок пинов
  // шаблона зависит только от версий движка и крейта, коммитить было бы
  // нечего, а пуш в main оказался бы деплоем без изменений — то есть
  // подтверждением «это ДЕПЛОЙ прода» за пустой коммит
  if (!push) {
    ui.raw('  прод: движок не публикуется — деплой не нужен');

    // …но собственные коммиты и теги ЭТОГО репозитория деплоем не являются и
    // всё равно ждут пуша: шаг скаффолдера коммитит `chore: bump
    // create-vimp-game` и ставит тег в корне. Промолчать нельзя — сводка
    // напечатает «прод: не пушился», и незапушенное всплывёт только
    // следующим релизом
    const local = await shell.read('git', ['log', '--oneline', '@{u}..HEAD'], {
      cwd: root,
      allowFailure: true,
    });

    if (local.stdout.trim() || tags.length) {
      ui.raw('');
      ui.raw(local.stdout.trim() || '  (коммитов нет)');
      ui.raw('');
      report.remaining.push('пуш локальных коммитов и тегов этого репозитория');
    }

    return;
  }

  await writePinSnapshot(shell, root);
  await shell.check('npm test', 'npm', ['test', '--', '--reporter=dot'], {
    cwd: root,
  });

  // коммитится только снимок пинов шаблона: package.json корня релиз больше
  // не трогает — игр в его зависимостях нет
  await commit(
    shell,
    root,
    games.length
      ? `chore: bump ${games.map(game => `${game.name} to ${game.target}`).join(', ')}`
      : `chore: refresh ${SCAFFOLD_NAME} pins`,
    [PIN_SNAPSHOT],
  );

  const pending = await shell.read('git', ['log', '--oneline', '@{u}..HEAD'], {
    cwd: root,
    allowFailure: true,
  });

  ui.raw('');
  ui.raw(pending.stdout.trim() || '  (нечего пушить)');
  ui.raw('');

  const pendingTags = await unpushedTags(shell, root, tags);

  const approved = await ui.confirm(
    'Пуш в main — это ДЕПЛОЙ прода (deploy.yml). Пушим?',
    false,
  );

  if (!approved) {
    ui.log('пуш отменён. Осталось выполнить вручную:');
    ui.raw('  git push');

    for (const name of pendingTags) {
      ui.raw(`  git push origin ${name}`);
    }

    report.remaining.push('пуш в main и теги движка/крейта');
    return;
  }

  await shell.write('git', ['push'], { cwd: root });

  for (const name of pendingTags) {
    await shell.write('git', ['push', 'origin', name], { cwd: root });
  }

  report.pushed = true;
}
