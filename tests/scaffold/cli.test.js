import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  buildDefaults,
  parseArgs,
  UsageError,
} from '../../packages/create-vimp-game/src/cli.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BIN = path.join(
  ROOT,
  'packages/create-vimp-game/bin/create-vimp-game.js',
);

let root;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vimp-scaffold-cli-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// запуск собственного bin дочерним процессом: только так проверяется код
// выхода — ради него CLI и существует
function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: options.cwd ?? root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

describe('parseArgs', () => {
  it('разбирает каталог, значения и флаги', () => {
    const args = parseArgs([
      'my-game',
      '--id',
      'space-arena',
      '--title',
      'Space Arena',
      '--yes',
      '--force',
      '--no-git',
    ]);

    expect(args).toEqual({
      directory: 'my-game',
      id: 'space-arena',
      title: 'Space Arena',
      yes: true,
      force: true,
      git: false,
    });
  });

  it('падает на неизвестном флаге и на флаге без значения', () => {
    expect(() => parseArgs(['--nope'])).toThrow(UsageError);
    expect(() => parseArgs(['--id', '--yes'])).toThrow(UsageError);
  });

  it('падает на втором позиционном аргументе', () => {
    expect(() => parseArgs(['a', 'b'])).toThrow(UsageError);
  });
});

describe('buildDefaults', () => {
  it('выводит id, заголовок и имя пакета из имени каталога', () => {
    expect(buildDefaults({ directory: 'tmp/My Game' })).toEqual({
      directory: 'tmp/My Game',
      id: 'my-game',
      title: 'My Game',
      packageName: '@vimp-games/my-game',
      author: '',
    });
  });

  it('явные флаги перекрывают дефолты', () => {
    const defaults = buildDefaults({
      directory: 'x',
      id: 'space-arena',
      title: 'Arena',
      packageName: 'arena',
      author: 'lgick',
    });

    expect(defaults).toEqual({
      directory: 'x',
      id: 'space-arena',
      title: 'Arena',
      packageName: 'arena',
      author: 'lgick',
    });
  });
});

describe('bin/create-vimp-game.js', () => {
  it('печатает справку и выходит с нулём', async () => {
    const { code, stdout } = await run(['--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('Usage: create-vimp-game');
  });

  it('печатает версию пакета', async () => {
    const { code, stdout } = await run(['--version']);
    const manifest = JSON.parse(
      await readFile(
        path.join(ROOT, 'packages/create-vimp-game/package.json'),
        'utf8',
      ),
    );

    expect(code).toBe(0);
    expect(stdout.trim()).toBe(manifest.version);
  });

  it('без каталога и без TTY падает с подсказкой', async () => {
    const { code, stderr } = await run(['--yes']);

    expect(code).toBe(1);
    expect(stderr).toContain('missing <directory>');
  });

  it('разворачивает шаблон с --yes и печатает next steps', async () => {
    const { code, stdout } = await run(['space-arena', '--yes', '--no-git']);

    expect(code).toBe(0);
    expect(stdout).toContain('Next steps');

    const target = path.join(root, 'space-arena');
    const entries = await readdir(target);

    expect(entries).toContain('package.json');
    expect(entries).toContain('.gitignore');

    const manifest = JSON.parse(
      await readFile(path.join(target, 'package.json'), 'utf8'),
    );

    expect(manifest.name).toBe('@vimp-games/space-arena');
    expect(manifest.devDependencies['vimp-engine']).toMatch(/^\^\d+\.\d+\.\d+/);
  });

  it('уважает --id, --title и --package', async () => {
    const { code } = await run([
      'dir-name',
      '--yes',
      '--no-git',
      '--id',
      'arena',
      '--title',
      'The Arena',
      '--package',
      '@vimp-games/the-arena',
    ]);

    expect(code).toBe(0);

    const manifest = JSON.parse(
      await readFile(path.join(root, 'dir-name', 'package.json'), 'utf8'),
    );

    expect(manifest.name).toBe('@vimp-games/the-arena');
    expect(manifest.description).toContain('The Arena');
  });

  it('падает на непустом каталоге и проходит с --force', async () => {
    const target = path.join(root, 'busy');

    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'keep.txt'), 'mine\n');

    const first = await run(['busy', '--yes', '--no-git']);

    expect(first.code).toBe(1);
    expect(first.stderr).toContain('not empty');

    const second = await run(['busy', '--yes', '--no-git', '--force']);

    expect(second.code).toBe(0);
  });

  it('падает на недопустимом id', async () => {
    const { code, stderr } = await run([
      'x',
      '--yes',
      '--no-git',
      '--id',
      'Space Arena',
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain('invalid game id');
  });
});
