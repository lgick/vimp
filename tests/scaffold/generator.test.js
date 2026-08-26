import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  generate,
  GenerateError,
  isTextFile,
  renderTokens,
  targetName,
} from '../../packages/create-vimp-game/src/generator.js';

// у генератора нет собственного шаблона в тестах: содержимое
// templates/default наполняется этапами 3–5 и будет меняться, поэтому
// каждое дело собирает своё маленькое дерево

let root;
let templateDir;
let targetDir;

const tokens = {
  GAME_ID: 'space-arena',
  GAME_TITLE: 'Space Arena',
  PACKAGE_NAME: '@vimp-games/space-arena',
  CRATE_NAME: 'space-arena-core',
  CRATE_SNAKE: 'space_arena_core',
  ENGINE_VERSION: '^0.9.0',
  CORE_VERSION: '0.3.2',
  AUTHOR: 'lgick',
  YEAR: '2026',
};

// звук шаблона — бинарный: побайтовая сохранность проверяется на нём
const binary = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff, 0x7b, 0x7b]);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vimp-scaffold-'));
  templateDir = path.join(root, 'template');
  targetDir = path.join(root, 'game');

  await mkdir(path.join(templateDir, 'core'), { recursive: true });
  await mkdir(path.join(templateDir, 'assets'), { recursive: true });

  await writeFile(
    path.join(templateDir, 'package.json.tpl'),
    '{\n  "name": "{{PACKAGE_NAME}}"\n}\n',
  );
  await writeFile(path.join(templateDir, '_gitignore'), 'node_modules/\n');
  await writeFile(
    path.join(templateDir, 'core', 'Cargo.toml.tpl'),
    'name = "{{CRATE_NAME}}"\nvimp-engine-core = "{{CORE_VERSION}}"\n',
  );
  await writeFile(
    path.join(templateDir, 'core', 'lib.rs'),
    '// {{CRATE_SNAKE}}\n',
  );
  await writeFile(path.join(templateDir, 'assets', 'shot.webm'), binary);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('переименования шаблона', () => {
  it('снимает .tpl и разворачивает префикс подчёркивания', () => {
    expect(targetName('package.json.tpl')).toBe('package.json');
    expect(targetName('_gitignore')).toBe('.gitignore');
    expect(targetName('lib.rs')).toBe('lib.rs');
  });

  it('текстовыми считает allowlist расширений и любые .tpl', () => {
    expect(isTextFile('lib.rs')).toBe(true);
    expect(isTextFile('_gitignore')).toBe(true);
    expect(isTextFile('LICENSE.tpl')).toBe(true);
    expect(isTextFile('shot.webm')).toBe(false);
    expect(isTextFile('logo.png')).toBe(false);
  });
});

describe('подстановка токенов', () => {
  it('заменяет известные токены', () => {
    expect(renderTokens('id={{GAME_ID}} v={{CORE_VERSION}}', tokens, 'f')).toBe(
      'id=space-arena v=0.3.2',
    );
  });

  it('падает на неизвестном токене', () => {
    expect(() => renderTokens('{{NOPE}}', tokens, 'f')).toThrow(GenerateError);
  });

  it('падает на токене нераспознанного вида', () => {
    expect(() => renderTokens('{{ game id }}', tokens, 'f')).toThrow(
      GenerateError,
    );
  });
});

