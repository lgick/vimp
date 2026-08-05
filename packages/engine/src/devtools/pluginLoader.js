import { access, readFile } from 'node:fs/promises';
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

// значение поля source у фикстуры: по нему отличается «своя игра, схему
// которой инструмент знает» от чужого плагина (см. builtinScenario.js)
export const FIXTURE_SOURCE = 'fixture:miniGame';

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
  const hostPlugin = await importDefault(
    baseDir,
    manifest.entries.host,
    assetsBase,
  );
  const clientPlugin = await importDefault(
    baseDir,
    manifest.entries.client,
    assetsBase,
  );

  assertPluginMatchesManifest(manifest, {
    host: hostPlugin,
    client: clientPlugin,
  });

  const nodeCore = core ?? manifest.entries.wasmNode ?? null;

  if (!nodeCore) {
    throw new Error(
      `${manifestPath}: no node build of the core — add entries.wasmNode ` +
        `to the manifest (core/pkg-node) or pass --core <path>`,
    );
  }

  const corePath = path.resolve(baseDir, nodeCore);

  // манифест объявляет поле, но опубликованный пакет мог не довезти файл
  // (ignore-правила срезают каталог внутри files) — без этой проверки отказ
  // приходит сырым ERR_MODULE_NOT_FOUND из резолвера
  try {
    await access(corePath);
  } catch {
    throw new Error(
      `${manifestPath}: entries.wasmNode points at '${nodeCore}', but ` +
        `${corePath} does not exist — the game package was published ` +
        `without its node core (npm run core:build:node) or pass --core <path>`,
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
    source: FIXTURE_SOURCE,
  };
}

// зеркало lib/gamePlugin.js:loadClientPlugin — манифест мог быть пересобран
// без dist/: прогон на старом плагине даёт зелёный вердикт о том, чего в
// сборке уже нет
function assertPluginMatchesManifest(manifest, plugins) {
  for (const [half, plugin] of Object.entries(plugins)) {
    if (plugin.engineApi !== manifest.engineApi) {
      throw new Error(
        `game "${manifest.id}": ${half} plugin engineApi ` +
          `v${plugin.engineApi} does not match manifest engineApi ` +
          `v${manifest.engineApi} — stale dist/`,
      );
    }
  }
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
