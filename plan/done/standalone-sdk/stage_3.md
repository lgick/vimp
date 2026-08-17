# Этап 3: Публикуемый Standalone SDK (`vimp-engine/standalone`) ✅ выполнен

_Цель: одна функция, которую вызывает репозиторий игры, чтобы получить
играбельный матч во вкладке; плюс расширение публикуемой поверхности пакета
`vimp-engine` до клиентской половины движка._

## Задача 3.1: `packages/engine/src/standalone/index.js` (новый)

```js
export async function startStandaloneGame({
  hostPlugin,                 // живой HostPlugin игры (обязателен)
  clientPlugin,               // живой ClientPlugin игры (обязателен)
  wasmUrl,                    // URL .wasm web-сборки ядра (обязателен)
  container = document.body,  // каркас интерфейса И канвасы; должен быть
                              // полноэкранным и position: relative
  assetsBase = '/',           // база ассетов игры (звуки: `${assetsBase}sounds/`)
  playerName,                 // задан → авто-вход без формы
  playerModel,                // и другие поля authSchema игры (см. auth)
  auth = {},                  // произвольные поля авторизации игры
  startupVotes = [],          // ответы на голосования, например [['teamChange','team1']]
  startupCommands = [],       // чат-команды после голосований, например ['/bot 4']
  room = {},                  // переопределения комнаты (map, maxPlayers, roundTime, friendlyFire, seed)
  devMode = false,            // room.isDevMode: рекордер + хостовый CONSOLE-лог
}) : Promise<{ stop(): void }>
```

Шаги:

1. `assertEngineApiCompatible` для обоих плагинов (`src/lib/gamePlugin.js`) —
   иначе несовпадение `ENGINE_API_VERSION` всплывёт где-то в середине
   хендшейка.
2. `ensureGameShell(container)` (Этап 2.2).
3. Синтетический манифест в памяти (мастера нет):
   ```js
   {
     id: hostPlugin.id, engineApi: hostPlugin.engineApi, version: 'dev',
     title: hostPlugin.gameConfig.title ?? hostPlugin.id,
     entries: { wasm: wasmUrl },        // client/host не нужны — плагины уже здесь
     assetsBase,
     maps: { version: 'dev', list: Object.keys(hostPlugin.gameConfig.maps) },
     roomDefaults: hostPlugin.gameConfig.roomDefaults,
   }
   ```
4. `setBootConfig({ mode: 'solo', manifest, clientPlugin, hostPlugin, container, room: { ...hostPlugin.gameConfig.roomDefaults, ...room, isDevMode: devMode }, autoAuth, startupVotes, startupCommands })`,
   где `autoAuth = playerName ? { name: playerName, model: playerModel, ...auth } : null`.
   `container` уезжает в boot-конфиг, потому что в него монтируются и каркас,
   и канвасы (`main.js:271-280`, точка ветвления 5 Этапа 2.5).
5. `await import('../client/main.js')` — дальше работает обычный клиент
   движка в solo-режиме (Этап 2.5).
6. Вернуть `{ stop() }` — снимает рендер-луп и гасит inline-хост
   (`InlineHostBridge.destroy()`).

Замечания:

- Отсутствующие звуки не ломают вход: `SoundManager.init` использует
  `Promise.allSettled` и только пишет ошибки в консоль
  (`src/client/SoundManager.js:108-116`).
- `bots: N` из предварительного ТЗ **не реализуем**: у движка нет понятия
  «бот». Эквивалент — игровая чат-команда в `startupCommands` (команда
  объявляется игрой в `hostPlugin.chatCommands`).
- **`startupVotes` — не удобство, а необходимость**: участник входит
  наблюдателем, а игровая команда спавна может требовать активной команды (у
  танков `botCommand` отбивает `/bot` наблюдателю). Выход из наблюдателей —
  ответ на initialVote: `['teamChange', '<team>']` на порт 7
  (`HostGame.parseVote:936`). Разбор порядка — Этап 2.5.
- Число scripted-участников в `startupCommands` должно влезать в
  `room.maxPlayers` (иначе игра отобьёт часть или порт-машина ответит
  `roomFull` живому игроку).

## Задача 3.2: `packages/engine/package.json` — публикуемая поверхность

