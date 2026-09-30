# Этап 1. Auth-сервис: таблица, приём, админ-API ✅ выполнен

Репозиторий: `vimp`, пакет `packages/auth` (Express 5 + `pg`, без ORM).
Зависимостей от других этапов нет. Журнала изменений у пакета нет
(приватный), npm-артефакты не затрагиваются.

## Цель

Auth-сервис умеет:

1. принимать пачки отчётов от боксов (`POST /client-reports`, общий секрет);
2. хранить их в `client_reports`, агрегируя по отпечатку;
3. **ограничивать появление новых строк** (бюджет по IP отправителя, общий
   бюджет, потолок таблицы — решение 9 в `README.md`), не мешая счёту
   повторов уже известных;
4. отдавать админу список и менять статус
   (`GET /admin/client-reports`, `PATCH /admin/client-reports/:id`);
5. раз в сутки удалять устаревшие строки.

## Что прочитать перед началом

- `packages/auth/src/main.js` — порядок middleware (`const app = express()`,
  затем **глобальный** `app.use(express.json({ limit: '16kb' }))`),
  `requireAuth` / `requireAdmin` (стр. ~126–174), `byIp(limiter)` (стр. ~122),
  лимитеры (стр. ~112–119), админские маршруты `/admin/games` (стр. ~524),
  финальный обработчик ошибок и старт `startGamesPurgeJob` (конец файла).
- `packages/auth/src/config/auth.js` — структура конфига (блоки `admin`,
  `games`, `rank`); значения из `process.env` читаются прямо здесь.
- `packages/auth/src/db/pool.js`, `db/migrate.js` (прогоняет **все**
  `migrations/*.sql` по имени на каждом запуске — миграции обязаны быть
  идемпотентными), `db/migrations/012_games_soft_delete.sql` (стиль SQL и
  комментариев), `db/gamesPurgeJob.js` (образец суточной задачи:
  `purgeDeletedGames`, `msUntilNextRun`, `startGamesPurgeJob`, таймер с
  `.unref()`).
- `packages/auth/src/lib/validators.js` — `clampLimit(value, fallback, max)`,
  `isValidGameId(id, config.games)`.
- `tests/auth/UserRepository.test.js` — паттерн теста репозитория через
  заглушку `createDbStub(handlers)` (`{ query: vi.fn(...) }`), без реальной БД.
- `main.js` при импорте поднимает сервер и пул — **маршруты из тестов не
  импортируются**; всё тестируемое выносится в модули (`lib/*`,
  репозиторий), как уже сделано с `lib/rateLimit.js`.

## Шаги

### 1.1. Миграция `packages/auth/src/db/migrations/013_client_reports.sql`

```sql
-- Журнал клиентских ошибок (plan/client-reports): строка — отпечаток
-- (sha256 от вида ошибки, сообщения, верхнего кадра и версий), повторы
-- копятся в count. Отпечаток считает бокс, auth его только хранит.
CREATE TABLE IF NOT EXISTS client_reports (
  id             BIGSERIAL PRIMARY KEY,
  fingerprint    CHAR(64)    NOT NULL UNIQUE,
  source         TEXT        NOT NULL,           -- client | host-worker | plugin | box
  kind           TEXT        NOT NULL,           -- error | rejection | worker | warn | csp
  code           TEXT,                           -- только у warn/plugin
  message        TEXT        NOT NULL,
  stack          TEXT,
  details        JSONB,
  engine_version TEXT,
  game_id        TEXT,
  game_version   TEXT,
  box            TEXT,                           -- домен бокса, приславшего первым
  mode           TEXT,                           -- lobby | dedicated | solo
  user_agent     TEXT,
  count          BIGINT      NOT NULL DEFAULT 0,
  first_seen     TIMESTAMPTZ NOT NULL,
  last_seen      TIMESTAMPTZ NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'fixed', 'ignored')),
  status_note    TEXT,
  status_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- users.id — SERIAL
  status_at      TIMESTAMPTZ
);

-- главный запрос панели: «открытые, свежие сверху»
CREATE INDEX IF NOT EXISTS client_reports_status_last_idx
  ON client_reports (status, last_seen DESC, id DESC);

-- фильтр по игре в панели
CREATE INDEX IF NOT EXISTS client_reports_game_idx
  ON client_reports (game_id, last_seen DESC);
```

