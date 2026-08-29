// Выбор активной игры из каталога мастера. Вынесено из client/main.js по той
// же причине, что и socketDispatch.js: main.js исполняется при импорте, и
// проверить ветвление внутри него нечем.
//
// Недоступная игра (manifest.compat.ok === false, этап 5 плана
// plugin-forward-compat) в СПИСОК лобби попадает — с причиной, — но активной
// быть не может: её плагин не загрузится, и вкладка встала бы на первой же
// игре каталога.

/**
 * Доступна ли игра. Поле `compat` появляется у манифеста каталога мастера,
 * только когда игра просит возможность, которой в этой сборке движка нет;
 * манифест без него (все опубликованные до этапа 5) доступен по определению.
 * @param {Object} manifest - GameManifest из каталога мастера.
 * @returns {boolean}
 */
export function isGameAvailable(manifest) {
  return manifest.compat?.ok !== false;
}

/**
 * Активная игра вкладки.
 *
 * Обе ветки фильтруются одинаково: сохранённый выбор игры (`gameId`) тоже мог
 * указывать на игру, ставшую недоступной после обновления движка, и брать её
 * «раз уж попросили» значило бы падать там, где можно объяснить.
 * @param {Array<Object>} manifests - Каталог мастера.
 * @param {string} [gameId] - Сохранённый выбор игры (boot.gameId).
 * @returns {Object|undefined} Манифест активной игры.
 * @throws {Error} Если каталог непустой, но играбельной игры в нём нет —
 *   с причиной по каждой строке.
 */
export function pickActiveGame(manifests, gameId) {
  const active = gameId
    ? manifests.find(
        manifest => manifest.id === gameId && isGameAvailable(manifest),
      )
    : manifests.find(isGameAvailable);

  if (active) {
    return active;
  }

  // непустой каталог без единой играбельной строки — сказать это одной
  // понятной фразой, а не отдать наверх первую попавшуюся и упасть в
  // loadClientPlugin непрозрачной ошибкой
  if (manifests.length) {
    throw new Error(
      'no playable game in the lobby catalog: ' +
        manifests
          .map(manifest => manifest.compat?.text ?? `"${manifest.id}"`)
          .join('; '),
    );
  }

  return undefined;
}

export default pickActiveGame;
