import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as ui from './ui.js';
import { releaseUnreleased } from './changelog.js';
import { waitForCrate, waitForNpm } from './registry.js';
import { CRATE_NAME, ENGINE_NAME } from './plan.js';

const REPO_URL = 'https://github.com/lgick/vimp';

function today() {
  return new Date().toISOString().slice(0, 10);
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

async function dateChangelog(file, { version, artifact, dryRun }) {
  await edit(
    file,
    text =>
      releaseUnreleased(text, {
        version,
        date: today(),
        repoUrl: REPO_URL,
        artifact,
      }),
    { dryRun },
  );
}

async function commit(shell, root, message) {
  await shell.write('git', ['add', '-A'], { cwd: root });
  await shell.write('git', ['commit', '-m', message], { cwd: root });
}

async function tag(shell, root, name) {
  await shell.write('git', ['tag', name], { cwd: root });
}

// ── Step A1: крейт ─────────────────────────────────────────────────────────

export async function publishCrate({ shell, root, decision, report }) {
  const { target } = decision;
  const cargoPath = path.join(root, 'packages/engine/core/Cargo.toml');

  ui.log(`крейт ${CRATE_NAME}: релиз ${target}`);

  await shell.check('npm run core:test', 'npm', ['run', 'core:test'], { cwd: root });

  if (decision.bump) {
    await edit(
      cargoPath,
      text => text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${target}"`),
      { dryRun: shell.dryRun },
    );
    await dateChangelog(path.join(root, 'packages/engine/core/CHANGELOG.md'), {
      version: target,
      artifact: CRATE_NAME,
      dryRun: shell.dryRun,
    });
  }

  await shell.check('cargo build', 'cargo', ['build'], { cwd: root });
  await commit(shell, root, `chore: bump ${CRATE_NAME} to ${target}`);

  await shell.check(
    'cargo publish --dry-run',
    'cargo',
    ['publish', '-p', CRATE_NAME, '--dry-run'],
    { cwd: root },
  );
  await shell.write('cargo', ['publish', '-p', CRATE_NAME], { cwd: root });

  const tagName = `${CRATE_NAME}@${target}`;
  await tag(shell, root, tagName);

  if (!shell.dryRun) {
    await waitForCrate(CRATE_NAME, target, ui.log);
  }

  report.published.push(`${CRATE_NAME}@${target} (crates.io)`);
  report.tags.push(tagName);
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
    const installed = path.join('node_modules', game.name);

    await shell.check(
      `npm run sim -- --game ${installed}`,
      'npm',
      ['run', 'sim', '--', '--game', installed, '--no-write'],
      { cwd: root },
    );
  }

  if (decision.bump) {
    const pkgPath = path.join(root, 'packages/engine/package.json');

    await edit(
      pkgPath,
      text => text.replace(/"version":\s*"[^"]+"/, `"version": "${target}"`),
      { dryRun: shell.dryRun },
    );
    await dateChangelog(path.join(root, 'packages/engine/CHANGELOG.md'), {
      version: target,
      artifact: ENGINE_NAME,
      dryRun: shell.dryRun,
    });
    await shell.write('npm', ['install'], { cwd: root });
  }

  await commit(shell, root, `chore: bump ${ENGINE_NAME} to ${target}`);

  await shell.check(
    'npm publish --dry-run',
    'npm',
    ['publish', '-w', ENGINE_NAME, '--dry-run'],
    { cwd: root },
  );
  await shell.write('npm', ['publish', '-w', ENGINE_NAME], { cwd: root });

  const tagName = `${ENGINE_NAME}@${target}`;
  await tag(shell, root, tagName);

  if (!shell.dryRun) {
    await waitForNpm(ENGINE_NAME, target, ui.log);
  }

  report.published.push(`${ENGINE_NAME}@${target} (npm)`);
  report.tags.push(tagName);
}

// ── Step B: игра ───────────────────────────────────────────────────────────

// Тарбол обязан везти манифест и node-глюe ядра: манифест объявляет
// entries.wasmNode, а `dist/`, `core/pkg-*` в игре под .gitignore — npm
// применяет ignore-правила и внутри каталогов из files. Логика повторена
// здесь, чтобы не зависеть от наличия check:pack у конкретной игры.
export async function checkTarball({ shell, dir }) {
  const { output } = await shell.check(
    'npm pack --dry-run',
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: dir },
  );

  const json = output.slice(output.indexOf('['));
  const files = JSON.parse(json)[0].files.map(entry => entry.path);

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

  const wasmNode = manifest.entries?.wasmNode ?? '';

  if (!/^\.?\/?(core-node|dist)\//.test(wasmNode.replace(/^\.\//, ''))) {
    throw new Error(
      `dist/manifest.json: entries.wasmNode="${wasmNode}" указывает вне dist/`,
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

  if (crateVersion && game.hasCargo) {
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
  await shell.check('npm test', 'npm', ['test', '--', '--reporter=dot'], { cwd: dir });
  await shell.check('npm run core:test', 'npm', ['run', 'core:test'], { cwd: dir });

  for (const script of ['sim', 'sim:scenarios']) {
    if (game.scripts[script]) {
      await shell.check(`npm run ${script}`, 'npm', ['run', script], { cwd: dir });
    }
  }

  await checkTarball({ shell, dir });
  await checkManifest({ dir, engineApi });

  await edit(
    path.join(dir, 'package.json'),
    text => text.replace(/"version":\s*"[^"]+"/, `"version": "${game.target}"`),
    { dryRun: shell.dryRun },
  );

  await commit(shell, dir, `chore: release ${game.target}`);
  await tag(shell, dir, `v${game.target}`);

  await shell.check('npm publish --dry-run', 'npm', ['publish', '--dry-run'], {
    cwd: dir,
  });
  await shell.write('npm', ['publish'], { cwd: dir });

  // пуш игрового репозитория ничего не деплоит — в отличие от vimp
  await shell.write('git', ['push'], { cwd: dir });
  await shell.write('git', ['push', '--tags'], { cwd: dir });

  if (!shell.dryRun) {
    await waitForNpm(game.name, game.target, ui.log);
  }

  report.published.push(`${game.name}@${game.target} (npm)`);
  report.tags.push(`${game.name}: v${game.target}`);
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
    const installed = path.join('node_modules', game.name);

    await shell.check(
      `npm run sim -- --game ${installed}`,
      'npm',
      ['run', 'sim', '--', '--game', installed, '--no-write'],
      { cwd: root },
    );
  }

  if (games.length) {
    await commit(
      shell,
      root,
      `chore: bump ${games.map(game => `${game.name} to ${game.target}`).join(', ')}`,
    );
  }

  const pending = await shell.read(
    'git',
    ['log', '--oneline', '@{u}..HEAD'],
    { cwd: root, allowFailure: true },
  );

  ui.raw('');
  ui.raw(pending.output.trim() || '  (нечего пушить)');
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
