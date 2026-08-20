# Переключение активной игры в лобби ✅ выполнен

## Контекст

На странице лобби игрок должен выбрать **любую** игру из каталога мастера и
поднять по ней сервер. Сегодня кнопка «Create server» блокируется, как только
выбранная игра отличается от загруженной при бутстрапе, потому что
`ClientPlugin` грузится ровно один раз (`main.js:141`). Это была осознанная
отложенная граница (`plan/done/lobby-page/`, комментарий в `hostGate.js`,
`docs/en/client.md`: «out of scope until a second game actually ships») —
вторая игра (`@vimp-games/snakes`) появилась, значит работу нужно доделать.

Та же первопричина ломает вход в чужую комнату: `connectToHost(hostId)` не
смотрит на `gameId` комнаты и подключается с плагином не той игры.

**Что упрощает задачу:** всё пер-игровое состояние (Factory, Pixi-приложения,
canvas'ы, clientCore) создаётся только на старте матча (обработчик
`CONFIG_DATA`), а после матча в lobby-режиме страница перезагружается
(`handleDisconnect` → `location.reload()`). Значит лобби всегда в чистом
до-матчевом состоянии, и переключение сводится к перепривязке бутстрапных
ссылок: манифест, плагин, `parts`, игровой CSS.

## Решения

- **Момент загрузки плагина** — при клике (создание сервера / вход в комнату),
  а не при смене селектора: просмотр каталога не качает лишние бандлы,
  ожидание прячется в уже асинхронный старт комнаты.
- **Join-путь чинится вместе** с host-путём — та же функция активации.
- **CHANGELOG**: `### Fixed` (patch). `hostGate.js` — внутренний модуль лобби,
  не часть контракта плагина.

## Шаги

### 1. Новый модуль `packages/engine/src/client/lib/gameActivator.js`

Фабрика `createGameActivator({ gamesById, loadClientPlugin })` возвращает
`activateGame(gameId)` → `{ manifest, plugin }`:

- манифест берётся из `gamesById`; неизвестный id — `Error`;
- загруженные плагины кешируются по `gameId` (кешируется промис — параллельные
  клики не дублируют импорт);
- **отказ из кеша вычищается**, чтобы повторный клик пробовал снова.

Вынесено из `main.js` ради юнит-теста — та же причина, по которой существовал
`hostGate.js` (`main.js` — бутстрап, тестами не покрывается).

### 2. `packages/engine/src/client/main.js`

- Хранить ссылку на `<style>` игрового CSS (сейчас узел создаётся и теряется) —
  helper `applyGameStyles(styles)`, создающий узел один раз и далее меняющий
  `textContent`.
- `bindActiveGame(manifest, plugin)` — присваивает `activeGameManifest`,
  `clientPlugin`, `parts` и зовёт `applyGameStyles`. Используется и в
  бутстрапе, и при переключении.
- Создать активатор рядом с `gamesById` (`~L1834`), только для lobby-режима:
  `boot.manifest`/`boot.clientPlugin` (solo, dedicated) плагин не перегружают.
- Обработчик `#lobby-host`: убрать гейт, стать `async` — прочитать значения
  формы синхронно, затем `await activateGame(gameSelect.value)`,
  `bindActiveGame(...)`, и только потом строить `overrides` из
  `roomDefaults` **выбранного** манифеста и звать `connectAsHost`.
  На время загрузки кнопка блокируется, при отказе — разблокируется.
- Обработчик `change` селектора: убрать управление `disabled`/`title`
  (остаются `populateRoomForm` + `gameChanged`).
- `connectToHost(hostId, gameId)` — перед установкой P2P активировать игру
  комнаты; при отказе остаться в лобби с сообщением.
- Ошибки показывать через `socketMethods[PS_TECH_INFORM_DATA]` — уже
  используемый в лобби канал (см. отказ «This browser cannot be a host»).
  Путь бутстрапа, затирающий `document.body`, для лобби неприемлем.
- Обновить устаревшие комментарии (`L83-89`).

### 3. `packages/engine/src/client/components/model/Lobby.js`

`join(hostId)` эмитит `{ hostId, gameId }` — `gameId` уже лежит в `_servers`.
Цепочка View → Ctrl → Model не меняется.

### 4. Удалить

`packages/engine/src/client/lib/hostGate.js` и
`tests/client/lib/hostGate.test.js`.

### 5. Тесты

- Новый `tests/client/lib/gameActivator.test.js`: успешная активация;
  неизвестный `gameId` → ошибка; повторный вызов не грузит второй раз;
  параллельные вызовы дают один импорт; отказ не кешируется (следующий вызов
  пробует снова).
- `tests/client/LobbyModel.test.js`: два теста на `join` — новый payload.

### 6. Документация и журнал

- `docs/en/client.md` + `docs/ru/client.md` — три места: bootstrap-заметка
  («активная игра остаётся `gamesManifest[0]`»), раздел про room-форму/game
  picker, упоминание join.
- `packages/engine/CHANGELOG.md` → `## [Unreleased]` → `### Fixed`.

## Проверка

- `npx eslint . && npm test` — зелёные.
- Ручной прогон: `npm run dev:auth` + `npm run dev`, вход через
  `/dev/login`, выбрать в селекторе не первую игру → «Create server»
  активна → комната поднимается по выбранной игре; из второй вкладки/профиля
  зайти в эту комнату из списка серверов.
