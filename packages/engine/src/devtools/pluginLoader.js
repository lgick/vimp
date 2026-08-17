import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertGameConfigShape } from '../lib/gamePlugin.js';
import { loadGamePackage } from '../lib/loadGamePackage.js';

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
 * @param {Object} plugin - Результат loadGameForSim.
 * @returns {boolean} Прогон идёт на встроенной фикстуре, а не на чужой игре.
 */
export const isFixture = plugin => plugin.source === FIXTURE_SOURCE;

/**
 * @param {Object} [options]
 * @param {string} [options.game] - Путь к пакету игры или к манифесту.
 * @param {string} [options.core] - Путь к node-сборке ядра (перекрывает
 *   entries.wasmNode манифеста).
 * @returns {Promise<Object>} { id, hostPlugin, clientPlugin, wasmUrl, manifest,
 *   source }.
 */
export async function loadGameForSim({ game = null, core = null } = {}) {
  const plugin = game
    ? await loadFromManifest(game, core)
    : await loadFixture(core);

  // контракт gameConfig проверяется здесь, а не только в createHostRuntime:
  // встроенный сценарий собирается из gameConfig раньше, чем стартует прогон
  // (builtinScenario.js), и плагин без конфига иначе отвечал бы сырым
  // TypeError вместо перечисления недостающих полей
  assertGameConfigShape(plugin.hostPlugin);

  return plugin;
}

// путь --game указывает либо на пакет игры, либо прямо на манифест; сама
// загрузка общая с dedicated-сервером (lib/loadGamePackage.js)
async function loadFromManifest(game, core) {
  const target = game.endsWith('.json')
    ? path.resolve(game)
    : path.resolve(game, 'dist');
  const pkg = await loadGamePackage(target, { core });

  return { ...pkg, source: pkg.manifestPath };
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