`users` объявлена в `001_init.sql`: `id SERIAL PRIMARY KEY`, ник — колонка
`nick`.

### 1.2. Конфиг — блок `clientReports` в `packages/auth/src/config/auth.js`

```js
// журнал клиентских ошибок (plan/client-reports): боксы пересылают сюда
// отчёты по общему секрету; пустой токен — приём выключен (503)
clientReports: {
  token: process.env.VIMP_CLIENT_REPORTS_TOKEN || '',
  // потолок пачки от одного бокса за запрос (бокс шлёт по 50)
  maxBatch: 100,
  // тело пачки: 100 × (стек 8000 + details 4096 + сообщение 500) с запасом
  bodyLimit: '2mb',
  // строки, не повторявшиеся дольше, удаляются суточной задачей
  retentionDays: 90,
  listMaxLimit: 100,
  // защита от спама (решение 9 плана): ограничивается появление НОВЫХ
  // строк, повторы известных отпечатков считаются всегда. Бюджет по IP
  // отправителя, а не по полю box: его бокс пишет сам, и с утёкшим
  // секретом оно подменяется на каждом запросе
  budget: {
    newPerIpPerHour: 2000,
    newGlobalPerHour: 10000,
    maxRows: 200000,
    // как часто пересчитывать число строк точным count(*)
    rowsRecountMs: 10 * 60 * 1000,
  },
  limits: {
    message: 500,
    stack: 8000,
    code: 64,
    details: 4096, // байт JSON.stringify(details)
    userAgent: 256,
    box: 253,
    version: 64,
    note: 500,
  },
},
```

### 1.3. Секрет сервиса — `packages/auth/src/lib/serviceToken.js`

```js
import { createHash, timingSafeEqual } from 'node:crypto';

// сравнение через хэши одинаковой длины: timingSafeEqual требует равных
// длин, а сравнение длин само по себе утекло бы по времени
export function isValidServiceToken(authorizationHeader, expected) { … }

// middleware: пустой expected → 503 { error: 'reportsDisabled' };
// неверный/отсутствующий Bearer → 401 { error: 'unauthorized' }; иначе next()
export function requireServiceToken(expected) { … }
```

- `isValidServiceToken`: `false`, если `expected` пустой, заголовок не
  строка или не начинается с `'Bearer '`; иначе сравнить
  `sha256(token)` и `sha256(expected)` через `timingSafeEqual`.

### 1.4. Нормализация входа — `packages/auth/src/lib/clientReportValidators.js`

```js
// 'box' — служебные записи самого бокса (reports.dropped, этап 2)
export const REPORT_SOURCES = ['client', 'host-worker', 'plugin', 'box'];
// 'csp' — нарушение Content-Security-Policy на странице (этап 3)
export const REPORT_KINDS = ['error', 'rejection', 'worker', 'warn', 'csp'];
export const REPORT_STATUSES = ['open', 'fixed', 'ignored'];
export const REPORT_MODES = ['lobby', 'dedicated', 'solo'];

// одна запись пачки бокса → чистый объект для репозитория или null
export function normalizeReportItem(raw, { limits, gameIdRules, now = Date.now() }) { … }
```

Правила `normalizeReportItem` (всё прочее в `raw` игнорируется):

