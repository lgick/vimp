import { ENGINE_CAPABILITIES } from './capabilities.js';
import { createGameConfigView } from './gameConfigView.js';

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

// Совместимость плагина с этой сборкой движка (этап 5 плана
// plugin-forward-compat). Числа больше не сравниваются: `engineApi` заморожен
// на 4 и остался меткой поколения контракта, а не гейтом. Плагин отвергается,
// только если просит возможность, которой в этой сборке нет (то есть он
// НОВЕЕ движка) — движок не может выдать того, чего в нём не существует.
// Плагин любого возраста принимается: поверхность append-only (И1), и имя,
// которое он написал, работает вечно.
//
// Функция возвращает вердикт, а не бросает: у четырёх входов (каталог
// мастера, Node-загрузчик, браузерный клиент, standalone SDK) разная
// правильная реакция — каталог помечает игру недоступной и продолжает
// раздавать остальные, остальные три бросают.
export function checkPluginCompatibility(manifest) {
  const wanted = manifest.requires ?? [];
  const missing = wanted.filter(name => !ENGINE_CAPABILITIES.has(name));

  if (missing.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: 'engine-too-old',
    missing,
    // текст обязан называть сторону, которую надо обновить: это единственный
    // оставшийся режим отказа, и он должен быть однозначным
    text:
      `game "${manifest.id}" needs engine capabilities this build does ` +
      `not have: ${missing.join(', ')} — update the engine`,
  };
}

// Имя, на которое ссылается существующий код и тесты (И1 действует и на
// экспорты движка): та же проверка, но бросающая.
export function assertEngineApiCompatible(manifest) {
  const compat = checkPluginCompatibility(manifest);

  if (!compat.ok) {
    throw new Error(compat.text);
  }
}

// Обязательные поля gameConfig и умолчания для всего остального живут в
// lib/gameConfigView.js (этап 2 плана plugin-forward-compat) — здесь только
// имена, на которые мог сослаться чужой код, и тонкая обёртка над view.
export { REQUIRED_GAME_CONFIG_PATHS } from './gameConfigView.js';

// spectatorTeam перестал быть обязательным (у него есть умолчание) —
// константа остаётся именем пути, а не требованием
export const SPECTATOR_CONFIG_PATH = 'spectatorTeam';

/**
 * Проверяет gameConfig плагина и возвращает представление с умолчаниями.
 * Гейт стоит сразу после import — рядом с engineApi-гейтом: недостающее
 * обязательное поле иначе валится непрозрачной ошибкой глубоко в onInit.
 * @param {Object} hostPlugin - Загруженный HostPlugin игры.
 * @returns {Object} Результат createGameConfigView (одна view на прогон).
 */
export function assertGameConfigShape(hostPlugin) {
  return createGameConfigView(hostPlugin.gameConfig, hostPlugin.id);
}

// динамический import ClientPlugin игры (client-entry её сборки). Сначала —
// вердикт совместимости по манифесту (дешевле: до сетевого import): игра,
// требующая возможности, которой в этой сборке нет, не заработает и после
// загрузки бандла. Сверка engineApi манифеста с плагином ниже — про
// рассинхрон сборки внутри пакета, а не про версию движка
export async function loadClientPlugin(manifest) {
  const compat = checkPluginCompatibility(manifest);

  if (!compat.ok) {
    throw new Error(compat.text);
  }

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
