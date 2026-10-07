# Этап 6. Движок: клиент лобби — гость без логин-гейта, тихое продление, passkey, Turnstile, CSP

Зависит от этапов 2, 3, 5 и ответов **У2**, **У3** (этап 0). Пакет
`packages/engine/` (клиент, `config/`, `.github/deployment/install-system.sh`
— шаблон CSP Nginx), тесты `tests/`.

## Контекст (проверено по коду 2026-10-07)

- Логин лобби — триплет `client/components/{model,view,controller}/LobbyAuth.js`:
  модель разбирает `?token=`/`?pendingToken=`/`?authError=` OAuth-редиректа
  или поднимает JWT из `localStorage['vimpAuthToken']`
  (`config/authClient.js` `tokenStorageKey`), `submitNick` (`POST /nick`
  pending-токеном), `logout()`, `getToken()`, `getNick()`, `getRole()`,
  `getTokenExpiresAt()`; события `login-required`, `nick-required`,
  `authenticated`, `login-error`, `nick-error`. Вид прячет `#lobby` до
  входа (логин-гейт), показывает бейдж `#lobby-user` (ник, «Sign out»).
  Разметка — `client/views/includes/lobbyAuth.pug` (кнопки провайдеров,
  форма ника), `client/views/includes/lobby.pug` (бейдж: «Signed in as»,
  «My games», «Moderation», «Errors», «Sign out»), стили —
  `client/style.css` (`#lobby-auth*`, `#lobby-user*`, `.lobby-auth-provider`,
  строки ~489–515, ~764, ~868, ~1074–1110, ~1324).
- `config/authClient.js`: `serviceUrl` (из `VITE_AUTH_SERVICE_URL`;
  модуль импортирует и Node-мастер — `typeof import.meta.env` guard),
  `providers`, `tokenStorageKey`, `issuer: 'vimp-auth'`, `queryParams`,
  `elems`, `providerButtonClass`.
- `client/main.js` (только lobby-режим, ~2602–2725): `LobbyAuthModel`
  создаётся в `if (isLobbyMode)`; `maybeInitLobby()` → `route.boot()` после
  `welcome` сигналинга **и** `authenticated`; обработчик `authenticated`
  перевзводит `membership.armTokenCapsTimer()` и (у хоста)
  `handoff.armTokenHandoff()`, открывает лобби при повторном входе;
  `lobbyAuthCtrl.init(location.search)` + `history.replaceState`.
  Потребители токена (берут его замыканием `getToken()` — свежий токен
  подхватывают сами): `AUTH_RESPONSE` (~614), `fetchServers` (~2107),
  `fetchPlacement` (~2149), модели `Games`/`ClientReports` (~2465–2492),
  `session/Membership.js` (`join_room`), `session/HostRole.js`
  (`register_host`/`reclaim_host`), `network/SessionSupervisor.js`
  (`RESUME_REQUEST`). `lobbyView.setSelfNick(lobbyAuthModel.getNick())`
  (~2452) — ник «неизменен на сессию».
- Точки создания/входа: лобби «Create server» → `hostRole.createRoom(…)`
  (~2589); список серверов → `guest.connectToRoom(roomId)` (~2416);
  `RouteBoot` (ссылки, быстрая игра) получает `connectToRoom` и
  `createRoom` (~2616–2617).
- `AUTH_RESULT` с ошибкой: `socketMethods[PS_AUTH_RESULT]` (~626) отдаёт
  её `modules.auth.parseRes(err)` (форма игры) — ошибка поля `token`
  приходит массивом `[{ name: 'token', error }]`.
- `sending(port, data)` (~1314) → `supervisor?.send(...)`.
- Ошибка мастера `invalidToken`: `client/lib/signalingErrors.js`
  `decideInvalidToken` → `abandonPromotion` | `keepPlaying` |
  `logoutAndLeave` | `logout`; обработка — `client/session/GuestSession.js`
  (~301–330, `this._logout()`, текст «Your session has expired — please
  sign in again.»).
