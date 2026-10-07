# Этап 5. Движок: мастер и хост — claims личности, гейты гостя, `TOKEN_REFRESH`, данные только участникам

Зависит от этапа 2 (формат identity-JWT: `kind`, `role`, `hvUntil`,
отрицательный `sub` гостя). Пакет `packages/engine/` (мастер, хост,
`lib/`, `config/wsports.js`), тесты `tests/`. Клиент лобби — этап 6
(здесь только то, что нужно мастеру и хосту, плюс порт, который клиент
начнёт слать на этапе 6).

## Контекст (проверено по коду 2026-10-07)

- `packages/engine/src/lib/jwt.js` `verifyIdentityToken(token, { jwks, issuer })`
  — RS256 через Web Crypto, `iss`, числовой `exp`, непустой `nick`;
  `decodeJwtPayload` — без проверки подписи. Изоморфен (мастер, Worker,
  браузер).
- Мастер, `packages/engine/src/master/SignalingServer.js`:
  - `_verifyToken(token)` (~1454) → `{ userId: Number(payload.sub), nick }`
    или `null` (тогда `error { code: 'invalidToken', re }`);
  - `_onRegisterHost` (~713): `promotionToken` → `_onPromotedRegister`
    (преемник, без гейта); иначе `_gameAvailable` → `_verifyToken` →
    `_registry.add(...)`;
  - `_onReclaimHost` (~832) — возврат комнаты хостом;
  - `_onJoinRoom` (~1115): `_verifyToken`; запись `room.members.get(memberId)`
    с чужим `userId` → `memberTaken`; иначе `joinMember(...)` →
    `room_joined`.
  - `userId` живёт в `RoomRegistry` (участники, `host.userId`,
    `demotedUsers`), `HostVoteManager` (голоса по аккаунту),
    `MigrationCoordinator` (`candidateUserId`, отчёты), `roomSecret.js`
    (`HMAC(roomId:epoch:userId)`). Отрицательный `userId` гостя всем им
    подходит без изменений (числа, `Map`/`Set`, строка в HMAC).
- `master/adminAuth.js` `createAdminAuth(jwksProxy, issuer)`: `identify`
  кладёт `req.user = { id, nick, role }`; `required` (админ), `optional`
  (`GET /servers`), `authenticated` (реестр игр: заявки).
- `master/lobby.js` — прокси `/auth/rank|state|placement(s)` с Bearer
  игрока; права проверяет auth (этап 2 сделал их member-only).
- Хост: `packages/engine/src/host/identity.js` `createTokenIdentity({ jwksUrl, issuer })`
  → `{ params: [], errorField: 'token', resolve(data) → nick }`;
  `createGuestIdentity` — ник из формы (standalone/dedicated).
  Подключение — `host/host.worker.js` (~163): `identity:
createTokenIdentity({ jwksUrl: lobbyConfig.auth.jwksUrl, issuer:
authClientConfig.issuer })`.
- `host/PortMachine.js`: `PORT_COUNT = 11`, `IN_GAME_PORTS`, `message()`
  молча игнорирует выключенный/неизвестный порт (`state.enabled[msg[0]]`)
  — старый Worker не сломается на новом порте; порт 1 (`AUTH_RESPONSE`)
  зовёт `this._identity.resolve(data, socketId)` и при ошибке шлёт
  `sendAuthResult(socketId, [{ name: errorField, error: 'invalid' }])`;
  `_resume` (RESUME_REQUEST) — тоже `resolve`, затем
  `this._host.resumeUser(gameId, socketId, data.token)`.
- `host/HostGame.js`: `createUser` → `this._playerDataSync.load(gameId, params.token)`
  (~1622); `resumeUser(gameId, socketId, token)` (~1981) — `user.token =
token; this._playerDataSync.attachToken(gameId, token)`;
  `getResumeTarget(gameId)` → `{ identityName, resumeKey, socketId }`;
  локальные токены эстафеты Worker'ов — `localTokens` (~962).
  `hostSocketId` loopback-игрока хоста — опция `HostGame` (`this._hostSocketId`,
  ~168), в лобби — `lobbyConfig.create.hostSocketId` (`'local'`,
  `config/lobby.js` ~495), в рантайм попадает через
  `lib/createHostRuntime.js` (~84, `room?.hostSocketId`).
