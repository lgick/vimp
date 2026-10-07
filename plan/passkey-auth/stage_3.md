# Этап 3. auth: passkey (регистрация, вход) и смена ника

Зависит от этапов 1–2 и от результатов этапа 0 (версия
`@simplewebauthn/server`, ответ У1 — резерв шаблона ника). Только
`packages/auth/`, `tests/auth/`, корневой `package-lock.json`.

## Контекст

- Решение Р3: rpId — общий родительский домен лобби и auth
  (`config.webauthn.rpId`, env `VIMP_AUTH_WEBAUTHN_RP_ID`; прод —
  `vimp.lgick.space`, dev — `localhost`). Церемония WebAuthn идёт на
  странице лобби (origin мастера), проверка — в auth; ожидаемые origin'ы
  — `config.allowedOrigins`.
- «Авторизация» в смысле правил = привязка passkey: только после неё в БД
  появляется аккаунт (`users` + `webauthn_credentials` + `sessions`) и
  сохраняются rank/state. Регистрация превращает **текущего гостя** в
  участника с **тем же ником** (ник гостя уникален по построению, см.
  `lib/guestNick.js`).
- Turnstile на регистрации и входе по passkey **не** требуется (Р7); на
  смене ника — требуется.
- Состояние challenge между `options` и `verify` — без БД: подписанный
  challenge-токен (`lib/signedToken.js`, `typ: 'wa-reg' | 'wa-auth'`,
  `exp = now + config.webauthn.challengeTtlMs`) + память использованных
  challenge (защита от повтора в пределах одного процесса auth;
  ограничение «одна реплика» записать в доке).

## 3.1 Зависимость

`npm install -w @vimp/auth @simplewebauthn/server@^<мажор из этапа 0>`.
Проверить, что `package-lock.json` обновился, а Docker-образ auth
(`packages/auth/Dockerfile`) ставит зависимости воркспейса без правок
(прочитать Dockerfile).

## 3.2 Сервис passkey — `src/lib/passkeys.js` (новый)

Фабрика с инжекцией библиотеки (тесты подменяют функции
`@simplewebauthn/server`):

```js
export function createPasskeyService({ webauthn, config, signer, usedChallenges, now = Date.now, randomBytes })
// webauthn = { generateRegistrationOptions, verifyRegistrationResponse,
//              generateAuthenticationOptions, verifyAuthenticationResponse }
```

Методы:

1. `registrationOptions(guest)` (`guest` — разобранная сессия гостя
   `{ gid, nick }`): `userID = randomBytes(16)`;
   `generateRegistrationOptions({ rpName: config.webauthn.rpName, rpID:
config.webauthn.rpId, userName: guest.nick, userDisplayName: guest.nick,
userID, attestationType: 'none', authenticatorSelection: { residentKey:
'required', userVerification: 'preferred' }, timeout:
config.webauthn.timeoutMs })` → `{ options, challengeToken:
signer.sign({ typ: 'wa-reg', challenge: options.challenge, gid:
guest.gid, userId: base64url(userID), exp }) }`.
2. `verifyRegistration({ guest, challengeToken, response })`: токен
   (`typ`, `exp`, `gid === guest.gid`), challenge не использован
   (`usedChallenges.take(challenge)` — `false` → отказ);
   `verifyRegistrationResponse({ response, expectedChallenge,
expectedOrigin: config.allowedOrigins, expectedRPID: config.webauthn.rpId,
requireUserVerification: false })`; `verified !== true` → отказ;
   вернуть `{ credential: { id, publicKey, counter, transports }, webauthnUserId }`
   (поля — из `registrationInfo.credential` v13; для другой мажорной
   версии — по результату этапа 0).
3. `authenticationOptions()`: `generateAuthenticationOptions({ rpID,
userVerification: 'preferred', timeout })` (без `allowCredentials` —
   discoverable credential) → `{ options, challengeToken (typ 'wa-auth') }`.
4. `verifyAuthentication({ challengeToken, response, credential })`
   (`credential` из БД): токен, повтор, `verifyAuthenticationResponse({
response, expectedChallenge, expectedOrigin, expectedRPID, credential: {
id, publicKey, counter, transports }, requireUserVerification: false })`
   → `{ newCounter }`.

Отказы — класс `PasskeyError` с кодом (`invalidChallenge`,
`passkeyRejected`), маршруты переводят в 400/401.

`src/lib/usedChallenges.js`: `Map<challenge, expiresAt>`, `take(challenge,
expiresAt)` → `true` при первом использовании; уборка просроченных при
каждом вызове или раз в минуту (`setInterval(...).unref()`).

Тесты `tests/auth/passkeys.test.js`, `tests/auth/usedChallenges.test.js`.

