# Центральный auth-сервис

`packages/auth/` (`@vimp/auth`) — самостоятельный сервис Node.js/Express:
отдельный npm-workspace, свой деплой/домен, своя база PostgreSQL (первая
зависимость от БД в проекте). Он даёт OAuth-вход, глобально уникальный ник,
JWT identity-токены (RS256, проверяются браузерным хостом через JWKS) и
хранение rank/state по играм. Игровой логики не содержит и не зависит от
`vimp-engine`.

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

`dev:auth` и `auth:db:migrate` тоже читают `.env` из корня репозитория
(`node --env-file-if-exists`), поэтому OAuth-креды и
`VIMP_AUTH_DATABASE_URL` не нужно вручную экспортировать в шелл; в отличие
от `start:auth`, они не падают, если файла нет.

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
users:           id, provider, provider_uid, nick(UNIQUE), created_at
ratings:         user_id, game_id, rank, updated_at            ← денормализованный кэш
rank_events:     id, user_id, game_id, hoster_user_id, session_id,
                 delta, voided, created_at                     ← append-only леджер
state_snapshots: user_id, game_id, session_id, hoster_user_id,
                 state_before, created_at                      ← MVP отката
states:          user_id, game_id, state(JSONB opaque), updated_at  ← «скиллы»
host_ratings:    hoster_user_id, score, blocked, updated_at    ← денормализованный кэш
host_votes:      hoster_user_id, voter_user_id, value, reason,
                 updated_at                              ← текущее мнение, 1 строка/пара
