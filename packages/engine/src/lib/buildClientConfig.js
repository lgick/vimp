// Сборка клиентского CONFIG_DATA (порт 0): merge движковых дефолтов
// (src/config/clientDefaults.js) с игровым client-конфигом
// (@vimp-games/tanks/config/client.js) + время голосования и данные client-side
// prediction из game-конфига. Используется Worker'ом хоста
// (src/host/host.worker.js).

const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// рекурсивный merge: объекты сливаются, массивы и скаляры заменяются
const deepMerge = (base, extra) => {
  const result = { ...base };

  for (const [key, value] of Object.entries(extra)) {
    result[key] =
      isPlainObject(result[key]) && isPlainObject(value)
        ? deepMerge(result[key], value)
        : value;
  }

  return result;
};

// Возвращает новый объект, не мутируя переданные конфиги.
export const buildClientConfig = (game, defaults, gameClient) => {
  const config = deepMerge(
    structuredClone(defaults),
    structuredClone(gameClient),
  );

  // время ожидания vote-модуля. Игра без голосований (noSpectators) не
  // объявляет modules.vote.params вовсе — движковые дефолты дают только
  // elems, поэтому params здесь и заводится
  config.modules.vote.params = {
    ...config.modules.vote.params,
    time: game.timers.voteTime,
  };

  // данные для client-side prediction (реплика движения своего танка
  // и визуального спавна его снарядов)
  config.prediction = {
    timeStep: game.timers.timeStep,
    playerKeys: game.playerKeys,
    models: game.parts.models,
    weapons: game.parts.weapons,
    // собственные параметры ядра игры (те же, что едут в хостовое ядро
    // через lib/coreConfig.js): движок их не читает и не валидирует, а
    // клиентская реплика обязана видеть правила ровно те же, что хост —
    // иначе предсказание разъедется с авторитетным молча
    coreParams: game.coreParams,
  };

  // снапшот-схема игры: клиент собирает по ней конфиг клиентского ядра и
  // читает hot-буфер — бандл клиента не обязан совпадать с бандлом хоста
  config.snapshot = game.snapshot;

  return config;
};
