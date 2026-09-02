// Активная игра переключается в лобби на лету: ClientPlugin выбранной игры
// (или игры комнаты, в которую заходим) грузится в момент клика, а не один раз
// при бутстрапе. Это возможно потому, что всё пер-игровое состояние (Factory,
// Pixi-приложения, clientCore) появляется только на старте матча, а после
// матча lobby-режим перезагружает страницу — лобби всегда в чистом
// до-матчевом состоянии.
//
// Вынесено из main.js (бутстрап, тестами не покрывается) отдельным модулем,
// чтобы кеш и обработка отказа проверялись юнит-тестом.
export function createGameActivator({ gamesById, loadClientPlugin }) {
  // `${gameId}@${manifest.version}` -> промис загрузки: кешируется именно
  // промис, иначе два быстрых клика подряд запустили бы импорт дважды.
  //
  // Версия в ключе обязательна (master-game-registry, этап 3): в каталоге
  // мастера две версии одной игры живут одновременно (админ стейджит новую,
  // игроки играют в одобренную), и ключ по одному gameId вернул бы уже
  // выполненный import() НЕ ТОГО кода. manifest.version — хеш бандла, то
  // есть идентификатор самого кода
  const plugins = new Map();

  return async function activateGame(gameId) {
    const manifest = gamesById.get(gameId);

    if (!manifest) {
      throw new Error(`unknown game "${gameId}"`);
    }

    const key = `${gameId}@${manifest.version}`;

    let pending = plugins.get(key);

    if (!pending) {
      pending = loadClientPlugin(manifest).catch(e => {
        // отказ не кешируем: сеть могла моргнуть, повторный клик обязан
        // попробовать снова, а не переигрывать ту же ошибку вечно
        plugins.delete(key);

        throw e;
      });

      plugins.set(key, pending);
    }

    return { manifest, plugin: await pending };
  };
}
