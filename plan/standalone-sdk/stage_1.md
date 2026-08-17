# Этап 1: Изоморфная порт-машина хоста + стратегии идентичности

_Цель: вынуть хендшейк-машину из `host.worker.js` в изоморфный модуль, чтобы
её могли переиспользовать inline-хост в браузере (Этап 3) и Node-сервер
(Этап 4), и сделать проверку личности игрока подключаемой стратегией
(JWT-лобби / гость)._

Без этого этапа появятся две-три копии порт-машины, которые разъедутся —
ровно та проблема, против которой в своё время был создан
`src/lib/createHostRuntime.js` (см. его шапку, строки 11-15).

## Задача 1.1: `packages/engine/src/host/PortMachine.js` (новый)

Переносится **без изменения поведения** из `host.worker.js`:
`buildPortMethods` (`:152-250`), реестр `clients` (`:39`), `onConnect`
(`:254-306`), `onClientMessage` (`:309-327`), `onDisconnect` (`:330-344`),
восстановление участников после эстафеты (`:263-285`), отказ `roomFull`
(`:289-294`).

```js
export default class PortMachine {
  /**
   * @param {Object} deps
   * @param {HostGame} deps.host
   * @param {SocketManager} deps.socketManager
   * @param {Object} deps.clientCfg      - конфиг клиента (порт 0)
   * @param {Object} deps.authSchema     - hostPlugin.authSchema
   * @param {Function} deps.makeSocket   - (socketId) => { send, sendBinary, close }
   * @param {Object} deps.identity       - стратегия идентичности (задача 1.2)
   */
  constructor({ host, socketManager, clientCfg, authSchema, makeSocket, identity })

  connect(socketId)             // бывший onConnect
  restore(socketId, gameId)     // порт-машина в игровом состоянии (эстафета)
  message(socketId, data)       // бывший onClientMessage (строка wire-кадра)
  disconnect(socketId)          // бывший onDisconnect
  has(socketId)
  get socketIds()               // для host.completeHandoff(new Set(...))
}
```

Требования:

- **Никаких `self`/`postMessage`/DOM внутри** — только `deps`. Всё, что знает
  про транспорт, приходит через `makeSocket`.
- Порт-1 (`AUTH_RESPONSE`) вызывает `validateAuth(data, params, validators)`,
  где `params = [...authSchema.params, ...identity.params]`, затем
  `identity.resolve(data, socketId)` вместо прямого `verifyClientToken`;
  остальная логика (гонка «клиент отключился, пока проверялся токен»,
  `sendTechInform('loading')`, `sendAuthResult(undefined)`, ошибка →
  `[{ name: 'token', error: 'invalid' }]`) сохраняется. Для гостевой стратегии
  ключ ошибки — имя поля, вернувшего отказ (`identity.errorField`, по
  умолчанию `'token'`).
- Порт-0 отправляет `sendAuthData(socketId, { elems, params: [...authSchema.params, ...identity.params], texts })` — то есть гостевое поле ника
  доезжает до формы клиента ровно тем же каналом, что игровые поля.

## Задача 1.2: `packages/engine/src/host/identity.js` (новый)

```js
export function createTokenIdentity({ jwksUrl, issuer })   // прод-лобби
export function createGuestIdentity({ fallbackPrefix = 'Player_' } = {})
```

Контракт стратегии: `{ params: Array, errorField: string, resolve(data, socketId): Promise<string> }` — возвращает проверенный ник или бросает.

- `createTokenIdentity` — перенос `getJwks()` (`host.worker.js:49-66`) и
  `verifyClientToken` (`:71-79`) как есть (кэш JWKS на время жизни
  экземпляра, сброс кэша при сбое), `params: []`, `errorField: 'token'`.
