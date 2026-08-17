# Техническое задание: Реализация Standalone SDK и Node.js Dedicated Server в `vimp-engine`

# 1. Цель

Доработать движок `vimp-engine`, добавив два независимых режима работы без нарушения существующей P2P-архитектуры:

1. **Standalone Browser SDK (`vimp-engine/standalone`)**: возможность запускать любую игру локально в её собственном репозитории (`npm run dev`) в одной вкладке браузера (Singleplayer / vs Bots) без развертывания мастер-сервера, без OAuth и без экрана лобби.
2. **Native Node.js Dedicated Server**: возможность запускать отдельный 24/7 сервер для конкретной игры на VPS (например, `tanks.lgick.dev`), где симуляция мира выполняется в Node.js, а клиенты подключаются по прямому WebSocket (без WebRTC и без привязки к браузеру хостера).

---

## 2. Архитектура изменений

```
packages/engine/
├── src/
│   ├── client/
│   │   └── network/
│   │       └── WebSocketTransport.js    <-- [НОВЫЙ] Прямой транспорт клиент <-> Dedicated сервер
│   ├── standalone/
│   │   ├── index.js                     <-- [НОВЫЙ] Точка входа Standalone SDK для репозиториев игр
│   │   └── standaloneDom.js             <-- [НОВЫЙ] Хелпер автоматической сборки DOM-контейнеров
│   ├── master/
│   │   ├── dedicated.js                 <-- [НОВЫЙ] Раннер выделенного Node.js сервера (120Hz)
│   │   └── main.js                      <-- [ИЗМЕНЕНИЕ] Ветвление: Lobby Master vs Dedicated Server
│   └── host/
│       ├── host.worker.js               <-- [ИЗМЕНЕНИЕ] Поддержка гостевого входа (без проверки JWT)
│       └── meta/modules/
│           └── PlayerDataSync.js        <-- [ИЗМЕНЕНИЕ] Graceful fallback при отсутствии Auth-сервера
└── package.json                         <-- [ИЗМЕНЕНИЕ] Экспорт ./standalone, ./network, ./dist/style.css
```

---

## 3. Пошаговый план реализации

---

### ЭТАП 1: Клиентский транспорт `WebSocketTransport`

_Цель: предоставить прозрачную замену `WebRtcManager` для подключения к Dedicated Node.js серверу по обычному WebSocket._

#### Задача 1.1: Создать `packages/engine/src/client/network/WebSocketTransport.js`

- **Интерфейс**: должен в точности повторять интерфейс `WebRtcManager` и `LoopbackTransport` на базе `Publisher`.
- **События `publisher`**:
  - `open` — соединение установлено.
  - `message` — входящее сообщение (строка JSON или `ArrayBuffer` бинарного кадра).
  - `close` — соединение закрыто.
- **Методы**:
  - `constructor(url)` — инициализирует `new WebSocket(url)`, ставит `ws.binaryType = 'arraybuffer'`.
  - `send(data)` — отправляет данные (текст или бинарный буфер), если сокет открыт.
  - `close()` — закрывает сокет.

---

### ЭТАП 2: Отвязка обязательной JWT-авторизации на хосте

_Цель: позволить запускать симуляцию без центрального сервиса `packages/auth` и без проверки JWT RS256._

#### Задача 2.1: Доработка `packages/engine/src/host/host.worker.js`

1. В сообщении `init(room)` читать флаг `room.authDisabled` (или `room.allowGuest`).
2. В обработчике порта 1 (`AUTH_RESPONSE`):
   - Если `authDisabled === true` или в данных пришел флаг `guest: true`:
     - Пропускать вызов `verifyClientToken(data.token)`.
     - Валидировать переданный ник `data.name` через регулярное выражение `NAME_REGEXP` (из `src/lib/validators.js`). Если не задан — использовать fallback `Player_${socketId.slice(0, 4)}`.
     - Сразу вызывать `host.createUser({ ...data, name: nick }, socketId, cb)`.
   - Если auth включен — сохранять текущее поведение с валидацией через `verifyIdentityToken`.

#### Задача 2.2: Безопасный fallback в `packages/engine/src/host/meta/modules/PlayerDataSync.js`

