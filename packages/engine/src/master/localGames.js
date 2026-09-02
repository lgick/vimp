import fs from 'node:fs';
import path from 'node:path';

// Каталог игр для локальной разработки: собирается из того, что лежит в
// node_modules — обычной зависимостью или симлинком `npm link`.
//
// Зачем: `master:games` в config/master.js — опубликованный код пакета
// vimp-engine, и правка этого массива под свою машину уезжает в релиз.
// Разработчик, прилинковавший игру, ожидает увидеть её в лобби, а не
// редактировать конфиг движка.
//
// Обнаружение не работает в проде: там каталог платформы приходит из реестра
// игр auth-сервиса, и локальная подмена скрыла бы одобренную версию
// (см. applyLocalGames).
export const GAMES_SCOPE = '@vimp-games';

/**
 * id игры, объявленный сборкой пакета.
 *
 * Единственный источник, которому можно верить: каталог всё равно сверяет с
 * ним настроенный id и молча выбрасывает игру при расхождении
 * (GameCatalog._addGame). Собранный `dist/manifest.json` он же и признак
 * игры: несобранный пакет мастеру бесполезен.
 *
 * @param {string} nodeModulesDir - директория node_modules, где резолвятся пакеты игр
 * @param {string} pkg - имя npm-пакета игры
 * @returns {string|null} id игры либо null (пакет не установлен, не собран
 *   или его манифест не читается)
 */
export function readGameId(nodeModulesDir, pkg) {
  const manifestPath = path.join(nodeModulesDir, pkg, 'dist', 'manifest.json');

  let manifest;

  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null; // пакет не собран (npm run build в репозитории игры)
  }

  return typeof manifest.id === 'string' && manifest.id ? manifest.id : null;
}

/**
 * npm-версия установленного пакета игры.
 *
 * Берётся из package.json, а не из манифеста: `manifest.version` — хеш
 * сборки, а не версия пакета (см. GameCatalog).
 *
 * @param {string} nodeModulesDir - директория node_modules, где резолвятся пакеты игр
 * @param {string} pkg - имя npm-пакета игры
 * @returns {string|null} версия либо null (пакета нет, package.json битый)
 */
export function readPackageVersion(nodeModulesDir, pkg) {
  let meta;

  try {
    meta = JSON.parse(
      fs.readFileSync(path.join(nodeModulesDir, pkg, 'package.json'), 'utf8'),
    );
  } catch {
    return null;
  }

  return typeof meta.version === 'string' && meta.version ? meta.version : null;
}

/**
 * Игры-плагины, физически присутствующие в node_modules.
 *
 * @param {string} nodeModulesDir - директория node_modules, где резолвятся пакеты игр
 * @param {{scope?: string}} [options]
 * @returns {{id: string, package: string}[]} записи формата master:games, по id
 */
export function discoverLocalGames(nodeModulesDir, { scope = GAMES_SCOPE } = {}) {
  let entries;

  try {
    entries = fs.readdirSync(path.join(nodeModulesDir, scope));
  } catch {
    return []; // скоупа нет вовсе — ни одной игры не установлено
  }

  const games = [];

  for (const name of entries) {
    // .package-lock.json и прочий служебный мусор npm внутри скоупа
    if (name.startsWith('.')) {
      continue;
    }

    const pkg = `${scope}/${name}`;
    const id = readGameId(nodeModulesDir, pkg);

    if (id) {
      games.push({ id, package: pkg });
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
 * Достраивает `master:games` играми из node_modules — только локально.
 *
 * @param {Object} config - синглтон lib/config.js
 * @param {string} nodeModulesDir
 * @param {Object} [env] - окружение (по умолчанию process.env)
 * @returns {{id: string, package: string}[]} что добавлено (пусто — ничего не меняли)
 */
export function applyLocalGames(config, nodeModulesDir, env = process.env) {
  // прод получает каталог из реестра игр auth-сервиса: игра, случайно
  // оказавшаяся в образе, не должна перекрывать одобренную версию — в лобби
  // поехало бы не то, что прошло модерацию
  if (env.NODE_ENV === 'production') {
    return [];
  }

  const discovered = discoverLocalGames(nodeModulesDir);

  if (discovered.length === 0) {
    return [];
  }

  config.set('master:games', mergeGames(discovered, config.get('master:games')));

  return discovered;
}
