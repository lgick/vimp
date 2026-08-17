// Профиль участника в контуре без мастера и auth-сервиса (headless-прогон,
// standalone SDK, dedicated-сервер). Это не заглушка ради тишины: пустой
// профиль и есть корректное состояние такого матча, а настоящий fetch по
// относительному URL вне браузерной вкладки просто не разрешается.

/**
 * Фабрика fetchImpl для HostGame (hostOptions.playerDataFetch): любой запрос
 * профиля отвечает дефолтами вместо сети — вместе с сетевыми вызовами уходят
 * предупреждения PlayerDataSync и его ретраи.
 * @returns {Function} fetchImpl, отдающий { rank: 0, state: null }.
 */
export function offlinePlayerData() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ rank: 0, state: null }),
  });
}