- Если URL авторизации (`rankUrl`/`stateUrl`) не заданы или запрос вернул сетевую ошибку:
  - Не писать ошибки в консоль в Standalone/Dedicated режиме.
  - Использовать `defaultState = {}` и `rank = 0`, держать их локально в памяти на время сессии.
  - Пропускать `flushAll()` при смене раундов без выброса исключений.

---

### ЭТАП 3: Standalone Browser SDK (`vimp-engine/standalone`)

_Цель: предоставить функцию `startStandaloneGame()`, которая позволяет запустить игру в одной вкладке браузера локально без мастера._

#### Задача 3.1: Создать `packages/engine/src/standalone/standaloneDom.js`

- Функция `ensureStandaloneDom(container)`:
  - Проверяет наличие стандартных контейнеров интерфейса движка (`#panel`, `#stat`, `#chat-box`, `#game-informer`, `#vote`).
  - Если контейнеры отсутствуют в переданном `container` (например, в пустом `index.html` игры), динамически создает базовый каркас DOM-элементов, чтобы модули `PanelView`, `StatView`, `ChatView` корректно инициализировались.

#### Задача 3.2: Создать `packages/engine/src/standalone/index.js`

- Экспортировать функцию:
  ```javascript
  export async function startStandaloneGame({
    hostPlugin,
    clientPlugin,
    wasmUrl,
    container = document.body,
    playerName = 'Player',
    playerModel = 'm1',
    bots = 4,
    roomConfig = {}
  })
  ```
- **Логика работы функции**:
  1. Вызывает `ensureStandaloneDom(container)`.
  2. Инициализирует Worker хоста через `HostController`, передавая:
     ```javascript
     {
       authDisabled: true,
       game: { hostEntryUrl: null, wasmUrl },
       injectedHostPlugin: hostPlugin,
       roomDefaults: hostPlugin.gameConfig.roomDefaults,
       ...roomConfig
     }
     ```
  3. Создает `LoopbackTransport(hostController)` для прямого обмена сообщениями внутри вкладки.
  4. Инициализирует клиентскую часть (`CanvasManager`, PixiJS `Application`, `SoundManager`, `Controls`, `BakingProvider`, `ClientCore`).
  5. Автоматически отправляет `CONFIG_READY` -> `AUTH_RESPONSE` (с именем `playerName` и `playerModel`) -> `MODULES_READY` -> `MAP_READY` -> `FIRST_SHOT_READY`.
  6. Если передан параметр `bots > 0`, после старта отправляет команду спавна ботов (или вызывает метод `scripted`-модуля).
  7. Запускает игровой цикл рендеринга `renderTick`.

#### Задача 3.3: Экспорт в `packages/engine/package.json`

Добавить в секцию `"exports"` и `"files"`:

```json
"exports": {
  ".": "./src/lib/index.js",
  "./standalone": "./src/standalone/index.js",
  "./network": "./src/client/network/index.js",
  "./style.css": "./src/client/style.css"
}
```

---

### ЭТАП 4: Native Node.js Dedicated Server

_Цель: запуск симуляции 120Hz в процессе Node.js на VPS с прямым подключением игроков по WebSocket._

#### Задача 4.1: Создать `packages/engine/src/master/dedicated.js`

- Реализовать функцию `startDedicatedServer({ gameId, port, domain })`:
  1. Поднять Express-сервер на указанном `port` для раздачи статики:
     - Раздавать собранный фронтенд движка `packages/engine/dist/`.
     - Раздавать статику игры `/games/:gameId` через `GameCatalog.getDistDir(gameId)`.
  2. Загрузить плагин игры через `GameCatalog.loadHostPlugin(gameId)`.
  3. Запустить симуляцию через `createHostRuntime`:
     ```javascript
     const { hostGame } = await createHostRuntime({
       loadHostPlugin: async () => plugin,
       room: {
         isDedicated: true,
         authDisabled: true,
         game: { id: gameId, wasmNodeUrl: plugin.manifest.entries.wasmNode },
         seed: Date.now(),
       },
     });
     ```
  4. Поднять `WebSocketServer({ server })`:
     - На каждое подключение `ws`:
       - Сгенерировать уникальный `socketId = crypto.randomUUID()`.
       - Создать Wire-сокет адаптер:
         ```javascript
         const socket = {
           send: (port, data) =>
             ws.send(typeof data === 'string' ? `[${port},${data}]` : data),
           sendBinary: buffer => ws.send(buffer),
           close: () => ws.close(),
         };
         ```
       - Зарегистрировать сокет в игре: `hostGame.createUser(...)` / подключить через `SocketManager`.
       - Маршрутизировать `ws.on('message', data => ...)` в `hostGame.updateKeys` / `pushMessage` / порты хоста.
       - При `ws.on('close')` вызывать `hostGame.removeUser(socketId)`.

