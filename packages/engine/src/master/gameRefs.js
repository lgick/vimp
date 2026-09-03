// Форматы ссылок на игру. Дублируют packages/auth/src/config/auth.js:games —
// пакеты разные, общей зависимости между ними нет. Значения обязаны
// совпадать: id — сегмент URL раздачи И имя каталога на диске, version —
// сегмент URL И имя подкаталога версии
export const GAME_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
export const GAME_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;
export const PACKAGE_NAME_PATTERN =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

// id мастера, занятые роутами реестра (/games/lookup, /games/mine,
// /games/submit, /games/<id>/manifest.json): игра с таким id перекрыла бы их
export const RESERVED_GAME_IDS = new Set(['mine', 'submit', 'manifest', 'lookup']);
