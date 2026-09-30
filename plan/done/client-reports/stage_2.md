# Этап 2. Боксы: приём `POST /client-reports`, пересылка в auth, деплой секрета ✅ выполнен

Репозиторий: `vimp`. Зависит от этапа 1 (приёмник в auth). Код —
`packages/engine/src/master/clientReports/` (новый каталог; `src/master/` в
npm не публикуется), подключение в `src/master/lobby.js` и
`src/dedicated/main.js`, конфиг в `src/config/` (**публикуется в npm** —
отметить в отчёте), деплой в `.github/workflows/deploy.yml`.

## Цель

Каждый бокс (лобби-мастер и dedicated) принимает отчёты браузера по
same-origin `POST /client-reports`, режет и проверяет их, считает отпечаток,
агрегирует повторы в памяти, печатает строку в журнал процесса на каждый
**новый** отпечаток и раз в 30 с пересылает пачки в auth-сервис по общему
секрету. Спам сдерживают лимит запросов по адресу (IPv6 — по подсети /64) и
**бюджет новых отпечатков на бокс**; отброшенное считается и видно в журнале
служебной записью `reports.dropped` (решение 9 в `README.md`). Без секрета
или без auth-сервиса бокс работает в режиме «только журнал процесса» —
приём никогда не ломает бокс.

## Что прочитать перед началом

- `README.md` этого плана — решения 2–6 и схема.
- `packages/engine/src/master/lobby.js`: порядок middleware
  (`app.use(securityHeaders(...))` стр. ~317; dev-маршрут `/debug/report` со
  **своим** парсером стр. ~326–349; затем глобальный `app.use(express.json())`
  стр. ~350); `limitSubmits` + `RateLimiter` (стр. ~119–131) как образец
  лимита; `security.createOriginValidator` (стр. ~303); чтение
  `config.get('master:security:authServiceUrl')`; `engineDir` (стр. ~40).
- `packages/engine/src/dedicated/main.js`: `const app = express()` +
  `securityHeaders` (стр. ~416–418), `clientIp(req, { trustProxy:
isProduction })` (стр. ~556), чтение `authServiceUrl` (стр. ~226), раздел
  «graceful shutdown» (стр. ~624) и `shutdown()` (стр. ~726) — там
  `dedicated.close()`.
- `packages/engine/src/lib/security.js` — `createOriginValidator({ protocol,
domain, port })` возвращает **колбэк-функцию** `(origin, cb)`, `cb(err)`
  зовётся на `process.nextTick`; `err === null` — origin разрешён (в проде —
  только `https://<domain>`, плюс `localhost`/`127.0.0.1` на порту).
- `packages/engine/src/lib/clientIp.js` — `clientIp(req, { trustProxy })`
  (за Nginx — только `X-Real-IP`).
- `packages/engine/src/lib/rateLimiter.js` — `new RateLimiter({ limit,
windowMs })`, `consume(key) → boolean`, `sweep()`.
- `packages/engine/src/config/env.js` (`applyMasterEnv`) и
  `packages/engine/src/config/master.js` — как env попадает в конфиг.
- `packages/engine/src/master/HostRatingProxy.js` — образец вызова auth
  (`fetchImpl` в конструкторе для тестов).
- `.github/workflows/deploy.yml`: job боксов (шаг «Deploy to ${{
  matrix.domain }}», `env:` + список `envs:` — **имя, не перечисленное в
  `envs:`, в скрипт не пробрасывается** — и блок «Generating .env config»);
  job auth-стека (идемпотентная перезапись `VIMP_ADMIN_NICKS` в
  `.env.prod`, «пустое значение строку не трогает»).

## Контракт браузер → бокс (его же реализует этап 3)

`POST /client-reports`, `Content-Type: application/json`, тело ≤ 16 КБ:

```json
{
  "v": 1,
  "sessionId": "uuid v4, один на вкладку",
  "context": {
    "mode": "lobby | dedicated | solo",
    "role": "client | host",
    "gameId": "tanks | null",
    "gameVersion": "0.22.7 | null",
    "page": "/ (только pathname, ≤ 128)",
    "userAgent": "≤ 256"
  },
  "items": [
    {
      "kind": "error | rejection | worker | warn | csp",
      "source": "client | host-worker | plugin",
      "code": "tanks.camera.missing | null",
      "message": "≤ 500",
      "stack": "≤ 4000 | null",
      "details": { "…": "простой объект ≤ 2048 байт JSON | null" },
      "count": 1,
      "firstAt": 1758900000000,
      "lastAt": 1758900000000
    }
  ]
}
```

Ответы: `204` — принято (в том числе частично); `400 { error:
'badRequest' }`; `403 { error: 'forbiddenOrigin' }`; `413` (парсер);
`429 { error: 'rateLimited' }`. Клиент ответ не читает (sendBeacon).

## Шаги

### 2.1. Конфиг

`packages/engine/src/config/master.js` — блок рядом с `security`:

```js
// журнал клиентских ошибок (plan/client-reports): приём POST
// /client-reports на боксе и пересылка пачками в auth-сервис. Пустой
// token — пересылка выключена, остаётся строка в журнале процесса
clientReports: {
  token: '',
  flushIntervalMs: 30000,
  forwardBatch: 50,
  forwardTimeoutMs: 5000,
  maxPending: 500,        // потолок разных отпечатков в буфере
  logSeenMax: 5000,       // сколько отпечатков процесс помнит «уже печатал»
  // бюджет НОВЫХ отпечатков на бокс (решение 9 плана): распределённый спам
  // обходит лимит по IP, а новая строка в auth — главный ресурс. Повторы
  // известных отпечатков бюджет не тратят
  newFingerprintsPerMinute: 60,
  // ключ — адрес, для IPv6 — подсеть /64 (lib/clientIp.js → rateLimitKey)
  rateLimit: { limit: 10, windowMs: 60000 },
  bodyLimit: '16kb',
  maxItemsPerRequest: 10,
},
```

`packages/engine/src/config/env.js`, в `applyMasterEnv`:

```js
// общий секрет бокса и auth-сервиса для пересылки журнала клиентских
// ошибок (plan/client-reports)
if (env.VIMP_CLIENT_REPORTS_TOKEN) {
  config.set('master:clientReports:token', env.VIMP_CLIENT_REPORTS_TOKEN);
}
```

Проверить, что `applyMasterEnv` вызывается и лобби (`lobby.js:75`), и
dedicated (`dedicated/main.js:702`) — да, оба.

### 2.2. Ключ лимита для IPv6 — `packages/engine/src/lib/clientIp.js`

`src/lib` **публикуется в npm** — отметить в отчёте. Рядом с `clientIp`:

```js
// Ключ rate-limit'а по адресу: IPv4 — сам адрес, IPv6 — подсеть /64.
// Провайдер выдаёт абоненту /64 целиком, то есть у одного человека
// 2^64 адресов, и лимит «на адрес» для IPv6 не лимит вовсе
export function rateLimitKey(ip) { … }
```

- `''` → `''` (вызывающий трактует как «адреса нет»).
- IPv4-mapped `::ffff:1.2.3.4` → `1.2.3.4`; IPv4 → как есть.
- IPv6: убрать зону (`%eth0`), развернуть `::` до 8 групп, взять первые 4
  группы без ведущих нулей в нижнем регистре → `v6:2001:db8:0:1::/64`.
- Непарсимое → строка как есть (лимит всё равно сработает — по строке).

Этой задачей хелпер применяется **только** к маршруту журнала; остальные
лимитеры — отдельная задача (README, «Вне объёма»).

### 2.3. Модули `packages/engine/src/master/clientReports/`

**`limits.js`** — длины полей (одни на приём и на санитайз):
`MESSAGE = 500`, `STACK = 4000` (сырой, от клиента), `STACK_SYMBOLICATED =
8000` (после этапа 4), `CODE = 64`, `DETAILS_BYTES = 2048`, `USER_AGENT =
256`, `PAGE = 128`, `SESSION_ID = 64`.

**`engineVersion.js`** — версия движка бокса, читается один раз:

```js
import fs from 'node:fs';

// версию штампует бокс, а не клиент (решение 5 плана): клиент движка
// раздаёт этот же бокс из своего образа
export const ENGINE_VERSION = JSON.parse(
  fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
).version;
```

