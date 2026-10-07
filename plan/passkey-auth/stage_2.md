# Этап 2. auth: сессии гостя и участника, JWT с `kind`, Turnstile, удаление OAuth, админы по id

Зависит от этапа 1 и от ответа **У3** (этап 0). Только `packages/auth/`
и `tests/auth/`.

## Контекст (проверено по коду 2026-10-07)

- `packages/auth/src/main.js` (1101 строка — читать фрагментами):
  проверки прода `VIMP_AUTH_PUBLIC_URL`, `VIMP_AUTH_ALLOWED_ORIGINS`,
  `VIMP_AUTH_STATE_SECRET`, `VIMP_AUTH_GITHUB_CLIENT_ID/_SECRET` (строки
  ~59–114); `callbackUrl` (~151); `isAllowedReturnUrl` (~161);
  лимитеры `nickLimiter` 5/мин, `oauthStartLimiter` 20/мин, `gamesLimiter`,
  `clientReportsLimiter` (~171–178), `byIp(limiter)` (~182);
  `requireAuth` (~185, кладёт `req.user = { id: Number(sub), nick }`,
  отказ `401 invalidToken`, pending → `401 nickRequired`);
  `issueIdentityToken(user)` (~212, синхронизирует роль из окружения);
  `requireAdmin` (~231, роль из БД `getRole`); `isAdminUser` (~250);
  CORS только для `/nick` (~307–323); dev-логин (~328–338);
  `GET /oauth/:provider/start` (~341), `/callback` (~369), `POST /nick`
  (~421, pending → identity); реестр игр `GET /games`, `/games/mine`,
  `POST /games`, `POST /games/:id/version`, `DELETE /games/:id` (~479–657,
  все кроме каталога — `requireAuth`); `/admin/*` (`requireAdmin`);
  `GET /jwks` (~845); `GET /leaderboard` (публичный); `GET /placement`,
  `GET/PUT /rank`, `GET/PUT /state` (`requireAuth`); `warnOnFreeAdminNicks`
  и dev-баннер при старте (~1035–1101).
- `src/lib/jwt.js`: `signIdentityToken({ sub, nick, role })` (RS256,
  `kid`, `iss: 'vimp-auth'`, `expiresIn: config.jwt.expiresIn` = `'4h'`),
  `signPendingToken`, `verifyToken`, `getJwks`.
- `src/config/auth.js`: `parseAdminNicks`, `parseAdminIdentities`,
  `publicUrl`, `allowedOrigins` (dev `['https://localhost:3002']`), `jwt`
  (`pendingExpiresIn`), `oauth.github`, `admin { nicks, identities }`.
- `src/lib/adminRights.js` (`isEnvAdmin` по `provider:uid` или нику),
  `src/oauth/{index,github}.js`, `src/lib/oauthState.js`,
  `src/devLogin.js` (фабрика обработчика с инжекцией зависимостей —
  образец для новых маршрутов).
- Движок проверяет identity-JWT сам (`packages/engine/src/lib/jwt.js`
  `verifyIdentityToken`: RS256, `iss`, числовой `exp`, непустой `nick`) —
  дополнительные claims ему не мешают. Гейты по `kind`/`hvUntil` в движке
  — этап 5.

## Модель личности (зафиксировано)

- **Identity-JWT** (RS256, тот же ключ, `/jwks` без изменений):
  `sub`, `nick`, `kind: 'guest' | 'member'`, `role` (`'admin'` для
  участника из `VIMP_ADMIN_USER_IDS`, иначе `'user'`), `hvUntil`
  (секунды эпохи, только гость, прошедший Turnstile и не истёкший),
  `iss`, `iat`, `exp` (`config.jwt.expiresIn`, 4 ч). Участник:
  `sub = String(users.id)`; гость: `sub = String(-gid)` (отрицательный:
  id участников положительные, мастер продолжает делать `Number(sub)`).
  Токен **без `kind`** (выданный старым сервисом) — недействителен
  везде.
- **Сессия гостя** — строка `'g_' + signer.sign({ typ: 'guest', gid,
nick, hvUntil? })` (`lib/signedToken.js`, HMAC, секрет
  `VIMP_AUTH_STATE_SECRET`). В БД её нет; срока нет. HMAC, а не RS256, —
  намеренно: бессрочный токен, подписанный ключом `/jwks`, мастер и хост
  приняли бы за identity-JWT.