| Поле входа                     | Правило                                                                                                                                              | Поле выхода                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `fingerprint`                  | строка `/^[0-9a-f]{64}$/`, иначе **вся запись null**                                                                                                 | `fingerprint`                    |
| `source`                       | из `REPORT_SOURCES`, иначе null-запись                                                                                                               | `source`                         |
| `kind`                         | из `REPORT_KINDS`, иначе null-запись                                                                                                                 | `kind`                           |
| `message`                      | строка, обрезать до `limits.message`; пустая → null-запись                                                                                           | `message`                        |
| `code`                         | строка `/^[a-z0-9][a-z0-9._-]*$/i` ≤ `limits.code`, иначе `null`                                                                                     | `code`                           |
| `stack`                        | строка → обрезать до `limits.stack`; иначе `null`                                                                                                    | `stack`                          |
| `details`                      | простой объект (не массив, не null); `JSON.stringify` ≤ `limits.details` байт (`Buffer.byteLength`), иначе `{ truncated: true }`; не объект → `null` | `details`                        |
| `count`                        | целое, clamp `[1, 1_000_000]`; не число → 1                                                                                                          | `count`                          |
| `firstSeen`, `lastSeen`        | число (epoch ms) или ISO-строка; вне `[now − 7 сут, now + 5 мин]` или мусор → `now`; если `firstSeen > lastSeen` — поменять местами                  | `firstSeen`, `lastSeen` (`Date`) |
| `engineVersion`, `gameVersion` | `/^[0-9A-Za-z.+-]{1,64}$/`, иначе `null`                                                                                                             | те же                            |
| `gameId`                       | `isValidGameId(v, gameIdRules)` (передать `config.games`), иначе `null`                                                                              | `gameId`                         |
| `box`                          | `/^[a-z0-9.-]{1,253}(:\d{1,5})?$/i`, иначе `null`                                                                                                    | `box`                            |
| `mode`                         | из `REPORT_MODES`, иначе `null`                                                                                                                      | `mode`                           |
| `userAgent`                    | строка, обрезать до `limits.userAgent`, иначе `null`                                                                                                 | `userAgent`                      |

### 1.5. Репозиторий — `packages/auth/src/ClientReportRepository.js`

Отдельный класс, **не** в `UserRepository.js` (тот и так ~1100 строк).

```js
export class ClientReportNotFoundError extends Error { … }

export default class ClientReportRepository {
  constructor(db) { this._db = db; }        // db — pg Pool или заглушка { query }

  // пачка нормализованных записей → { accepted, throttled }.
  // allowNew(n) → сколько НОВЫХ отпечатков разрешено вставить (бюджет, 1.6)
  async ingest(items, { allowNew = n => n } = {}) { … }
  // точное число строк — для потолка таблицы (бюджет пересчитывает редко)
  async countRows() { … }
  // { status: 'open'|'fixed'|'ignored'|'all', gameId, limit, offset } → { reports, total }
  async list({ status = 'open', gameId = null, limit = 50, offset = 0 } = {}) { … }
  async get(id) { … }                        // строка или null
  // → обновлённая строка; нет строки → ClientReportNotFoundError
  async setStatus(id, { status, note = null, userId }) { … }
  async purge(before) { … }                  // Date → число удалённых
}
```

`ingest`:

1. **Слить дубликаты отпечатков внутри пачки в JS** (сумма `count`, min
   `firstSeen`, max `lastSeen`, остальные поля — от первого вхождения):
   `INSERT … ON CONFLICT DO UPDATE` падает, если одна команда задевает одну
   строку дважды.
2. **Разделить на известные и новые**: `SELECT fingerprint FROM
client_reports WHERE fingerprint = ANY($1::text[])`. Известные проходят
   всегда. Из новых проходят первые `allowNew(newCount)` штук (порядок — как
   в пачке); остальные — `throttled`, в БД не пишутся. Гонку «между SELECT и
   INSERT отпечаток вставил другой запрос» закрывает `ON CONFLICT` — такая
   запись просто обновит счётчик.
3. Один запрос на все прошедшие записи через `jsonb_to_recordset($1::jsonb)`:

```sql
INSERT INTO client_reports (fingerprint, source, kind, code, message, stack,
  details, engine_version, game_id, game_version, box, mode, user_agent,
  count, first_seen, last_seen)
SELECT fingerprint, source, kind, code, message, stack, details,
  engine_version, game_id, game_version, box, mode, user_agent,
  count, first_seen, last_seen
FROM jsonb_to_recordset($1::jsonb) AS r(
  fingerprint text, source text, kind text, code text, message text,
  stack text, details jsonb, engine_version text, game_id text,
  game_version text, box text, mode text, user_agent text,
  count bigint, first_seen timestamptz, last_seen timestamptz)
ON CONFLICT (fingerprint) DO UPDATE SET
  count      = client_reports.count + EXCLUDED.count,
  first_seen = LEAST(client_reports.first_seen, EXCLUDED.first_seen),
  last_seen  = GREATEST(client_reports.last_seen, EXCLUDED.last_seen),
  stack      = COALESCE(client_reports.stack, EXCLUDED.stack),
  details    = COALESCE(client_reports.details, EXCLUDED.details)
```

