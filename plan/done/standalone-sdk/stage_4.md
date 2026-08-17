# Этап 4: Dedicated Node.js сервер ✅ выполнен

_Цель: отдельный процесс, который держит авторитетный матч одной игры в
Node и отдаёт браузерам собранный клиент движка; игроки подключаются прямым
WebSocket, лобби/OAuth/WebRTC не участвуют._

## Задача 4.1: развилка точки входа

- `packages/engine/src/master/lobby.js` (новый) — **весь нынешний**
  `src/master/main.js` без изменений логики.
- `packages/engine/src/master/main.js` — 10-строчный диспетчер:
  ```js
  if (process.env.VIMP_DEDICATED_GAME) {
    await import('../dedicated/main.js');
  } else {
    await import('./lobby.js');
  }
  ```
  Так `CMD ["node", "src/master/main.js"]` в `Dockerfile`, `npm start`,
  `npm run dev` и watch-списки nodemon остаются валидными.
- Env-переопределения (`src/master/lobby.js:38-64`) сейчас читаются **только
  при `NODE_ENV=production`**. Для dedicated нужны и в dev — вынести чтение
  env в `src/config/env.js` (или снять условие для dedicated-ветки), иначе
  локальный запуск молча проигнорирует настройки.

## Задача 4.2: `packages/engine/src/lib/loadGamePackage.js` (новый)

Вынести из `src/devtools/pluginLoader.js` (`loadFromManifest`, `:45-135`, +
`importDefault`/`stripBase`) загрузку игрового пакета в Node:

```js
export async function loadGamePackage(distDir)
// → { id, manifest, hostPlugin, clientPlugin, wasmUrl /* file: URL node-ядра */, distDir }
```

Сохранить существующие проверки: `engineApi` манифеста vs
`ENGINE_API_VERSION`, `assertPluginMatchesManifest` (устаревший `dist/`),
внятная ошибка при отсутствии `entries.wasmNode` («игра не собрала node-ядро,
`npm run core:build:node`»). `src/devtools/pluginLoader.js` импортирует
функцию оттуда — прод-сервер не должен зависеть от `src/devtools/`
(граница из `CLAUDE.md`).

## Задача 4.3: `packages/engine/src/dedicated/main.js` (новый)

`startDedicatedServer(opts)` — экспортируемая функция (тесты вызывают её
напрямую), плюс запуск из env в конце файла.

```js
startDedicatedServer({
  gameId,                    // VIMP_DEDICATED_GAME
  port = 3002,               // VIMP_MASTER_PORT
  host,                      // '0.0.0.0' в прод
  room = {},                 // VIMP_DEDICATED_ROOM (JSON): map/maxPlayers/roundTime/mapTime/friendlyFire
  loadGame,                  // инъекция для тестов (по умолчанию loadGamePackage)
})
```

Порядок:

1. **Пакет игры**: `loadGame()` по каталогу из
   `config.get('master:games')`/`GAMES_MATRIX` (тот же формат
   `{id, package, version}`, резолв `<nodeModules>/<package>/dist`) —
   переиспользуется `GameCatalog` для манифеста и карт
   (`getManifest`, `getMapCatalog`, `getDistDir`), а сам плагин грузит
   `loadGamePackage`.
2. **Симуляция**:
   ```js
   const runtime = await createHostRuntime(
     { game: { id, version: manifest.version, wasmUrl /* file: */ },
       maps: mapCatalog, seed: Date.now(), ...room },
     { loadHostPlugin: async () => hostPlugin,
       hostOptions: { playerDataFetch: offlinePlayerData(),
                      onMapChange: name => log(name) } },
   );
   const portMachine = new PortMachine({ ...runtime, identity: createGuestIdentity(), makeSocket });
   ```
3. **HTTP**: `express()` + security-заголовки (вынести middleware из
   `src/master/lobby.js:165-182` в `src/master/httpSecurity.js` и
   переиспользовать), маршруты:
   - `GET /config` → `{ mode: 'dedicated', gameId, gameVersion, wsPath: '/game' }`;
   - `GET /games/manifest.json` → массив из одного манифеста;
   - `GET /games/:id/manifest.json`, `GET /games/:id/maps/manifest.json`,
     `GET /games/:id/maps/:name` — как в лобби-мастере;
   - `app.use('/games/:id', express.static(distDir))`;
   - `ViteExpress.bind(app, server)` — отдаёт клиент движка (dev через Vite,
     прод — статику из `packages/engine/dist`).
   В `src/master/lobby.js` добавить симметричный `GET /config` →
   `{ mode: 'lobby' }`, чтобы у клиентского пробинга был один контракт.