(`src/master/clientReports/` → `../../../package.json` =
`packages/engine/package.json`; проверить путь тестом.)

**`sanitize.js`** — `sanitizeClientReport(body) → { sessionId, context,
items }`, бросает `Error` с `status = 400` на неверной форме:

- `body` — объект, `body.v === 1`, `items` — массив длиной
  `1..maxItemsPerRequest` (передаётся аргументом), иначе 400;
- `sessionId` — строка `/^[0-9a-f-]{8,64}$/i`, иначе `null` (не 400);
- `context.mode` ∈ `lobby|dedicated|solo`, `context.role` ∈ `client|host`
  (иначе `null`); `gameId` — `/^[a-z][a-z0-9-]{1,30}$/` (как `idPattern`
  auth-сервиса), иначе `null`; `gameVersion` — `/^[0-9A-Za-z.+-]{1,64}$/`,
  иначе `null`; `page`, `userAgent` — строки с обрезкой, иначе `null`;
- item: `kind` ∈ `error|rejection|worker|warn|csp`, `source` ∈
  `client|host-worker|plugin` — иначе item **отбрасывается** (в том числе
  `source: 'box'`: служебные записи порождает только сам бокс);
  `message` — строка, обрезка, пустая → отбросить; `code` —
  `/^[a-z0-9][a-z0-9._-]*$/i` ≤ `CODE` или `null`; `stack` — обрезка или
  `null`; `details` — простой объект ≤ `DETAILS_BYTES` байт JSON, больше →
  `{ truncated: true }`, иначе `null`; `count` — целое clamp `[1, 10000]`;
  `firstAt`/`lastAt` — числа в окне `[now − 1 сут, now + 5 мин]`, иначе
  `now`;
- если после отбора items пуст → 400;
- любые неизвестные поля не проходят; **клиентское `engineVersion`
  игнорируется** (его нет в схеме).

**`fingerprint.js`**:

```js
// сообщение без «шума» экземпляра: числа и длинные hex-идентификаторы
export function normalizeMessage(message) { … }  // \d+ → N, [0-9a-f]{8,} → H, trim, ≤ 200
// первый кадр стека как `<pathname>:<line>:<col>` или null
export function rawTopFrame(stack) { … }
export function computeFingerprint({ source, kind, code, message, stack,
  engineVersion, gameId, gameVersion, extra = null }) { … }   // sha256 hex (node:crypto)
```

- `rawTopFrame` понимает оба формата: V8 — `    at fn (https://h/p.js:84:46108)`
  и `    at https://h/p.js:84:46108`; Firefox/Safari — `fn@https://h/p.js:84:46108`.
  Берётся первая строка, где нашёлся URL с `:line:col`; от URL остаётся
  `pathname` (`new URL(url).pathname`); непарсимый URL → строка как есть.
- `computeFingerprint`: `sha256(JSON.stringify([source, kind, code ??
normalizeMessage(message), rawTopFrame(stack), engineVersion, gameId,
gameVersion]))`; если `extra !== null` — он дописывается последним
  элементом массива (служебной записи бокса — его домен, чтобы у каждого
  бокса была своя строка `reports.dropped`).

**`ClientReportBuffer.js`** — агрегат в памяти:

```js
export default class ClientReportBuffer {
  constructor({ maxPending = 500, logSeenMax = 5000,
    newPerMinute = 60, now = Date.now } = {}) { … }
  has(fingerprint) { … }
  // известный = в буфере ИЛИ уже принимался процессом (_logged)
  isKnown(fingerprint) { … }
  // можно ли сейчас принять НОВЫЙ отпечаток (бюджет и место), без списания —
  // маршрут спрашивает ДО расшифровки стека, чтобы спам не жёг CPU
  canAcceptNew() { … }        // → null | 'budget' | 'bufferFull'
  // учесть отброшенный новый отпечаток (маршрут, получив отказ canAcceptNew)
  countDropped(reason) { … }
  // entry — полная запись для auth (поля этапа 1: fingerprint, source, kind,
  // code, message, stack, details, count, firstSeen, lastSeen, engineVersion,
  // gameId, gameVersion, box, mode, userAgent).
  // → { accepted, isNew }: accepted — запись в буфере; isNew — процесс видит
  // отпечаток впервые (для строки в журнале)
  add(entry) { … }
  drain(max) { … }       // снимает до max записей (старые по lastSeen — первыми)
  // вернуть неотправленное: сложить count, min/max дат; В ОБХОД бюджета
  // (это уже принятые записи), но не больше maxPending
  restore(entries) { … }
  // { budget, bufferFull } с прошлого вызова, счётчики обнуляются
  drainDropped() { … }
  get size() { … }
}
```

