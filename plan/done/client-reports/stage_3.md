# Этап 3. Клиент движка: глобальный перехват ошибок, сервис `diagnostics` ✅ выполнен

Репозиторий: `vimp`, `packages/engine/src/client/` (+ `src/config/`,
`src/lib/`, `src/host/host.worker.js`). **Всё это публикуется в npm
(`vimp-engine`) → `### Added`, minor.** Зависит от этапа 2 (приёмник на
боксе); без него отчёты просто получают 404 и теряются — клиент от этого не
ломается.

## Цель

1. Любая неперехваченная ошибка страницы (`error`, `unhandledrejection`) и
   Worker-хоста, а также **нарушение CSP** (`securitypolicyviolation`)
   уходит на бокс (`POST /client-reports`, контракт — в `stage_2.md`, раздел
   «Контракт браузер → бокс»). Вызовы `console.error`/`console.warn` **не**
   перехватываются — решено осознанно (шум, случайные данные в аргументах).
2. Партам плагина доступен сервис пула `diagnostics` —
   `warn(code, details)` и `capture(error)`.
3. Репортёр **никогда** не становится новым источником падений и не шумит:
   дедупликация, потолок на сессию, пачки, отправка через `sendBeacon`.

## Что прочитать перед началом

- `packages/engine/src/client/main.js`:
  - стр. ~141–150: `injectedBoot`, `const boot = injectedBoot ?? (await
    resolveBootConfig())`, `bootMode`, `isLobbyMode` — самая ранняя точка,
    где известен режим;
  - места присваивания `activeGameManifest` (`grep -n "activeGameManifest ="`):
    ветка `boot.manifest` (стр. ~152) и `selectActiveGame` (стр. ~2061);
  - `availableServices` (стр. ~423–440) — пул движковых сервисов
    (`renderer`, `soundManager`, `localPlayer`, `accolades`, `assetsBase`);
  - `connectAsHost` (стр. ~1534) и `new HostController(room, {…})`
    (стр. ~1596).
- `packages/engine/src/client/boot.js` — `mode: 'lobby' | 'solo' |
  'dedicated'`; SDK зовёт `setBootConfig` до `import('./main.js')`.
- `packages/engine/src/config/lobby.js` — там же `debugReportUrl:
  '/debug/report'` (стр. ~146).
- `packages/engine/src/client/network/HostController.js` — конструктор
  `(room, { workerFactory, workerUrl, onReady, onError, onMapChange })`,
  `_createWorker`, все места `this._worker.onmessage = …` (при эстафете
  Worker пересоздаётся), обработка сообщения `{ type: 'error' }`.
- `packages/engine/src/host/host.worker.js` — `self.onmessage`, ветка
  `init` шлёт `{ type: 'error', message }` при сбое загрузки (эту семантику
  **не менять**: по ней идёт откат эстафеты).
- `packages/engine/src/config/clientServices.js` (реестр движковых
  сервисов, append-only, `since` — номер API, **заморожен на 4**) и
  `packages/engine/src/lib/capabilities.js` (реестр capability, `since` —
  версия движка строкой). Прецедент ровно этой пары — сервис `accolades` +
  capability `accolades`.
- `packages/engine/bin/vimp-surface.js` — пересборка
  `packages/engine/contract/surface.json` (`--write`).
- `docs/ai/04-client-plugin.md` — спецификация плагина для LLM (раздел о
  сервисах пула).
- Тесты: `tests/client/lib/accolades.test.js`, `tests/client/clientServices.test.js`,
  `tests/client/network/` — образцы; проект vitest `engine-client` (happy-dom).

## Шаги

### 3.1. Модуль `packages/engine/src/client/lib/diagnostics.js`

```js
/**
 * @param {Object} opts
 * @param {string|null} opts.url - адрес приёма; null — репортёр выключен
 * @param {Object} [opts.context] - { mode, role, gameId, gameVersion, page, userAgent }
 * @param {Function} [opts.send] - (url, json) => void; по умолчанию beacon/fetch
 * @param {Function} [opts.now]
 * @param {number} [opts.maxKeysPerSession=50]
 * @param {number} [opts.flushDelayMs=2000]
 * @returns {{ capture, warn, flush, setContext, install }}
 */
export function createDiagnostics(opts) { … }
```

