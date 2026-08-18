import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE_API_VERSION } from '../../config/opcodes.js';

// Сбор контекста статической проверки: по каталогу пакета игры собирается
// всё, что удалось прочитать, и помечается недостающее. Ни одна неудача не
// бросает — правило, которому не хватило входа, вернёт skip.
//
// Живые объекты плагинов важнее исходников: gameConfig/authSchema/parts —
// это вычисленные структуры (импорты, спреды, сгенерированные карты), и
// парсинг текста врал бы. Поэтому половины плагина импортируются как
// модули; исходники читаются только там, где проверяется буква кода
// (engineApi литералом или импортом).

// каталог движка (packages/engine) — из него берётся версия крейта, с
// которой сверяется пин игры. core/Cargo.toml числится в "files"
// package.json именно ради этого: иначе в установке из npm версии крейта
// нет, и правило A5 проверяло бы пин только внутри монорепозитория
const ENGINE_DIR = new URL('../../../', import.meta.url);

const HOST_ENTRIES = ['src/host/index.js', 'host/index.js'];
const CLIENT_ENTRIES = ['src/client/index.js', 'client/index.js'];

/**
 * @param {string} gameDir - Каталог пакета игры.
 * @returns {Promise<Object>} Контекст правил.
 */
export async function loadContext(gameDir) {
  const dir = path.resolve(gameDir);
  const ctx = {
    dir,
    engineApi: ENGINE_API_VERSION,
    engineCoreVersion: await readEngineCoreVersion(),
    pkg: await readJson(path.join(dir, 'package.json')),
    viteText: await readText(path.join(dir, 'vite.config.js')),
    cargoText: await readText(path.join(dir, 'core', 'Cargo.toml')),
    workspaceCargoText: await readText(path.join(dir, 'Cargo.toml')),
    hostText: await readFirstText(dir, HOST_ENTRIES),
    clientText: await readFirstText(dir, CLIENT_ENTRIES),
    hostEntryExists: await exists(path.join(dir, 'src/host/index.js')),
    clientEntryExists: await exists(path.join(dir, 'src/client/index.js')),
    notes: [],
  };

  const distDir = path.join(dir, 'dist');

  ctx.manifest = await readJson(path.join(distDir, 'manifest.json'));
  ctx.distDir = ctx.manifest ? distDir : null;
  ctx.distFiles = ctx.manifest ? await listFiles(distDir) : null;

  ctx.hostPlugin = await loadHalf(ctx, 'host', HOST_ENTRIES);
  ctx.clientPlugin = await loadHalf(ctx, 'client', CLIENT_ENTRIES);

  ctx.gameConfig = ctx.hostPlugin?.gameConfig ?? null;
  ctx.authSchema = ctx.hostPlugin?.authSchema ?? null;
  ctx.clientConfig = buildClientConfig(ctx);

  return ctx;
}

// Половина плагина: сначала исходник (он свежее сборки), при неудаче —
// собранный entry из манифеста. Клиентский исходник в Node обычно не
// импортируется вовсе (`import './game.css'` — расширение Vite, не Node),
// поэтому падение первого кандидата — норма, а не ошибка.
async function loadHalf(ctx, half, candidates) {
  const sources = [
    ...candidates.map(rel => path.join(ctx.dir, rel)),
    distEntry(ctx, half),
  ].filter(Boolean);

  const failures = [];

  for (const file of sources) {
    if (!(await exists(file))) {
      continue;
    }

    try {
      const module = await import(pathToFileURL(file).href);
      const source = path.relative(ctx.dir, file);

      ctx[`${half}Source`] = source;

      // модуль импортировался, но плагина не отдал: движок берёт половину
      // ровно из default-экспорта, поэтому это отказ, а не «нечего
      // проверять» — без ноты автор увидел бы десяток немых skip
      if (module.default === undefined || module.default === null) {
        ctx.notes.push(
          `${half} plugin has no default export (${source}) — the engine ` +
            'loads the half by it',
        );
      }

      return module.default ?? null;
    } catch (error) {
      failures.push(`${path.relative(ctx.dir, file)}: ${error.message}`);
    }
  }

  ctx.notes.push(
    failures.length
      ? `${half} plugin not loaded — ${failures.join('; ')}`
      : `${half} plugin not found (looked for ${candidates.join(', ')})`,
  );

  return null;
}

// entries.* манифеста — URL-ы, какими их видит браузер; на диске им
// соответствует каталог манифеста (та же арифметика, что в
// lib/loadGamePackage.js)
function distEntry(ctx, half) {
  const entry = ctx.manifest?.entries?.[half];

  if (!entry || !ctx.distDir) {
    return null;
  }

  const { assetsBase } = ctx.manifest;
  const rel =
    assetsBase && entry.startsWith(assetsBase)
      ? entry.slice(assetsBase.length)
      : entry.replace(/^\/+/, '');

  return path.resolve(ctx.distDir, rel);
}

// клиентский CONFIG_DATA игры собирается хостом (buildClientGameConfig
// вызывается движком безусловно) — своего файла у него нет
function buildClientConfig(ctx) {
  if (typeof ctx.hostPlugin?.buildClientGameConfig !== 'function') {
    return null;
  }

  try {
    return ctx.hostPlugin.buildClientGameConfig();
  } catch (error) {
    ctx.notes.push(`buildClientGameConfig() threw: ${error.message}`);

    return null;
  }
}

async function readEngineCoreVersion() {
  const text = await readText(new URL('core/Cargo.toml', ENGINE_DIR));

  return text ? (parseCrateVersion(text) ?? null) : null;
}

// версия пакета в секции [package] — первый `version = "…"` до следующей
// секции; TOML-парсера в зависимостях движка нет, а формат здесь наш.
//
// Копия живёт в packages/create-vimp-game/src/versions.js: скаффолдер
// ставится через `npm create` и обязан работать без движка в зависимостях.
// Разбор обязан совпадать — правьте обе или ни одной (см. тест
// tests/scaffold/versions.test.js).
export function parseCrateVersion(text) {
  const section = text.split(/^\s*\[/m).find(part => part.startsWith('package]'));

  return section?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

async function readJson(file) {
  const text = await readText(file);

  if (text === null) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readFirstText(dir, candidates) {
  for (const rel of candidates) {
    const text = await readText(path.join(dir, rel));

    if (text !== null) {
      return text;
    }
  }

  return null;
}

async function exists(file) {
  try {
    await access(file);

    return true;
  } catch {
    return false;
  }
}

// плоский список путей внутри dist/ (posix-разделители): правила проверяют
// наличие ассетов и entry-файлов по нему, а не десятком stat()
async function listFiles(root) {
  const found = new Set();

  async function walk(dir, prefix) {
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);

      // симлинк-каталог (обычная dev-раскладка: dist/img -> ../assets/img)
      // у readdir не isDirectory(); без разыменования он попал бы в список
      // файлом, и правила ассетов дали бы ложный отказ
      if (entry.isSymbolicLink() ? await isDirectory(full) : entry.isDirectory()) {
        await walk(full, rel);
      } else {
        found.add(rel);
      }
    }
  }

  await walk(root, '');

  return found;
}

async function isDirectory(file) {
  try {
    return (await stat(file)).isDirectory();
  } catch {
    return false;
  }
}

export default loadContext;