- В буфере один объект на отпечаток: повтор — `count += entry.count`,
  `firstSeen = min`, `lastSeen = max`, остальное — от первого. **Повтор
  отпечатка, лежащего в буфере, принимается всегда** — ни бюджет, ни
  переполнение его не касаются.
- Новый отпечаток: `canAcceptNew()` — если бюджет минуты
  (`newPerMinute`, фиксированное окно `Math.floor(now() / 60000)`) исчерпан
  → `'budget'`; если `size >= maxPending` → `'bufferFull'`; иначе `null`.
  `add` сам повторяет проверку (на случай вызова без неё), при отказе —
  `countDropped(reason)` и `{ accepted: false }`, при успехе — списывает
  единицу бюджета.
- `isNew` считается по отдельному `Set` «уже печатал», ограниченному
  `logSeenMax` (при переполнении — очистить целиком: лучше повторная строка
  в журнале, чем растущая память).
- **Известный отпечаток** — есть в буфере **или** в «уже печатал» (ушёл
  пересылкой). В «уже печатал» попадают только принятые записи, поэтому
  спамер пополняет его не быстрее бюджета. Известный, но отсутствующий в
  буфере: бюджет не тратит, `isNew = false`, но требует места — при
  `size >= maxPending` → `countDropped('bufferFull')`, `{ accepted: false }`.
  Расшифрованный стек не теряется: auth хранит первый присланный
  (`COALESCE`). Край: если auth срезал самую первую пересылку бюджетом,
  строка создастся повтором уже с сырым стеком — допустимо.

**Служебная запись `reports.dropped`** — в `index.js` (ему известен бокс),
функция `makeDroppedEntry({ budget, bufferFull })` → запись для auth или
`null`, если оба нуля:

- `source: 'box'`, `kind: 'warn'`, `code: 'reports.dropped'`,
  `message: 'dropped N new client reports'` (N — сумма),
  `details: { budget, bufferFull, windowMs: flushIntervalMs }`,
  `count: N`, `firstSeen = lastSeen = now`, `engineVersion`, `box`,
  `mode: box.mode`, `gameId`/`gameVersion`/`userAgent`/`stack` — `null`;
- `fingerprint = computeFingerprint({ source: 'box', kind: 'warn', code:
'reports.dropped', message, engineVersion, gameId: null, gameVersion:
null, extra: box.domain })` — одна строка на бокс и версию движка, её
  `count` копит общее число отброшенного;
- при создании — строка в журнал процесса
  `[vimp:client-report] dropped N new reports (budget: B, bufferFull: F)`
  (независимо от того, включена ли пересылка).

**`ClientReportForwarder.js`**:

```js
export default class ClientReportForwarder {
  constructor({ buffer, authServiceUrl, token, fetchImpl = fetch,
    intervalMs = 30000, batchSize = 50, timeoutMs = 5000, log = console,
    // служебные записи тика (reports.dropped): зовётся в начале каждого
    // flush, результат идёт первой пачкой в обход бюджета буфера
    extraEntries = () => [] }) { … }
  get enabled() { … }   // token && authServiceUrl
  // setInterval(flush, intervalMs) + .unref(); при выключенной пересылке
  // тик зовёт extraEntries(), отбрасывает результат и опустошает буфер
  start() { … }
  async flush() { … }   // пока буфер не пуст: drain(batchSize) → POST
  async stop() { … }    // clearInterval + последний flush (для graceful shutdown)
}
```