- Таймеры срока токена (остаются запасным путём, если продление не
  удалось): `session/Membership.js` `armTokenCapsTimer`
  (`canHost` гаснет за `migration.minTokenLifetimeMs`),
  `client/network/TokenHandoffTimer.js` (хост отдаёт роль за
  `migration.tokenHandoffLeadMs`).
- CSP: `config/master.js` `security.csp(authServiceUrl)` (~227–242) и
  его копия в Nginx — `.github/deployment/install-system.sh` (~404,
  `add_header Content-Security-Policy …`), совпадение проверяет
  `tests/config/csp-nginx-parity.test.js`.
- Тесты триплета: `tests/client/LobbyAuthModel.test.js`,
  `LobbyAuthView.test.js`, `LobbyAuthCtrl.test.js` (happy-dom).

## Поведение (зафиксировано)

- **Нет логин-гейта.** Первый визит: модель сама делает `POST /guest` и
  открывает лобби с ником гостя. Возврат: сессия из хранилища →
  `POST /token`. Сессия участника отвергнута (`sessionUnknown` — аккаунт
  удалён по неактивности или «Sign out» с другого устройства) → новый
  гость и уведомление в лобби «Your account was removed after 30 days of
  inactivity or signed out — you are playing as a guest».
- **Хранилище сессии** (У2): A — `localStorage['vimpSession']`; B —
  `sessionStorage['vimpSession']`. Старый ключ `vimpAuthToken` удаляется
  при загрузке. JWT в хранилище не пишется (живёт в памяти, 4 ч).
- **Тихое продление**: JWT продлевается по сессии за
  `authClient.renew.leadMs` (1 ч) до `exp`, при сбое сети/5xx/429 —
  повтор каждые `renew.retryMs` (60 с) до истечения; 401 → сессия
  потеряна (см. выше). После продления — событие `token-renewed`.
- **Личность вкладки неизменна, пока вкладка в комнате.** Сессия читается
  из хранилища только при загрузке; регистрация passkey, вход по passkey,
  смена ника, «Sign out» доступны **только в лобби** (бейдж — внутри
  `#lobby`, в комнате лобби скрыто). Потеря сессии посреди матча не
  меняет личность до возврата в лобби: токен действует до `exp`, P2P-матчу
  он не нужен.
- **Гейт «человек» для гостя** (У3 задаёт срок): перед созданием комнаты
  и переходом на сервер (список, ссылка, быстрая игра) — если
  `kind === 'guest'` и `hvUntil` JWT нет или истёк → оверлей Turnstile →
  `POST /guest/verify` → новые сессия и JWT → продолжение. Участник гейт
  не проходит. Ответы `humanCheckRequired` (мастер — `register_host`/
  `join_room`; хост — `AUTH_RESULT`) запускают тот же гейт и повтор.
- **Passkey в лобби** доступен, если `browserSupportsWebAuthn()` и
  `location.hostname` совпадает с `webauthnRpId` из `/client-config` или
  оканчивается на `'.' + webauthnRpId`; иначе кнопки неактивны с
  подсказкой «Passkeys are not available on this server».

## 6.1 Зависимость

`npm install -w vimp-engine @simplewebauthn/browser@^<мажор из этапа 0>`
(имя воркспейса — из `packages/engine/package.json` `name`). Попадает в
бандл лобби через Vite; Worker и `src/devtools/` его не импортируют.

## 6.2 Конфиг — `config/authClient.js`

Удалить `providers`, `tokenStorageKey`, `queryParams`,
`providerButtonClass` и элементы логин-гейта. Оставить `serviceUrl` (с
guard), `issuer`. Добавить:

