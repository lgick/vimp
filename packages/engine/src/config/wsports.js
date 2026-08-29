// Номера портов JSON-канала (docs/en/network.md). Реестр append-only, как и
// остальные словари плагинной поверхности (этап 3 плана
// plugin-forward-compat): номер НИКОГДА не переиспользуется и не
// перенумеровывается — уже опубликованная сборка игры шлёт и слушает те
// номера, что видела при сборке, и её dist больше никто не тронет.
// Выведенный из эксплуатации порт остаётся в этом файле со своим номером и
// пометкой `// retired in vN`, чтобы номер не был выдан повторно. За
// механикой следит раздел `ports` слепка поверхности
// (contract/surface.json): удаление имени или смена номера валит тест.
export default {
  // порты получения данные от сервера
  server: {
    CONFIG_DATA: 0,
    AUTH_DATA: 1,
    AUTH_RESULT: 2,
    MAP_DATA: 3,
    FIRST_SHOT_DATA: 4,
    SHOT_DATA: 5,
    SOUND_DATA: 6,
    GAME_INFORM_DATA: 7,
    TECH_INFORM_DATA: 8,
    MISC: 9,
    PING: 10,
    CLEAR: 11,
    CONSOLE: 12,
    PANEL_DATA: 13,
    STAT_DATA: 14,
    CHAT_DATA: 15,
    VOTE_DATA: 16,
    KEYSET_DATA: 17,
    // места участников в глобальном топе (snakes-v3 этап 4): косметика
    // для parts игры, в снапшот не идёт
    ACCOLADES_DATA: 18,
  },
  // порты получения данных от клиента
  client: {
    CONFIG_READY: 0,
    AUTH_RESPONSE: 1,
    MODULES_READY: 2,
    MAP_READY: 3,
    FIRST_SHOT_READY: 4,
    KEYS_DATA: 5,
    CHAT_DATA: 6,
    VOTE_DATA: 7,
    PONG: 8,
  },
};