- `POST ${authServiceUrl}/client-reports`, заголовки `authorization: Bearer
${token}`, `content-type: application/json`, тело `{ items }` (даты —
  epoch ms, auth принимает оба формата), `signal: AbortSignal.timeout(timeoutMs)`.
- В начале `flush`: `extraEntries()` → если не пусто, эти записи уходят
  первыми (вместе с первой порцией `drain`, не превышая `batchSize`).
  `extraEntries` зовётся **и при выключенной пересылке** — тогда записи
  просто отбрасываются (строку в журнал уже написал `makeDroppedEntry`),
  чтобы счётчики отброшенного не копились вечно, и буфер опустошается
  (`drain(Infinity)`, результат отбрасывается): строки `new …` уже напечатаны,
  а неопустошаемый буфер после `maxPending` отпечатков отсекал бы все новые
  как `bufferFull` и глушил журнал процесса.
- `2xx` — дальше. Ответ auth `{ accepted, throttled, rejected }`: если
  `throttled > 0` — строка `[vimp:client-report] auth throttled N new reports`
  **не чаще раза в час** (сумма за час); отсечённое auth **не
  возвращается** в буфер — это не сбой, а решение auth.
- Иначе (статус ≥ 300 или исключение) — `buffer.restore(batch)`, выйти из
  цикла до следующего тика, записать **одну** строку на серию отказов:
  `[vimp:client-report] forward failed: <status|message>` (флаг «уже
  сообщал», сбрасывается первым успехом). `400` от auth — тоже отказ, но
  пачка **не** возвращается (иначе вечный цикл) — строка в журнал.
- Параллельные `flush` не допускаются (флаг «идёт отправка»).

**`createClientReportRoute.js`**:

```js
import express from 'express';

/**
 * @returns {Function[]} middleware для app.post('/client-reports', ...route)
 */
export function createClientReportRoute({
  buffer, limiter, checkOrigin, trustProxy,
  box,                 // { domain, mode: 'lobby'|'dedicated', engineVersion }
  bodyLimit = '16kb', maxItemsPerRequest = 10,
  symbolicate = null,  // этап 4: async (stack) => stack
  log = console,
}) { … }
```

Порядок проверок в обработчике:

1. `const key = rateLimitKey(clientIp(req, { trustProxy }))`; пустой `key`
   или `!limiter.consume(key)` → `429 { error: 'rateLimited' }`. Лимит стоит
   **до** парсера тела (сначала middleware лимита, потом `express.json({
limit })`, потом обработчик).
2. `origin = req.get('origin')`; если есть — промисифицировать
   `checkOrigin(origin, cb)`; `err` → `403 { error: 'forbiddenOrigin' }`.
   Нет заголовка — пропустить (same-origin навигационные запросы его могут
   не нести; злоупотребление всё равно режет лимит).
3. `sanitizeClientReport(req.body, { maxItemsPerRequest })`; ошибка со
   `status` → `400 { error: 'badRequest' }`.
4. Для каждого item: `fingerprint = computeFingerprint({ ...item,
engineVersion: box.engineVersion, gameId: context.gameId, gameVersion:
context.gameVersion })`. Если отпечаток **совсем новый**
   (`!buffer.isKnown(fp)` — ни в буфере, ни среди уже принимавшихся):
   - `reason = buffer.canAcceptNew()`; не `null` → `buffer.countDropped(reason)`,
     item пропускается (**без** расшифровки — спам не жжёт CPU);
   - иначе, если `symbolicate && item.stack` — `stack = await
symbolicate(item.stack)` в `try/catch` (ошибка расшифровки → сырой
     стек).

   Затем `buffer.add({ fingerprint, source, kind, code, message, stack,
details, count, firstSeen: firstAt, lastSeen: lastAt, engineVersion:
box.engineVersion, gameId, gameVersion, box: box.domain, mode:
context.mode ?? box.mode, userAgent })`.

5. `isNew` → одна строка:
   `[vimp:client-report] new <fp[0..8]> <kind>/<source> <code ?? message[0..120]> (<gameId>@<gameVersion>, engine <engineVersion>)`.
