# Правки по кодревью этапов B (авторизация)

✅ выполнен

Разбор дефектов — в `plan-readme-md-b-zippy-giraffe.md` (корень репозитория,
кодревью коммита `38024c0`, этапы B1–B6). Здесь — что именно исправлено.

## Блокеры

- **F1. CORS на `POST /nick`.** Добавлен middleware в
  `packages/auth/src/main.js` (allowlist `config.allowedOrigins`, заголовки
  `Access-Control-Allow-*`, ответ на `OPTIONS`). Источник allowlist — новая
  env `VIMP_AUTH_ALLOWED_ORIGINS` (CSV), в dev дефолт — origin dev-мастера
  (`https://localhost:3002`). В проде **обязательна** (иначе сервис не
  стартует).
- **F2. Захардкоженный `http://localhost` в callback.** Новая env
  `VIMP_AUTH_PUBLIC_URL` (**обязательна** в проде); `callbackUrl()` строится
  от неё, fallback на `protocol/domain/port` остался для dev.

## Высокий приоритет

- **F3. Open redirect.** `isAllowedReturnUrl()` проверяет origin `returnUrl`
  по тому же `VIMP_AUTH_ALLOWED_ORIGINS` — и на `/oauth/:provider/start`
  (ранний `400 returnUrlNotAllowed`), и повторно на `/callback` перед
  редиректом.
- **F4. `PlayerDataSync` затирал сохранённый rank/state дефолтами.**
  `packages/engine/src/host/meta/modules/PlayerDataSync.js`: запись получила
  флаги `rankLoaded`/`stateLoaded` (true только при `res.ok`); `flush`
  пропускает `PUT` для не загруженной части и вместо этого повторяет
  `load()` на следующей попытке.
- **F5. TTL identity-токена короче матча.** `config.jwt.expiresIn`:
  `15m` → `4h` (`packages/auth/src/config/auth.js`). Плюс клиент
  (`LobbyAuthModel._restore`/`_setIdentity`) проверяет `exp` при
  восстановлении из `localStorage` и эмитит `login-required` вместо
  зависшего «авторизован» с протухшим токеном.

## Средний приоритет

- **F6. `POST /nick` позволял переименование.** Эндпоинт отклоняет
  identity-токен (`403 nickAlreadySet`, требуется именно `pending`);
  `UserRepository.setNick` — `UPDATE ... WHERE id = $2 AND nick IS NULL`,
  0 строк → `NickAlreadySetError`.
- **F7. Регистрозависимая уникальность ника.** Новая миграция
  `002_nick_case_insensitive.sql` — `CREATE UNIQUE INDEX IF NOT EXISTS ...
  ON users (lower(nick))`.
- **F8. Нестойкое сравнение HMAC + слабые дефолты.**
  `oauthState.decodeState` сравнивает подпись через
  `crypto.timingSafeEqual`; в проде сервис требует
  `VIMP_AUTH_STATE_SECRET`/`VIMP_AUTH_GITHUB_CLIENT_ID`/`_SECRET` явно
  (иначе не стартует).

## Низкий приоритет

- **F9. Гонка в `load`.** Серверный rank прибавляется к уже накопленному
  (`entry.rank += serverRank`), а не перезаписывает его — дельта от `addRank`
  во время ожидания ответа не теряется.
- **F10. Общий `_defaultState`.** Клонируется (`structuredClone`) на каждую
  запись участника.
- **F11. `PUT /state` без ограничений.** `express.json({ limit: '16kb' })`
  + проверка, что `state` — объект (не массив/строка/число).
- **F12. Rate-limit.** `packages/auth/src/lib/rateLimiter.js` (тот же
  паттерн, что у мастера) — 5 запросов/мин на IP для `POST /nick`, 20/мин
  для `GET /oauth/:provider/start`. IP клиента берётся из
  `X-Forwarded-For` (первый адрес) с фолбэком на `req.socket.remoteAddress`
  (`clientIp()` в `main.js`) — не через Express `req.ip`/`trust proxy`,
  чтобы за Nginx в проде (см. `deployment.md`) лимит не схлопнулся в один
  общий бакет на всех клиентов сразу; тот же приём, что и в
  `packages/engine/src/master/SignalingServer.js`.
- **F13. `\s` в regexp ника.** `packages/auth/src/lib/validators.js`:
  `[\w\s#]` → `[\w #]` (движковая копия не трогалась — ставки ниже, там ник
  не глобально-персистентная личность).
- **F14. Дедуп-суффикс поверх глобального ника** — сознательно не
  исправлялось: сам кодревью отмечает это как косметику, не баг; риск
  трогать пер-комнатный `ParticipantManager.checkName` не оправдан
  небольшим выигрышем.

## Тесты и доки

Новые/обновлённые тесты: `tests/host/PlayerDataSync.test.js` (F4/F9/F10),
`tests/client/LobbyAuthModel.test.js` (F5 — просроченный токен),
`tests/auth/UserRepository.test.js` (F6), `tests/auth/validators.test.js`
(F13). `npx eslint .` и `npm test` — зелёные (85 файлов / 803 теста).

Документация обновлена в `docs/en/` и `docs/ru/`: `auth.md` (новые env,
CORS/redirect/TTL/переименование/регистр), `configuration.md` (таблица env
auth-сервиса), `deployment.md` (обязательные прод-переменные),
`host.md` (`rankLoaded`/`stateLoaded` в `PlayerDataSync`).

Вне рамок правок (уже зафиксировано как осознанное ограничение в
`plan/README.md`): хост недоверен, rank/state, присылаемые им, технически
подделываемы — это не считается багом.