```js
// сессия устройства ('g_…' гость / 'm_…' участник). У2: localStorage —
// ник гостя переживает визиты; sessionStorage — новый на каждый визит
sessionStorageKey: 'vimpSession',
sessionStorageArea: 'local', // 'local' | 'session' — по ответу У2
legacyTokenKey: 'vimpAuthToken', // удаляется при загрузке
// dev-логин (только сборка Vite dev): ?devSession=m_… → сессия участника
devSessionParam: 'devSession',
// тихое продление JWT: за leadMs до exp, повтор при сбое через retryMs
renew: { leadMs: 3600000, retryMs: 60000 },
// загрузчик Turnstile (тот же источник — в CSP)
turnstileScriptUrl: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
elems: { … }, // id новых элементов из 6.4
```

## 6.3 Модули без DOM (тест первым)

1. `client/lib/authApi.js` — `createAuthApi({ serviceUrl, fetchImpl = fetch })`
   → `clientConfig()`, `guest()`, `verifyHuman(session, turnstileToken)`,
   `token(session)`, `logout(session)`, `passkeyRegisterOptions(session)`,
   `passkeyRegisterVerify(session, challengeToken, response)`,
   `passkeyLoginOptions()`, `passkeyLoginVerify(challengeToken, response)`,
   `changeNick(token, nick, turnstileToken)`. Каждый — `POST`/`GET` JSON
   на `${serviceUrl}/…`; ответ `{ ok: true, data }` |
   `{ ok: false, status, error }` (`error` — поле `error` тела или
   `'network'`). Тест `tests/client/lib/authApi.test.js`.
2. `client/network/TokenRenewer.js` — по образцу
   `client/network/TokenHandoffTimer.js` (инжектируемые `timers`, `now`):
   `new TokenRenewer({ getExpiresAt, renew, onLost, config, timers, now })`;
   `arm()` — таймер на `expiresAt - leadMs` (не раньше «сейчас»); на
   срабатывании `renew()` → `'ok'` → `arm()` от нового `exp`; `'retry'` →
   повтор через `retryMs`, пока не истёк токен; `'lost'` → `onLost()`;
   `cancel()`. Тест `tests/client/network/TokenRenewer.test.js`.
3. `client/lib/turnstile.js` — `createTurnstile({ scriptUrl, document })`
   → `run(container, siteKey)` → `Promise<string>`: однократно
   подгружает скрипт, `window.turnstile.render(container, { sitekey,
callback, 'error-callback', 'expired-callback' })`, по завершении
   `turnstile.remove(widgetId)`; отказ/ошибка — reject с кодом.
   Тест — с подменённым `window.turnstile` (happy-dom), без сети.
4. `client/lib/passkey.js` — обёртка `@simplewebauthn/browser`:
   `isSupported()`, `rpAvailable(rpId, hostname)`,
   `register(optionsJSON)` → `startRegistration({ optionsJSON })`,
   `authenticate(optionsJSON)` → `startAuthentication({ optionsJSON })`;
   отмена пользователем (`NotAllowedError`) → код `'cancelled'`.
   Тест `rpAvailable` (точное совпадение, поддомен, чужой домен,
   «похожий» `evilvimp.lgick.space` — не подходит).

## 6.4 Триплет `LobbyAuth` — переписать

**Модель** (`components/model/LobbyAuth.js`, синглтон как сейчас):

- состояние: `session` (`{ kind, value }`), `token`, `nick`, `kind`,
  `id` (участник), `role`, `clientConfig`, `lostNotice`;
- `takeDevSession(search)` (синхронный) → `boolean`: только в dev
  (`import.meta.env.DEV`) берёт `?devSession=` как сессию участника и
  кладёт в хранилище; `true` — вызывающий чистит адрес
  (`history.replaceState`, как сейчас после OAuth);
- `boot()` (async): удалить `legacyTokenKey`; сессия из хранилища →
  `token()`; нет сессии или `sessionUnknown`/`invalidSession` → `guest()`;
  сеть/5xx → событие `auth-error` (`'unavailable'`) и повтор по кнопке
  «Retry»; успех → `authenticated { nick, kind, id, role }`;
  параллельно `clientConfig()`;