Поведение:

- **Запись** (item) — поля из контракта `stage_2.md`: `kind`, `source`,
  `code`, `message`, `stack`, `details`, `count`, `firstAt`, `lastAt`.
  Обрезки на клиенте — те же числа, что у бокса: `message` 500, `stack`
  4000, `code` 64, `details` 2048 байт JSON (больше → `{ truncated: true }`).
- `capture(error, { source = 'client', kind = 'error' } = {})`:
  `message = error?.message ?? String(error)`, `stack = typeof error?.stack
  === 'string' ? error.stack : null`. Не-`Error` (строка, объект из
  `reject(...)`) — через `String(...)` в `try/catch`.
- `warn(code, details = null, { source = 'plugin', message } = {})`:
  `kind: 'warn'`; `code` проверяется `/^[a-z0-9][a-z0-9._-]{0,63}$/i`,
  иначе `'invalid-code'`; `message` по умолчанию = `code`; `stack` —
  `new Error().stack`, обрезанный (место вызова полезно при разборе).
- **Дедупликация**: ключ `${source}|${kind}|${code ?? message}|<первая
  строка стека с «:цифры:цифры»>`; повтор — `count++`, `lastAt = now()`.
- **Потолок сессии**: после `maxKeysPerSession` разных ключей новые ключи
  игнорируются (повторы уже известных — считаются дальше). Один раз
  `console.warn('[vimp] diagnostics: session cap reached')`.
- **Отправка**: дебаунс `flushDelayMs`; уходят только записи, у которых с
  прошлой отправки вырос `count` — **дельтой** (`count` = прирост, `firstAt`
  = первое время в дельте). Пачки по ≤ 10 записей; если JSON пачки > 15 000
  байт — у записей этой пачки удалить `details`, затем обрезать `stack` до
  1000; всё ещё больше — отправлять по одной записи.
- Тело: `{ v: 1, sessionId, context, items }`; `sessionId` —
  `crypto.randomUUID()` (есть в браузерах и в happy-dom; нет — fallback на
  `Math.random().toString(16)`), один на экземпляр.
- **Транспорт по умолчанию**: `navigator.sendBeacon(url, new Blob([json],
  { type: 'application/json' }))`; нет `sendBeacon` или он вернул `false` →
  `fetch(url, { method: 'POST', body: json, headers: { 'content-type':
  'application/json' }, keepalive: true, credentials: 'same-origin' })
  .catch(() => {})`.
- `install(target = window)` → функция снятия:
  - `error`: только `event instanceof ErrorEvent` (ошибки загрузки ресурсов
    `<img>`/`<script>` приходят обычным `Event` на элементе — их
    пропускать) → `capture(event.error ?? event.message, { kind: 'error' })`;
  - `unhandledrejection` → `capture(event.reason, { kind: 'rejection' })`;
  - `securitypolicyviolation` — слушать на `target.document` (событие
    всплывает к документу) → `reportCsp(event)`, см. ниже;
  - `pagehide` → `flush()`.
- `reportCsp(event)` (внутренняя функция) — нарушение CSP как запись
  `kind: 'csp'`, `source: 'client'`, `code: null`, `stack: null`:
  - **пропустить**, если `event.blockedURI` или `event.sourceFile`
    начинается с `chrome-extension:`, `moz-extension:`,
    `safari-extension:` или `safari-web-extension:` — расширения браузера
    игрока внедряют скрипты и стили, и без фильтра журнал утонет в чужом
    шуме;
  - `blocked` = `blockedURI` без query и hash (абсолютный URL — через
    `new URL(...)`: `origin + pathname`; служебные значения `inline`,
    `eval`, `wasm-eval`, `data`, `blob` и пустая строка — как есть);
  - `message: \`CSP ${event.effectiveDirective} blocked ${blocked}\``;
  - `details: { directive: event.effectiveDirective, disposition:
    event.disposition, sourceFile: <без query>, line: event.lineNumber,
    column: event.columnNumber, sample: (event.sample || '').slice(0, 40) }`;
  - дедуп и счётчик — общие (ключ по `message`), то есть одно правило CSP,
    сработавшее тысячу раз, — одна запись с `count`.
  CSP мастер ставит **только в проде** (`packages/engine/src/config/master.js`,
  блок `security`), поэтому в dev этих записей не будет — это ожидаемо.
