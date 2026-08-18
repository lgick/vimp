import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Пины vimp-engine / vimp-engine-core для сгенерированной игры. В шаблоне
// они не хардкодятся: устаревший пин — тихая поломка, которая всплывает
// только на сборке ядра (vimp-street-fighters приехал на
// vimp-engine-core = "0.1.0" при актуальном 0.3.2).
//
// Два источника, в порядке приоритета:
//   1. запуск из монорепозитория движка — версии читаются из
//      packages/engine/package.json и packages/engine/core/Cargo.toml;
//   2. установка из npm — src/versions.generated.json, который пишет
//      scripts/write-versions.js хуком prepack.

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const GENERATED_FILE = path.join(moduleDir, 'versions.generated.json');

// packages/create-vimp-game/src → корень репозитория
export const REPO_ROOT = path.resolve(moduleDir, '..', '..', '..');

// версия крейта — первый `version = "…"` после [package]: в Cargo.toml
// ниже идут секции зависимостей со своими version
export function parseCrateVersion(toml) {
  const packageSection = toml
    .split(/^\[/m)
    .find(part => part.startsWith('package]'));

  if (packageSection === undefined) {
    throw new Error('Cargo.toml has no [package] section');
  }

  const match = packageSection.match(/^\s*version\s*=\s*"([^"]+)"/m);

  if (match === null) {
    throw new Error('Cargo.toml [package] has no version');
  }

  return match[1];
}

export async function readRepoVersions(root = REPO_ROOT) {
  const enginePackage = JSON.parse(
    await readFile(
      path.join(root, 'packages', 'engine', 'package.json'),
      'utf8',
    ),
  );
  const cargo = await readFile(
    path.join(root, 'packages', 'engine', 'core', 'Cargo.toml'),
    'utf8',
  );

  return { engine: enginePackage.version, core: parseCrateVersion(cargo) };
}

async function readGeneratedVersions(file = GENERATED_FILE) {
  const raw = JSON.parse(await readFile(file, 'utf8'));

  if (typeof raw.engine !== 'string' || typeof raw.core !== 'string') {
    throw new Error(`${file} is malformed: expected { engine, core }`);
  }

  return { engine: raw.engine, core: raw.core };
}

// пины для buildTokens: движок — caret-диапазон (патчи подхватываются),
// крейт — точная версия (cargo сам трактует её как ^)
export function toPins({ engine, core }) {
  return { engineVersion: `^${engine}`, coreVersion: core };
}

export async function resolveVersions({
  root = REPO_ROOT,
  generated = GENERATED_FILE,
} = {}) {
  try {
    return await readRepoVersions(root);
  } catch {
    return readGeneratedVersions(generated);
  }
}