- `refresh()` → `'ok' | 'retry' | 'lost'` (для `TokenRenewer` и ошибок
  `invalidToken`); `'ok'` → `token-renewed { expiresAt }`;
- `ensureHuman()` → `Promise<boolean>`: участник или живой `hvUntil` →
  `true` сразу; иначе событие `human-check-required` и ожидание
  `submitHuman(turnstileToken)` / `cancelHuman()` из вида;
- `registerPasskey()`, `signInWithPasskey()` (новая сессия; сессия
  прежнего гостя просто забывается — в БД её нет), `changeNick(nick)`
  (нужен Turnstile — через тот же оверлей), `logout()` (участник:
  `POST /logout`, затем новый гость);
- геттеры как сейчас + `getKind()`, `isMember()`, `getUserId()`,
  `getHumanUntil()`; `getRole()` читает claim `role` JWT.
- **Запрет посреди матча:** `registerPasskey`, `signInWithPasskey`,
  `changeNick`, `logout` бросают/игнорируются, если вызывающий сообщил
  `setInRoom(true)` (main.js зовёт при входе/выходе из комнаты); сессия
  потеряна в комнате → `lostNotice` и новый гость при `setInRoom(false)`.

**Вид** (`components/view/LobbyAuth.js`) и разметка:

- `lobbyAuth.pug`: удалить `#lobby-auth-login`, `#lobby-auth-nick`;
  добавить оверлей проверки `#human-check` (контейнер виджета, текст
  «Quick check before you play», кнопка «Cancel»), диалог смены ника
  `#nick-dialog` (поле, правило, ошибки, «Save», «Cancel»), строку ошибки
  сервиса `#lobby-auth-error` с «Retry».
- `lobby.pug` бейдж `#lobby-user`: ник; ярлык «Guest — progress is not
  saved» или «Account #<id>»; кнопки гостя — «Save progress with a
  passkey», «Sign in with a passkey»; участника — «Change nick», «Sign
  out»; «My games» — только участнику; «Moderation», «Errors» — как
  сейчас по `role`; строка `lostNotice`; под кнопкой passkey — «Accounts
  inactive for 30 days are deleted».
- `#lobby` больше не скрывается до входа: показывается, как только
  модель выдала `authenticated` (до этого — спиннер «Loading…» в бейдже).
- Тексты ошибок (английские): `nickTaken` «This nick is already taken»,
  `invalidNick` «Invalid nick», `nickReserved` «This nick is reserved for
  guests», `turnstileFailed` «Check failed, try again»,
  `turnstileUnavailable`/`unavailable` «Service unavailable, try again
  later», `unknownPasskey` «No account for this passkey (it may have been
  deleted after 30 days of inactivity)», `cancelled` — без текста,
  `passkeyRejected` «Passkey was not accepted».
- Стили: удалить `#lobby-auth-login*`, `#lobby-auth-nick*`,
  `.lobby-auth-provider`; добавить для новых элементов в стиле карточек
  (`.card`) — следовать соседним правилам `style.css`.

**Контроллер**: события вида → методы модели (`registerPasskey`,
`signIn`, `changeNick`, `logout`, `retry`, `submitHuman`,
`cancelHuman`).

Тесты переписать: `tests/client/LobbyAuthModel.test.js` (первый визит →
`guest`, возврат → `token`, `sessionUnknown` → гость + `lostNotice`,
dev-сессия только в DEV, `ensureHuman` для гостя без/с `hvUntil` и
участника, запреты в комнате, `refresh` → `token-renewed`),
`LobbyAuthView.test.js` (бейдж гостя/участника, кнопки, оверлей),
`LobbyAuthCtrl.test.js`.

## 6.5 Подключение в `client/main.js`

