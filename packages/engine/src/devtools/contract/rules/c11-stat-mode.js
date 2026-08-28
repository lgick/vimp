import { ERROR, skip, verdict } from '../result.js';

// Режим статистики по Tab объявляется ДВАЖДЫ, и обе половины обязаны
// совпадать (snakes-v3 этап 4):
//
//   gameConfig.statMode              — читает хост (host/HostGame.js);
//   modules.stat.params.mode         — читает клиент (client/…/model/Stat.js).
//
// Рассинхронизация не падает и ничем себя не выдаёт, поэтому её ловит
// правило, а не рантайм:
//
//   объявлен только клиент — хост каждый тик собирает и рассылает таблицу
//     комнаты, которую клиент выбрасывает первой же строкой update();
//   объявлен только хост — хост не шлёт таблицу вовсе, а клиент рисует ту
//     самую таблицу комнаты и она навсегда остаётся пустой.
//
// Первое стоит трафика, второе — пустого экрана; оба варианта — дефект
// конфигурации, а не выбор.
export default {
  id: 'C11',
  name: 'statMode',
  level: ERROR,
  title: 'gameConfig.statMode and modules.stat.params.mode agree',

  check(ctx) {
    const params = ctx.clientConfig?.modules?.stat?.params;

    if (!params || !ctx.gameConfig) {
      return skip('no client stat params');
    }

    const client = params.mode ?? null;
    const host = ctx.gameConfig.statMode ?? null;

    if (client === host) {
      return verdict([], client ? `both declare '${client}'` : 'the room table');
    }

    if (client && !host) {
      return verdict([
        `modules.stat.params.mode is '${client}', but gameConfig.statMode is ` +
          'not set: the host keeps broadcasting the room table every tick and ' +
          'the client throws every one of those messages away',
      ]);
    }

    if (host && !client) {
      return verdict([
        `gameConfig.statMode is '${host}', but modules.stat.params.mode is ` +
          'not set: the host sends no stat at all and the client draws the ' +
          'room table, which stays empty forever',
      ]);
    }

    return verdict([
      `gameConfig.statMode is '${host}' and modules.stat.params.mode is ` +
        `'${client}': the two halves of the same decision disagree`,
    ]);
  },
};