- `host/meta/modules/PlayerDataSync.js`: `_makeEntry(token)`,
  `load(id, token)`, `flush`/`_sync`: `PUT rank` с 4xx (кроме 429) →
  `drop()` — очки теряются (~760); `PUT state` 4xx — только
  `console.warn`; `attachToken(id, token)` (~512) снимает `awaitingToken`;
  `flush` пропускает запись с `awaitingToken` (~628).
- Порты: `config/wsports.js` — `client` 0…10, реестр append-only, слепок
  `packages/engine/contract/surface.json` → раздел `ports`; новое имя —
  `npm run surface:update` (тест `tests/devtools/surface.test.js` иначе
  требует обновить слепок).
- Тесты подписывают токены сами в каждом файле: `tests/lib/jwt.test.js`,
  `tests/host/identity.test.js`, `tests/host/hostWorker.test.js`,
  `tests/master/SignalingServer.test.js`,
  `tests/master/MigrationCoordinator.test.js`,
  `tests/master/HostVoteManager.test.js`, `tests/master/adminAuth.test.js`,
  `tests/master/lobbyGamesRoutes.test.js` (поиск:
  `generateKeyPair|signToken|makeToken|createToken`). После этого этапа
  токен без `kind` недействителен — **во всех фабриках токенов этих тестов
  добавить `kind: 'member'`** (или гостя с `hvUntil`, где проверяется
  гость).

## 5.1 Claims личности — `packages/engine/src/lib/identityClaims.js` (новый)

Изоморфный (без Node-глобалов — его импортирует Worker):

```js
// claims identity-токена central auth-сервиса: кто это и прошёл ли гость
// проверку Turnstile. Токен без kind выдан старым сервисом — недействителен
export const identityKind = payload =>
  payload?.kind === 'member' || payload?.kind === 'guest' ? payload.kind : null;

export const isMember = payload => identityKind(payload) === 'member';

// участник проверен passkey; гость — пока не истёк hvUntil (секунды эпохи)
export function isHumanVerified(payload, nowMs = Date.now()) {
  if (isMember(payload)) {
    return true;
  }

  return Number.isFinite(payload?.hvUntil) && payload.hvUntil * 1000 > nowMs;
}
```

Тест `tests/lib/identityClaims.test.js`.

## 5.2 Мастер

`master/SignalingServer.js`:

1. `_verifyToken`: после `verifyIdentityToken` — `identityKind(payload)
=== null` → `return null`; вернуть
   `{ userId: Number(payload.sub), nick, kind, member: isMember(payload), human: isHumanVerified(payload, this._now()) }`.
2. `_onRegisterHost` (новая комната, не промоушен): сразу после проверки
   `identity === null` — `if (!identity.human) { this._sendError(session, 'humanCheckRequired', { re: 'register_host' }); return; }`.
   Комментарий: гость без Turnstile не создаёт серверы (правило Р7);
   `_onPromotedRegister` и `_onReclaimHost` — продолжение существующей
   комнаты, гейта нет.
3. `_onJoinRoom`: после проверки `memberTaken` —
   `if (!taken && !identity.human) → _sendError(session, 'humanCheckRequired', { re: 'join_room', roomId }); return;`
   (повторный `join_room` той же вкладки — после реконнекта сигналинга, с
   `taken.userId === identity.userId` — пропускается без проверки:
   идущий матч истечение `hvUntil` не прерывает).
4. Комментарий над `_verifyToken` и в шапке класса — про `kind`, гостей
   (отрицательный `userId`) и гейт.

`master/adminAuth.js`:

5. `identify`: `identityKind(payload) === null` → `null` (401);
   `req.user = { id, nick, role: payload.role ?? 'user', kind }`.
6. `authenticated` → только участник: гость — `403 { error: 'memberRequired' }`
   (заявки в реестр игр подаёт аккаунт с passkey: у гостя нет строки в
   БД для `author_user_id`). `required` → участник и `role === 'admin'`.
   `optional` — без изменений.

Тесты (сначала падающие):

- `tests/master/SignalingServer.test.js`: `register_host` гостя без
  `hvUntil` → `humanCheckRequired`; с будущим `hvUntil` и участника — ок;
  с истёкшим `hvUntil` → отказ; промоушен (`promotionToken`) и
  `reclaim_host` гостя без `hvUntil` — проходят; `join_room` нового гостя
  без `hvUntil` → `humanCheckRequired`, повторный `join_room` той же
  вкладки — проходит; токен без `kind` → `invalidToken`.
- `tests/master/adminAuth.test.js`: гость → 403 на `authenticated`,
  без `kind` → 401.
- Обновить фабрики токенов во всех файлах из «Контекста».