6. `res.status(204).end()` — **и когда часть или все записи отброшены
   бюджетом**: отправителю незачем знать, что его режут (спамеру это
   подсказка, честному клиенту — бесполезно).

Весь обработчик в `try/catch`: неожиданная ошибка → `500 { error:
'internal' }` + строка в журнал; бокс не падает.

**`index.js`** — сборка для входов, чтобы не дублировать код в лобби и
dedicated:

```js
// → { route, forwarder } ; route — массив middleware, forwarder.start() зовёт вход
export function createClientReports({ config, box, trustProxy, checkOrigin,
  symbolicate = null, fetchImpl, log }) { … }
```

Внутри: `ClientReportBuffer` из `config.get('master:clientReports:*')`
(включая `newFingerprintsPerMinute` → `newPerMinute`), `RateLimiter` из
`…:rateLimit`, `ClientReportForwarder` с
`config.get('master:security:authServiceUrl')`, `…:token` и `extraEntries:
() => [makeDroppedEntry(buffer.drainDropped())].filter(Boolean)`,
`createClientReportRoute(...)`. Лимитеру нужна периодическая `sweep()` — тем
же `setInterval` (`.unref()`), что и flush, или отдельным. При выключенной
пересылке `forwarder.start()` всё равно заводит таймер, который только
вызывает `extraEntries()` (строка в журнал об отброшенном и сброс
счётчиков).

### 2.4. Подключение в лобби — `packages/engine/src/master/lobby.js`

Сразу **после** блока `if (!isProduction) { … /debug/report … }` и **до**
`app.use(express.json())` (у маршрута свой парсер с лимитом 16 КБ):

```js
// журнал клиентских ошибок (plan/client-reports): браузер шлёт на свой же
// бокс (same-origin — ни CSP, ни CORS), бокс пересылает пачками в auth
const clientReports = createClientReports({
  config,
  box: {
    domain: config.get('master:domain'),
    mode: 'lobby',
    engineVersion: ENGINE_VERSION,
  },
  trustProxy: isProduction,
  checkOrigin: security.createOriginValidator({
    protocol: config.get('master:protocol'),
    domain: config.get('master:domain'),
    port: config.get('master:port'),
  }),
});

app.post('/client-reports', ...clientReports.route);
clientReports.forwarder.start();
```

(`security` уже импортирован в `lobby.js` — проверить имя импорта.)
Обработчика `SIGTERM` в лобби нет — **не добавлять** (он отменил бы выход
процесса по умолчанию); потеря ≤ 30 с отчётов при передеплое допустима.
Если выключен токен, при старте одна строка:
`[vimp:client-report] forwarding disabled (no VIMP_CLIENT_REPORTS_TOKEN) — logging only`.

### 2.5. Подключение в dedicated — `packages/engine/src/dedicated/main.js`

После `app.use(securityHeaders({ isProduction }))` — тот же вызов с
`mode: 'dedicated'`. В реализации `close()` (раздел «graceful shutdown»,
стр. ~624, её зовёт `shutdown()`) — `await clientReports.forwarder.stop()`
**с потолком 3 с** (`Promise.race` с таймером), чтобы остановка не зависла на
недоступном auth.

### 2.6. Деплой — `.github/workflows/deploy.yml`

Job боксов (шаг «Deploy to ${{ matrix.domain }}»):

1. `env:` — `VIMP_CLIENT_REPORTS_TOKEN: ${{ secrets.CLIENT_REPORTS_TOKEN }}`
   с комментарием.
2. `envs:` — дописать `VIMP_CLIENT_REPORTS_TOKEN` в список (иначе ssh-action
   его не пробросит).
3. Блок «Generating .env config»:

```bash
if [ -n "$VIMP_CLIENT_REPORTS_TOKEN" ]; then
  echo "VIMP_CLIENT_REPORTS_TOKEN=$VIMP_CLIENT_REPORTS_TOKEN"
fi
```

Job auth-стека (шаг с `envs: AUTH_SERVICE_URL,VIMP_ADMIN_NICKS,…`):