- `createGuestIdentity` — `params`:
  ```js
  [{
    name: 'name',
    value: '',
    options: {
      control: 'text', label: 'Name', validator: 'isValidName',
      storage: 'playerName', required: true, maxlength: 15,
    },
  }]
  ```
  (`options` — это дескриптор формы + валидатор, ровно как в
  `tests/fixtures/miniGame/config/auth.js`; `isValidName` уже зарегистрирован
  в `validationRules`, `src/lib/validators.js:13-15`, поэтому хост валидирует
  ник сам, без кода игры).
  `resolve` → `isValidName(data.name) ? data.name : ${fallbackPrefix}${socketId.slice(0, 4)}`; `errorField: 'name'`.
  Ограничение (принимается осознанно): гостевые ники не уникальны и не
  защищены от подмены — фиксируется в доках.

## Задача 1.3: `packages/engine/src/lib/offlinePlayerData.js` (новый)

Вынести `emptyProfileFetch` из `src/devtools/ScenarioRunner.js:38-42` в
`export function offlinePlayerData()` (возвращает `fetchImpl`, отдающий
`{ rank: 0, state: null }` со `ok: true`), `ScenarioRunner` импортирует
оттуда. Используется standalone и dedicated как
`hostOptions.playerDataFetch` — это убирает и сетевые вызовы, и
`console.warn` из `PlayerDataSync` (`:78`, `:87`, `:95-99`), и лишние
ретраи в `flush()` (`:147-149`). **Новый флаг в `PlayerDataSync` не нужен.**

## Задача 1.4: `host.worker.js` — тонкий адаптер

После рефакторинга в файле остаётся: `makeWorkerSocket` (`:82-120`),
`onInit` (создаёт `PortMachine` с `createTokenIdentity({ jwksUrl: lobbyConfig.auth.jwksUrl, issuer: authClientConfig.issuer })`), и `self.onmessage`-свитч, который дёргает
`portMachine.connect/message/disconnect`, `host.updateMaps`,
`host.setHostId`, handoff и debug. Поведение прод-лобби не меняется ни в
одном байте протокола.

## Задача 1.5: `HostGame.destroy()`

Публичный teardown: `stopGameTimers()` + `flushAll()` + снятие всех
участников. Нужен dedicated-серверу для graceful shutdown (Этап 4) и
тестам порт-машины; сейчас останов таймеров доступен только изнутри
(`HostGame.js:609`).

## Тесты

- `tests/host/portMachine.test.js` (новый; прецедент харнеса —
  `tests/host/fixtureHarness.js`, фикстура `miniGame`):
  - гостевой путь: `connect` → `CONFIG_DATA` → `CONFIG_READY` → `AUTH_DATA`
    (в `params` есть поле `name`) → `AUTH_RESPONSE {name, model}` →
    участник создан, `AUTH_RESULT === undefined`;
  - невалидный ник → участник создан под `Player_xxxx`;
  - токеновый путь: `resolve` бросает → `[{ name: 'token', error: 'invalid' }]`,
    участник не создан;
  - сообщение на выключенном порту игнорируется;
  - комната заполнена → `close(4006, 'roomFull')`, порт-машина не создана;
  - `disconnect` снимает участника и чистит `SocketManager`.
- `tests/host/identity.test.js` — гостевые `params`/`resolve`;
  токеновая стратегия с подставленным `fetch` (JWKS) и заранее подписанным
  RS256-токеном (прецедент — существующие тесты `lib/jwt`).
- Регресс: `tests/host/*`, `tests/devtools/*` (ScenarioRunner) остаются
  зелёными.

## Документация и журнал

- `docs/en/host.md` + `docs/ru/host.md`: раздел про порт-машину — теперь
  отдельный модуль; таблица стратегий идентичности; ссылка на
  `offlinePlayerData`.
- `packages/engine/CHANGELOG.md` → `### Added`: `PortMachine`,
  `createTokenIdentity`/`createGuestIdentity`, `offlinePlayerData`,
  `HostGame.destroy()`.

## Проверка

```bash
npx eslint . && npm test
npm run sim:check          # headless-прогон на фикстуре не сломан
```
