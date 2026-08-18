import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { generate } from '../../packages/create-vimp-game/src/generator.js';
import { buildTokens } from '../../packages/create-vimp-game/src/tokens.js';
import {
  resolveVersions,
  toPins,
} from '../../packages/create-vimp-game/src/versions.js';
import {
  loadContext,
  runRules,
} from '../../packages/engine/src/devtools/contract/index.js';
import { FAIL, ERROR } from '../../packages/engine/src/devtools/contract/result.js';

// Шаблон игры никто не собирает в этом репозитории: он существует только в
// виде токенизированных файлов, поэтому дрейф за контрактом движка ничем не
// ловится. Быстрый уровень защиты (этап 6.1 плана): развернуть шаблон во
// временный каталог и прогнать по исходникам те правила vimp-contract,
// которым не нужна сборка — группы B (host), C (client) и D (снапшот).
// Rust, npm install и сборка — тяжёлый уровень, job `scaffold` в CI.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const enginePath = path.join(repoRoot, 'packages', 'engine');
const templateDir = path.join(
  repoRoot,
  'packages',
  'create-vimp-game',
  'templates',
  'default',
);

// правила, которым достаточно исходников игры: A — про сборку и пакет,
// E — про содержимое dist/, и то и другое здесь заведомо skip
const FAST_GROUPS = /^[BCD]\d+$/;

// файлы, без которых сгенерированная игра не игра: по одному якорю на
// каждый слой контракта (docs/ai/02-packaging.md)
const REQUIRED_FILES = [
  'package.json',
  'vite.config.js',
  'Cargo.toml',
  'CLAUDE.md',
  '.gitignore',
  'core/Cargo.toml',
  'core/src/lib.rs',
  'src/config/game.js',
  'src/config/client.js',
  'src/config/auth.js',
  'src/config/snapshot.js',
  'src/host/index.js',
  'src/client/index.js',
  'src/client/style.css',
  'src/data/maps/arena.js',
];

let root;
let gameDir;
let ctx;
let results;
let files;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vimp-template-'));
  gameDir = path.join(root, 'game');

  const tokens = buildTokens({
    id: 'template-check',
    title: 'Template Check',
    packageName: '@vimp-games/template-check',
    author: 'vimp',
    ...toPins(await resolveVersions()),
  });

  await generate({ templateDir, targetDir: gameDir, tokens, enginePath });

  // импорт половин плагина резолвит `vimp-engine` по node_modules игры;
  // npm install ради этого не нужен — достаточно симлинка на чекаут
  await mkdir(path.join(gameDir, 'node_modules'), { recursive: true });
  await symlink(
    enginePath,
    path.join(gameDir, 'node_modules', 'vimp-engine'),
    'dir',
  );

  ctx = await loadContext(gameDir);
  results = runRules(ctx).filter(result => FAST_GROUPS.test(result.id));
  files = await listFiles(gameDir);
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function listFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }

    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      found.push(...(await listFiles(path.join(dir, entry.name), rel)));
      continue;
    }

    found.push(rel);
  }

  return found.sort();
}

describe('сгенерированный проект', () => {
  it('содержит ключевые файлы контракта', () => {
    expect(files).toEqual(expect.arrayContaining(REQUIRED_FILES));
  });

  it('не оставляет незаменённых токенов', async () => {
    const left = [];

    for (const file of files) {
      const raw = await readFile(path.join(gameDir, file));

      if (raw.includes('{{')) {
        left.push(file);
      }
    }

    expect(left).toEqual([]);
  });

  it('называет игру подставленным id, а не именем шаблона', async () => {
    const pkg = JSON.parse(
      await readFile(path.join(gameDir, 'package.json'), 'utf8'),
    );

    expect(pkg.name).toBe('@vimp-games/template-check');
    expect(ctx.hostPlugin.id).toBe('template-check');
  });
});

describe('vimp-contract по исходникам шаблона', () => {
  it('загружает обе половины плагина', () => {
    expect(ctx.notes).toEqual([]);
    expect(ctx.hostSource).toBe('src/host/index.js');
    expect(ctx.clientSource).toBe('src/client/index.js');
  });

  it('не нарушает ни одного правила групп B, C, D', () => {
    const failed = results
      .filter(result => result.status === FAIL)
      .map(result => `${result.id} ${result.title}: ${result.violations.join('; ')}`);

    expect(failed).toEqual([]);
  });

  it('прогоняет все правила уровня error, не пропуская их', () => {
    const skipped = results
      .filter(result => result.status !== FAIL && result.level === ERROR)
      .filter(result => result.status === 'skip')
      .map(result => `${result.id}: ${result.note}`);

    expect(skipped).toEqual([]);
  });
});