describe('generate', () => {
  it('разворачивает дерево с подстановкой и переименованиями', async () => {
    const created = await generate({ templateDir, targetDir, tokens });

    expect(created).toEqual([
      '.gitignore',
      'assets/shot.webm',
      'core/Cargo.toml',
      'core/lib.rs',
      'package.json',
    ]);

    const manifest = JSON.parse(
      await readFile(path.join(targetDir, 'package.json'), 'utf8'),
    );

    expect(manifest.name).toBe('@vimp-games/space-arena');
    expect(await readFile(path.join(targetDir, 'core', 'lib.rs'), 'utf8')).toBe(
      '// space_arena_core\n',
    );
  });

  it('сохраняет бинарные файлы побайтово', async () => {
    await generate({ templateDir, targetDir, tokens });

    const copied = await readFile(path.join(targetDir, 'assets', 'shot.webm'));

    expect(copied.equals(binary)).toBe(true);
  });

  it('отказывается писать в непустой каталог без --force', async () => {
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, 'keep.txt'), 'mine\n');

    await expect(generate({ templateDir, targetDir, tokens })).rejects.toThrow(
      GenerateError,
    );

    // чужой файл на месте, поверх ничего не записано
    expect(await readFile(path.join(targetDir, 'keep.txt'), 'utf8')).toBe(
      'mine\n',
    );
  });

  it('с --force пишет в непустой каталог', async () => {
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, 'keep.txt'), 'mine\n');

    await generate({ templateDir, targetDir, tokens, force: true });

    expect(await readFile(path.join(targetDir, 'keep.txt'), 'utf8')).toBe(
      'mine\n',
    );
    expect(
      await readFile(path.join(targetDir, 'package.json'), 'utf8'),
    ).toContain('space-arena');
  });

  it('падает на незаменённом токене в файле шаблона', async () => {
    await writeFile(path.join(templateDir, 'notes.md'), '{{UNKNOWN_TOKEN}}\n');

    await expect(generate({ templateDir, targetDir, tokens })).rejects.toThrow(
      /UNKNOWN_TOKEN/,
    );
  });

  it('--engine-path переписывает зависимость на локальный чекаут', async () => {
    await writeFile(
      path.join(templateDir, 'package.json.tpl'),
      '{\n  "name": "{{PACKAGE_NAME}}",\n  "devDependencies": { "vimp-engine": "{{ENGINE_VERSION}}" }\n}\n',
    );

    await generate({ templateDir, targetDir, tokens, enginePath: root });

    const manifest = JSON.parse(
      await readFile(path.join(targetDir, 'package.json'), 'utf8'),
    );

    expect(manifest.devDependencies['vimp-engine']).toBe(
      `file:${path.resolve(root)}`,
    );
  });

  // движок берёт ссылку в футере формы входа только из этих полей, фолбэка
  // нет (lib/packageLink.js), поэтому проставить их должен скаффолдер
  it('--repository пишет repository и homepage, раскрывая шорткат user/repo', async () => {
    await generate({ templateDir, targetDir, tokens, repository: 'lgick/space-arena' });

    const manifest = JSON.parse(
      await readFile(path.join(targetDir, 'package.json'), 'utf8'),
    );

    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/lgick/space-arena.git',
    });
    expect(manifest.homepage).toBe('https://github.com/lgick/space-arena#readme');
  });

  it('полный URL берётся как есть', async () => {
    await generate({
      templateDir,
      targetDir,
      tokens,
      repository: 'https://gitlab.com/a/b',
    });

    const manifest = JSON.parse(
      await readFile(path.join(targetDir, 'package.json'), 'utf8'),
    );

    expect(manifest.repository.url).toBe('git+https://gitlab.com/a/b.git');
  });

  // вводят руками, поэтому приходит всё, что копируется из адресной строки и
  // из кнопки "Code": без нормализации хвосты удваивались бы (`.git.git`) и
  // уезжали в опубликованный package.json игры
  it.each([
    ['https://github.com/lgick/vg.git', 'кнопка Code → HTTPS'],
    ['https://github.com/lgick/vg/', 'завершающий слэш'],
    ['https://github.com/lgick/vg#readme', 'адрес из homepage'],
    ['git+https://github.com/lgick/vg.git', 'значение поля repository'],
    ['git@github.com:lgick/vg.git', 'scp-форма'],
    ['ssh://git@github.com/lgick/vg.git', 'ssh-форма'],
    ['  lgick/vg  ', 'шорткат с пробелами'],
  ])('нормализует %s (%s)', async repository => {
    await generate({ templateDir, targetDir, tokens, repository });

    const manifest = JSON.parse(
      await readFile(path.join(targetDir, 'package.json'), 'utf8'),
    );

    expect(manifest.repository.url).toBe('git+https://github.com/lgick/vg.git');
    expect(manifest.homepage).toBe('https://github.com/lgick/vg#readme');
  });

  it('без --repository полей нет вовсе — пустых значений не появляется', async () => {
    await generate({ templateDir, targetDir, tokens });

    const manifest = JSON.parse(
      await readFile(path.join(targetDir, 'package.json'), 'utf8'),
    );

    expect(manifest.repository).toBeUndefined();
    expect(manifest.homepage).toBeUndefined();
  });

  it('--core-path дописывает patch.crates-io в корневой Cargo.toml', async () => {
    await writeFile(path.join(templateDir, 'Cargo.toml.tpl'), '[workspace]\n');

    await generate({ templateDir, targetDir, tokens, corePath: root });

    const cargo = await readFile(path.join(targetDir, 'Cargo.toml'), 'utf8');

    expect(cargo).toContain('[patch.crates-io]');
    expect(cargo).toContain(
      `vimp-engine-core = { path = "${path.resolve(root)}" }`,
    );
  });
});
