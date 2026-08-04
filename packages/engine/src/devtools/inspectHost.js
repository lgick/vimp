// Срез меты хоста для проверок инвариантов. Читает приватные поля HostGame
// намеренно: отладочный контур не должен ради себя расширять боевой API
// хоста, а держать копию реестра участников в runner'е — значит проверять
// не то состояние, которым живёт матч. Весь доступ к внутренностям собран
// здесь, чтобы правка HostGame ломала один файл, а не пол-devtools.

/**
 * @param {Object} host - HostGame прогона.
 * @returns {Object} { activeList, humans, scripted, total, currentMap }.
 */
export function inspectHost(host) {
  const participants = host._participants;

  return {
    activeList: participants.getActiveList().map(String),
    humans: participants.getHumans().map(user => String(user.gameId)),
    scripted: participants.getScripted().map(user => String(user.gameId)),
    total: participants.totalCount,
    currentMap: host.currentMap,
  };
}

/**
 * Курированный дамп мира ядра через адаптер хоста (этап 4). null, если
 * ядро игры собрано против движка без `debug_json`.
 * @param {Object} host - HostGame прогона.
 * @returns {Object|null}
 */
export function inspectCore(host) {
  return host._game.debugJson();
}