1. `env:` + `envs:` — `VIMP_CLIENT_REPORTS_TOKEN`.
2. Рядом с блоком `VIMP_ADMIN_IDENTITIES` — идемпотентная перезапись той же
   формы (пустое значение строку **не** трогает, `chmod 600`), с
   сообщениями `🔑 Updating VIMP_CLIENT_REPORTS_TOKEN...` /
   `… is empty — keeping the value already on the server`. Контейнер auth
   уже пересоздаётся ниже в этом шаге — проверить, что пересоздание идёт
   **после** перезаписи (env_file читается только при создании контейнера).

Ни Nginx, ни CSP не меняются (same-origin, `location /` уже проксирует всё).

## Тесты (`tests/master/`, проект `engine-node`)

- `tests/lib/clientIp.test.js` (файл есть — дописать): `rateLimitKey` —
  IPv4 как есть; `::ffff:1.2.3.4` → `1.2.3.4`; два адреса
  одной /64 (`2001:db8:0:1::a`, `2001:db8:0:1:ffff::1`) → один ключ, соседняя
  /64 → другой; сокращённая запись `::1`, зона `%eth0`, мусор, `''`.
- `clientReportsSanitize.test.js`: `v !== 1` → 400; пустые/лишние items;
  отбрасывание неизвестных `kind`/`source`, **включая `source: 'box'`**;
  обрезки; `details` > лимита; окно дат; `engineVersion` из тела не
  проходит.
- `clientReportsFingerprint.test.js`: V8 и Firefox-кадры → одинаковый
  `pathname:line:col`; `normalizeMessage` (числа, hex); отпечаток зависит от
  версий и `extra` и не зависит от `count`/времени.
- `ClientReportBuffer.test.js` (инжектируемый `now`): слияние повторов,
  `isNew` один раз; **бюджет**: 61-й новый отпечаток за минуту →
  `canAcceptNew() === 'budget'`, а повтор уже известного принимается; смена
  минуты возвращает бюджет; **переполнение**: при `size === maxPending` новый
  → `'bufferFull'`, повтор известного → принят; `drainDropped` отдаёт
  счётчики по причинам и обнуляет; `drain` по старшинству; `restore`
  складывает и не тратит бюджет.
- `ClientReportForwarder.test.js` (заглушка `fetchImpl`): успех опустошает
  буфер пачками по `batchSize`; `extraEntries` уходят первыми; ответ с
  `throttled > 0` — без `restore`, строка журнала не чаще раза в час;
  `500`/исключение — `restore` и одна строка журнала на серию; `400` — без
  `restore`; выключен без токена — `fetch` не зовётся, но `extraEntries`
  вызывается и счётчики сбрасываются; нет параллельных `flush`; `stop()`
  делает последний `flush`.
- `makeDroppedEntry` (в тесте `index.js` или отдельном): нули → `null`;
  иначе запись `source: 'box'`, `code: 'reports.dropped'`, `count` = сумма,
  отпечаток зависит от домена бокса; строка в журнал.
- `clientReportRoute.test.js`: собрать `express()` с маршрутом и дёрнуть
  через `http` (`app.listen(0)` + `fetch` на `127.0.0.1`) или вызвать
  middleware с фейковыми `req/res` — посмотреть, как это делает
  `tests/master/lobbyGamesRoutes.test.js`, и повторить: 429 после лимита, 403
  на чужой Origin, 400 на мусор, 413 на тело > 16 КБ, 204 + запись в буфере с
  `engineVersion` бокса; строка журнала только на новый отпечаток;
  `symbolicate` зовётся только для нового отпечатка и его ошибка не ломает
  приём; **лимит по /64**: запросы с разных адресов одной /64 (через
  `x-real-ip` при `trustProxy: true`) делят один бакет; **бюджет**: при
  исчерпанном бюджете новый отпечаток не попадает в буфер, `symbolicate` для
  него **не** вызывается, ответ всё равно 204.
- `tests/config/` — если там есть тест `applyMasterEnv`, добавить
  `VIMP_CLIENT_REPORTS_TOKEN`.

## Документация (en + ru)

