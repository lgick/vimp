# B5. Команда `/rank` ✅ выполнен

- Реализована как движковая команда в `CommandProcessor.js` (наряду с
  `/name`, `/timeleft`, `/mapname`) — rank общий для всех игр-плагинов, а
  `PlayerDataSync` уже живёт в движке (`HostGame`), а не в игре. Handler
  читает **локально закэшированный** rank текущего участника через
  `PlayerDataSync.getRank(gameId)` (подгружен на join, Этап B4 — без
  дополнительного сетевого запроса) и печатает его через новый системный код
  `RANK: 'c:1'` (группа `c`, рядом с `COMMANDS_NOT_FOUND: 'c:0'`).

## Критические файлы

- `packages/engine/src/host/meta/core/CommandProcessor.js` — регистрация
  `/rank`, зависимость `playerDataSync`.
- `packages/engine/src/host/HostGame.js` — `playerDataSync` передан в deps
  `CommandProcessor`.
- `packages/engine/src/host/meta/modules/chat/systemMessages.js` — код
  `RANK: 'c:1'`.
- Тесты: `tests/host/CommandProcessor.test.js`.
- Доки: `docs/en/gameplay.md`, `docs/ru/gameplay.md`, `docs/en/auth.md`,
  `docs/ru/auth.md`.

## Предусловие

B4 (rank должен уже подгружаться и храниться) — выполнено.