- **Сессия участника** — `'m_' + base64url(randomBytes(32))`; в БД —
  `sha256` hex (`sessions.secret_hash`). Срока нет; уходит по «Sign out»
  или вместе с аккаунтом.

## 2.1 Конфиг — `src/config/auth.js`

1. Удалить `parseAdminNicks`, `parseAdminIdentities`, `publicUrl`,
   `oauth`, `jwt.pendingExpiresIn`, `admin.nicks`, `admin.identities`.
2. Добавить (экспортируемая функция — ради юнит-теста, как раньше):

   ```js
   // VIMP_ADMIN_USER_IDS="17,42": id аккаунтов с passkey. Ник менять можно,
   // поэтому права привязаны к id, а не к нику
   export const parseAdminUserIds = raw =>
     String(raw || '')
       .split(',')
       .map(item => Number(item.trim()))
       .filter(id => Number.isSafeInteger(id) && id > 0);
   ```

   `admin: { userIds: parseAdminUserIds(process.env.VIMP_ADMIN_USER_IDS) }`.

3. `session: { secret: process.env.VIMP_AUTH_STATE_SECRET || 'dev-session-secret', touchIntervalMs: 3600000 }`
   — секрет подписи гостевых сессий и challenge-токенов (имя переменной
   прежнее, чтобы не трогать `.env.prod` прода; смысл — в комментарии).
4. `turnstile`:

   ```js
   turnstile: {
     // тестовые ключи Cloudflare «всегда проходит» — dev и тесты; в проде
     // обязательны свои (проверка при старте)
     siteKey: process.env.VIMP_AUTH_TURNSTILE_SITE_KEY || '1x00000000000000000000AA',
     secret: process.env.VIMP_AUTH_TURNSTILE_SECRET || '1x0000000000000000000000000000000AA',
     verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
     timeoutMs: 5000,
     // У3: сколько гость считается проверенным после Turnstile; 0 — бессрочно
     humanTtlMs: 86400000,
   },
   ```

   Значения ключей — сверить с результатом этапа 0 (0.2.2); `humanTtlMs` —
   по ответу У3 (A — `86400000`, B — `300000`, C — `0`).

5. `webauthn: { rpId: process.env.VIMP_AUTH_WEBAUTHN_RP_ID || 'localhost', rpName: 'VIMP', timeoutMs: 60000, challengeTtlMs: 300000 }`
   (использует этап 3; объявить здесь, чтобы проверка прода была в одном
   месте).
6. `jwt`: поправить комментарий над `expiresIn` (4 ч — срок короткого
   токена; клиент продлевает его молча по сессии, этап 6).
7. Комментарий над `allowedOrigins`: origin'ы мастеров — CORS
   браузерных ручек, ожидаемые origin'ы WebAuthn, допустимые `hostname`
   ответа Turnstile, `returnUrl` dev-логина.

## 2.2 JWT — `src/lib/jwt.js`

- `signIdentityToken({ sub, nick, kind, role, hvUntil })`: `kind`
  обязателен (`'guest' | 'member'`, иначе `throw`); `role` пишется только
  участнику (`role ?? 'user'`); `hvUntil` — только если число. Удалить
  `signPendingToken`.
- `verifyToken(token)`: после `jwt.verify` проверить
  `['guest','member'].includes(payload.kind)`, иначе `throw` — токены
  старого сервиса отвергаются.
- Тесты `tests/auth/jwt.test.js` переписать: claims гостя/участника, отказ
  без `kind`, `hvUntil` пишется только числом.

## 2.3 Сессии — `src/lib/sessions.js` (новый)

```js
export const GUEST_PREFIX = 'g_';
export const MEMBER_PREFIX = 'm_';
export function newMemberSecret() { … }          // 'm_' + base64url(32 байта)
export function hashSecret(secret) { … }         // sha256 hex (64 символа)
export function guestSession(signer, { gid, nick, hvUntil }) { … }
export function parseSession(value, signer) { … }
// → { kind: 'member', secret } | { kind: 'guest', gid, nick, hvUntil } | null
```

`parseSession` не бросает: мусор, чужая подпись, неизвестный префикс —
`null`. Тесты `tests/auth/sessions.test.js`.