```json
"exports": {
  "./lib/*": "./src/lib/*",
  "./config/*": "./src/config/*",
  "./host/*": "./src/host/*",
  "./client/*": "./src/client/*",
  "./devtools/*": "./src/devtools/*",
  "./standalone": "./src/standalone/index.js",
  "./style.css": "./src/client/style.css"
},
"files": ["src/lib", "src/config", "src/host", "src/client", "src/standalone",
          "src/devtools", "tests/fixtures", "bin"]
```

- `howler` переезжает `devDependencies` → `dependencies` (импортируется из
  `src/client/SoundManager.js`, то есть из публикуемого кода). `pixi.js` уже
  в `dependencies` — оставить там; в доках зафиксировать требование
  `resolve.dedupe: ['pixi.js']` на стороне репозитория игры (два экземпляра
  PixiJS = два реестра расширений и падение рендера).
- `src/client/_style.css` (529 строк, ноль ссылок в коде) в публикацию
  попадать не должен: по конвенции `_`-файлы не коммитятся вовсе — вынести
  вопрос владельцу и либо удалить, либо исключить из `files`.
  **Решено при исполнении**: файл не удалён (он вне git, решение за
  владельцем), а исключён из публикации отрицанием `"!src/client/_*"` в
  `files` — `npm pack --dry-run` его больше не содержит.
- `./network` из предварительного ТЗ не добавляем: барреля
  `src/client/network/index.js` нет, а `./client/*` уже отдаёт транспорты
  адресно.

## Задача 3.3: документация SDK

- Новая страница `docs/en/standalone.md` + `docs/ru/standalone.md`:
  сигнатура `startStandaloneGame`, минимальный `index.html`, готовый
  `vite.config.js` для репозитория игры (`resolve.dedupe`, `server.fs.allow`,
  `optimizeDeps.exclude: ['vimp-engine']`), откуда брать `wasmUrl`
  (`?url`-импорт web-сборки), как отдавать звуки в dev (`assetsBase`),
  требования к контейнеру (полный экран + `position: relative`), связка
  `startupVotes` → `startupCommands`, чем solo отличается от прода (хост в
  главном потоке, гостевой вход, нет мастера/рейтинга/эстафеты Worker'ов,
  WebRTC и module-worker'ы не требуются вовсе).
- Строки в `docs/en/README.md` и `docs/ru/README.md` (таблица разделов +
  «Where to start»).
- `docs/en/publishing.md` + `ru`: расширение `files`/`exports`, `howler` в
  `dependencies`, что теперь ломает потребителя SDK.
- `docs/ai/`: в раздел авторского цикла — упоминание, что игру можно гонять
  локально через `vimp-engine/standalone` без мастера.
- `CLAUDE.md` (корень): в таблицу «Area → page» добавить
  `src/standalone/` → `standalone.md`.

## Тесты

- `tests/standalone/startStandaloneGame.test.js` (happy-dom) —
  **уточнение при исполнении**: настоящий `src/client/main.js` в happy-dom не
  поднимается (`Application.init` требует WebGL, и упал бы внутри обработчика
  CONFIG_DATA, то есть до первого шага хендшейка), поэтому клиент подменён
  заглушкой, которая ведёт хендшейк по boot-конфигу, собранному SDK:
  на фикстуре `packages/engine/tests/fixtures/miniGame` (host+client плагины,
  ядро — чистый JS, wasm не нужен) — вызов SDK доводит хендшейк до
  `FIRST_SHOT_READY`, участник создан, `startupCommands` доехали до
  `HostGame.pushMessage`, каркас интерфейса собран в переданном контейнере.
- `vitest.config.js`: добавить `tests/standalone/**` в проект `engine-client`
  (happy-dom) — сейчас такого glob'а нет.
- `tests/scripts/packageSurface.test.js` (новый): каждая цель `exports`
  существует на диске; каждый путь `files` существует; ни один импорт из
  `src/client`/`src/standalone` не уходит за пределы публикуемых каталогов, и
  все bare-импорты этих каталогов присутствуют в `dependencies` (страховка
  ровно от истории с `howler` в `devDependencies`).

## Проверка

```bash
npx eslint . && npm test
npm pack --dry-run -w vimp-engine   # в архиве есть src/client и src/standalone
```

Ручной smoke делается на Этапе 6 (в репозитории игры).