## 3.3 Маршруты passkey — `src/routes/passkeys.js` (новый)

Фабрика `createPasskeyRoutes({ userRepo, passkeys, identity, signer, config })`
(`identity` — объект из `routes/identity.js`: `issueMemberToken`).

| Маршрут                                                                 | Поведение                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /passkey/register/options` `{ session }`                          | `parseSession`: гость → `registrationOptions`; участник → 409 `alreadyMember`; мусор → 401 `invalidSession`                                                                                                                                                                                                                                                                                         |
| `POST /passkey/register/verify` `{ session, challengeToken, response }` | гость → `verifyRegistration` → `secret = newMemberSecret()` → `userRepo.createMember({ nick: guest.nick, webauthnUserId, credential, sessionHash: hashSecret(secret) })` → `{ session: secret, token: issueMemberToken(user), nick, kind: 'member', id }`. `NickTakenError` → 409 `nickTaken` (по построению невозможно — залогировать как аномалию); `CredentialExistsError` → 409 `passkeyExists` |
| `POST /passkey/login/options`                                           | `authenticationOptions()`                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /passkey/login/verify` `{ challengeToken, response }`             | `findCredential(response.id)` → нет → 401 `unknownPasskey` (аккаунт удалён по неактивности или passkey чужой); `verifyAuthentication` → `updateCredentialUse(id, newCounter)` → `createSession` → `touchActivity` → `{ session, token, nick, kind: 'member', id }`                                                                                                                                  |

Лимитер `passkeyLimiter` 30/мин на IP на все четыре. Ответы
`PasskeyError` → 400 `invalidChallenge` / 401 `passkeyRejected`.
Тесты `tests/auth/passkeyRoutes.test.js` — с заглушками сервиса и
репозитория.

## 3.4 Смена ника — новый `POST /nick`

Только участник: `requireMember` (Bearer identity-JWT участника), тело
`{ nick, turnstileToken }`:

1. `isValidNick(nick)` → иначе 400 `invalidNick`;
2. `isReservedNick(nick)` (`lib/guestNick.js`) → 400 `nickReserved`;
3. `turnstile.verify(turnstileToken, clientIp(req))` → 403
   `turnstileFailed` / 503 `turnstileUnavailable`;
4. `userRepo.renameNick(req.user.id, nick)` → `NickTakenError` → 409
   `nickTaken`; `null` (аккаунт удалён) → 401 `sessionUnknown`;
5. `touchActivity`; ответ `{ token: issueMemberToken(user), nick }`.

Лимитер `nickLimiter` (5/мин) — тот же. Обработчик — в
`src/routes/identity.js` (`changeNick`) с тестами в
`tests/auth/identityRoutes.test.js`: каждая ветка, порядок проверок
(капча не тратится на заведомо неверный ник).

Правила ника не меняются («по текущим правилам VIMP»): `isValidNick`
(`^[a-zA-Z][\w #]{0,13}\w$`), уникальность без учёта регистра (индекс
`lower(nick)`), плюс новый резерв гостевого шаблона. Смена ника у
игрока в идущем матче не меняет его ник там до следующего входа (ник
матча — из JWT на момент входа); клиент разрешает смену только в лобби
(этап 6).

## 3.5 Подключение в `main.js`

`const passkeys = createPasskeyService({ webauthn: await import('@simplewebauthn/server') …, config, signer, usedChallenges: createUsedChallenges(), randomBytes: crypto.randomBytes })`
(обычный статический импорт — тоже годится); маршруты из 3.3 и
`POST /nick` из 3.4.

## 3.6 Документация (en и ru одинаково)

`docs/{en,ru}/auth.md`: новый раздел «## Passkeys» — rpId и origin'ы,
discoverable credential, регистрация = гость становится участником с тем
же ником, вход на новом устройстве, отсутствие Turnstile на passkey,
challenge-токены и ограничение «одна реплика» для защиты от повтора;
строки REST-таблицы `/passkey/*` и нового `POST /nick`; раздел о нике —
правила смены и резерв шаблона.

## Проверки

Prettier, eslint, `npx vitest run --reporter=dot`. Ручная проверка — на
этапе 6 (нужен клиент): регистрация passkey в Chrome (виртуальный
аутентификатор DevTools → WebAuthn), вход в другом профиле, смена ника.

## Критерии готовности

- Регистрация passkey создаёт аккаунт с ником гостя и сессию; вход по
  passkey выдаёт новую сессию; неизвестный passkey — 401 `unknownPasskey`.
- Повтор challenge отвергается; истёкший challenge-токен отвергается.
- Смена ника — только участнику, с Turnstile, с проверкой резерва и
  уникальности.
- Release impact: auth-сервис (выкатывается со всем планом).
