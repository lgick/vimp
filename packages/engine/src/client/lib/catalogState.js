// Каталог игр платформы может быть ПУСТ, и это законное состояние лобби, а не
// отказ загрузки: игры живут в реестре auth-сервиса, модератор вправе снять с
// раздачи последнюю, а на первом развёртывании не одобрена ещё ни одна.
//
// Лобби в этом состоянии обязано жить целиком: вход, бейдж пользователя, «My
// games» и «Moderation» от игры не зависят — и только через них каталог
// возвращается к жизни. Раньше пустой каталог бросал из бутстрапа и стирал
// разметку страницы: модератор, отключивший последнюю игру, запирал сам себя
// и вернуть её мог только запросом мимо интерфейса.
//
// Вынесено из main.js (бутстрап, в happy-dom не поднимается) отдельным
// модулем, чтобы обе ветки проверялись юнит-тестом.

/**
 * Приводит лобби в соответствие с активной игрой.
 * @param {Object} [manifest] - Манифест активной игры; `undefined` — каталог
 *   платформы пуст.
 * @param {Object} deps - Проводка лобби.
 * @param {HTMLElement} [deps.hostBtn] - Кнопка «Create server».
 * @param {string} deps.emptyText - Строка отказа для пустого каталога.
 * @param {Function} deps.bindGame - Форма комнаты и Leaderboard активной игры.
 * @param {Function} deps.showError - Показать строку отказа лобби.
 * @param {Function} deps.clearError - Снять строку отказа лобби.
 * @returns {void}
 */
export function applyCatalogState(
  manifest,
  { hostBtn, emptyText, bindGame, showError, clearError },
) {
  if (manifest) {
    bindGame(manifest);
    clearError();
  } else {
    // форму комнаты и Leaderboard не трогаем вовсе: без игры у первой нет
    // схемы полей, а второй — игры, за рейтингом которой идти
    showError(emptyText);
  }

  if (hostBtn) {
    hostBtn.disabled = !manifest;
  }
}

export default applyCatalogState;