- `master.md` — раздел «Client error reports»: маршрут, контракт тела,
  лимиты (запросы по IP, IPv6 — по /64), **бюджет новых отпечатков** и
  служебная запись `reports.dropped` (как читать её в журнале: это признак
  спама или бури реальных ошибок), отпечаток, агрегация, пересылка, ответ
  auth `throttled`, строки `[vimp:client-report]` в журнале, поведение без
  токена.
- `dedicated.md` — в разделе «HTTP» — тот же маршрут (ссылкой на
  `master.md`) и flush при остановке.
- `configuration.md` — `VIMP_CLIENT_REPORTS_TOKEN`, блок
  `master:clientReports`.
- `deployment.md` — секрет `CLIENT_REPORTS_TOKEN`: как создать
  (`openssl rand -hex 32`), куда деплой его кладёт (`.env` боксов,
  `.env.prod` auth-стека), ротация (сменить секрет → push в `main`
  передеплоит и auth, и все боксы; до передеплоя старые боксы получают 401 и
  копят), где смотреть строки (`docker logs vimp-<domain> | grep
vimp:client-report`, см. раздел «Viewing logs on the VPS»).

## Журнал

`packages/engine/CHANGELOG.md`, `## [Unreleased]` → `### Added`:

- Lobby masters and dedicated servers accept client error reports at
  `POST /client-reports` (same-origin, rate-limited per address or IPv6
  /64, 16 KB, a per-server budget of new fingerprints) and forward them in
  batches to the auth service (`VIMP_CLIENT_REPORTS_TOKEN`,
  `master:clientReports`); every new fingerprint is also logged as
  `[vimp:client-report]`, and dropped reports are counted in a
  `reports.dropped` entry.
- `rateLimitKey(ip)` in `src/lib/clientIp.js`: an IPv4 address or an IPv6
  /64 prefix as a rate-limit key.

## Проверка

```bash
npx eslint .
npx vitest run --project engine-node --reporter=dot
npm test --silent
```

Ручная, локально: auth из этапа 1 с `VIMP_CLIENT_REPORTS_TOKEN=dev-token`;
мастер `VIMP_CLIENT_REPORTS_TOKEN=dev-token VIMP_AUTH_SERVICE_URL=http://localhost:3010 npm run dev`:

```bash
curl -sk -X POST https://localhost:3002/client-reports \
  -H 'origin: https://localhost:3002' -H 'content-type: application/json' \
  -d '{"v":1,"sessionId":"0f8c2b1e-1111-4222-8333-444455556666","context":{"mode":"lobby","role":"client","gameId":"tanks","gameVersion":"0.22.7"},"items":[{"kind":"error","source":"client","message":"probe","stack":"TypeError: probe\n    at f (https://localhost:3002/assets/index-abc.js:1:10)","count":1,"firstAt":'$(date +%s000)',"lastAt":'$(date +%s000)'}]}' -o /dev/null -w '%{http_code}\n'
# → 204; в журнале мастера строка [vimp:client-report] new …;
# через ≤ 30 с строка в client_reports (engine_version = версия packages/engine)
```

То же с `-H 'origin: https://evil.example'` → 403; 11-й запрос за минуту → 429. Без токена — только строка журнала, auth не вызывается.

Бюджет: временно `newFingerprintsPerMinute: 2` (локальная правка конфига,
не коммитить) и снять лимит запросов (`rateLimit.limit: 1000`) → три
запроса с **разными** `message` дают две новые строки и одну отброшенную;
через ≤ 30 с — строка журнала `[vimp:client-report] dropped 1 new reports
(budget: 1, bufferFull: 0)` и запись `reports.dropped` в `client_reports`.

## Готово, когда

- оба входа (лобби, dedicated) принимают, считают и пересылают;
- лимит по /64 и бюджет новых отпечатков работают; повторы известных
  отпечатков не тратят бюджет, отбросить их может только полный буфер; отброшенное видно как `reports.dropped`;
- без токена/auth бокс работает и пишет строки журнала;
- `deploy.yml` раскладывает секрет боксам и auth-стеку;
- тесты, линт, документация (en+ru), журнал — готовы;
- этот файл и строка в `README.md` помечены «✅ выполнен»; в отчёте —
  release impact (`src/config/*` и `src/lib/clientIp.js` публикуются:
  `vimp-engine`, minor).
