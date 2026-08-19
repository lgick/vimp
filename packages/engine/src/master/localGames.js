import fs from 'node:fs';
import path from 'node:path';

// Каталог игр для локальной разработки: то, что в проде задаёт переменная
// окружения GAMES_MATRIX (её ставит CI/деплой), локально собирается из того,
// что лежит в node_modules — обычной зависимостью или симлинком `npm link`.
//
// Зачем: `master:games` в config/master.js — опубликованный код пакета
// vimp-engine, и правка этого массива под свою машину уезжает в релиз.
// Разработчик, прилинковавший игру, ожидает увидеть её в лобби, а не
// редактировать конфиг движка.
//
// Обнаружение НЕ подменяет явно заданный GAMES_MATRIX и не работает в
// проде — там каталог задаётся деплоем целиком (см. applyLocalGames).
export const GAMES_SCOPE = '@vimp-games';

/**
 * Игры-плагины, физически присутствующие в node_modules.
 *
 * Признак игры — собранный `dist/manifest.json`: несобранный пакет мастеру
 * бесполезен (GameCatalog всё равно его пропустит), а id берётся из самого
 * манифеста, потому что каталог сверяет его с настроенным и молча
 * выбрасывает игру при расхождении.
 *
 * @param {string} nodeModulesDir - директория node_modules, где резолвятся пакеты игр
 * @param {{scope?: string}} [options]
 * @returns {{id: string, package: string}[]} записи формата master:games, по id
 */
export function discoverLocalGames(nodeModulesDir, { scope = GAMES_SCOPE } = {}) {
  let entries;

  try {
    entries = fs.readdirSync(path.join(nodeModulesDir, scope));
  } catch (err) {
    return []; // скоупа нет вовсе — ни одной игры не установлено
  }

  const games = [];

  for (const name of entries) {
    // .package-lock.json и прочий служебный мусор npm внутри скоупа
    if (name.startsWith('.')) {
      continue;
    }

    const pkg = `${scope}/${name}`;
    const manifestPath = path.join(nodeModulesDir, pkg, 'dist', 'manifest.json');

    let manifest;

    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      continue; // пакет не собран (npm run build в репозитории игры)
    }

    if (typeof manifest.id === 'string' && manifest.id) {
      games.push({ id: manifest.id, package: pkg });
    }
  }

  // порядок детерминирован: первая игра каталога становится активной в лобби
  // (client/main.js), и он не должен зависеть от порядка чтения директории
  return games.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Сливает найденное локально с тем, что уже в конфиге: найденное впереди
 * (это игры, лежащие рядом с движком прямо сейчас), настроенное — следом и
 * без дублей, чтобы игра вне скоупа @vimp-games не пропала из каталога.
 *
 * @param {{id: string, package: string}[]} discovered
 * @param {{id: string, package: string}[]} [configured]
 * @returns {{id: string, package: string}[]}
 */
export function mergeGames(discovered, configured = []) {
  const seen = new Set(discovered.map(game => game.id));

  return [...discovered, ...configured.filter(game => !seen.has(game.id))];
}

/**
 * Достраивает `master:games` играми из node_modules — только локально и
 * только когда каталог не задан окружением явно.
 *
 * @param {Object} config - синглтон lib/config.js
 * @param {string} nodeModulesDir
 * @param {Object} [env] - окружение (по умолчанию process.env)
 * @returns {{id: string, package: string}[]} что добавлено (пусто — ничего не меняли)
 */
export function applyLocalGames(config, nodeModulesDir, env = process.env) {
  // прод получает каталог от деплоя; GAMES_MATRIX — явное слово разработчика
  // и о нём же способ переопределить порядок игр локально
  if (env.NODE_ENV === 'production' || env.GAMES_MATRIX) {
    return [];
  }

  const discovered = discoverLocalGames(nodeModulesDir);

  if (discovered.length === 0) {
    return [];
  }

  config.set('master:games', mergeGames(discovered, config.get('master:games')));

  return discovered;
}