1. `isLobbyMode`: модель создаётся с `createAuthApi`; вместо
   `lobbyAuthCtrl.init(location.search)` — `if (model.takeDevSession(location.search)) history.replaceState(…)`
   (чистка только query, hash маршрута остаётся — как сейчас), затем
   `model.boot()` (async); `maybeInitLobby()` по-прежнему ждёт `welcome`
   и `authenticated`.
2. `TokenRenewer` — `arm()` на `authenticated` и `token-renewed`;
   `onLost` → модель (сессия потеряна).
3. На `token-renewed`: `membership.armTokenCapsTimer()` и
   `membership.sendUpdate()` (если вкладка в комнате — вернуть мастеру
   `canHost`); у хоста `handoff.armTokenHandoff()` (таймер перечитает
   новый `exp`); если вкладка в матче (`sessionStarted` и есть
   `supervisor`) — `sending(PC_TOKEN_REFRESH, { token })`
   (`PC_TOKEN_REFRESH = wsports.client.TOKEN_REFRESH`).
4. `setInRoom(true/false)` — там, где `roomCtx.entered` меняется (найти
   единое место; если его нет — на входе в комнату и в обработчике
   возврата в лобби).
5. Гейт «человек»: обернуть `connectToRoom` и `createRoom`, передаваемые
   в `RouteBoot` (~2616), вызов `hostRole.createRoom` кнопки лобби
   (~2589) и `guest.connectToRoom` списка серверов (~2416):
   `ensureHuman().then(ok => ok && <действие>)`; отмена — ничего не
   делать (вкладка остаётся в лобби; для ссылки — открыть лобби).
6. `socketMethods[PS_AUTH_RESULT]`: если `err` — массив с
   `{ name: 'token', error: 'humanCheckRequired' }` → `ensureHuman({ force: true })`
   → при успехе повторить `sending(PC_AUTH_RESPONSE, { …lastAuthData, token: getToken() })`
   (сохранить последние данные формы при отправке ~614); при отмене —
   `leaveRoomWith('Check not passed.')`.
7. `fetchPlacement` — для гостя не ходить на мастер (вернуть `null`); в
   лобби вместо плашки места у гостя — «Save progress with a passkey to
   get a rank».
8. `lobbyView.setSelfNick(...)` — перевызвать на `authenticated` после
   смены личности (смена ника/вход по passkey в лобби).

## 6.6 Ошибки мастера: `invalidToken` и `humanCheckRequired`

`client/lib/signalingErrors.js` `decideInvalidToken` → варианты
`'abandonPromotion' | 'keepPlaying' | 'renewAndRetry'` («выйти из
аккаунта» больше нечем — личность восстанавливается сессией):

- `register_host` при промоушене → `abandonPromotion` (как сейчас);
- `join_room` в живом матче → `keepPlaying` + `refresh()` и повтор
  `join_room` (`membership.sendJoinRoom()`) при `'ok'`;
- иначе → `renewAndRetry`: `refresh()`; при `'ok'` повторить запрос по
  `msg.re` (`register_host`/`reclaim_host` → `hostRole.reRegister()`,
  `join_room` → `membership.sendJoinRoom()`); при `'lost'`/`'retry'` в
  комнате и `re` ∈ {`register_host`, `reclaim_host`} → прежний выход
  `leaveRoomWith('Your session has expired — please reload the page.')`,
  иначе `diagnostics.warn('engine.session.tokenExpired', …)`.

`GuestSession.handleSignalingError`: новый `case 'humanCheckRequired'` →
`ensureHuman({ force: true })` → повтор по `msg.re` (как выше); отмена →
для `register_host` — остаться в лобби, для `join_room` — выйти в лобби.
Зависимости `_logout` в `GuestSession` заменить на `_refreshIdentity` /
`_ensureHuman` (инжектируются из main.js).

Тесты: `tests/client/lib/signalingErrors.test.js` (все ветки),
`tests/client/session/GuestSession.test.js` (`humanCheckRequired`,
`renewAndRetry`).