#### Задача 4.2: Ветвление в `packages/engine/src/master/main.js`

- При старте проверять переменную окружения `process.env.STANDALONE_GAME`:
  ```javascript
  const standaloneGame = process.env.STANDALONE_GAME;

  if (standaloneGame) {
    console.log(
      `[Master] Starting in Dedicated Server mode for game: ${standaloneGame}`,
    );
    await startDedicatedServer({
      gameId: standaloneGame,
      port: process.env.VIMP_MASTER_PORT || 3002,
      domain: process.env.VIMP_DOMAIN || 'localhost',
    });
  } else {
    // Стандартный запуск Lobby Master Server (P2P сигналинг)
    startLobbyMasterServer();
  }
  ```

#### Задача 4.3: Авто-переключение транспорта на клиенте (`src/client/main.js`)

- Если клиент загружен с сервера, работающего в режиме Dedicated Server (передается флаг в HTML или через `GET /config`):
  - Пропускать экран `LobbyAuth` и экран списка серверов лобби.
  - Вместо `WebRtcManager` инициализировать `WebSocketTransport(`wss://${location.host}`)`.
  - Сразу переходить к экрану выбора модели/ввода ника и входу в игру.

---

### ЭТАП 5: Деплой и конфигурация CI/CD

#### Задача 5.1: Обновить `.github/workflows/deploy.yml`

В шаге `Deploy to ${{ matrix.domain }}` добавить передачу `STANDALONE_GAME`:

```yaml
env:
  STANDALONE_GAME: ${{ matrix.standaloneGame }}
script: |
  # ...
  {
    echo "NODE_ENV=production"
    echo "VIMP_DOMAIN=$VIMP_DOMAIN"
    if [ -n "$VIMP_AUTH_SERVICE_URL" ]; then
      echo "VIMP_AUTH_SERVICE_URL=$VIMP_AUTH_SERVICE_URL"
    fi
    if [ -n "$GAMES_MATRIX" ]; then
      echo "GAMES_MATRIX=$GAMES_MATRIX"
    fi
    if [ -n "$STANDALONE_GAME" ]; then
      echo "STANDALONE_GAME=$STANDALONE_GAME"
    fi
  } > .env.prod
```

---

## 4. Критерии приемки и тестирование

1. **Тест Standalone SDK (локальная симуляция без мастера)**:
   - Написать тест `tests/standalone/standaloneGame.test.js` с использованием встроенной фикстуры `miniGame`:
     - Проверить, что вызов `startStandaloneGame()` успешно инициализирует симуляцию, создает игрока, спавнит ботов и доставляет кадры в `LoopbackTransport`.
2. **Тест WebSocketTransport**:
   - Написать юнит-тест `tests/client/network/WebSocketTransport.test.js` на отправку строковых и бинарных данных, а также обработку событий `open/message/close`.
3. **Тест Dedicated Server**:
   - Написать интеграционный тест `tests/master/dedicatedServer.test.js`:
     - Запустить `startDedicatedServer` на тестовом порту с игрой-фикстурой `miniGame`.
     - Подключить тестовый WebSocket-клиент.
     - Проверить прохождение хэндшейка `CONFIG_DATA` -> `AUTH_RESPONSE` -> получение бинарного кадра `SHOT_DATA` (порт 5).
     - Проверить, что отключение клиента не останавливает симуляцию сервера.
4. **Проверка регрессий**:
   - Выполнить `npm test` — все существующие тесты движка, включая тесты лобби, сигналинга и фикстур, должны проходить на 100%.
   - Выполнить `npx eslint .` — отсутствие ошибок линтера.
