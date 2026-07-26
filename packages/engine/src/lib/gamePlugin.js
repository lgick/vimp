import { ENGINE_API_VERSION } from '../config/opcodes.js';

// Динамическая загрузка игры по GameManifest мастера (Этап 6.3): клиент
// больше не импортирует игру статически (gameRegistry.static.js) — вместо
// этого он читает каталог игр мастера и подгружает ClientPlugin по
// entries.client из манифеста.

// каталог всех игр мастера (GameCatalog, см. Этап 6.2) — массив манифестов
export async function fetchGamesManifest(url = '/games/manifest.json') {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`games manifest: HTTP ${res.status}`);
  }

  return res.json();
}

// манифест одной игры (GameCatalog::getManifest, см. Этап 6.2) — объект,
// не массив; используется при повторном фетче активной игры (Этап 6.5)
export async function fetchGameManifest(url) {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`game manifest: HTTP ${res.status}`);
  }

  return res.json();
}

// несовпадение engineApi — плагин собран под другую версию контрактов
// движка (§3.7 PLAN.md); загружать его небезопасно
export function assertEngineApiCompatible(manifest) {
  if (manifest.engineApi !== ENGINE_API_VERSION) {
    throw new Error(
      `game "${manifest.id}" requires engine API v${manifest.engineApi}, ` +
        `this engine build is v${ENGINE_API_VERSION}`,
    );
  }
}

// поля gameConfig, которые движок читает до какой-либо игровой логики
// (applyRoomOverrides/coreConfig/buildClientConfig) — недостающее валится
// непрозрачной ошибкой глубоко в onInit; проверяем контракт §HostPlugin API
// (docs/en/plugin-api.md) сразу после import, рядом с engineApi-гейтом
const REQUIRED_GAME_CONFIG_PATHS = [
  'roomDefaults.maxPlayers',
  'snapshot',
  'parts.models',
  'parts.weapons',
  'parts.friendlyFire',
  'panel.fields',
  'playerKeys',
];

function getPath(obj, dottedPath) {
  return dottedPath
    .split('.')
    .reduce((value, key) => value?.[key], obj);
}

// бросает при отсутствии обязательных полей HostPlugin.gameConfig
export function assertGameConfigShape(hostPlugin) {
  const missing = REQUIRED_GAME_CONFIG_PATHS.filter(
    p => getPath(hostPlugin.gameConfig, p) === undefined,
  );

  if (missing.length > 0) {
    throw new Error(
      `game "${hostPlugin.id}": gameConfig is missing required field(s): ` +
        missing.join(', '),
    );
  }
}

// динамический import ClientPlugin игры (client-entry её сборки). Манифест и
// плагин собираются одной сборкой (build-game-manifest.js читает то же
// entries.client) и их engineApi всегда совпадает — проверяем только
// манифест (дешевле: до сетевого import), плагин сверяем после загрузки как
// защиту от рассинхрона сборки, а не как отдельный путь отказа
export async function loadClientPlugin(manifest) {
  assertEngineApiCompatible(manifest);

  const module = await import(/* @vite-ignore */ manifest.entries.client);
  const plugin = module.default;

  if (plugin.engineApi !== manifest.engineApi) {
    throw new Error(
      `game "${manifest.id}": plugin engineApi v${plugin.engineApi} ` +
        `does not match manifest engineApi v${manifest.engineApi}`,
    );
  }

  return plugin;
}
