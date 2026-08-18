// Подстановки шаблона: из ответов CLI выводится полный набор токенов
// {{…}}, которые generator.js подставляет в файлы templates/default.

// id игры — kebab-case: он же сегмент URL (/games/<id>/), ключ каталога и
// HostPlugin.id, поэтому пробелы и заглавные в нём недопустимы
const GAME_ID_RE = /^[a-z][a-z0-9-]*$/;

// имя npm-пакета: правила реестра (опциональная область видимости,
// нижний регистр, без пробелов)
const PACKAGE_NAME_RE =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export class TokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenError';
  }
}

export function isValidGameId(id) {
  return typeof id === 'string' && GAME_ID_RE.test(id) && !id.endsWith('-');
}

export function isValidPackageName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 214 &&
    PACKAGE_NAME_RE.test(name)
  );
}

// имя каталога встречается любое («My Game 2», «game_v2»); приводим к
// допустимому id, чтобы --yes не падал на первом же запуске
export function toGameId(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^([0-9])/, 'game-$1');
}

export function defaultTitle(id) {
  return id
    .split('-')
    .filter(part => part !== '')
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

export function defaultPackageName(id) {
  return `@vimp-games/${id}`;
}

export function toCrateName(id) {
  return `${id}-core`;
}

// wasm-bindgen выдаёт файлы по имени крейта в snake_case: pkg-web/<crate>_bg.wasm
export function toCrateSnake(crateName) {
  return crateName.replace(/-/g, '_');
}

export function buildTokens({
  id,
  title,
  packageName,
  author,
  engineVersion,
  coreVersion,
  year = new Date().getFullYear(),
}) {
  if (!isValidGameId(id)) {
    throw new TokenError(
      `invalid game id '${id}': expected kebab-case, e.g. 'space-arena'`,
    );
  }

  const resolvedPackage = packageName ?? defaultPackageName(id);

  if (!isValidPackageName(resolvedPackage)) {
    throw new TokenError(`invalid npm package name '${resolvedPackage}'`);
  }

  const crateName = toCrateName(id);

  return {
    GAME_ID: id,
    GAME_TITLE: title ?? defaultTitle(id),
    PACKAGE_NAME: resolvedPackage,
    CRATE_NAME: crateName,
    CRATE_SNAKE: toCrateSnake(crateName),
    ENGINE_VERSION: engineVersion,
    CORE_VERSION: coreVersion,
    AUTHOR: author ?? '',
    YEAR: String(year),
  };
}