```

`(provider, provider_uid)` уникальна — одна строка на внешнюю личность;
`nick` уникален на весь сервис (один ник на все игры), проверка регистронезависимая
(`002_nick_case_insensitive.sql` — `UNIQUE INDEX` по `lower(nick)` поверх
обычного `UNIQUE(nick)`), так что `"Admin"` и `"admin"` не могут сосуществовать.
Единственный модуль, трогающий эти таблицы, — `packages/auth/src/UserRepository.js`.

**Леджер rank** (server-rating этап 1, `003_rank_ledger.sql`): `ratings.rank`
теперь кэш, а не источник истины. Каждый результат матча дописывает строку
`delta` в `rank_events`, атрибутированную к серверу-хосту
(`hoster_user_id` — `userId` создателя комнаты) и его сессии
(`session_id`); `ratings.rank` пересчитывается как
`SUM(delta) WHERE voided = false`, клампится в `config.rank.min/max`. Именно
эта атрибуция позволяет server-rating этапу 4 аннулировать вклад забаненного
сервера, не трогая остальную историю игрока. `state_snapshots` фиксирует `state` один раз
на `(user, game, session)` — значение прямо перед первой записью этого
сервера — как MVP-точку отката; если игрок между двумя сессиями на
забаненном сервере поиграл на честном, восстановление снапшота затрёт этот
честный прогресс — принятый MVP-компромисс: альтернатива (снапшот на
каждую сессию) пока не реализована.

**Рейтинг сервера** (server-rating этап 2, `004_host_ratings.sql`,
[master.md](master.md#рейтинг-сервера-likeunlike)): в отличие от леджера
rank, `host_votes` — не append-only, а **одна строка на пару `(hoster,
voter)`**: мнение гостя о хостере может меняться (`like`↔`unlike`) и должно
заменять предыдущий голос, а не копиться поверх него. `voteHost` перезаписывает
эту строку (no-op, если значение не изменилось — `counted: false`) и
пересчитывает `host_ratings.score = clamp(SUM(value), config.rating.min/max)`;
`blocked = score <= config.rating.blockAt`. `config.rating` здесь зеркалирует
движковый дефолт (`packages/engine/src/config/master.js: rating`) — именно
этот сервис фактически клампит/решает `blocked`, копия мастера — лишь
документированный дефолт.

**Аннулирование при бане** (server-rating этап 4): в момент, когда голос
впервые опускает счёт хостера до `blocked` (проверяется как переход —
голос, который держит уже заблокированного хостера заблокированным, не
повторяет это), `_recomputeHostRating` вызывает
`voidHosterContributions(hosterUserId)` — целиком внутри auth-сервиса, т.к.
он единственный владелец и леджера rank, и снапшотов state (этап 4.1:
«транзакционно на auth, не на мастере»). Метод помечает все непогашенные
строки `rank_events` этого хостера как `voided`, пересчитывает `ratings.rank`
для каждой когда-либо задетой этим хостером пары `(user, game)` (даже если
само гашение — no-op при повторе, пересчёт кэша всё равно выполняется — это
и делает весь вызов идемпотентным), и восстанавливает `states.state` из
**самого раннего** снапшота `state_snapshots` этого хостера для каждой
`(user, game)` — значения непосредственно перед первой сессией игрока на
этом хостере, отбрасывая прогресс, набранный именно на нём. SQL-транзакция
здесь не используется (этот класс нигде её не использует, см.
`recomputeRank`) — идемпотентность каждого шага заменяет атомарность.
Известное ограничение, унаследованное с этапа 1: честный прогресс на других
серверах между двумя сессиями на забаненном тоже откатывается восстановлением
снапшота.

**Индекс для рейтинга** (lobby-page-plan, `005_leaderboard_idx.sql`):
индекс `(game_id, rank DESC)` на `ratings`, чтобы `ORDER BY rank DESC` в
`GET /leaderboard` по игре не превращался в полный скан таблицы.

## REST API

| Эндпоинт | Назначение |
| --- | --- |
| `GET /oauth/:provider/start?returnUrl=` | редирект на страницу провайдера; origin `returnUrl` обязан быть в `VIMP_AUTH_ALLOWED_ORIGINS` (иначе `400 returnUrlNotAllowed`), сам `returnUrl` и CSRF-nonce упакованы в подписанный stateless `state` (`src/lib/oauthState.js` — HMAC, без серверной сессии); rate-limit по IP (`rateLimit(oauthStartLimiter)`) |
| `GET /oauth/:provider/callback` | обменивает `code`, находит/создаёт пользователя по `(provider, providerUid)`, повторно проверяет origin декодированного `returnUrl`, редиректит на него с `?token=` (ник уже есть — полноценный identity JWT) либо `?pendingToken=` (первый вход, ник не выбран) |
| `GET /dev/login?nick=&returnUrl=` **(только dev)** | вход мимо OAuth: находит/создаёт пользователя как `('dev', nick)`, при первом входе задаёт ник (`setNick` с guard'ом `nick IS NULL` делает повтор no-op) и редиректит на `returnUrl` с `?token=` — ровно в той форме, что выдаёт `/oauth/:provider/callback`, поэтому клиентский путь не меняется. Ник проходит через тот же `isValidNick`, return URL — через ту же проверку allowlist, что и OAuth (открытого редиректа с валидным токеном не появляется). Регистрируется **только** при `NODE_ENV !== 'production'`; в проде маршрута не существует (`404`). Хендлер — `src/devLogin.js`, см. [getting-started.md](getting-started.md#центральный-auth-сервис-нужен-для-входа-в-лобби) |
| `POST /nick` (Bearer pending-токен, `{ nick }`) | CORS для origin'ов из `VIMP_AUTH_ALLOWED_ORIGINS` (включая preflight `OPTIONS` — единственный эндпоинт, вызываемый напрямую браузером лобби, не проксируется мастером), rate-limit по IP; отклоняет identity-токен (`403 nickAlreadySet` — нужен именно pending-токен, иначе `/nick` мог бы переименовывать существующего пользователя); проверяет ник по `NAME_REGEXP` (уникальность регистронезависимая — см. «Схема БД») и сохраняет, возвращает `{ token }` (полный identity JWT). `409 { error: 'nickTaken' }` при гонке |
| `GET /jwks` | публичный RS256-ключ в формате JWK — хост проверяет подпись `token` перед тем, как довериться его `nick` |
| `GET /rank?game=` (Bearer identity-токен) | `{ rank }` — закэшированная, клампленная сумма непогашенных `rank_events` вызывающего для игры |
| `PUT /rank?game=` (Bearer, `{ delta, hosterUserId?, sessionId? }`) | дописывает событие леджера с дельтой матча (целое в пределах `±config.rank.maxDelta`, фикс кодревью — иначе один вызов мог бы разогнать кэш до клампа за один матч), атрибутированное к серверу/сессии-репортёру, пересчитывает и возвращает `{ rank }`; зеркало `PUT /state` (Этап B4, семантика дельты — с server-rating этапа 1). `hosterUserId`/`sessionId` должен проставлять *мастер* вызывающего, не сам браузерный хост — см. [master.md](master.md#getput-authrank-getput-authstate) |
| `GET /state?game=` (Bearer) | `{ state }` (непрозрачный JSON, блок «скиллов») |
| `PUT /state?game=` (Bearer, `{ state, hosterUserId?, sessionId? }`) | если передан `sessionId` и снапшота для `(user, game, session)` ещё нет — сначала сохраняет текущий `state` в `state_snapshots`, затем upsert'ит новый `state`; отклоняет state больше `config.state.maxBytes` (`400 stateTooLarge`) |
| `GET /host-rating` (Bearer identity-токен) | `{ score, blocked }` — **собственный** рейтинг вызывающего как хостера; мастер вызывает это с токеном хостера при `register_host`, чтобы решить, отклонить ли комнату (`blocked: true`), и заодно сеет закэшированный `rating` комнаты в лобби (server-rating этап 3) |
| `PUT /host-rating/:hosterUserId` (Bearer, `{ value, reason }`) | голос гостя за/против `hosterUserId` (голосующий — вызывающий, из его Bearer-токена — `403 selfVote`, если совпадает с `hosterUserId`); `value` должно быть `1` или `-1` (`400 invalidVote`); пустая/отсутствующая `reason` не учитывается (возвращает текущий рейтинг с `counted: false`, без записи); иначе upsert голоса и `{ score, blocked, counted }` |
| `GET /host-rating/:hosterUserId` (без авторизации — server-rating этап 3) | `{ score, blocked }` для произвольного `hosterUserId`; без авторизации, т.к. значение и так публично отображается в лобби (поле `rating` в `GET /servers`) — `HostRatingProxy.getPublic` мастера опрашивает этот эндпоинт по таймеру (`SignalingServer.refreshRatings()`), чтобы обновлять кэш рейтинга по комнатам, не храня Bearer-токен каждого активного хостера между запросами. `400 badRequest` для нецелого `:hosterUserId` |
| `GET /leaderboard?game=&limit=&period=` (без авторизации — lobby-page-plan) | `{ leaderboard: [{nick, rank, place}], total }` — топ-`limit` (клампится в `1..100`, дефолт `10`) по `ratings` для `game`, только `rank > 0 AND nick IS NOT NULL`, сортировка `rank DESC, nick ASC`. `place` — competition ranking (`RANK() OVER (ORDER BY rank DESC)`): игроки с одинаковым `rank` делят `place`, следующее отличное значение перескакивает на размер группы — согласовано с определением `GET /placement` ниже, а не плоский порядковый номер строки (code review M3: список и плашка позиции вызывающего должны совпадать). `total` и `place` считаются оконными функциями над всем набором, прошедшим `WHERE`, ещё до `LIMIT`, в том же запросе, что и страница (code review L1 — один round-trip вместо отдельного `COUNT(*)`). Без авторизации: показывается в лобби до логина, тот же уровень доверия, что и `GET /host-rating/:hosterUserId`. `400 gameRequired`, если `game` не передан. **`period`** (rank-periods) выбирает срез времени: `all` (по умолчанию — и это то, что получает старый клиент, не передающий `period`), `day` или `month`. `all` читает кэш `ratings` ровно как раньше; `day`/`month` считаются на лету из леджера `rank_events` (`SUM(delta) WHERE voided = false AND created_at >= date_trunc('day'|'month', now() AT TIME ZONE 'utc')`, `HAVING SUM(delta) > 0`) — окна КАЛЕНДАРНЫЕ и в UTC, а не скользящие: «топ за сегодня» должен значить одно и то же для всех, кто на него смотрит. На прочих значениях — `400 badPeriod`: ответить не тем срезом под верным заголовком хуже, чем отказать |
| `GET /placement?game=&period=` (Bearer identity-токен — lobby-page-plan) | `{ placement, total, rank }` для вызывающего: `rank` — его закэшированные очки (`0`, если не ранжирован), `total` — тот же счётчик ранжированных игроков, что и в `/leaderboard`, `placement` — та же competition-ranking позиция, что и `place` в `/leaderboard` (`(COUNT(*) WHERE rank > мой) + 1`), либо `null`, если `rank` равен `0` (ещё не ранжирован). `period` — тот же срез и считается тем же способом: плашка позиции не должна противоречить списку, рядом с которым её показывают |

Rate limiting — одна middleware (`src/lib/rateLimit.js`: `main.js` при импорте
поднимает сервер и пул БД, поэтому контракт лимита внутри него не проверить).
Ключ — IP клиента из `clientIp()` (`src/lib/clientIp.js`, копия
движкового хелпера), а не `req.ip`/`trust proxy` из Express: за Nginx
(прод-топология, см. [deployment.md](deployment.md)) `req.ip` сам по себе
указывал бы на адрес Nginx, и лимит схлопнулся бы в один общий бакет на всех
клиентов сразу. В проде адрес берётся из `X-Real-IP` (Nginx деплоя ставит его
из `$remote_addr`, перезаписывая присланное клиентом), вне прода — из
`req.socket.remoteAddress`. `X-Forwarded-For` не используется намеренно: тот
же Nginx ставит его через `$proxy_add_x_forwarded_for`, то есть *дописывает*
реальный адрес к клиентскому, поэтому первый адрес списка задаёт сам клиент —
ключ по нему снимал бы лимиты перебора ников и старта OAuth одним заголовком.
Запрос вообще без адреса (сокет уже разорван) получает `429`, а не делит общий
бакет `''` со всеми такими же — мастер и dedicated по той же причине обрывают
такие соединения. Тот же приём и по той же причине — у мастера в
`SignalingServer.handleConnection` и у dedicated-сервера; а прокси, не ставящий
`X-Real-IP`, схлопывает всех клиентов в один бакет — см.
[deployment.md](deployment.md#обязательный-заголовок-прокси-x-real-ip).

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
| `src/devLogin.js` | фабрика хендлера dev-входа (`createDevLoginHandler({ userRepo, jwtLib, isAllowedReturnUrl, isValidNick })`) — зависимости инжектируются, поэтому тестируется без Express и живой БД; подключается в `main.js` под `if (!isProduction)` |
| `src/lib/validators.js` | regexp ника, продублирован из `packages/engine/src/lib/validators.js` (`NAME_REGEXP`) — воркспейсы не делят рантайм-зависимость |
| `src/UserRepository.js` | весь SQL: найти/создать пользователя, задать ник, get rank, добавить/пересчитать события леджера rank, get/upsert state, снапшот state, получить рейтинг хостера, upsert голоса и пересчёт `host_ratings`, аннулирование вклада забаненного хостера в rank/state, чтение рейтинга/позиции игрока для лобби (lobby-page-plan) |
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
   декодированный `exp` уже прошёл (или токен битый), сохранённый токен
   удаляется и показывается чистый экран входа, без баннера ошибки —
   просроченный/битый токен при тихом восстановлении это штатная ситуация
   возврата на сайт, не ошибка. `login-error` (`tokenExpired` /
   `invalidToken`) эмитится только на интерактивном пути (OAuth-редирект,
   отправка ника), не при тихом восстановлении.

Домен auth-сервиса бандлится на клиенте в
[packages/engine/src/config/authClient.js](../../packages/engine/src/config/authClient.js)
(`serviceUrl`, dev-дефолт `http://localhost:3010`) — Vite подставляет его при
сборке из `import.meta.env.VITE_AUTH_SERVICE_URL`: Dockerfile объявляет
`ARG VITE_AUTH_SERVICE_URL`, а job `build_and_push` в `deploy.yml` передаёт
его через `build-args` из той же переменной репозитория `AUTH_SERVICE_URL`,
что используется для серверного `VIMP_AUTH_SERVICE_URL` (см.
[deployment.md](deployment.md#central-auth-сервис-packagesauth)) — вручную
ничего править перед сборкой больше не нужно. `authClient.js` также
импортируется `master/main.js` под чистым Node (ради `.issuer`), где
`import.meta.env` не определён — `typeof`-guard откатывается на dev-дефолт
вместо падения. CSP `connect-src` мастера
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
защиту `nick IS NULL` от переименования, а также кейсы `voteHost`/
`getHostRating`: первый голос, повторный неизменный голос как no-op, смена
мнения, клампинг в `config.rating` и выставление `blocked`;
`getLeaderboard`/`getPlacement` — форма SQL одним запросом, competition
ranking при равном `rank`, пустая игра), `devLogin.test.js` (редирект несёт
токен, проверяемый одноразовой парой RSA-ключей; ник задаётся только при
первом входе; невалидный ник и `returnUrl` с чужого origin отклоняются до
любой записи).

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
