import { isValidNick } from './validators.js';

/**
 * Разбор поля `authorNick` тела `PATCH /admin/games/:id`: наружу админ
 * называет автора ником, в колонку `games.author_user_id` едет id. Вынесено
 * из маршрута отдельным модулем по той же причине, что и `gameViews.js` —
 * `main.js` при импорте поднимает сервер и пул, и проверить эту развилку
 * иначе нечем.
 *
 * @param {*} authorNick - Значение поля из тела запроса.
 * @param {Function} findByNick - `UserRepository.findByNick`.
 * @returns {Promise<Object>} `{ok: true, authorUserId}` либо
 *   `{ok: false, status, error}`. `authorUserId === undefined` означает
 *   «поле не трогать», `null` — «снять автора» (колонка nullable).
 */
export default async function resolveAuthor(authorNick, findByNick) {
  if (authorNick === undefined) {
    return { ok: true, authorUserId: undefined };
  }

  // пустая строка приходит из формы модерации, где очистить поле — это и
  // есть «снять автора»: игры платформы законно ничьи
  if (authorNick === null || authorNick === '') {
    return { ok: true, authorUserId: null };
  }

  if (!isValidNick(authorNick)) {
    return { ok: false, status: 400, error: 'badRequest' };
  }

  const author = await findByNick(authorNick);

  if (!author) {
    return { ok: false, status: 404, error: 'unknownUser' };
  }

  return { ok: true, authorUserId: author.id };
}
