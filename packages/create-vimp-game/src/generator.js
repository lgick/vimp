import {
  readdir,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

// Разворачивание templates/default в каталог игры: обход дерева, подстановка
// {{ТОКЕНОВ}}, переименования служебных имён.

export class GenerateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GenerateError';
  }
}

// подстановка идёт только в текстовых файлах: ассеты (webm/mp3) копируются
// побайтово, иначе кодировка их портит
const TEXT_EXTENSIONS = new Set([
  '.js',
  '.json',
  '.rs',
  '.toml',
  '.md',
  '.html',
  '.css',
  '.txt',
  '.gitignore',
]);

const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g;

// внутри репозитория движка файлы шаблона не должны выглядеть настоящими:
// package.json.tpl не подхватят workspaces, _gitignore — git
export function targetName(name) {
  const withoutTpl = name.endsWith('.tpl') ? name.slice(0, -4) : name;

  return withoutTpl.startsWith('_') ? `.${withoutTpl.slice(1)}` : withoutTpl;
}

export function isTextFile(sourceName) {
  if (sourceName.endsWith('.tpl')) {
    return true;
  }

  const name = targetName(sourceName);

  return TEXT_EXTENSIONS.has(path.extname(name) || name);
}

export function renderTokens(content, tokens, file) {
  const rendered = content.replace(TOKEN_RE, (match, key) => {
    if (!(key in tokens)) {
      throw new GenerateError(`unknown token ${match} in ${file}`);
    }

    return tokens[key];
  });

  // токен неизвестного вида ({{ foo }}, {{Bar}}) TOKEN_RE не ловит: такой
  // мусор уехал бы в файлы игры молча.
  //
  // Цена стража: любая пара `{{…}}` в шаблоне запрещена, включая
  // экранирование фигурной скобки в Rust (`format!("{{")`). Такой код в
  // шаблоне пишется через промежуточную переменную или обходом форматтера
  const leftover = rendered.match(/\{\{[^}]*\}\}/);

  if (leftover !== null) {
    throw new GenerateError(`unsubstituted token ${leftover[0]} in ${file}`);
  }

  return rendered;
}

// каталог должен отсутствовать или быть пустым: генератор пишет поверх и
// без проверки затёр бы чужую работу
export async function ensureTargetDir(dir, { force = false } = {}) {
  let entries;

  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await mkdir(dir, { recursive: true });
      return;
    }

    throw error;
  }

  if (entries.length > 0 && !force) {
    throw new GenerateError(
      `target directory is not empty: ${dir} (use --force to write into it)`,
    );
  }
}

// rootDir отдельно от targetDir: список созданных файлов собирается путями
// от корня игры, а рекурсия спускается по подкаталогам
async function copyTree(sourceDir, targetDir, tokens, created, rootDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, targetName(entry.name));

    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true });
      await copyTree(source, target, tokens, created, rootDir);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (isTextFile(entry.name)) {
      const content = await readFile(source, 'utf8');

      await writeFile(target, renderTokens(content, tokens, source), 'utf8');
    } else {
      await copyFile(source, target);
    }

    created.push(path.relative(rootDir, target));
  }
}

// dev-режимы этапа 6: игра собирается против несобранного релиза движка —
// пакет берётся из локального чекаута, крейт подменяется patch.crates-io
async function applyEnginePath(targetDir, enginePath) {
  const file = path.join(targetDir, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));

  manifest.devDependencies = {
    ...manifest.devDependencies,
    'vimp-engine': `file:${path.resolve(enginePath)}`,
  };

  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function applyCorePath(targetDir, corePath) {
  const file = path.join(targetDir, 'Cargo.toml');
  const patch =
    '\n[patch.crates-io]\n' +
    `vimp-engine-core = { path = "${path.resolve(corePath)}" }\n`;

  const content = await readFile(file, 'utf8');

  await writeFile(file, `${content.trimEnd()}\n${patch}`, 'utf8');
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function generate({
  templateDir,
  targetDir,
  tokens,
  force = false,
  enginePath,
  corePath,
}) {
  await ensureTargetDir(targetDir, { force });

  const created = [];

  await copyTree(templateDir, targetDir, tokens, created, targetDir);

  if (
    enginePath !== undefined &&
    (await exists(path.join(targetDir, 'package.json')))
  ) {
    await applyEnginePath(targetDir, enginePath);
  }

  if (
    corePath !== undefined &&
    (await exists(path.join(targetDir, 'Cargo.toml')))
  ) {
    await applyCorePath(targetDir, corePath);
  }

  return created.sort();
}
