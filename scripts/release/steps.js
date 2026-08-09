import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as ui from './ui.js';
import { parseUnreleased, releaseUnreleased } from './changelog.js';
import { waitForCrate, waitForNpm } from './registry.js';
import { isDirectory } from './games.js';
import { CRATE_NAME, ENGINE_NAME } from './plan.js';

const REPO_URL = 'https://github.com/lgick/vimp';

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
// несуществующему пути падает — уже после публикации.
export async function gameCommitPaths(dir) {
  const paths = ['package.json', 'core/Cargo.toml', 'Cargo.lock'];

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

// Прогон vimp-sim по игре, установленной в node_modules движка. Подтверждённый
// чекаут может не быть зависимостью vimp — такую игру проверит шаг прода
// после перепина.
async function simGame(shell, root, game) {
  const relative = path.join('node_modules', game.name);

  if (!(await isDirectory(path.join(root, relative)))) {
    ui.log(`  · sim пропущен: ${game.name} не установлен в vimp`);
    return;
  }

  await shell.check(
    `npm run sim -- --game ${relative} --no-write`,
    'npm',
    ['run', 'sim', '--', '--game', relative, '--no-write'],
    { cwd: root },
  );
}

// ── Step A1: крейт ─────────────────────────────────────────────────────────

export async function publishCrate({ shell, root, decision, report }) {
  const { target } = decision;

  ui.log(`крейт ${CRATE_NAME}: релиз ${target}`);

  await shell.check('npm run core:test', 'npm', ['run', 'core:test'], { cwd: root });

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
  await commit(shell, root, `chore: bump ${CRATE_NAME} to ${target}`, [
    'packages/engine/core/Cargo.toml',
    'packages/engine/core/CHANGELOG.md',
    'Cargo.lock',
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

export async function publishEngine({ shell, root, decision, games, report }) {
  const { target } = decision;

  ui.log(`движок ${ENGINE_NAME}: релиз ${target}`);

  await shell.check('npx eslint .', 'npx', ['eslint', '.'], { cwd: root });
  await shell.check('npm test', 'npm', ['test', '--', '--reporter=dot'], {
    cwd: root,
  });
  await shell.check('npm run core:test', 'npm', ['run', 'core:test'], { cwd: root });
  await shell.check('npm run sim:check', 'npm', ['run', 'sim:check'], { cwd: root });

  for (const game of games) {
    await simGame(shell, root, game);
  }

  if (decision.bump) {
    await bumpJsonVersion(
      path.join(root, 'packages/engine/package.json'),
      target,
      { dryRun: shell.dryRun },
    );
    await shell.write('npm', ['install'], { cwd: root });
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
  ]);

  await shell.check(
    'npm publish --dry-run',
    'npm',
    ['publish', '-w', ENGINE_NAME, '--dry-run'],
    { cwd: root },
  );
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

// ── Step B: игра ───────────────────────────────────────────────────────────

// Тарбол обязан везти манифест и node-глюe ядра: манифест объявляет
// entries.wasmNode, а `dist/`, `core/pkg-*` в игре под .gitignore — npm
// применяет ignore-правила и внутри каталогов из files. Логика повторена
// здесь, чтобы не зависеть от наличия check:pack у конкретной игры.
export async function checkTarball({ shell, dir }) {
  const { stdout } = await shell.check(
    'npm pack --dry-run',
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: dir },
  );

  let files;

  try {
    files = JSON.parse(stdout)[0].files.map(entry => entry.path);
  } catch (error) {
    throw new Error(`не разобрать вывод npm pack --json: ${error.message}`);
  }

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

  return files.length;
}

export async function checkManifest({ dir, engineApi }) {
  const manifestPath = path.join(dir, 'dist', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

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

export async function publishGame({
  shell,
  game,
  crateVersion,
  engineVersion,
  engineApi,
  report,
}) {
  const dir = game.dir;

  ui.log(`игра ${game.name}: релиз ${game.target}`);

  if (crateVersion) {
    await edit(
      path.join(dir, 'core', 'Cargo.toml'),
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
    await shell.write('npm', ['i', '-D', `${ENGINE_NAME}@^${engineVersion}`], {
      cwd: dir,
    });
  }

  // сборка всегда: `dist/` и `core/pkg-*` не в git, иначе уедет вчерашняя
  await shell.check('npm run core:build', 'npm', ['run', 'core:build'], { cwd: dir });
  await shell.check('npm run build', 'npm', ['run', 'build'], { cwd: dir });

  await shell.check('npx eslint .', 'npx', ['eslint', '.'], { cwd: dir });

  // набор скриптов у игр разный (у street-fighters нет sim/sim:scenarios) —
  // гоняем то, что объявлено
  for (const script of ['test', 'core:test', 'sim', 'sim:scenarios']) {
    if (game.scripts[script]) {
      await shell.check(`npm run ${script}`, 'npm', ['run', script], { cwd: dir });
    }
  }

  await checkTarball({ shell, dir });
  await checkManifest({ dir, engineApi });

  if (game.bump !== false) {
    await bumpJsonVersion(path.join(dir, 'package.json'), game.target, {
      dryRun: shell.dryRun,
    });
  }

  await commit(
    shell,
    dir,
    `chore: release ${game.target}`,
    await gameCommitPaths(dir),
  );
  await tag(shell, dir, `v${game.target}`);

  await shell.check('npm publish --dry-run', 'npm', ['publish', '--dry-run'], {
    cwd: dir,
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

export async function rollOutProduction({ shell, root, games, report, tags }) {
  ui.log('прод: перепин плагинов и пуш в main');

  for (const game of games) {
    await shell.write('npm', ['i', `${game.name}@${game.target}`], { cwd: root });
  }

  await shell.check('npm test', 'npm', ['test', '--', '--reporter=dot'], {
    cwd: root,
  });

  for (const game of games) {
    await simGame(shell, root, game);
  }

  if (games.length) {
    await commit(
      shell,
      root,
      `chore: bump ${games.map(game => `${game.name} to ${game.target}`).join(', ')}`,
      ['package.json', 'package-lock.json'],
    );
  }

  const pending = await shell.read('git', ['log', '--oneline', '@{u}..HEAD'], {
    cwd: root,
    allowFailure: true,
  });

  ui.raw('');
  ui.raw(pending.stdout.trim() || '  (нечего пушить)');
  ui.raw('');

  const approved = await ui.confirm(
    'Пуш в main — это ДЕПЛОЙ прода (deploy.yml). Пушим?',
    false,
  );

  if (!approved) {
    ui.log('пуш отменён. Осталось выполнить вручную:');
    ui.raw('  git push');

    for (const name of tags) {
      ui.raw(`  git push origin ${name}`);
    }

    report.remaining.push('пуш в main и теги движка/крейта');
    return;
  }

  await shell.write('git', ['push'], { cwd: root });

  for (const name of tags) {
    await shell.write('git', ['push', 'origin', name], { cwd: root });
  }

  report.pushed = true;
}
