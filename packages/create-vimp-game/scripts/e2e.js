#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Тяжёлый уровень защиты шаблона (этап 6.2 плана): развернуть игру и
// прогнать полный цикл — cargo + wasm-pack, сборка, контракт, тесты, sim.
// В `npm test` не входит: `wasm-pack build --release` — минуты.
//
// Проверка идёт против НЕСОБРАННОГО релиза: движок ставится тарболлом
// `npm pack`, крейт подменяется через [patch.crates-io]. Иначе E2E судил бы
// шаблон по уже опубликованным версиям и пропускал бы ровно те поломки
// контракта, которые вносит текущая ветка.
//
//   node packages/create-vimp-game/scripts/e2e.js [--keep] [--dir <path>]

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const cli = path.join(scriptDir, '..', 'bin', 'create-vimp-game.js');

const GAME_ID = 'e2e-game';

function run(command, args, cwd) {
  process.stdout.write(`\n> ${command} ${args.join(' ')}   (${cwd})\n`);

  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }

  return result.stdout.trim();
}

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') {
      args.keep = true;
      continue;
    }

    if (argv[i] === '--dir') {
      i += 1;

      if (argv[i] === undefined || argv[i].startsWith('--')) {
        throw new Error("option '--dir' needs a value");
      }

      args.dir = argv[i];
      continue;
    }

    throw new Error(`unknown option '${argv[i]}'`);
  }

  return args;
}

// npm pack печатает имя тарболла последней строкой, но в старых версиях
// подмешивает в stdout лог — берём файл из каталога назначения
async function packEngine(destination) {
  capture(
    'npm',
    ['pack', '-w', 'vimp-engine', '--pack-destination', destination],
    repoRoot,
  );

  const tarball = (await readdir(destination)).find(name =>
    name.endsWith('.tgz'),
  );

  if (tarball === undefined) {
    throw new Error(`npm pack produced no tarball in ${destination}`);
  }

  return path.join(destination, tarball);
}

async function main(argv) {
  const args = parseArgs(argv);
  const workDir =
    args.dir === undefined
      ? await mkdtemp(path.join(tmpdir(), 'vimp-e2e-'))
      : path.resolve(args.dir);

  await mkdir(workDir, { recursive: true });

  const gameDir = path.join(workDir, GAME_ID);

  try {
    const tarball = await packEngine(workDir);

    run(
      'node',
      [
        cli,
        gameDir,
        '--yes',
        '--id',
        GAME_ID,
        '--no-git',
        '--engine-path',
        tarball,
        '--core-path',
        path.join(repoRoot, 'packages', 'engine', 'core'),
      ],
      repoRoot,
    );

    run('npm', ['install'], gameDir);
    run('npm', ['run', 'core:build'], gameDir);
    run('npm', ['run', 'check:contract'], gameDir);
    run('npm', ['run', 'build'], gameDir);
    run('npm', ['test'], gameDir);
    run('npm', ['run', 'sim'], gameDir);
    run('npx', ['eslint', '.'], gameDir);

    process.stdout.write(`\nscaffold e2e: ok (${gameDir})\n`);
  } finally {
    if (args.keep === true) {
      process.stdout.write(`kept: ${workDir}\n`);
    } else {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  return 0;
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  },
);
