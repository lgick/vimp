# План: Standalone SDK (браузер) + Dedicated-сервер (Node.js)

Новое направление. Итоговая версия предварительного ТЗ
([original-statement.md](original-statement.md)) — переписана под фактические
API движка (см. «Поправки к предварительному ТЗ» ниже).

## Контекст (что есть сейчас)

- Любой матч сегодня требует мастера: клиент на старте делает **top-level
  await** `GET /games/manifest.json` (`src/client/main.js:85-103`), безусловно
  поднимает сигнальный WS (`:137`, `:1828`), а вход в лобби открыт только при
  `welcomeReceived && authenticated` (`:1805-1826`) — то есть после OAuth в
  `packages/auth`.
- Хост-игрок в своей вкладке уже работает без сети: `HostController` →
  Worker → `LoopbackTransport` (`:1195-1391`). Но комната создаётся только
  кликом в лобби, а `host.worker.js:188` **безусловно** проверяет
  identity-JWT (`verifyClientToken` → `fetch('/auth/jwks')`).
- Авторитетная половина уже вынута в изоморфную сборку
  `src/lib/createHostRuntime.js` и запускается в Node headless-раннером
  (`bin/vimp-sim.js` → `src/devtools/ScenarioRunner.js`) — прецедент
  «хост в Node» есть, но порт-машина хендшейка (`buildPortMethods`,
  `onConnect/onClientMessage/onDisconnect`, отказ `roomFull`) целиком заперта
  в `src/host/host.worker.js:151-344`, и раннер её обходит вручную.
- `packages/engine` публикует только `src/lib`, `src/config`, `src/host`,
  `src/devtools`, `tests/fixtures`, `bin`. `src/client` не публикуется и не
  экспортируется — из репозитория игры движковый клиент недоступен.

## Цель

1. **Standalone Browser SDK** (`vimp-engine/standalone`): в репозитории игры
   `npm run dev` открывает вкладку с работающим матчем против ботов — без
   мастера, без OAuth, без экрана лобби.
2. **Dedicated Node.js сервер**: отдельный 24/7 сервер под одну игру, где
   симуляция крутится в процессе Node, а клиенты подключаются прямым
   WebSocket (без WebRTC и без вкладки хостера).

## Зафиксированные решения