## 6.7 CSP Turnstile

- `config/master.js` `security.csp`: в `script-src` добавить
  `https://challenges.cloudflare.com`; новая директива
  `frame-src https://challenges.cloudflare.com`. Комментарий над `csp` —
  абзац о Turnstile (скрипт и iframe виджета; `connect-src` auth уже
  есть — браузер ходит в auth прямым fetch).
- `.github/deployment/install-system.sh`: та же строка CSP в шаблоне
  Nginx (`add_header Content-Security-Policy …`).
- `tests/config/csp-nginx-parity.test.js` — зелёный; при необходимости
  дописать проверку наличия `challenges.cloudflare.com`.
- Хэш инлайнового importmap в `script-src` не меняется.

## 6.8 Документация (en и ru одинаково)

- `docs/{en,ru}/client.md`: таблица режимов (строка `lobby` — «catalog,
  signaling, OAuth» → «… guest identity / passkeys»); абзац о query после
  OAuth (`?token=`…) → `?devSession=` (dev); раздел LobbyAuth MVC
  (~854–872) — переписать; членство/`invalidToken` (~406–412) —
  `renewAndRetry`, `humanCheckRequired`; срок токена и роль хоста
  (~625–646, «is never renewed») — продление, `TokenRenewer`,
  `TOKEN_REFRESH`, запасные таймеры.
- `docs/{en,ru}/auth.md`, «## Lobby login (client)» — переписать целиком
  (гость, сессии, продление, гейт, passkey, смена ника, хранилище по У2).
- `docs/{en,ru}/configuration.md`: `config/authClient.js` (новые ключи),
  `security.csp` (Turnstile).
- `docs/{en,ru}/getting-started.md` — на этапе 8.

## 6.9 CHANGELOG — `packages/engine/CHANGELOG.md`, `## [Unreleased]`

- `### Changed`: «The lobby has no sign-in gate: a first visit gets a
  unique system-generated nick as a guest (nothing is stored); "Save
  progress with a passkey" turns the guest into an account (rank and
  state are saved only for accounts), "Sign in with a passkey" restores it
  on another device, and an account can change its nick (Turnstile). The
  identity token is renewed silently from the device session and reaches
  the host over `TOKEN_REFRESH`.»
- `### Added`: «Guests pass a Cloudflare Turnstile check before creating
  or joining a room (`humanCheckRequired`); the lobby CSP allows
  `https://challenges.cloudflare.com` (script and frame).»
- `### Removed`: «GitHub sign-in, the sign-in gate and the nick picker
  of the lobby (`authClient.providers`, `queryParams`, `tokenStorageKey`).»

## Проверки

Prettier, eslint, `npx vitest run --reporter=dot`, `npm run build:app`
(бандл собирается с `@simplewebauthn/browser`). Ручная (dev-контур, auth
этапов 1–4 запущен, тестовые ключи Turnstile): первый визит — ник гостя
без кликов; перезагрузка — тот же ник (У2 = A); «Create server» гостем —
виджет Turnstile, затем комната; «Save progress with a passkey»
(Chrome DevTools → WebAuthn → виртуальный аутентификатор) — «Account
#N»; второй профиль Chrome — «Sign in with a passkey» тем же
аутентификатором; «Change nick»; «Sign out» → новый гость.

## Критерии готовности

- Лобби открывается без логина; гость не создаёт строк в БД.
- Гость проходит Turnstile перед созданием/входом с заданной в У3
  частотой; участник — нет.
- Passkey: регистрация, вход, смена ника, выход — только в лобби.
- JWT продлевается молча; хост получает свежий токен; таймеры срока
  остаются запасным путём.
- CSP пропускает Turnstile; паритет с Nginx зелёный.
- Release impact: npm `vimp-engine` (записи под ⚠️ Breaking-релизом из
  этапа 5 → minor).