В JSON-параметре — snake_case-ключи, даты — ISO-строки. **Статус при
повторе не меняется** (решение 4 в README). Прошедших нет — запрос не
делать. 4. Вернуть `{ accepted: <прошедших после слияния>, throttled: <отсечённых
   новых> }`.

`countRows`: `SELECT count(*)::bigint AS n FROM client_reports` → `Number(n)`.

`list`: `WHERE` собирается из `status` (кроме `'all'`) и `gameId`;
`ORDER BY last_seen DESC, id DESC LIMIT $n OFFSET $m`; `total` — отдельный
`SELECT count(*)` с тем же `WHERE`. Колонки наружу — все, кроме `status_by`
(вместо него — `u.nick AS status_by_nick` через
`LEFT JOIN users u ON u.id = client_reports.status_by`). Возвращать
camelCase-объекты: `id, fingerprint, source, kind, code, message, stack,
details, engineVersion, gameId, gameVersion, box, mode, userAgent, count`
(числом: `Number(row.count)` — `pg` отдаёт BIGINT строкой), `firstSeen,
lastSeen, status, statusNote, statusByNick, statusAt` (даты — ISO-строки).

`setStatus`: `UPDATE client_reports SET status = $2, status_note = $3,
status_by = $4, status_at = now() WHERE id = $1 RETURNING *`.

`purge`: `DELETE FROM client_reports WHERE last_seen < $1` → `rowCount`.

### 1.6. Бюджет новых строк — `packages/auth/src/lib/ClientReportBudget.js`

В памяти процесса (auth-сервис — один процесс; после рестарта бюджеты
начинаются заново, это допустимо). Не зависит от БД — тестируется
отдельно.

```js
export default class ClientReportBudget {
  /**
   * @param {Object} opts - config.clientReports.budget
   * @param {Function} [opts.now]
   */
  constructor({ newPerIpPerHour, newGlobalPerHour, maxRows, now = Date.now }) { … }

  // текущее число строк: задаёт вход (пересчёт count(*)), растёт от take()
  setRows(n) { … }

  // сколько из wanted новых строк разрешено ключу ip прямо сейчас;
  // разрешённое сразу списывается из обоих бюджетов и прибавляется к строкам
  take(ip, wanted) { … }

  // { reason, skipped } — сводка отсечённого с прошлого вызова, для журнала
  drainThrottled() { … }
}
```

- Окна — **фиксированные часовые** (`Math.floor(now() / 3600000)`): при
  смене часа счётчики обнуляются. Скользящее окно здесь не нужно.
- `take(ip, wanted)`: `allowed = min(wanted, perIpLeft(ip), globalLeft,
maxRows − rows)`, не меньше 0; списать; запомнить отсечённое и причину
  (`'ip' | 'global' | 'maxRows'` — та, что ограничила сильнее).
- Счётчики по IP — `Map`; при смене часа — очистить целиком (растущей
  памяти нет).

Подключение в `main.js`:

```js
const clientReportBudget = new ClientReportBudget(config.clientReports.budget);

// потолок таблицы: точный count(*) на старте и раз в rowsRecountMs —
// между пересчётами число строк ведёт сам бюджет (take прибавляет)
const recountClientReports = () =>
  clientReportRepo
    .countRows()
    .then(n => clientReportBudget.setRows(n))
    .catch(err => console.error('[client-reports] recount failed:', err.message));

recountClientReports();
setInterval(recountClientReports, config.clientReports.budget.rowsRecountMs).unref?.();
```

Журнал отсечений — не чаще раза в час, одной строкой (тем же интервалом
или отдельным `setInterval(…, 3600000).unref?.()`):
`[client-reports] throttled N new reports (reason: ip|global|maxRows)` —
только если `N > 0`. Удаление строк суточной очисткой (1.7) бюджет узнает
при ближайшем пересчёте.

### 1.7. Суточная очистка — `packages/auth/src/db/clientReportsPurgeJob.js`

Повторить структуру `db/gamesPurgeJob.js` один в один:
`purgeOldClientReports(db, { now })` (граница
`now − config.clientReports.retentionDays` суток, вызывает
`new ClientReportRepository(db).purge(before)`, логирует
`[client-reports] purged N`), `startClientReportsPurgeJob(db)` с тем же
`msUntilNextRun` (импортировать из `gamesPurgeJob.js`, не копировать).