1. **Хост в standalone крутится в главном потоке (inline)**, без Worker'а: SDK
   принимает живые объекты `hostPlugin`/`clientPlugin`. Причина — `hostPlugin`
   принципиально непередаваем в Worker (`postMessage` не несёт функции), а
   `createHostRuntime` уже умеет `options.loadHostPlugin`. Прод-путь (хост в
   Worker'е) не меняется; расхождение dev/prod осознанное и документируется.
2. **Клиент один на все режимы**: новый `src/client/boot.js` задаёт режим
   `lobby | solo | dedicated`, `main.js` ветвится в четырёх точках (источник
   манифеста, сигналинг, лобби-гейт, выбор транспорта). Параллельной копии
   бутстрапа не создаём — монолит `main.js` не рефакторим в фабрику.
3. **Dedicated — только гостевой вход**: движок сам доклеивает поле `name` в
   `AUTH_DATA` (валидация `isValidName` уже есть в `src/lib/validators.js`),
   `rank`/`state` не персистятся (offline-заглушка через существующий
   `hostOptions.playerDataFetch`). Центральный JWT на dedicated — возможное
   продолжение, в объём не входит.
4. **Терминология разведена**: *standalone* — браузерный SDK для репозитория
   игры; *dedicated* — Node-сервер. Env-переменная —
   `VIMP_DEDICATED_GAME` (а не `STANDALONE_GAME` из предварительного ТЗ).
5. **Одна комната на процесс** dedicated-сервера: мета-модули движка
   (`TimerManager`, `Panel`, `Stat`, `Vote`, `Chat`) — модульные синглтоны
   (см. `src/devtools/resetHostSingletons.js`). Мультирум = процесс на комнату.
6. **Ботов на dedicated-сервере в v1 нет**: `/bot` — команда *игры*
   (`hostPlugin.chatCommands`), а не движка, и вызывается участником. В
   standalone боты появляются как `startupCommands`, которые отправляет
   клиент-игрок после первого кадра — строго после `startupVotes`
   (выход из наблюдателей), иначе игра отобьёт команду.
7. **WebRTC и module-worker'ы в solo/dedicated не нужны вовсе**:
   `ensureWebRtcAvailable`/`supportsModuleWorker` вызываются только из
   lobby-путей (`main.js:1175`, `:1198`, `:1207`). Правок не требуется —
   фиксируем как приёмочное свойство (игра запускается при отключённом
   WebRTC).

## Этапы

| # | Этап | Статус |
| --- | --- | --- |
| 1 | [Изоморфная порт-машина хоста + стратегии идентичности](stage_1.md) | ✅ выполнен |
| 2 | [Клиентские режимы загрузки, DOM-каркас, WebSocketTransport](stage_2.md) | ✅ выполнен |
| 3 | [Публикуемый Standalone SDK (`vimp-engine/standalone`)](stage_3.md) | ✅ выполнен |
| 4 | [Dedicated Node.js сервер](stage_4.md) | ✅ выполнен |
| 5 | [Деплой, CI, конфигурация, документация](stage_5.md) | ✅ выполнен |
| R | [Правки по кодревью коммита 93ba930](review.md) | ✅ выполнен (кроме R5: `docker build` и ручные smoke) |
| R2 | [Правки по кодревью коммита 4c3bf30](review-2.md) | ✅ выполнен |
| R3 | [Правки по кодревью коммита affe6d7](review-3.md) | ✅ выполнен |
| 6 | [Доработки в репозитории игры (`vimp-tanks`)](stage_6.md) | не начат |

Порядок обязателен: 2 зависит от 1 (гостевая идентичность), 3 — от 2
(режимы загрузки), 4 — от 1 и 2 (порт-машина + WS-транспорт), 6 — от
публикации движка после 3 (или `npm link`). Этап R стоит перед 6 и перед
публикацией: два его блокера ломают именно standalone-контур, который Этап 6
и поднимает. Этап R2 — второй раунд ревью (блокеров нет, но R2-1 лежит ровно
на пути Этапа 6). Этап R3 — третий раунд: блокеров нет, главная правка
(ключ rate-limit'ов не из `X-Forwarded-For`) вышла за рамки направления и
задела мастер с auth-сервисом.

## Поправки к предварительному ТЗ

| Утверждение в ТЗ | Факт в коде |
| --- | --- |
| `createHostRuntime({ loadHostPlugin, room })` | `createHostRuntime(room, { loadHostPlugin, createSocketManager, hostOptions, overrideGameConfig })` (`src/lib/createHostRuntime.js:33`) |
| возвращает `hostGame` | возвращает `{ hostPlugin, game, seed, core, clientCfg, socketManager, host }` |
| `room.injectedHostPlugin` | `room` уезжает в Worker через `structuredClone` — функции не переносятся; инъекция только через `options.loadHostPlugin` |
| `room.game.wasmNodeUrl` | читается только `room.game.wasmUrl`; в Node это `file:`-URL node-сборки ядра (`entries.wasmNode`, `src/devtools/pluginLoader.js:114`) |
| `GameCatalog.loadHostPlugin(gameId)` | метода нет и не будет: мастер не исполняет код игры. Нужна отдельная node-загрузка пакета (`src/devtools/pluginLoader.js:loadFromManifest`) |
| `ws.send(\`[${port},${data}]\`)` | прод-фрейминг — `JSON.stringify([port, data])` (`host.worker.js:88`); шаблонная строка ломается на объектах |
| socket = `{ send, sendBinary, close }` c `send(port, data)` | `SocketManager.addUser` биндит все три: `send(port, data, reliable)`, `sendBinary(buffer, reliable)`, `close(code, data)` (`SocketManager.js:72-76`) |
| регистрация клиента через `hostGame.createUser(...)` | поток: `socketManager.addUser` → `sendConfig` → порт-машина → `host.createUser` (`host.worker.js:254-306`) |
| `PlayerDataSync` нужен новый флаг | флаг не нужен: `hostOptions.playerDataFetch` уже существует (`HostGame.js:88`), готовая заглушка — `emptyProfileFetch` (`ScenarioRunner.js:38-42`) |
| `bots: 4` в SDK | у движка нет понятия «бот» — только «scripted participant»; спавн идёт игровой чат-командой. У танков синтаксис `/bot <count> [team]`, то есть одна команда `'/bot 4'` |
| боты появятся сразу после входа | нет: `botCommand.handler` отбивает команду наблюдателю (`BOT_PLAYERS_ONLY`), а участник входит наблюдателем → SDK обязан сначала ответить на initialVote (`['teamChange','team1']`, порт 7) и только потом слать чат-команды |
| `ensureStandaloneDom` проверяет `#vote` | `#vote` создаётся в рантайме `view/Vote.js:33-79`, в разметке его нет |
| каркас DOM достаточно собрать в контейнере | канвасы создаются отдельно и безусловно уходят в `document.body` (`main.js:271-280`) — точку монтирования нужно брать из boot-конфига, а контейнер обязан быть полноэкранным и `position: relative` (`#panel`/`#stat`/`#vote` — `position: absolute`) |

## Release impact (заранее)

- **npm `vimp-engine` — minor** (`### Added`): новые экспорты `./standalone`,
  `./client/*`, `./style.css`; `src/client` + `src/standalone` попадают в
  `files`; `howler` переезжает из `devDependencies` в `dependencies`; новые
  публичные модули хоста (`PortMachine`, `identity`), `WebSocketTransport`,
  dedicated-раннер, `HostGame.destroy()`.
- **Крейт `vimp-engine-core` — не затрагивается** (Rust не меняется).
- **`ENGINE_API_VERSION` не меняется** → репозиторий игры *не обязан* следовать
  за движком; но чтобы получить `npm run dev`, `vimp-tanks` поднимает
  зависимость до новой minor-версии (Этап 6).
- Публикацию и правку `version` делает разработчик (`npm run release`).

## Критерии приёмки направления

1. `npm test` и `npx eslint .` зелёные после каждого этапа.
2. В репозитории игры `npm run dev` даёт играбельный матч с ботами без
   мастера и без ошибок в консоли (Этап 6).
3. Dedicated-сервер поднимается локально (`npm run dedicated`), браузер
   заходит без лобби и OAuth, отключение клиента не роняет симуляцию.
4. Регресс лобби-режима отсутствует: ручной smoke — создать комнату в
   лобби, зайти вторым клиентом (WebRTC), сменить карту голосованием.
5. `docs/en/` и `docs/ru/` обновлены попарно, `packages/engine/CHANGELOG.md`
   содержит `### Added` за это направление.
