import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPluginCompatibility } from './gamePlugin.js';

// Загрузка пакета игры в Node по его собранному dist/ (Этап 4 плана
// standalone-sdk). В браузере плагин грузится по URL из GameManifest мастера;
// в Node URL-ов нет — оба Node-контура (headless-runner devtools/pluginLoader.js
// и dedicated-сервер) читают манифест с диска и импортируют половины плагина
// как обычные модули. Модуль живёт в lib/, а не в devtools/: прод-сервер не
// должен зависеть от отладочного контура (граница из CLAUDE.md).
//
// entries.wasmNode — node-сборка ядра игры (конвенция core/pkg-node,
// docs/ai/02-packaging.md). Для боевой игры она обязательна: без ядра
// авторитетную симуляцию крутить нечем.

/**
 * @param {string} distDir - Каталог собранного пакета игры (с manifest.json)
 *   или прямой путь к файлу манифеста.
 * @param {Object} [options]
 * @param {string} [options.core] - Путь к node-сборке ядра, перекрывающий
 *   entries.wasmNode манифеста.
 * @returns {Promise<Object>} { id, manifest, hostPlugin, clientPlugin, wasmUrl,
 *   distDir, manifestPath }.
 */
export async function loadGamePackage(distDir, { core = null } = {}) {
  // манифест под нестандартным именем нужен headless-прогону (--game
  // <path>/manifest-variant.json); dedicated-сервер всегда даёт каталог
  const manifestPath = distDir.endsWith('.json')
    ? path.resolve(distDir)
    : path.join(path.resolve(distDir), 'manifest.json');
  const baseDir = path.dirname(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  // игра одна и подменить её нечем — вердикт несовместимости здесь
  // терминальный (в отличие от каталога мастера, который помечает игру
  // недоступной и продолжает раздавать остальные)
  const compat = checkPluginCompatibility(manifest);

  if (!compat.ok) {
    throw new Error(`${manifestPath}: ${compat.text}`);
  }

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
    wasmUrl: pathToFileURL(corePath).href,
    distDir: baseDir,
    manifestPath,
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

  assertRequiresMatchManifest(manifest, plugins);
}

// `requires` пишут ТРИ независимых места одного пакета игры: скрипт сборки
// манифеста и обе половины плагина (последние — ради standalone SDK, у
// которого манифеста нет вовсе). Разъехавшись, они дают игру, которая в
// лобби честно отвергается, а в solo-режиме тихо недоигрывает — то есть
// именно тот молчаливый режим, ради отказа от которого возможности и
// заводились. Проверка — того же класса, что сверка engineApi выше: это
// рассинхрон сборки ВНУТРИ пакета, а не отказ по возрасту (И4).
//
// Половина, вовсе НЕ объявившая поле, из сверки исключена: старый пакет,
// собранный до его появления, обязан грузиться (И1/И2). Объявленное пустым
// (`requires: []`) — уже утверждение «игре ничего не нужно», и оно
// расходится с манифестом наравне с неполным списком.
function assertRequiresMatchManifest(manifest, plugins) {
  const wanted = new Set(
    Array.isArray(manifest.requires) ? manifest.requires : [],
  );

  for (const [half, plugin] of Object.entries(plugins)) {
    if (plugin.requires === undefined || plugin.requires === null) {
      continue;
    }

    if (!Array.isArray(plugin.requires)) {
      throw new Error(
        `game "${manifest.id}": ${half} plugin requires must be an array ` +
          'of capability names',
      );
    }

    const extra = plugin.requires.filter(name => !wanted.has(name));

    if (extra.length) {
      throw new Error(
        `game "${manifest.id}": ${half} plugin requires ` +
          `${extra.join(', ')}, which manifest.requires does not list — ` +
          'stale dist/ (the manifest is what the lobby master reads)',
      );
    }
  }

  // обратная сторона: манифест просит возможность, о которой половины не
  // знают. Половина, вовсе не объявившая поле, из сверки исключена — иначе
  // правка ломала бы каждый уже опубликованный пакет. Объявленное пустым
  // (`requires: []`) — это утверждение «ничего не нужно», и оно расходится
  // с манифестом наравне с неполным списком
  const halves = Object.values(plugins).filter(
    plugin => plugin.requires !== undefined && plugin.requires !== null,
  );

  if (halves.length === 0) {
    return;
  }

  const declared = halves.flatMap(plugin => plugin.requires);

  const missing = [...wanted].filter(name => !declared.includes(name));

  if (missing.length) {
    throw new Error(
      `game "${manifest.id}": manifest.requires names ${missing.join(', ')}, ` +
        'which neither plugin half declares — stale dist/ (the standalone ' +
        'SDK reads the halves, there is no manifest in solo mode)',
    );
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

export default loadGamePackage;