## 5.3 Хост: допуск в матч

`host/identity.js`:

1. `createTokenIdentity({ jwksUrl, issuer, exemptSocketId = null })`:
   общий приватный `verify(data)` → `payload` (подпись + `identityKind`,
   иначе `throw new Error('invalid')`); `resolve(data)` → `payload.nick`
   (как сейчас — им пользуются `RESUME_REQUEST` и `TOKEN_REFRESH`);
   новый `admit(data, socketId)` → `verify`; если
   `socketId !== exemptSocketId && !isHumanVerified(payload)` →
   `throw new Error('humanCheckRequired')`; вернуть `payload.nick`.
   Комментарий: собственный игрок хоста (loopback) не проверяется —
   вкладка уже прошла гейт мастера при `register_host`, а преемник
   занимает комнату по `promotionToken`.
2. `createGuestIdentity`: `admit = resolve` (то же поведение).

`host/PortMachine.js`, порт 1 (`AUTH_RESPONSE`): вместо
`this._identity.resolve(data, socketId)` —
`(this._identity.admit ?? this._identity.resolve).call(this._identity, data, socketId)`;
в `.catch(err => …)` код ошибки поля:
`err?.message === 'humanCheckRequired' ? 'humanCheckRequired' : 'invalid'`.
Клиент (этап 6) на `humanCheckRequired` проходит Turnstile и повторяет
вход.

`host/host.worker.js`: `createTokenIdentity({ …, exemptSocketId: <socketId loopback-игрока> })`
— взять то же значение, что получает `HostGame` как `hostSocketId`
(через рантайм, `room.hostSocketId`; если в месте создания его нет —
`lobbyConfig.create.hostSocketId`). Убедиться чтением кода, что у
преемника после промоушена loopback-сокет тот же.

Тесты: `tests/host/identity.test.js` — `admit` гостя без/с `hvUntil`,
участника, exempt-сокета, токена без `kind`; `tests/host/portMachine.test.js`
— код ошибки `humanCheckRequired` в
`AUTH_RESULT`.

## 5.4 Хост: rank/state только участникам

`host/meta/modules/PlayerDataSync.js`:

1. Запись получает признак `persistent`: `decodeJwtPayload(token)?.kind === 'member'`
   (токен уже проверен порт-машиной до `createUser`/`resumeUser`, поэтому
   разбор без подписи здесь безопасен — так и написать в комментарии).
   Для гостя (`persistent: false`): `load` не ходит на мастер (профиль —
   умолчания), `flush` ничего не шлёт, накопленные очки не копятся в
   `writes` (или копятся и молча отбрасываются — выбрать вариант, при
   котором `serialize`/`restore` контрольной точки не меняют формат).
   Правило: «ранг и скиллы без авторизации не сохраняются».
2. `attachToken(id, token)` пересчитывает `persistent` по новому токену
   только если запись ещё не участника (переход гость→участник посреди
   матча клиент не допускает — этап 6, — но код не должен падать).
3. **401 на запись не теряет очки.** `PUT rank` и `PUT state` с
   `res.status === 401` → не `drop()`, а `entry.awaitingToken = true` +
   `console.warn('[playerData] … 401 — waiting for a fresh token')`;
   запись остаётся открытой и уходит после `attachToken` (порт
   `TOKEN_REFRESH` или `RESUME_REQUEST`). Остальные 4xx — как сейчас.
   Срочный flush ухода участника с `awaitingToken` записать не может —
   это ограничение (в доку).

Тесты `tests/host/PlayerDataSync.test.js`:
гость — ни одного `fetch`; 401 на `PUT rank` → запись цела,
`awaitingToken`, после `attachToken` следующий `flush` её шлёт; 403/400 —
прежнее поведение.

## 5.5 Порт `TOKEN_REFRESH` (клиент → хост)

1. `config/wsports.js`, `client`: после `LEAVE: 10` —

   ```js
   // свежий identity-токен игрока (passkey-auth): клиент продлевает JWT
   // молча, а хост пишет rank/state его токеном — без порта долгий матч
   // писал бы истёкшим. Старый хост порт игнорирует
   TOKEN_REFRESH: 11,
   ```

   `npm run surface:update` — в `contract/surface.json` добавится
   `"TOKEN_REFRESH": 11` (только добавление).