4. **WebSocket**: `new WebSocketServer({ server, path: '/game' })`; на
   соединение:
   - `socketId = crypto.randomUUID()`;
   - адаптер сокета — **точная копия фрейминга** `makeWorkerSocket`:
     ```js
     send: (port, data) => ws.send(JSON.stringify([port, data])),
     sendBinary: (buffer, reliable) => { /* бэкпрешер, см. ниже */ ws.send(buffer); },
     close: (code, data) => { if (data !== undefined) ws.send(JSON.stringify([PS_TECH_INFORM_DATA, data])); ws.close(code); },
     ```
   - бэкпрешер: при `ws.bufferedAmount > 262144` дропать кадры с
     `reliable === false` (аналог `HostConnectionManager._deliver:139-153`),
     надёжные не дропать никогда;
   - `ws.on('message')` → `portMachine.message(socketId, data.toString())`;
     `ws.on('close')` → `portMachine.disconnect(socketId)`;
   - валидация `Origin` (как `SignalingServer.handleConnection:61`) и
     лимит соединений по `host.maxPlayers` уже обеспечивает порт-машина
     (`roomFull`, код 4006).
5. **Graceful shutdown** (`SIGTERM`/`SIGINT`): закрыть WS-соединения,
   `host.destroy()` (Этап 1.5), закрыть HTTP-сервер, выйти.

## Ограничения (документируются)

- **Одна комната на процесс**: мета-модули движка — модульные синглтоны
  (`src/devtools/resetHostSingletons.js`). Несколько комнат = несколько
  процессов/контейнеров.
- **Нет эстафеты Worker'ов**: деплой dedicated-сервера = перезапуск процесса
  и разрыв матча (в отличие от P2P-хоста). Фиксируется в доках.
- **Нет ботов на старте** (см. решение 6 в [README](README.md)): scripted-участников
  добавляют игроки игровой чат-командой.
- **Гостевые ники** не уникальны и не подтверждены (решение 3).
- Рейтинг серверов (`/like`) и `GET /servers` в dedicated-режиме
  отсутствуют — этот сервер в каталог лобби не попадает.

## Тесты

- `tests/dedicated/dedicatedServer.test.js` (проект `engine-node`; первый в
  репозитории тест, поднимающий express+ws — прецеденты по мокам:
  `tests/master/SignalingServer.test.js`, `tests/master/GameCatalog.test.js`):
  - `startDedicatedServer({ port: 0, loadGame: async () => fixtureGame })` на
    фикстуре `miniGame` (её ядро — JS, `wasmNode` не нужен);
  - реальный WS-клиент (`ws`) проходит хендшейк
    `CONFIG_DATA → CONFIG_READY → AUTH_DATA → AUTH_RESPONSE{name,model} → MAP_DATA → MAP_READY → FIRST_SHOT_DATA → FIRST_SHOT_READY` и получает бинарный кадр
    `SHOT_DATA`;
  - `GET /config` отдаёт `mode: 'dedicated'`;
  - отключение клиента не останавливает симуляцию: второй клиент входит и
    получает кадры;
  - `resetHostSingletons()` в `beforeEach`, `server.close()` в `afterEach`.
- `vitest.config.js`: добавить `tests/dedicated/**` в проект `engine-node`.
- `tests/lib/loadGamePackage.test.js` — перенос/адаптация существующих
  проверок `pluginLoader` (устаревший `dist/`, отсутствующий `wasmNode`).

## Документация и журнал

- Новая страница `docs/en/dedicated.md` + `docs/ru/dedicated.md`: назначение,
  схема (Node-процесс: express + ws + hostGame), env-переменные, запуск
  локально, отличия от P2P-хоста, ограничения выше.
- `docs/en/master.md` + `ru`: развилка точки входа (`main.js` → `lobby.js` /
  `dedicated/main.js`), новый `GET /config`.
- `docs/en/README.md` + `ru`: строка про `dedicated.md`.
- `CLAUDE.md`: в таблицу «Area → page» — `src/dedicated/` → `dedicated.md`;
  в «Architecture» — упоминание третьей точки входа.
- `CHANGELOG.md` → `### Added`.

## Проверка

```bash
npx eslint . && npm test
VIMP_DEDICATED_GAME=tanks npm run dedicated     # локальный запуск (Этап 5.3)
```
Ручной smoke: открыть `https://localhost:3000` (dev) — лобби и OAuth не
показываются, сразу форма ника/модели, вход, матч; отключить вкладку и
зайти снова — сервер жив, счёт сохранился.