- `setContext(patch)` — слияние в контекст (игра выбрана, стал хостом).
- **Безопасность самого репортёра**: каждая публичная функция — в
  `try/catch` без повторного броска; флаг реентерабельности (ошибка внутри
  `capture` не порождает новый `capture`); `console.*` страницы не
  перехватывается и не подменяется.
- **Выключен** (`url === null`): все методы — no-op, `install` ничего не
  вешает.

### 3.2. Конфиг — `packages/engine/src/config/lobby.js`

Рядом с `debugReportUrl`: `clientReportUrl: '/client-reports',` с
комментарием (журнал клиентских ошибок, plan/client-reports; приём на том
же боксе).

### 3.3. Подключение — `packages/engine/src/client/main.js`

1. Сразу после определения `bootMode` (стр. ~147):

```js
// журнал клиентских ошибок (plan/client-reports): ставится как можно
// раньше, чтобы ловить и сбои самого старта. Лобби и dedicated шлют на
// свой бокс; SDK (solo) — только если встраивающий передал reportUrl
const diagnostics = createDiagnostics({
  url: bootMode === 'solo' ? (boot.reportUrl ?? null) : lobbyConfig.clientReportUrl,
  context: {
    mode: bootMode,
    role: 'client',
    gameId: null,
    gameVersion: null,
    page: location.pathname.slice(0, 128),
    userAgent: navigator.userAgent.slice(0, 256),
  },
});

diagnostics.install(window);
```

   Ошибки **до** этой строки (импорты, `resolveBootConfig`) не ловятся —
   это осознанно: без режима неизвестно, куда слать.
2. После **каждого** присваивания `activeGameManifest`:
   `diagnostics.setContext({ gameId: activeGameManifest.id ?? null,
   gameVersion: activeGameManifest.version ?? null })` (проверить имена
   полей манифеста в `GameManifest`, `docs/en/plugin-api.md`).
3. В `connectAsHost`: `diagnostics.setContext({ role: 'host' })`; при
   выходе из роли хоста (найти, где `hostController` обнуляется) —
   `setContext({ role: 'client' })`.
4. В `availableServices` — **урезанный фасад**, без `flush`/`install`:

```js
// журнал клиентских ошибок для партов игры (plan/client-reports):
// warn(code, details) — своё предупреждение, capture(error) — пойманная
// ошибка. Сервис опционален: игра не пишет его в requires
diagnostics: {
  warn: (code, details) => diagnostics.warn(code, details, { source: 'plugin' }),
  capture: error => diagnostics.capture(error, { source: 'plugin' }),
},
```

5. В `new HostController(room, { … })` — передать `diagnostics` (новая
   опция, см. 3.4).

### 3.4. Ошибки Worker-хоста

`packages/engine/src/host/host.worker.js` (Worker-safe — только `self`):

```js
// журнал клиентских ошибок (plan/client-reports): необработанный reject в
// Worker не всплывает в worker.onerror главного потока — пересылаем сами.
// Отдельный тип сообщения: 'error' занят сбоем init и запускает откат эстафеты
self.addEventListener('unhandledrejection', event => {
  const reason = event.reason;

  self.postMessage({
    type: 'diagnostic',
    kind: 'rejection',
    message: reason && reason.message ? reason.message : String(reason),
    stack: reason && typeof reason.stack === 'string' ? reason.stack : null,
  });
});
```

`packages/engine/src/client/network/HostController.js`:

- новая опция конструктора `diagnostics` (JSDoc);
- в **каждом** месте, где новому Worker назначается `onmessage`
  (первичное создание и эстафета), назначить и
  `worker.onerror = event => this._diagnostics?.capture(event.error ??
  event.message, { source: 'host-worker', kind: 'worker' })` и
  `worker.onmessageerror` (`message: 'messageerror'`, `kind: 'worker'`);
  **не** вызывать `event.preventDefault()` — консольный вывод браузера
  остаётся как есть;
- в `_onWorkerMessage`: `type === 'diagnostic'` → `capture({ message,
  stack }, { source: 'host-worker', kind: msg.kind })` и выход; существующая
  ветка `type === 'error'` дополнительно зовёт `capture(new
  Error(msg.message), { source: 'host-worker', kind: 'error' })` —
  **поведение отката не меняется**.

### 3.5. SDK (solo) — `packages/engine/src/standalone/`

Найти место, где SDK собирает объект для `setBootConfig`, и пропустить в
него необязательную опцию `reportUrl` (строка или `null`, по умолчанию
`null` — в solo нет бокса, и слать некуда). Описать опцию в JSDoc SDK.

### 3.6. Реестры и контракт

- `packages/engine/src/config/clientServices.js`:
  `{ value: 'diagnostics', since: 4 }` с комментарием (журнал клиентских
  ошибок, `lib/diagnostics.js`). `since: 4` — потому что
  `ENGINE_API_VERSION` заморожен на 4 (`vimp/CLAUDE.md`).
- `packages/engine/src/lib/capabilities.js`:
  `{ value: 'diagnostics', since: '<версия релиза>' }` с комментарием.
  Версия релиза = следующая minor от `version` в
  `packages/engine/package.json` на момент исполнения (сейчас `0.34.8` →
  `0.35.0`); если в `## [Unreleased]` журнала уже есть `### ⚠️ Breaking` —
  всё равно minor в `0.x`, та же версия.
- `node packages/engine/bin/vimp-surface.js --write` — в
  `contract/surface.json` должны появиться **только добавления**
  (`clientServices` → `diagnostics`, `engineCapabilities` → `diagnostics`).
  Любое удаление — остановиться и обсудить.

## Тесты (проект `engine-client`, happy-dom)

- `tests/client/lib/diagnostics.test.js`:
  - выключенный (`url: null`) — `send` не вызывается, `install` не вешает
    слушатели;
  - дедуп: три одинаковые ошибки → одна запись, `count: 3`; после отправки
    ещё одна → вторая отправка с `count: 1` (дельта);
  - потолок сессии: 51-й ключ не отправляется, повторы старых — да;
  - дебаунс (`vi.useFakeTimers()`): несколько `capture` → одна отправка через
    `flushDelayMs`; `flush()` — немедленно;
  - ужатие пачки > 15 000 байт (сначала `details`, потом стеки);
  - транспорт: `sendBeacon` вернул `false` → `fetch` с `keepalive`;
    исключение в транспорте не выходит наружу;
  - `install`: `window.dispatchEvent(new ErrorEvent('error', { error }))` →
    запись; обычный `Event('error')` (ресурс) — нет; `PromiseRejectionEvent`
    (или ручной `Event('unhandledrejection')` с полем `reason`) → `kind:
    'rejection'`; снятие слушателей;
  - CSP: `new Event('securitypolicyviolation')` на `document` с полями
    `effectiveDirective`, `blockedURI` (`https://cdn.example/x.js?t=1`),
    `sourceFile`, `lineNumber`, `disposition`, `sample` (через
    `Object.assign` — в happy-dom может не быть
    `SecurityPolicyViolationEvent`) → запись `kind: 'csp'`, в `message` и
    `details` нет `?t=1`; `blockedURI: 'inline'` — как есть;
    `blockedURI: 'chrome-extension://abc/x.js'` и `sourceFile` расширения —
    записи нет; тысяча одинаковых нарушений — одна запись с `count`;
  - `warn`: неверный код → `'invalid-code'`; `source: 'plugin'`;
  - реентерабельность: `send`, бросающий при каждом вызове, не зацикливает.