### 1.8. Маршруты в `packages/auth/src/main.js`

1. Импорты: `ClientReportRepository`, `ClientReportNotFoundError`,
   `ClientReportBudget`, `requireServiceToken`, `normalizeReportItem`,
   `REPORT_STATUSES`, `startClientReportsPurgeJob`, `clientIp` (из
   `./lib/clientIp.js` — тот же, что внутри `lib/rateLimit.js`).
2. `const clientReportRepo = new ClientReportRepository(dbPool.getPool());`
   и бюджет с пересчётом строк — как в 1.6.
3. Лимитер рядом с остальными:
   `const clientReportsLimiter = new RateLimiter({ limit: 120, windowMs: 60000 });`
   (клиенты — только боксы, лимит против мусора с чужих адресов).
4. **Приём регистрируется сразу после `const app = express();` и ДО
   `app.use(express.json({ limit: '16kb' }))`** — со своим парсером, иначе
   глобальный парсер ответит 413 на любую пачку больше 16 КБ:

```js
// приём журнала клиентских ошибок от боксов (plan/client-reports): свой
// парсер тела — пачка со стеками не влезает в общий лимит 16 КБ
app.post(
  '/client-reports',
  byIp(clientReportsLimiter),
  requireServiceToken(config.clientReports.token),
  express.json({ limit: config.clientReports.bodyLimit }),
  async (req, res) => { … },
);
```

Тело — `{ items: [...] }`. Не массив или длина вне
`[1, config.clientReports.maxBatch]` → `400 { error: 'badRequest' }`.
Каждую запись — через `normalizeReportItem(item, { limits, gameIdRules:
   config.games })`; ни одной годной → `400 { error: 'badRequest' }`. Иначе:

```js
const ip = clientIp(req, { trustProxy: isProduction });
const { accepted, throttled } = await clientReportRepo.ingest(valid, {
  allowNew: n => clientReportBudget.take(ip, n),
});

res.json({ accepted, throttled, rejected: items.length - valid.length });
```

Отсечённое бюджетом — **не ошибка**: ответ `200`, бокс такую пачку не
повторяет (этап 2). `byIp` уже есть в файле; `requireServiceToken` стоит
до парсера, чтобы чужой запрос не заставлял парсить 2 МБ. 5. Админские маршруты рядом с `/admin/games`:

- `GET /admin/client-reports` (`requireAdmin`): `status` из
  `[...REPORT_STATUSES, 'all']`, по умолчанию `'open'`, иначе 400;
  `gameId` — необязательный, `isValidGameId(gameId, config.games)`, иначе
  400; `limit = clampLimit(req.query.limit, 50,
config.clientReports.listMaxLimit)`; `offset` — целое `[0, 100000]`,
  иначе 0. Ответ — `{ reports, total }`.
- `PATCH /admin/client-reports/:id` (`requireAdmin`): `id` —
  `/^\d{1,18}$/`, иначе 400; тело `{ status, note }`: `status` из
  `REPORT_STATUSES` обязателен; `note` — `undefined`/`null` или строка
  ≤ `limits.note`, иначе 400. `ClientReportNotFoundError` →
  `404 { error: 'unknownReport' }`. Ответ — `{ report }`.

6. Рядом с `startGamesPurgeJob(dbPool.getPool())`:
   `startClientReportsPurgeJob(dbPool.getPool());`
7. В блоке `if (isProduction)` в начале файла — **не** `process.exit`, а
   предупреждение: приём необязателен.

```js
if (!env.VIMP_CLIENT_REPORTS_TOKEN) {
  console.warn('[auth] VIMP_CLIENT_REPORTS_TOKEN is not set — POST /client-reports answers 503');
}
```

## Тесты (`tests/auth/`, проект vitest `auth`)

- `serviceToken.test.js`: пустой `expected` → `false` и middleware отвечает
  503; нет заголовка / не Bearer / неверный токен → 401; верный → `next()`;
  токены разной длины не бросают.
