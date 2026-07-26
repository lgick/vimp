# Центральный auth-сервис

`packages/auth/` (`@vimp/auth`) — самостоятельный сервис Node.js/Express:
отдельный npm-workspace, свой деплой/домен, своя база PostgreSQL (первая
зависимость от БД в проекте). Он даёт OAuth-вход, глобально уникальный ник,
JWT identity-токены (RS256, проверяются браузерным хостом через JWKS) и
хранение rank/state по играм. Игровой логики не содержит и не зависит от
`@vimp/engine`.

> Статус: этапы B1–B6 плана `plan/README.md` реализованы — B1 (сервис +
> схема + REST), B2 (UI входа в лобби), B3 (проброс JWT в игру + проверка
> хостом через `/jwks`), B4 (загрузка и синхронизация rank/state между
> auth-сервисом, мастером и хостом), B5 (чат-команда `/rank`) и B6 (образ в
> CI, деплой, доки по конфигурации — см.
> [deployment.md](deployment.md#central-auth-сервис-packagesauth)). По итогам
> кодревью (`plan/done/central-auth/auth_fixes.md`) прод-путь доработан — ниже фиксы CORS,
> open-redirect, callback-URL, запрета переименования и TTL.

## Зачем отдельный сервис

У мастер-сервера (`packages/engine/src/master/`) нет БД, он деплоится
по-доменно; несколько мастеров могут делить один auth-сервис — тогда ник,
рейтинг и состояние игрока остаются глобальными между доменами. Полное
обоснование и оговорка о том, что браузерный хост недоверен (любой
присланный им rank/state технически подделываем; JWT защищает только
идентичность, но не честность результата матча) — в `plan/README.md`.

## Запуск

```bash
npm run dev:auth          # dev, http://localhost:3010 (nodemon)
npm run start:auth        # продакшн, читает .env
npm run auth:db:migrate   # применить packages/auth/src/db/migrations/*.sql
```

Конфиг — [packages/auth/src/config/auth.js](../../packages/auth/src/config/auth.js).
Нужна база PostgreSQL (`VIMP_AUTH_DATABASE_URL`, по умолчанию
`postgres://localhost:5432/vimp_auth`) и пара RS256-ключей в `.keys/`:

```bash
openssl genrsa -out .keys/jwt.pem 2048
openssl rsa -in .keys/jwt.pem -pubout -out .keys/jwt.pub.pem
```

Пока подключён только GitHub (Google/Apple добавляются тем же паттерном
провайдера в `src/oauth/`). Заведите GitHub OAuth App с callback
`http://localhost:3010/oauth/github/callback` и задайте
`VIMP_AUTH_GITHUB_CLIENT_ID` / `VIMP_AUTH_GITHUB_CLIENT_SECRET`.

В продакшне (`NODE_ENV=production`) сервис отказывается стартовать без
следующих переменных (`src/main.js`):

| Переменная | Назначение |
| --- | --- |
| `VIMP_AUTH_PUBLIC_URL` | публичный origin сервиса для построения OAuth `redirect_uri` (`callbackUrl()`); без неё callback уходит как `http://localhost:PORT`, недостижимый для провайдера |
| `VIMP_AUTH_ALLOWED_ORIGINS` | CSV-список origin'ов мастеров, которым разрешён CORS на `POST /nick` и редирект OAuth (origin `returnUrl` проверяется и на `/start`, и на `/callback` — закрывает open redirect, крадущий identity-токен) |
| `VIMP_AUTH_STATE_SECRET` | HMAC-секрет для stateless OAuth `state` (`src/lib/oauthState.js`); сравнивается через `crypto.timingSafeEqual`, не `!==` |
| `VIMP_AUTH_GITHUB_CLIENT_ID` / `VIMP_AUTH_GITHUB_CLIENT_SECRET` | реквизиты GitHub OAuth App |

В dev `VIMP_AUTH_ALLOWED_ORIGINS` по умолчанию — origin dev-мастера
(`https://localhost:3002`).

## Схема БД

```
users:    id, provider, provider_uid, nick(UNIQUE), created_at
ratings:  user_id, game_id, rank, updated_at
states:   user_id, game_id, state(JSONB opaque), updated_at   ← «скиллы»
```

`(provider, provider_uid)` уникальна — одна строка на внешнюю личность;
`nick` уникален на весь сервис (один ник на все игры), проверка регистронезависимая
(`002_nick_case_insensitive.sql` — `UNIQUE INDEX` по `lower(nick)` поверх
обычного `UNIQUE(nick)`), так что `"Admin"` и `"admin"` не могут сосуществовать.
Единственный модуль, трогающий эти таблицы, — `packages/auth/src/UserRepository.js`.

## REST API

| Эндпоинт | Назначение |
| --- | --- |
| `GET /oauth/:provider/start?returnUrl=` | редирект на страницу провайдера; origin `returnUrl` обязан быть в `VIMP_AUTH_ALLOWED_ORIGINS` (иначе `400 returnUrlNotAllowed`), сам `returnUrl` и CSRF-nonce упакованы в подписанный stateless `state` (`src/lib/oauthState.js` — HMAC, без серверной сессии); rate-limit по IP (`rateLimit(oauthStartLimiter)`) |
| `GET /oauth/:provider/callback` | обменивает `code`, находит/создаёт пользователя по `(provider, providerUid)`, повторно проверяет origin декодированного `returnUrl`, редиректит на него с `?token=` (ник уже есть — полноценный identity JWT) либо `?pendingToken=` (первый вход, ник не выбран) |
| `POST /nick` (Bearer pending-токен, `{ nick }`) | CORS для origin'ов из `VIMP_AUTH_ALLOWED_ORIGINS` (включая preflight `OPTIONS` — единственный эндпоинт, вызываемый напрямую браузером лобби, не проксируется мастером), rate-limit по IP; отклоняет identity-токен (`403 nickAlreadySet` — нужен именно pending-токен, иначе `/nick` мог бы переименовывать существующего пользователя); проверяет ник по `NAME_REGEXP` (уникальность регистронезависимая — см. «Схема БД») и сохраняет, возвращает `{ token }` (полный identity JWT). `409 { error: 'nickTaken' }` при гонке |
| `GET /jwks` | публичный RS256-ключ в формате JWK — хост проверяет подпись `token` перед тем, как довериться его `nick` |
| `GET /rank?game=` (Bearer identity-токен) | `{ rank }` вызывающего для игры |
| `PUT /rank?game=` (Bearer, `{ rank }`) | upsert rank (должен быть конечным числом); зеркало `PUT /state` (Этап B4) |
| `GET /state?game=` (Bearer) | `{ state }` (непрозрачный JSON, блок «скиллов») |
| `PUT /state?game=` (Bearer, `{ state }`) | upsert блока state |

Ключ rate-limit'а — IP клиента из `X-Forwarded-For` (первый адрес) с
фолбэком на `req.socket.remoteAddress` (`clientIp()` в `src/main.js`), а не
`req.ip`/`trust proxy` из Express — тот же приём, что и у мастера в
`SignalingServer.handleConnection`, и по той же причине: за Nginx (прод-топология,
см. [deployment.md](deployment.md)) `req.ip` сам по себе указывал бы на адрес
Nginx, и лимит схлопнулся бы в один общий бакет на всех клиентов сразу.

Identity JWT (`src/lib/jwt.js`) несёт `sub` (id пользователя) и `nick`,
подписан RS256, короткоживущий (`config.jwt.expiresIn`, 4 часа по
умолчанию — с запасом покрывает длительность матча; клиент также проверяет
`exp` при восстановлении сохранённого токена, см. «Вход в лобби» ниже),
проверяется с `issuer: 'vimp-auth'`. Pending-токен (выдаётся между
OAuth-колбэком и `POST /nick`) вместо этого несёт `pending: true` и не
содержит ника — `requireAuth` в `src/main.js` отклоняет его на всех прочих
эндпоинтах, а `/nick` отклоняет обратный случай (identity-токен, т.е.
`pending` отсутствует).

## Модули

| Модуль | Ответственность |
| --- | --- |
| `src/main.js` | Express-приложение, роуты, middleware `requireAuth` (Bearer-токен) |
| `src/config/auth.js` | порт/домен, пути к ключам JWT, строка подключения к БД, конфиг OAuth-провайдеров |
| `src/lib/jwt.js` | подпись/проверка RS256 (identity + pending), экспорт JWKS |
| `src/lib/oauthState.js` | подписанный stateless `state` OAuth (return URL + CSRF-nonce) |
| `src/lib/validators.js` | regexp ника, продублирован из `packages/engine/src/lib/validators.js` (`NAME_REGEXP`) — воркспейсы не делят рантайм-зависимость |
| `src/UserRepository.js` | весь SQL: найти/создать пользователя, задать ник, get/upsert rank, get/upsert state |
| `src/oauth/github.js`, `src/oauth/index.js` | реестр провайдеров; форма `getAuthorizationUrl`/`exchangeCode`, расширяема под Google/Apple |
| `src/db/pool.js`, `src/db/migrate.js`, `src/db/migrations/*.sql` | `pg.Pool`, минимальный идемпотентный раннер миграций (`CREATE TABLE IF NOT EXISTS`, без таблицы версий пока) |

## Вход в лобби (клиент)

`plan/done/central-auth/auth_b2.md`. Тройка MVC движка **LobbyAuth**
(`packages/engine/src/client/components/{model,view,controller}/LobbyAuth.js`,
описана в [client.md](client.md#mvc-компоненты-packagesenginesrcclientcomponents))
закрывает лобби экраном входа — `#lobby` скрыт, пока клиент не авторизован.
Поток:

1. **Старт**: игрок жмёт кнопку провайдера (`.lobby-auth-provider`) →
   браузер переходит (не fetch) на
   `GET {authServiceUrl}/oauth/:provider/start?returnUrl=<текущий URL лобби>`.
2. **Колбэк**: auth-сервис обменивает code, редиректит обратно на
   `returnUrl` с `?token=` (ник уже есть) либо `?pendingToken=` (первый
   вход, ника ещё нет).
3. **Boot клиента**: `LobbyAuthModel.boot(location.search)` разбирает
   найденный query-параметр (`main.js` затем чистит адресную строку через
   `history.replaceState`), либо — если параметров нет — восстанавливает
   identity JWT из `localStorage['vimpAuthToken']`. `?token=` или
   восстановленный токен декодируется на клиенте (только для отображения,
   без проверки подписи — см. [client.md](client.md#mvc-компоненты-packagesenginesrcclientcomponents))
   ради ника и открывает лобби; `?pendingToken=` показывает экран выбора
   ника.
4. **Выбор ника**: отправка формы ника делает `POST {authServiceUrl}/nick`
   (Bearer pending-токен) прямо из браузера — кросс-доменный fetch, не
   проксируется мастером, требует собственной CORS-настройки auth-сервиса
   (`VIMP_AUTH_ALLOWED_ORIGINS`, см. «Запуск» выше). При успехе полученный
   identity-токен сохраняется и открывается лобби; `409 nickTaken` /
   `400 invalidNick` выводятся inline.
5. **Восстановление/протухание**: при заходе без query-параметров
   `LobbyAuthModel._restore()` читает `localStorage['vimpAuthToken']`; если
   декодированный `exp` уже прошёл, сохранённый токен удаляется и снова
   показывается экран входа (`login-error: 'tokenExpired'`) вместо
   зависшего «авторизован», который хост всё равно отклонит при входе в игру.

Домен auth-сервиса бандлится на клиенте в
[packages/engine/src/config/authClient.js](../../packages/engine/src/config/authClient.js)
(`serviceUrl`, dev-дефолт `http://localhost:3010`) — перед продакшн-сборкой
подставить реальный домен. CSP `connect-src` мастера
(`packages/engine/src/config/master.js`, `security.csp`, применяется только
в проде) шаблонизируется тем же доменом (`security.authServiceUrl`,
переопределяется `VIMP_AUTH_SERVICE_URL`), иначе fetch `POST /nick`
заблокирован; сами OAuth-редиректы — навигация верхнего уровня и `connect-src`
их не касается.

## Вход в комнату (проверка хостом)

`plan/done/central-auth/auth_b3.md`. Комнатная тройка MVC **Auth**
(`packages/engine/src/client/components/{model,view,controller}/Auth.js`)
по-прежнему ведёт игровую форму авторизации, но в форме больше нет поля
`name` — `authSchema.params` игры-плагина (например,
`src/config/auth.js` в `vimp-tanks`) теперь объявляет только игро-специфичные
поля (`model`). Ник свободно не вводится: клиент прикладывает лобби-JWT
личности (`LobbyAuthModel.getToken()`) к payload `AUTH_RESPONSE`
(`packages/engine/src/client/main.js`, порт 1) как `token`, рядом с полями
формы.

Хост (`packages/engine/src/host/host.worker.js`, недоверенная вкладка,
запускающая матч) — точка верификации:

1. `validateAuth` по-прежнему проверяет игро-специфичные
   `authSchema.params` (например `isValidModel`) — токена это не касается.
2. `verifyClientToken(data.token)` фетчит (и кэширует на время жизни
   Worker'а) мастеровский `GET /auth/jwks` (`config/lobby.js`, поле
   `auth.jwksUrl`), затем вызывает `verifyIdentityToken`
   (`packages/engine/src/lib/jwt.js`) — проверка подписи RS256 через Web
   Crypto (`crypto.subtle`, отдельная JWT-библиотека не нужна; работает
   одинаково в браузере, Worker'е хоста и в Node ≥19), сверка `iss` с
   `issuer` из `authClient.js` (должен совпадать с `config.jwt.issuer`
   `packages/auth` — `'vimp-auth'`) и срока годности.
3. При успехе `host.createUser({ ...data, name: payload.nick }, socketId, cb)`
   использует проверенный ник — `ParticipantManager.createHuman` не
   изменился (его пер-комнатный дедуп `checkName` остаётся защитным
   фолбэком, хотя ники уже глобально уникальны). При неудаче `AUTH_RESULT`
   несёт `[{ name: 'token', error: 'invalid' }]`, пользователь не создаётся.

К самому auth-сервису хост не обращается вовсе — он доверяет только
проксированному JWKS мастера (`JwksProxy`, см.
[master.md](master.md#get-authjwks)), что не даёт недоверенному хосту
касаться поверхности auth-сервиса напрямую.

## Загрузка и синхронизация rank и state (хост)

`plan/done/central-auth/auth_b4.md`. После проверки identity-токена участника (см. выше) хост
автоматически загружает его rank/state и держит их синхронизированными с
auth-сервисом всё время сессии — механику на стороне хоста см. в
[host.md](host.md#синхронизация-rank-и-state-игрока-этап-b4)
(`PlayerDataSync`, точки flush, API-поверхность `HostGame`). Коротко:

1. **Загрузка на join**: `HostGame.createUser()` запускает
   `PlayerDataSync.load(participantId, token)` (fire-and-forget — не
   блокирует вход), которая дёргает мастеровские `GET /auth/rank` и
   `GET /auth/state` (проксируются в центральный auth-сервис — см.
   [master.md](master.md#getput-authrank-getput-authstate))
   собственным identity-токеном участника. Если auth-сервис недоступен,
   участник остаётся на дефолтах (rank `0`, `playerState.defaultState`
   игры-плагина, например `src/config/game.js` в `vimp-tanks`) —
   недоступность auth-сервиса никогда не блокирует вход.
2. **Накопление**: rank меняется на ±1 за убийство — тот же чокпоинт, что и
   эфемерный score в `Stat`, — `RoundManager.reportKill()` (с той же
   веткой победа/тимкилл).
3. **Синхронизация обратно**: `PlayerDataSync.flush()`/`flushAll()`
   отправляют текущие rank+state участника на мастеровские `PUT /auth/rank`/
   `PUT /auth/state` (best-effort, `Promise.allSettled` — неудачный flush
   молча повторится на следующей естественной точке flush с уже
   накопленными за это время данными). Точки flush: смена карты и конец
   раунда (обе — в `RoundManager`), плюс финальный flush при выходе
   участника (`HostGame.removeUser()`).

Rank здесь — простой аккумулятор дельты по убийствам (+1/-1), а не
ELO или матчмейкинг-рейтинг. Rust/WASM-ядро игры вообще не знает о
rank/state — это чисто engine/JS-концепция, доступная игровым плагинам через
`HostGame.getPlayerRank()`/`getPlayerState()`/`setPlayerState()`, а игрокам —
через движковую чат-команду `/rank` (этап B5,
[CommandProcessor](../../packages/engine/src/host/meta/core/CommandProcessor.js),
см. доки игрового процесса активной игры-плагина, например [vimp-tanks/docs/ru/gameplay.md](https://github.com/lgick/vimp-tanks/blob/main/docs/ru/gameplay.md#чат-клавиша-c-и-команды)) — она читает локально
закэшированный rank через `PlayerDataSync.getRank()`, без сетевого запроса.

## Тесты

`tests/auth/` (node-проект Vitest): `validators.test.js` (включая кейс F13 —
управляющие пробельные символы), `jwt.test.js` (подписывает одноразовой
RSA-парой, мокает `config/auth.js`), `github.test.js` (мокает `fetch`),
`oauthState.test.js` (включая тайминг-безопасное сравнение, всё ещё
отклоняющее подделанную подпись), `UserRepository.test.js` (заглушка
`{ query() }` — для юнит-тестов реальный PostgreSQL не нужен, включая
защиту `nick IS NULL` от переименования).

Проверка на стороне хоста (B3) и синхронизация rank/state (B4) тестируются
в дереве движка: `tests/lib/jwt.test.js` (`verifyIdentityToken` — валидная
подпись, чужой ключ, неверный issuer, просроченный токен, отсутствующий
`nick`, неизвестный `kid`, битый токен — всё на одноразовой RSA-паре,
подписанной `jsonwebtoken`), `tests/master/JwksProxy.test.js`
(проксирование, TTL-кэш, сбой апстрима), `tests/master/PlayerDataProxy.test.js`
(проксирование GET/PUT `/rank`+`/state`, отсутствие кэша, сбой апстрима) и
`tests/host/PlayerDataSync.test.js` (загрузка с дефолтами при сбое
auth-сервиса, накопление rank, flush/flushAll, плюс кейсы правок: `flush` не
шлёт `PUT` вовсе, если `load` ни разу не удался, и повторяет `load` вместо
затирания сохранённого значения дефолтом; дельта ранга, накопленная во время
ожидания `load`, не теряется; `defaultState` клонируется на каждого
участника, а не расшаривается), плюс покрытие rank/flush, добавленное в
`tests/host/RoundManager.test.js`, и проброс токена в
`tests/host/ParticipantManager.test.js`. На клиенте
`tests/client/LobbyAuthModel.test.js` покрывает восстановление с
просроченным токеном.

---

[← Предыдущая: Мастер-сервер](master.md) · [Следующая: Браузерный хост →](host.md)