- `tests/client/network/HostController.test.js` (если файла нет — создать по
  образцу соседних): `onerror` Worker'а → `capture` с `source:
  'host-worker'`; сообщение `diagnostic` → `capture`, откат не вызывается;
  `error` из init → и `onError` (как раньше), и `capture`.
- `tests/client/clientServices.test.js` — `diagnostics` в `SERVICES`.
- Тест реестра capability (найти существующий — `grep -rn "map.bodyState"
  tests/`) — `diagnostics` на месте.

## Документация (en + ru; плюс `docs/ai/`)

- `client.md` — раздел «Error reporting»: что ловится (неперехваченные
  ошибки и отклонения страницы, Worker хоста, нарушения CSP — только в
  проде, без расширений браузера, — сервис плагина), что **нет** (вызовы
  `console.error`/`console.warn`, ошибки, пойманные `try/catch`, сбои
  загрузки ресурсов и сети, ошибки до определения режима, серверные ошибки
  dedicated-процесса), лимиты и дедуп, приватность (нет ника/id/IP, у URL
  срезаны query и hash), куда уходит (ссылка на `master.md`).
- `plugin-api.md` — сервис пула `diagnostics`: объявление в
  `componentDependencies`, API, пример
  `this._diagnostics = dependencies.diagnostics ?? null;
  this._diagnostics?.warn('mygame.something', { … })`, правило «в
  `requires` не писать — на старом движке будет `undefined`», формат `code`.
- `standalone.md` — опция `reportUrl`.
- `docs/ai/04-client-plugin.md` — тот же сервис в списке движковых
  сервисов; при необходимости пункт в `docs/ai/10-pitfalls.md` («не
  требуйте `diagnostics` в `requires`»).

## Журнал

`packages/engine/CHANGELOG.md`, `## [Unreleased]` → `### Added`:

- The client reports uncaught errors and unhandled rejections of the page
  and of the host Worker, and Content-Security-Policy violations (browser
  extensions filtered out), to its server (`POST /client-reports`),
  deduplicated and capped per session.
- Client service `diagnostics` (`warn(code, details)`, `capture(error)`) and
  engine capability `diagnostics`; games use it optionally and must not list
  it in `requires`.
- Standalone SDK option `reportUrl`.

## Проверка

```bash
npx eslint .
npx vitest run --project engine-client --reporter=dot
npm test --silent
node packages/engine/bin/vimp-surface.js      # без --write: расхождений нет
```

Ручная (этапы 1–2 подняты локально, см. `stage_2.md`): открыть лобби, войти
в матч, в DevTools:

```js
setTimeout(() => { throw new TypeError('probe-sync'); });
Promise.reject(new Error('probe-async'));
```

→ через ~2 с в Network — `POST /client-reports` (204), в журнале мастера две
строки `[vimp:client-report] new …`, через ≤ 30 с — две строки в
`client_reports` с `game_id`/`game_version` выбранной игры. Повтор тех же
ошибок увеличивает `count`, новых строк нет.

CSP — только в прод-подобном запуске (`npm run build:app`, мастер с
`NODE_ENV=production`, см. `docs/en/getting-started.md`): в DevTools

```js
const s = document.createElement('script');
s.textContent = '1';
document.body.append(s);
```

→ браузер блокирует инлайн-скрипт, в журнале появляется запись `kind: 'csp'`
с `message` `CSP script-src-elem blocked inline`.

## Готово, когда

- ошибки страницы и Worker-хоста и нарушения CSP (без расширений) доходят
  до бокса; сервис `diagnostics` в пуле; репортёр не падает и не шумит;
- `surface.json` — только добавления; тесты, линт, документация, журнал —
  готовы;
- этот файл и строка в `README.md` помечены «✅ выполнен»; в отчёте —
  release impact: `vimp-engine` minor (`src/client`, `src/config`,
  `src/lib`, `src/host`, `src/standalone`), vimp-tanks **может** следовать
  (этап 6), но не обязан.