- `clientReportValidators.test.js`: плохой отпечаток/вид/источник → `null`;
  обрезка `message`/`stack`/`userAgent`; `details` > лимита →
  `{ truncated: true }`, массив → `null`; `count` clamp; даты вне окна →
  `now`, перепутанные — меняются местами; версии и `gameId` с мусором →
  `null`; неизвестные поля не проходят.
- `ClientReportRepository.test.js` (заглушка `createDbStub`): `ingest`
  сливает дубликаты (одна строка, сумма `count`, min/max дат); известные
  отпечатки (ответ заглушки на `SELECT … ANY`) проходят при `allowNew: () =>
0`, новые — отсекаются и попадают в `throttled`; при `allowNew: n => 1`
  проходит ровно первый новый; всё прошедшее — **одним** `INSERT` с
  JSON-параметром, без прошедших `INSERT` не выполняется; `countRows`;
  `list` строит `WHERE` для `open`/`all`/`gameId`, отдаёт `total`;
  `setStatus` на пустом `rowCount` бросает `ClientReportNotFoundError`;
  `purge` возвращает `rowCount`.
- `ClientReportBudget.test.js` (инжектируемый `now`): бюджет по IP
  исчерпывается и не трогает другой IP; общий бюджет режет всех; потолок
  `maxRows` (после `setRows`) режет и растёт от `take`; смена часа обнуляет
  счётчики; `drainThrottled` отдаёт сумму и причину и обнуляется.
- `clientReportsPurgeJob.test.js` — по образцу
  `tests/auth/gamesPurgeJob.test.js` (граница удаления = retentionDays).

## Документация

- `docs/en/auth.md` + `docs/ru/auth.md` — новый раздел «Client reports»:
  назначение, `POST /client-reports` (Bearer-секрет, тело, лимиты, коды
  ответов 200/400/401/429/503), `GET`/`PATCH /admin/client-reports`
  (параметры, статусы), таблица `client_reports` (кратко), правило «статус
  при повторе не меняется, новая версия — новая строка», **защита от спама**
  (ограничиваются новые строки: 2000/час на IP отправителя, 10 000/час
  всего, потолок 200 000 строк; повторы считаются всегда; ответ
  `throttled`; строка `[client-reports] throttled …` раз в час; почему ключ
  — IP, а не `box`), очистка через 90 суток, переменная
  `VIMP_CLIENT_REPORTS_TOKEN`. Если в `auth.md` есть таблица
  env-переменных — дописать туда.

## Проверка

```bash
npx eslint .
npx vitest run --project auth --reporter=dot
npm test --silent
```

Ручная (локальный Postgres, см. `docs/en/auth.md`):

```bash
npm run auth:db:migrate
VIMP_CLIENT_REPORTS_TOKEN=dev-token npm run dev:auth

curl -s -X POST http://localhost:3010/client-reports \
  -H 'authorization: Bearer dev-token' -H 'content-type: application/json' \
  -d '{"items":[{"fingerprint":"'$(printf 'a%.0s' {1..64})'","source":"client","kind":"error","message":"probe","count":2,"firstSeen":'$(date +%s000)',"lastSeen":'$(date +%s000)',"box":"localhost:3002","mode":"lobby"}]}'
# → {"accepted":1,"throttled":0,"rejected":0}; повтор → count в БД = 4
```

Бюджет: временно выставить `budget.newPerIpPerHour: 1` (правкой конфига
локально, не коммитить) → второй **новый** отпечаток даёт `"throttled":1`,
а повтор первого по-прежнему увеличивает `count`.

Админский GET — с токеном админа (dev-вход `GET /dev/login?nick=<ник из
VIMP_ADMIN_NICKS>&returnUrl=…`, см. `packages/auth/src/devLogin.js`):
`curl -H 'authorization: Bearer <jwt>' 'http://localhost:3010/admin/client-reports?status=all'`.

## Готово, когда

- миграция идемпотентна (двойной `npm run auth:db:migrate` без ошибок);
- приём, список и смена статуса работают по ручной проверке;
- новые строки режутся бюджетом (по IP, общим, потолком таблицы), повторы
  известных отпечатков считаются всегда;
- тесты и линт зелёные, `docs/en|ru/auth.md` обновлены;
- заголовок этого файла и строка в `README.md` помечены «✅ выполнен».
