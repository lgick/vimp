import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertEngineApiCompatible } from '../lib/gamePlugin.js';

// Поиск игры для headless-прогона. В браузере плагин грузится по URL из
// GameManifest мастера; в Node URL-ов нет, поэтому источников три, по
// убыванию точности:
//
//   1. --game <путь>  — каталог пакета игры или прямо dist/manifest.json;
//   2. --core <путь>  — переопределение node-сборки ядра (entries.wasmNode);
//   3. ничего         — фикстура miniGame из этого репозитория.
//
// entries.wasmNode — новое ОПЦИОНАЛЬНОЕ поле манифеста: конвенция
// core/pkg-node/ уже описана в docs/ai/02-packaging.md, не хватало только
// пути в манифесте. Его отсутствие не ошибка — просто игра не прогоняется
// headless своим настоящим ядром.

const FIXTURE_DIR = new URL(
  '../../tests/fixtures/miniGame/',
  import.meta.url,
);

/**
 * @param {Object} [options]
 * @param {string} [options.game] - Путь к пакету игры или к манифесту.
 * @param {string} [options.core] - Путь к node-сборке ядра (перекрывает
 *   entries.wasmNode манифеста).
 * @returns {Promise<Object>} { id, hostPlugin, clientPlugin, wasmUrl, manifest,
 *   source }.
 */
export async function loadGameForSim({ game = null, core = null } = {}) {
  if (!game) {
    return loadFixture(core);
  }

  const manifestPath = game.endsWith('.json')
    ? path.resolve(game)
    : path.resolve(game, 'dist/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  assertEngineApiCompatible(manifest);

  const baseDir = path.dirname(manifestPath);
  const { assetsBase } = manifest;
  const hostPlugin = await importDefault(baseDir, manifest.entries.host, assetsBase);
  const clientPlugin = await importDefault(baseDir, manifest.entries.client, assetsBase);
  const nodeCore = core ?? manifest.entries.wasmNode ?? null;

  if (!nodeCore) {
    throw new Error(
      `${manifestPath}: no node build of the core — add entries.wasmNode ` +
        `to the manifest (core/pkg-node) or pass --core <path>`,
    );
  }

  return {
    id: manifest.id,
    manifest,
    hostPlugin,
    clientPlugin,
    wasmUrl: pathToFileURL(path.resolve(baseDir, nodeCore)).href,
    source: manifestPath,
  };
}

// фикстура даёт рабочий контур сразу, ещё до того как игра соберёт pkg-node:
// её ядра — обычный JS, поэтому wasmUrl не нужен
async function loadFixture(core) {
  const [hostPlugin, clientPlugin] = await Promise.all([
    import(new URL('host/index.js', FIXTURE_DIR).href).then(m => m.default),
    import(new URL('client/index.js', FIXTURE_DIR).href).then(m => m.default),
  ]);

  return {
    id: hostPlugin.id,
    manifest: null,
    hostPlugin,
    clientPlugin,
    wasmUrl: core ? pathToFileURL(path.resolve(core)).href : undefined,
    source: 'fixture:miniGame',
  };
}

function importDefault(baseDir, entry, assetsBase) {
  const file = path.resolve(baseDir, stripBase(entry, assetsBase));

  return import(pathToFileURL(file).href).then(module => module.default);
}

// entries.host/client — URL-ы, какими их видит браузер (`assetsBase` + путь
// внутри пакета). На диске этой базе соответствует каталог манифеста,
// поэтому абсолютный URL сначала обрезается до пути внутри пакета — иначе
// path.resolve увёл бы в корень файловой системы.
function stripBase(entry, assetsBase) {
  if (assetsBase && entry.startsWith(assetsBase)) {
    return entry.slice(assetsBase.length);
  }

  return entry.replace(/^\/+/, '');
}
