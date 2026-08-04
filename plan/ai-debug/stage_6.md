# Этап 6 — Браузерная половина ✅ выполнен

Записывает то, что headless не воспроизводит: реальный WebRTC, PixiJS, живой
ввод человека.

- **Рекордер в хосте**: под уже существующим флагом `gameConfig.isDevMode`
  (`config/hostDefaults.js:6`) `HostGame` пишет seed + joins + каждый
  `updateKeys`/`pushMessage`/`parseVote` с номером тика и
  последовательностью `dt` — ровно формат сценария этапа 2. Seed берётся из
  сообщения `ready` (добавлено в этапе 1).
- **Выгрузка**: Worker → главный поток → `POST /debug/report` на мастере,
  маршрут только в dev (гвард `isProduction`, `master/main.js:34`) → пишет в
  `.debug/`. Добавить `.debug/` в `.gitignore`.
- **`window.__vimpDebug`**: `dump()`, `startRecording()`, `stopRecording()`,
  `divergence()`. Читается через Chrome MCP (`javascript_tool`,
  `read_console_messages`) без участия человека.
- **Структурированный `console.log`** с префиксом `[vimp:debug]`.
- Порт 12 `CONSOLE` (зарезервирован и не используется: `config/wsports.js`,
  обработчик — `client/main.js:605`, `_PORT_CONSOLE` —
  `SocketManager.js:35`) оживляется для проброса хостовых логов клиенту —
  добавить `sendConsole`.

Новый тест: `tests/master/debugReport.test.js`.

---

## Что сделано

- **`host/DebugRecorder.js`** (новый, Worker-safe: только `clock`) — пишет
  живой матч в формат сценария этапа 2. Уже вошедшие участники превращаются
  в `join` нулевого тика, иначе реплей стартовал бы с пустой комнатой.
  Идентификаторы сценария свои (`p1`, `p2`, …): `gameId` переиспользуется
  после выхода и склеил бы двух разных людей в одну запись. Кап
  (`maxOps`/`maxDtSamples`) не молчит — переполнение уезжает в `meta`.
- **`HostGame`** получил точки записи (`_onShotTick`, `createUser`,
  `removeUser`, `updateKeys`, `pushMessage`, `parseVote`) и публичный
  отладочный API: `startRecording()`, `stopRecording()`, `isRecording`,
  `debugSnapshot()` (мета хоста + `debug_json` ядра этапа 4). Рекордер
  создаётся только при `isDevMode` — в проде это `null` и все точки
  вырождаются в `?.`.
- **Seed** доехал до рекордера: `createHostRuntime` передаёт его в
  `HostGame` (`opts.seed`), а в браузере он же виден в консоли из `ready`.
- **`isDevMode` комнаты**: `applyRoomOverrides` принимает `room.isDevMode`,
  `client/main.js` выставляет его из `import.meta.env.DEV` — прод-бандл
  ветку вырезает сборкой.
- **Транспорт запрос/ответ**: `host.worker.js` — сообщение `debug`
  (`startRecording`/`stopRecording`/`dump`) → `debug_result` с `requestId`;
  `HostController` — `startRecording()`/`stopRecording()`/`dump()` на
  промисах. Висящих промисов не остаётся: `destroy()` и пауза эстафеты
  отклоняют накопленные запросы.
- **`window.__vimpDebug`** — `client/debug.js`: `dump()`,
  `startRecording()`, `stopRecording()` (по умолчанию сразу выгружает),
  `divergence()` (вычерпывает детектор этапа 5 из `ClientCore`), `save()`.
  Молчаливого отказа нет: «вкладка не хостит комнату» — исключение с
  текстом, а не `null`.
- **Выгрузка**: `POST /debug/report` → `master/DebugReportStore.js` пишет в
  `.debug/` рядом с отчётами headless-прогона. Маршрут поднимается только
  при `!isProduction`, вид выгрузки — закрытый список (`scenario`/`dump`/
  `divergence`), лимит тела 8 MB собственным парсером (`express.json` по
  умолчанию режет на 100 kb, а сценарий матча заведомо больше).
- **Порт 12 `CONSOLE` ожил**: `SocketManager.sendConsole`, хост шлёт им
  события рекордера, клиент печатает их как `[vimp:debug][host] …`.
  `RecordingSocketManager` дополнен `sendConsole` — иначе фикстурные тесты
  и runner не видели бы этот канал.

## Отклонения и находки

1. **Запись → прогон замкнута тестом, а не декларацией.**
   `tests/devtools/replayRecording.test.js` записывает матч фикстурным
   хостом и тут же прогоняет результат через `runScenario` — контракт «файл
   из браузера принимается `npm run sim:replay` без правок» проверяется, а
   не подразумевается.
2. **`express.json()` пришлось подвинуть ниже** debug-маршрута: глобальный
   парсер уже отработал бы со своими 100 kb и вернул 413 раньше, чем
   маршрут со своим лимитом получил бы управление.

## Тесты ✅ выполнен

- `tests/master/debugReport.test.js` (5)
- `tests/host/DebugRecorder.test.js` (11) — включая приём записанного
  сценария через `parseScenario` и отсутствие рекордера без dev-режима
- `tests/client/debug.test.js` (9)
- `tests/client/network/HostControllerDebug.test.js` (4)
- `tests/devtools/replayRecording.test.js` (1)

## Проверка ✅ выполнен

- `npx eslint .` — зелёный.
- `npm test` — 98 файлов, 983 теста, зелёные.
- `npm run sim:check` — код возврата 0, контур на фикстуре цел.
- Браузерный smoke (две вкладки, `npm run dev`) — вручную, не выполнялся.

Документация (`docs/en|ru`, `docs/ai/`) — этап 7 по плану.
