# Д1. Снапшот-схема — из движка в игру (критично, ~M) ✅ выполнен

## Замечание

Игровая схема `SNAPSHOT_KEYS` (ключи m1/w1/w2/w2e/c1/c2 с полями
gunRotation/condition/ownerId…) живёт в движковом
`packages/engine/src/config/opcodes.js:31-107` и потребляется движком в
`lib/coreConfig.js`, `lib/clientCoreConfig.js` и `client/main.js`
(`reconstructHot` с жёсткой раскладкой 12/5 float, `SNAPSHOT_KEYS_BY_ID`).
Целевая структура §2 PLAN.md кладёт snapshot-схему в
`games/tanks/src/config/` — файла там нет. В текущем виде вторая игра с
другой раскладкой невозможна без правки движка. Rust-сторона уже полностью
schema-driven (этапы 4a.2/4c) — доработка чисто JS-ная, байты не меняются.

## Решение

1. Новый `games/tanks/src/config/snapshot.js` — текущий `SNAPSHOT_KEYS`;
   подключить в `HostPlugin.gameConfig.snapshot`
   (`games/tanks/src/config/game.js`); добавить `'snapshot'` в
   `REQUIRED_GAME_CONFIG_PATHS` (`packages/engine/src/lib/gamePlugin.js`).
2. `lib/coreConfig.js`: `keys` — из `gameConfig.snapshot`
   (`version`/`port` остаются движковыми).
3. `lib/buildClientConfig.js`: схема едет клиенту в CONFIG_DATA (рядом с
   `prediction`) — устраняется скрытая связь «бандл клиента = хост».
4. `lib/clientCoreConfig.js`: `keys` — из CONFIG_DATA, не из импорта.
5. `client/main.js`: generic `reconstructHot` — ширина hot-записи и ключи
   из схемы CONFIG_DATA (2 служебных поля + число hot-полей класса),
   включая PREDICTED-хвост; `SNAPSHOT_KEYS`/`SNAPSHOT_KEYS_BY_ID` из
   `opcodes.js` удалить (остаются `ENGINE_API_VERSION`,
   `SNAPSHOT_FORMAT_VERSION`, `HOT_FLAGS`).
6. Фикстура miniGame получает собственную мини-схему — усиливает
   доказательство «второй игры».
7. `SNAPSHOT_FORMAT_VERSION` остаётся 3 (байтовая раскладка не меняется).

## Правки

- `games/tanks/src/config/snapshot.js` (новый), `games/tanks/src/config/game.js`
- `packages/engine/src/config/opcodes.js` (минус SNAPSHOT_KEYS/BY_ID)
- `packages/engine/src/lib/{gamePlugin,coreConfig,buildClientConfig,clientCoreConfig}.js`
- `packages/engine/src/client/main.js`
- фикстура miniGame (tests/fixtures)
- тесты: coreConfig/clientCoreConfig/gamePlugin/fixture
- docs: plugin-api, configuration, network (en+ru)

## Критерий готовности

`grep SNAPSHOT_KEYS packages/engine` — пусто; eslint/`npm test`/
`npm run core:test` зелёные; parity-набор без изменений; smoke двух вкладок.