2. `host/PortMachine.js`: `PC_TOKEN_REFRESH`, `PORT_COUNT = 12`, порт в
   `IN_GAME_PORTS`; обработчик 11 → `this._refreshToken(socketId, state, data)`:
   - `typeof data?.token === 'string'` и `state.gameId !== undefined`,
     иначе игнор;
   - не больше одной проверки в полёте на соединение
     (`state.refreshing`);
   - участник без токена (гостевая личность standalone/dedicated —
     `this._host.hasToken(gameId)` ложно) — игнор;
   - `this._identity.resolve({ token: data.token }, socketId)` → ник
     должен совпасть с `this._host.getIdentityName(gameId)` (новый
     геттер `HostGame`, тот же `identityName`, что в `getResumeTarget`),
     иначе игнор (+ `console.warn`);
   - `this._host.refreshToken(gameId, data.token)`.
3. `host/HostGame.js`: `hasToken(gameId)`, `getIdentityName(gameId)`,
   `refreshToken(gameId, token)` → `user.token = token;
this._playerDataSync.attachToken(gameId, token); return true`. Эстафета
   Worker'ов (`localTokens`) берёт `user.token` — свежий токен поедет
   сам.
4. Тесты `tests/host/portMachine.test.js`: успешное обновление;
   чужой ник; не строка; до входа в матч; второе сообщение во время
   проверки; `tests/host/HostGame.resume.test.js` (или новый `HostGame.token.test.js`) — `refreshToken` снимает
   `awaitingToken`. `tests/devtools/surface.test.js` — зелёный после
   `surface:update`.

Клиентская отправка — этап 6 (6.6).

## 5.6 Документация (en и ru одинаково)

- `docs/{en,ru}/master.md`: личность участника сигналинга — claims
  `kind`/`hvUntil`, гость с отрицательным `userId`; гейт
  `humanCheckRequired` (`register_host` новой комнаты, новое членство
  `join_room`), без гейта — промоушен, `reclaim_host`, повторный
  `join_room`; таблица ошибок сигналинга — `humanCheckRequired`;
  admin/реестр — только участник (`memberRequired`).
- `docs/{en,ru}/host.md`: стратегия личности (`admit`/`resolve`,
  exempt-сокет), гости без rank/state, 401 → ожидание токена,
  `TOKEN_REFRESH`.
- `docs/{en,ru}/network.md`: таблица клиентских портов — `11
TOKEN_REFRESH` (`{ token }`, когда шлётся, что делает хост, старый хост
  игнорирует); ошибка поля `humanCheckRequired` в `AUTH_RESULT`.
- `docs/{en,ru}/network.md` (раздел со всеми портами) — строка
  порта 11 (контрактный справочник плагина).

## 5.7 CHANGELOG — `packages/engine/CHANGELOG.md`, `## [Unreleased]`

- `### ⚠️ Breaking`: «The master and the host accept only identity tokens
  with a `kind` claim (`guest` | `member`) — tokens of the previous auth
  service are rejected; the lobby master needs the auth service from the
  same release (guest identities, passkeys).»
- `### Migration`: «Deploy the auth service of this release together with
  the masters (`docs/en/deployment.md` → rollout order); its database
  migration 017 deletes all existing accounts.»
- `### Added`: «Client port `TOKEN_REFRESH` (11): a player's renewed
  identity token reaches the host, which writes rank/state with it; an
  older host ignores the port.» и «Guests without a fresh Turnstile check
  (`hvUntil`) cannot create a room (`register_host`) or join one
  (`join_room`, host admission) — `humanCheckRequired`.»
- `### Changed`: «Rank and state are loaded and written only for players
  with an account (`kind: 'member'`); a `401` on a write keeps it until a
  fresh token arrives instead of dropping the points.»

## Проверки

Prettier, eslint, `npx vitest run --reporter=dot`; `npm run surface:update`
выполнен, `tests/devtools/surface.test.js` зелёный; `node
packages/engine/bin/vimp-contract.js --game <tanks dist>` — не нужен
(контракт плагина не менялся).

## Критерии готовности

- Токен без `kind` не принимает ни мастер, ни хост, ни admin-роуты.
- Гость без `hvUntil` не создаёт комнату и не входит в новую; идущий матч
  и миграция не требуют повторной проверки.
- Гости не загружают и не пишут rank/state; 401 не теряет очки участника.
- Порт 11 обновляет токен участника на хосте; старый хост его
  игнорирует.
- Release impact: npm `vimp-engine` — ⚠️ Breaking → minor; игры не
  затрагиваются (контракт плагина и `ENGINE_API_VERSION` прежние,
  `surface.json` только дополнен).