## 2.4 Turnstile — `src/lib/turnstile.js` (новый)

```js
/**
 * @param {Object} deps
 * @param {string} deps.secret
 * @param {string} deps.verifyUrl
 * @param {number} deps.timeoutMs
 * @param {string[]|null} deps.allowedHostnames - null — не сверять (dev)
 * @param {Function} [deps.fetchImpl]
 */
export function createTurnstileVerifier(deps) {
  return {
    // → { ok: true } | { ok: false, error: 'turnstileFailed' | 'turnstileUnavailable' }
    async verify(token, remoteIp) { … },
  };
}
```

- POST `application/x-www-form-urlencoded`: `secret`, `response`,
  `remoteip` (если есть); таймаут через `AbortSignal.timeout(timeoutMs)`.
- Сеть/таймаут/не-2xx → `turnstileUnavailable` (маршрут отвечает 503);
  `success !== true` или `hostname` не из `allowedHostnames` →
  `turnstileFailed` (403). Пустой/не строковый `token` → `turnstileFailed`
  без похода в сеть.
- `allowedHostnames` = hostname'ы `config.allowedOrigins` **в проде**;
  вне прода — `null` (тестовые ключи отвечают своим hostname).

Тесты `tests/auth/turnstile.test.js` с подменённым `fetchImpl`.

## 2.5 CORS браузерных ручек — `src/lib/cors.js` (новый)

Вынести и обобщить middleware `/nick` (`main.js` ~307–323): фабрика
`createCors({ allowedOrigins })` для путей `/client-config`, `/guest`,
`/guest/verify`, `/token`, `/logout`, `/nick`, `/passkey/*`;
`Access-Control-Allow-Origin` = эхо `Origin` из списка, `Vary: Origin`,
методы `GET, POST, OPTIONS`, заголовки `authorization, content-type`;
`OPTIONS` → 204. Остальные ручки по-прежнему ходят через прокси мастера и
CORS не получают. Тест `tests/auth/cors.test.js`.

## 2.6 Маршруты личности — `src/routes/identity.js` (новый)

Фабрика по образцу `devLogin.js` (зависимости инжектируются, без Express
и живой БД в тестах):

```js
export function createIdentityRoutes({
  userRepo,
  jwtLib,
  signer,
  turnstile,
  config,
  now = Date.now,
  clientIp,
}) {
  return { clientConfig, guest, guestVerify, token, logout, issueMemberToken };
}
```

Каждый обработчик `async (req, res)`; отказ — `res.status(…).json({ error })`.

