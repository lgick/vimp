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

// Приводит введённое человеком к голому https-адресу проекта, из которого
// собираются оба поля. Разбираются все формы, которые реально вводят руками:
// шорткат `user/repo`, строка из кнопки "Code → HTTPS" (хвост `.git`),
// scp-форма `git@host:a/b`, `git+`/`ssh://`/`git://`, `#readme` и слэш.
//
// Движковый resolveProjectUrl сюда не импортируется: у пакета нулевые
// рантайм-зависимости (см. prompts.js), а vimp-engine ему даже не
// зависимость. Формы держать согласованными с packages/engine/src/lib/
// packageLink.js — их читает та же ссылка в футере.
function normalizeRepositoryUrl(raw) {
  let url = raw.trim().replace(/^git\+/, '');

  if (/^[\w.-]+\/[\w.-]+$/.test(url)) {
    return `https://github.com/${url}`;
  }

  // scp-форма git@host:user/repo — двоеточие здесь разделитель, не порт
  const scp = /^git@([^:/]+):(.+)$/.exec(url);

  if (scp) {
    url = `https://${scp[1]}/${scp[2]}`;
  }

  return url
    .replace(/^ssh:\/\/(git@)?/, 'https://')
    .replace(/^git:\/\//, 'https://')
    .replace(/#readme$/, '')
    .replace(/\.git(?=$|[#?])/, '')
    .replace(/\/+$/, '');
}

// Адрес проекта в package.json: движок берёт из него ссылку в футере формы
// входа (docs/en/client.md), а правило контракта A7 предупреждает, когда поля
// нет. Пишется только по явно заданному значению — угаданный URL уехал бы
// битой ссылкой к игрокам.
async function applyRepository(targetDir, repository) {
  const url = normalizeRepositoryUrl(repository);

  const file = path.join(targetDir, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));

  manifest.repository = { type: 'git', url: `git+${url}.git` };
  manifest.homepage = `${url}#readme`;

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
  repository = '',
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
    (repository ?? '').trim() !== '' &&
    (await exists(path.join(targetDir, 'package.json')))
  ) {
    await applyRepository(targetDir, repository);
  }

  if (
    corePath !== undefined &&
    (await exists(path.join(targetDir, 'Cargo.toml')))
  ) {
    await applyCorePath(targetDir, corePath);
  }

  return created.sort();
}
