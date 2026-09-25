import * as ui from './ui.js';
import { UsageError } from './errors.js';
import { increment, isVersion, compareVersions } from './semver.js';

// Общая проверка ответа: level-слово или явная версия, строго выше current
// и выше опубликованной. Общая для askVersion и askGameVersionAsIs, чтобы
// они не расходились в валидации.
export function resolveVersionAnswer(answer, { current, published }) {
  const target = ['patch', 'minor', 'major'].includes(answer)
    ? increment(current, answer)
    : answer;

  if (!isVersion(target)) {
    throw new UsageError(`не версия и не уровень инкремента: ${answer}`);
  }

  // опечатка в версии дошла бы до publish и упала там с 403 — уже после
  // правки файлов, коммита и тега, откатывать которые пришлось бы руками
  if (compareVersions(target, current) <= 0) {
    throw new UsageError(`${target} не больше текущей ${current}`);
  }

  if (published && compareVersions(target, published) <= 0) {
    throw new UsageError(`${target} не больше опубликованной ${published}`);
  }

  return target;
}

export async function askVersion(label, { current, level, reason, published }, { yes }) {
  const suggested = increment(current, level);

  ui.log(`${label}: ${current} → ${suggested} (${reason})`);

  const answer = yes
    ? suggested
    : await ui.ask('Enter — принять, либо patch/minor/major/своя версия', suggested);

  return resolveVersionAnswer(answer, { current, published });
}

// Игра, чья локальная версия уже опережает опубликованную (game.bump ===
// false в plan.js), обычно публикуется как есть — но если под текущей
// версией уже стоит тег на remote от неудавшегося прогона (публикация не
// дошла до реестра), повторный `git push origin <тот же тег>` — no-op:
// GitHub не увидит новое событие, и release.yml не перезапустится. Нужен
// путь явно попросить версию выше, не полагаясь на level/increment, как
// askVersion — default здесь именно "как есть", а не бамп.
export async function askGameVersionAsIs(label, { current, published }, { yes }) {
  ui.log(`${label}: публикуется как есть, ${current}`);

  if (yes) {
    return current;
  }

  const answer = await ui.ask(
    'Enter — как есть, либо patch/minor/major/своя версия ' +
      '(нужно, если тег текущей версии уже занят неудачным прогоном)',
    current,
  );

  if (answer === current) {
    return current;
  }

  return resolveVersionAnswer(answer, { current, published });
}

// Игра, которую тянут только сигналы сверху (релиз крейта или движка,
// отставший пин ядра): выпуск по желанию, по умолчанию «нет». Под --yes
// спрашивать некого — решает явный --follow-games: крейт игру не обязывает,
// и молча перевыпускать её вслед за каждым релизом движка нельзя.
export async function askGameFollow(game, { yes, followGames = false }) {
  if (yes) {
    return followGames;
  }

  return ui.confirm(`${game.name}: ${game.reason}. Выпустить игру?`, false);
}