| Маршрут                                            | Поведение                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /client-config`                               | `{ turnstileSiteKey, webauthnRpId, humanTtlMs }` — публичный                                                                                                                                                                                                                                                                             |
| `POST /guest`                                      | `n = userRepo.nextGuestNumber()`, `nick = formatGuestNick(n)`; `session = guestSession(signer, { gid: n, nick })`; JWT `{ sub: String(-n), nick, kind: 'guest' }` → `{ session, token, nick, kind: 'guest' }`. **Строк в БД не пишет.**                                                                                                  |
| `POST /guest/verify` `{ session, turnstileToken }` | сессия гостя (иначе 401 `invalidSession`); `turnstile.verify(turnstileToken, clientIp(req))` (403/503); `hvUntil` = `now + humanTtlMs` (мс → в сессии мс, в JWT секунды; `humanTtlMs === 0` → `253402300799` с, «бессрочно») → `{ session, token }`                                                                                      |
| `POST /token` `{ session }`                        | гость: подпись → JWT (`hvUntil`, если не истёк). Участник: `findSessionUser(hashSecret(secret))` → нет → 401 `sessionUnknown`; иначе `touchSession`/`touchActivity` (`config.session.touchIntervalMs`, ошибки — в лог, не в ответ) → JWT участника → `{ token, nick, kind, id }` (`id` — только участнику). Мусор — 401 `invalidSession` |
| `POST /logout` `{ session }`                       | участник: `deleteSession(hash)`; гость — ничего; всегда 204                                                                                                                                                                                                                                                                              |

`issueMemberToken({ id, nick })` — общий выпуск JWT участника (роль:
`config.admin.userIds.includes(id) ? 'admin' : 'user'`), им пользуются
этапы 3 и dev-логин.

Тесты `tests/auth/identityRoutes.test.js` (фейковые `req/res`,
заглушки репозитория, настоящий `signedToken`, `jwtLib` — заглушка или
реальный с тестовыми ключами, как в `tests/auth/jwt.test.js`): гость не
пишет в БД кроме `nextGuestNumber`; `/token` гостя без/с `hvUntil`,
истёкший `hvUntil` не попадает в JWT; `/token` участника — `sessionUnknown`
и роль админа; `/guest/verify` — 403/503 без выдачи; `/logout`.

## 2.7 Авторизация ручек и админы

В `main.js`:

1. `requireAuth`: `jwtLib.verifyToken` (теперь требует `kind`);
   `req.user = { id: Number(payload.sub), nick: payload.nick, kind: payload.kind }`.
2. Новый `requireMember`: `requireAuth` + `req.user.kind === 'member' && req.user.id > 0`,
   иначе `403 { error: 'memberRequired' }`. Поставить вместо
   `requireAuth` на: `GET /games/mine`, `POST /games`,
   `POST /games/:id/version`, `DELETE /games/:id`, `GET /placement`,
   `GET /rank`, `PUT /rank`, `GET /state`, `PUT /state` (правило «ранг и
   скиллы без авторизации не сохраняются»).
3. `requireAdmin`: `requireMember` + `config.admin.userIds.includes(req.user.id)`,
   иначе 403 `forbidden`; `req.user.role = 'admin'`. Чтения роли из БД нет
   (колонки больше нет): разжалование — правкой переменной и рестартом
   auth, действует сразу на все записи.
4. `isAdminUser(userId)` → `config.admin.userIds.includes(userId)`
   (синхронная; поправить `await` в вызовах).
5. `src/lib/adminRights.js` — заменить содержимое функцией
   `isAdminId(adminConfig, userId)` (или удалить файл и использовать
   `config.admin.userIds` напрямую — на выбор исполнителя, без влияния на
   поведение); `tests/auth/adminRights.test.js` — переписать под id,
   `tests/auth/adminNicks.test.js` — заменить тестом `parseAdminUserIds`
   (пробелы, мусор, ноль, отрицательные, пустая строка).

## 2.8 Dev-логин — переписать `src/devLogin.js`

Только вне прода (как сейчас). `GET /dev/login?nick=&returnUrl=`:
`isValidNick(nick)`; `isAllowedReturnUrl(returnUrl)`; аккаунт-участник с
этим ником (`findByNick` → есть — взять; нет — `createDevMember(nick)`;
`NickTakenError` здесь невозможен после `findByNick`, но обработать как
409); `newMemberSecret()` → `createSession(user.id, hashSecret(secret))`;
редирект на `returnUrl` с `?devSession=<secret>`. Passkey для dev-участника
не нужен (вход по сессии). Тест `tests/auth/devLogin.test.js` переписать.

Dev-баннер при старте (`main.js` ~1075–1100): ссылки
`/dev/login?nick=Player1&returnUrl=<allowedOrigins[0]>/` и, если задан
`VIMP_ADMIN_USER_IDS`, подсказка «admin: войдите под аккаунтом с id из
VIMP_ADMIN_USER_IDS (id dev-аккаунта печатается в логе при dev-логине)» —
dev-логин логирует `console.info('[dev login] <nick> -> id <id>')`.

## 2.9 Удаление старой авторизации

1. Удалить файлы: `src/oauth/index.js`, `src/oauth/github.js`,
   `src/lib/oauthState.js`; тесты `tests/auth/github.test.js`,
   `tests/auth/oauthState.test.js`.
2. `main.js`: удалить импорты и код OAuth (`callbackUrl`,
   `/oauth/:provider/start`, `/oauth/:provider/callback`, `oauthStartLimiter`),
   старый `POST /nick` (pending-поток; новый — этап 3),
   `issueIdentityToken`, `warnOnFreeAdminNicks`, CORS-блок `/nick`
   (заменён 2.5).
3. `UserRepository.js`: удалить `findOrCreateByProvider`, `setNick`,
   `deleteIfAnonymous`, `getIdentity`, `syncRole`, `getRole`,
   `NickAlreadySetError` и их тесты.
4. Проверки прода: убрать `VIMP_AUTH_PUBLIC_URL` и `VIMP_AUTH_GITHUB_*`;
   оставить `VIMP_AUTH_ALLOWED_ORIGINS`, `VIMP_AUTH_STATE_SECRET`;
   добавить обязательные `VIMP_AUTH_TURNSTILE_SITE_KEY`,
   `VIMP_AUTH_TURNSTILE_SECRET`, `VIMP_AUTH_WEBAUTHN_RP_ID` (тот же стиль
   `console.error` + `process.exit(1)`); при пустом `VIMP_ADMIN_USER_IDS`
   — `console.warn` «админов нет».
5. `packages/auth/package.json` → `description`: «VIMP central auth
   service — guest identities, passkeys, global nick, rank/state storage,
   JWT/JWKS».
6. Поиск по `packages/auth` и `tests/auth`: `oauth`, `OAuth`, `github`,
   `pending`, `provider`, `VIMP_ADMIN_NICKS`, `VIMP_ADMIN_IDENTITIES`,
   `PUBLIC_URL` — не должно остаться (кроме комментариев выведенных
   миграций). Комментарий в корневом `vitest.config.js` (строка ~11) —
   поправить, если упоминает OAuth.

## 2.10 Подключение в `main.js`

- `const signer = createSigner(config.session.secret)`,
  `const turnstile = createTurnstileVerifier({ …config.turnstile, allowedHostnames: isProduction ? hostnamesOf(config.allowedOrigins) : null })`,
  `const identity = createIdentityRoutes({ … })`.
- CORS-middleware (2.5) — до `express.json`-маршрутов, после
  `/client-reports` (как сейчас `/nick`).
- Лимитеры (константы рядом с существующими): `guestLimiter` 30 / 10 мин
  на IP (общий NAT школы/офиса — не меньше), `tokenLimiter` 120/мин,
  `humanLimiter` 30/мин (`/guest/verify`); `nickLimiter` остаётся 5/мин.
- Маршруты: `GET /client-config`, `POST /guest` (guestLimiter),
  `POST /guest/verify` (humanLimiter), `POST /token` (tokenLimiter),
  `POST /logout` (tokenLimiter).

## 2.11 Документация (en и ru одинаково)

- `docs/{en,ru}/auth.md`: «## Why a separate service» (без OAuth),
  «## Running» (переменные окружения: удалённые и новые), «## REST API»
  — таблица: удалить строки `/oauth/*`, старого `POST /nick`; добавить
  `GET /client-config`, `POST /guest`, `POST /guest/verify`, `POST /token`,
  `POST /logout`, `GET /dev/login` (новый); пометить member-only ручки;
  абзац об identity-JWT (claims `kind`, `role`, `hvUntil`, `sub` гостя;
  отказ токенам без `kind`; сессии гостя/участника); админы по id.
- `docs/{en,ru}/configuration.md`, таблица переменных auth (строки ~88–93
  сейчас): удалить `VIMP_AUTH_PUBLIC_URL`, `VIMP_AUTH_GITHUB_*`,
  `VIMP_ADMIN_NICKS`, `VIMP_ADMIN_IDENTITIES`; добавить
  `VIMP_AUTH_TURNSTILE_SITE_KEY`, `VIMP_AUTH_TURNSTILE_SECRET`,
  `VIMP_AUTH_WEBAUTHN_RP_ID`, `VIMP_ADMIN_USER_IDS`; новое назначение
  `VIMP_AUTH_STATE_SECRET` и `VIMP_AUTH_ALLOWED_ORIGINS`.

## Проверки

Prettier, eslint, `npx vitest run --reporter=dot`. Ручная: `npm run
dev:auth` стартует; `curl -X POST https://localhost:3010/guest` (или
`http://localhost:3010/guest`) → сессия и токен; `/token` по ней; токен
декодируется с `kind: 'guest'`, `sub` отрицательный; в таблице `users`
ни одной новой строки.

## Критерии готовности

- Гость получает ник, сессию и JWT без единой строки в БД.
- `/token` выдаёт JWT по сессии гостя и участника; токены без `kind`
  отвергаются ручками auth.
- Rank/state/placement/реестр игр — только участникам; админ — по id.
- OAuth, pending-токен, админы по нику/провайдеру удалены из кода и
  тестов.
- Release impact: auth-сервис (выкатывается со всем планом).
