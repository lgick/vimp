// продублировано из packages/engine/src/lib/validators.js (plan/auth_b1.md:
// "вынести в общий пакет или продублировать") — auth-сервис живёт в
// отдельном workspace без рантайм-зависимости на движок, дублирование проще
// общего пакета на этом этапе. Отличие от движкового оригинала (F13
// кодревью): `\s` разрешал управляющие пробелы (\t\n\f\v) внутри ника — здесь
// это глобально-персистентная личность, поэтому сужено до обычного пробела
const NAME_REGEXP = new RegExp('^[a-zA-Z]([\\w #]{0,13})[\\w]{1}$');

export const isValidNick = nick => typeof nick === 'string' && NAME_REGEXP.test(nick);

// snakes-v3 (stage_2.md, 2.5): результат игры. best — одна игра, points —
// сумма склеенных. `best <= points` — не формальность: best это максимум
// среди игр, чья сумма равна points, и нарушение означает битого клиента
export const isValidGameResult = (points, best, { maxGameScore, maxPoints }) =>
  Number.isInteger(points) && Number.isInteger(best) &&
  points >= 0 && best >= 0 &&
  best <= maxGameScore && points <= maxPoints && best <= points;

// state — непрозрачный JSON игры, auth проверяет только общий объём
export const isValidStateSize = (state, maxBytes) =>
  Buffer.byteLength(JSON.stringify(state)) <= maxBytes;

// server-rating этап 2 (stage_2.md, 2.1): голос — ровно +1 (/like) или
// -1 (/unlike), никаких других значений
export const isValidVoteValue = value => value === 1 || value === -1;

// причина обязательна (правило /like·/unlike, как раньше у /ban); пустая —
// голос не учитывается
export const isValidVoteReason = reason =>
  typeof reason === 'string' && reason.trim().length > 0;

// клампит query-параметр в целое [1, max]; невалидное значение — fallback
// (lobby-page-plan: GET /leaderboard?limit=). Вынесено из main.js (code
// review L3), чтобы клампинг был покрыт юнит-тестом отдельно от роута
export const clampLimit = (value, fallback, max) => {
  const num = Number(value);

  return Number.isInteger(num) ? Math.min(Math.max(num, 1), max) : fallback;
};

// ***** РЕЕСТР ИГР (master-game-registry, этап 1) *****
//
// Пределы и шаблоны приходят аргументом (config.games), а не импортом
// конфига: файл остаётся набором чистых функций, проверяемых без окружения.
// Отдельная функция на поле — чтобы роут отвечал своим кодом ошибки на
// каждое поле, а не общим badRequest

// сегмент URL раздачи /games/<id>/<version>/ — обязан совпадать с
// manifest.id пакета
export const isValidGameId = (id, { idPattern }) =>
  typeof id === 'string' && idPattern.test(id);

export const isValidPackageName = (name, { packagePattern }) =>
  typeof name === 'string' && packagePattern.test(name);

// строгий semver-триплет: версия становится сегментом URL и именем каталога
// на диске мастера (этап 2), диапазоны и теги здесь недопустимы
export const isValidGameVersion = (version, { versionPattern }) =>
  typeof version === 'string' && versionPattern.test(version);

// title и repoUrl необязательны: пустое значение — это отсутствие значения
export const isValidGameTitle = (title, { maxTitleLength }) =>
  title === undefined || title === null ||
  (typeof title === 'string' && title.trim().length > 0 && title.length <= maxTitleLength);

// только http(s): ссылка показывается в лобби, javascript:/data: там не место
export const isValidRepoUrl = (url, { maxUrlLength }) => {
  if (url === undefined || url === null) {
    return true;
  }

  if (typeof url !== 'string' || url.length > maxUrlLength) {
    return false;
  }

  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

// замечание модератора: пустое считается снятием замечания (null)
export const isValidModeratorNote = (note, { maxNoteLength }) =>
  note === undefined || note === null ||
  (typeof note === 'string' && note.length <= maxNoteLength);
