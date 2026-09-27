# Кодревью задачи `client-reports` и план исправлений

> План самодостаточен: исполнителю не нужен контекст беседы, в которой он
> составлен. Перед каждым этапом прочитать разделы «Контекст», «Найденные
> проблемы», «Общие правила исполнения» и сам этап.

## Контекст

Задача `client-reports` (журнал клиентских ошибок) сделана в коммитах
движка `c2f0c6c9`, `310337a1`, `0b798eea`, `5563c586`
(`/Users/dmitry/Sites/my/vimp`) и игры `dfa8ef8`
(`/Users/dmitry/Sites/my/vimp-tanks`). Описание задачи:
`vimp/plan/done/client-reports/README.md` и `stage_1..6.md`.

Как проверялось:

- прочитаны все диффы: auth, бокс, клиент, админка, tanks;
- тесты по теме зелёные: движок — 20 файлов, 194 теста; tanks — 3 файла,
  172 теста;
- проблемы подтверждены экспериментами:
  - обход `denySourceMaps` — на express 5.2.1 + send 1.2.1;
  - `EXPLAIN` запроса `ingest` — на dev-базе `vimp_auth`;
  - поведение `ErrorEvent` Worker'а и `sendBeacon` — в headless Chrome 153;
  - цена разбора source map: ~35 мс и ~7 МБ кучи на карту `index-*.js.map`
    (1,3 МБ).

## Итог по критериям

| Критерий | Оценка | Замечания |
| --- | --- | --- |
| Читаемость | хорошо | модули маленькие, имена точные, комментарии объясняют «почему» |
| Работоспособность | есть дефекты | №3, №5, №6, №7, №8 |
| Тестируемость | хорошо, но есть пробелы | зависимости внедряются (`now`, `fetchImpl`, `log`, `send`), но тесты моделируют нереальные формы данных: Firefox-стек с подставленной строкой-заголовком, `event.error` у Worker'а. Поэтому №3 и №5 тесты не поймали |
| Поддерживаемость | хорошо | мелкий дубль — №12 |
| Безопасность | есть дефекты | №1, №4, №9. XSS в панели закрыт (`textContent`), секрет сравнивается через `timingSafeEqual`, IP нигде не хранится |
| Производительность | есть дефекты | №2, №4 |
| Масштабируемость | в целом хорошо | многослойные бюджеты сделаны правильно; №2 растёт вместе с таблицей |
| DRY | хорошо | №12. Копии `unavailable()` и `_request` в прокси (по две) допустимы |
| Документированность | хорошо, есть неточности | en/ru зеркальны. Неточности: «debounce 2 s», «`*.map` never served», поля `role`/`page` в контексте |
| Стандартизация | соответствует | ESM, `===`, фигурные скобки, порядок импортов, комментарии по-русски |

## Актуальность фикса 4092a28 (vimp-tanks)

**Правки актуальны и нужны. Откатывать или упрощать их нельзя.**

1. `client-reports` только **наблюдает** ошибки и не предотвращает их.
   Падение из прода — `Tr` = `modelLean` (`src/client/tank3d/project.js`) —
   читал `camera.x` у `null` внутри `Tank._applyModel`, в `onRender`. Без
   защиты `if (!camera)` исключение по-прежнему роняло бы кадр: Pixi Ticker
   после исключения не запрашивает следующий `requestAnimationFrame`, и
   сцена замирает. Журнал лишь записал бы это падение.
2. Этап 6 `client-reports` **построен поверх** 4092a28:
   `levelView.setDiagnostics` отправляет в журнал тот самый `warnNoCamera`,
   который появился в 4092a28.
3. Проверка `destroyed` в `cameraCenter` (`src/client/camera.js`) не
   дублирует проверку в `levelView`. `cameraCenter` зовут напрямую ещё
   `Bomb`, `Dust`, `Smoke`, `Tracks`, `ExplosionEffectController`,
   `ShotEffectController` и `MapObject` (запасной путь).
4. Все остальные потребители центра камеры `null` терпят — проверено
   grep'ом:
   - ранний выход в `MapLayer` и `createLighting`;
   - `offsetPoint` и `applyParallax`;
   - `covers` в `tileGrid.js`;
   - `roofHidesPlayer`.

   Непокрытых мест разыменования нет.
5. **Первопричина по-прежнему неизвестна**: почему на dedicated бывает кадр
   без трансформа сцены. Фикс защитный. Причину покажет строка
   `tanks.camera.missing` во вкладке «Errors»: в `details` там лежат
   `destroyed`, `position`, `scale`, `screen`.
6. **Важно для прода:** на npm опубликована `@vimp-games/tanks@0.22.6`, а в
   ней нет ни 4092a28, ни этапа 6 — оба лежат в `[Unreleased]`.
   - Dedicated-бокс до сих пор крутит сборку, которая падает.
   - Нужен ручной релиз tanks. `### Added` + `### Fixed` → **0.23.0**.
   - Затем передеплой dedicated-бокса.
7. Косметика: один комментарий в `levelView.js` устарел после этапа 6.
   Это этап 7 ниже.

## Найденные проблемы

| № | Серьёзность | Где | Суть | Этап |
| --- | --- | --- | --- | --- |
| 1 | **Высокая** (безопасность) | бокс, `master/httpSecurity.js` | `denySourceMaps` проверяет нераскодированный `req.path`, а `express.static` (send) раскодирует путь сам. Поэтому `/assets/index-*.js.%6dap`, `/assets/x.js%2Emap`, `/games/<id>/client-*.js.%6Dap` отдают карту с кодом 200 — проверено | 1 |
| 2 | **Высокая** (производительность) | auth, `ClientReportRepository.ingest` | Условие `fingerprint CHAR(64) = ANY($1::text[])` приводит колонку к `text`, и UNIQUE-индекс не используется. `EXPLAIN` показывает `Filter` вместо `Index Cond`. Итог — полный проход таблицы (до 200 000 строк) на каждую пачку каждого бокса | 2 |
| 3 | Средняя | бокс, `clientReports/symbolicate.js` | Первая строка стека всегда считается заголовком. У Firefox/Safari заголовка нет, и **верхний кадр не расшифровывается**. Тест это маскирует: подставляет строку `HEAD` | 3 |
| 4 | Средняя (DoS) | бокс, `symbolicate.js` | Нет бюджета холодных загрузок карт. В лобби корни — все версии всех игр: до 60 новых отпечатков в минуту × до 12 разных карт = до 720 разборов в минуту по ~35 мс в event loop. Параллельные загрузки одной карты не склеиваются | 3 |
| 9 | Низкая | бокс, `createClientReportRoute.js` | `message` отчёта уходит в `log.warn` как есть: `\n` подделывает строки `docker logs` | 4 |
| 10 | Низкая | мастер, `ClientReportsProxy.js` | У запроса нет таймаута (у `GameRegistryProxy` — 15 с) | 4 |
| 11 | Низкая | лобби, `master/lobby.js` | Нет обработчика SIGTERM. Node в образе — PID 1 без init, поэтому сигнал игнорируется до SIGKILL. Буфер (до 30 с отчётов) теряется на каждом деплое | 4 |
| 12 | Низкая (DRY) | `dedicated/main.js` | Два одинаковых валидатора origin (WS и журнал); второй собирается на каждом запросе | 4 |
| 5 | Средняя | клиент, `network/HostController.js` | В `worker.onerror` у Chrome `event.error === null` — проверено. Отчёт уходит без места: нет верхнего кадра, нет расшифровки. Если `message` пустой (Worker не загрузился), бокс отбрасывает отчёт | 5 |
| 6 | Средняя | клиент, `HostController.js` + `host/host.worker.js` | При сбое init `new Error(msg.message)` создаётся в главном потоке. В журнал уходит стек HostController'а, а не Worker'а | 5 |
| 7 | Средняя | клиент, `lib/diagnostics.js` | Смена игры или роли применяется к ещё не отправленным записям. До 2 с отчётов уходят с чужими `gameId`/`gameVersion` — это чужой отпечаток, чужие карты и чужой фильтр в панели | 5 |
| 8 | Средняя | клиент ↔ бокс | Повторяющаяся ошибка даёт отправку каждые 2 с — до 30 запросов в минуту. Лимит бокса — 10 запросов в минуту с адреса (за NAT он общий). Ответ 429 молча съедает приросты счётчиков: `sentCount` к этому моменту уже сдвинут | 5 |
| 13 | Низкая | клиент, `diagnostics.js` | Исключение из `navigator.sendBeacon` не перехватывается, и запасной `fetch` не срабатывает. В Chrome 153 Blob с JSON принимается; нужна страховка для старых браузеров | 5 |
| 14 | Низкая | auth, upsert | `details = COALESCE(старое, новое)`: служебная строка `reports.dropped` навсегда показывает разбивку первого окна | 2 |
| 15 | Низкая | клиент → бокс → auth | `context.role` и `context.page` собираются и проверяются боксом, но в журнал не попадают, хотя документация их обещает | 6 |
| 16 | Низкая | tanks, `src/client/levelView.js` | Устаревший комментарий о том, что предупреждение уходит только в консоль | 7 |
| 17 | Низкая, **отложено** | SDK, `client/main.js` | `diagnostics.install()` возвращает функцию снятия, но она игнорируется: после `stop()` SDK слушатели остаются. Отложено: для `main.js` нет тестового харнесса, а отчёты уходят на собственный `reportUrl` встраивающего | — |

## Общие правила исполнения

Правила взяты из `CLAUDE.md` обоих репозиториев.

- **Никаких коммитов**, правок `version`, публикаций. Всё остаётся в рабочем
  дереве.
- Каждый этап заканчивается зелёными проверками из корня репозитория:
  `npx eslint .` и `npx vitest run --reporter=dot`.
  - Тесты зеркалят `packages/engine/src/` в `tests/`.
  - Тесты auth лежат в `tests/auth/`.
- Любая функциональная правка сразу правит тест, а исправление начинается с
  теста, который воспроизводит баг.
- **Документация — в том же изменении**: `docs/en/<page>.md` канон,
  `docs/ru/<page>.md` — точное зеркало (те же заголовки, тот же смысл).
- **Журнал** `packages/engine/CHANGELOG.md`, раздел `## [Unreleased]`.
  - Допустимые подзаголовки: `### Security` и `### Fixed` (patch). Других
    не заводить.
  - Правки бокса (`src/master`, `src/dedicated`) по прецеденту 0.35.0 тоже
    записываются.
  - У auth журнала нет. Тесты и `docs/` — не записи.
- Код:
  - ESM, `===`, `let`/`const`, фигурные скобки у каждого блока;
  - никаких двух заглавных подряд в camelCase;
  - комментарии по-русски, кратко, про «почему».
- `packages/engine/src/host/` остаётся Worker-safe: без DOM и Node-глобалов.
- Файлы с префиксом `_` не трогать.
- Готовый этап помечать в его заголовке меткой «✅ выполнен». Когда
  выполнены все, выполнить `git mv plan/client-reports-review.md
  plan/done/` (без коммита).
- Этап 7 — в `/Users/dmitry/Sites/my/vimp-tanks`, остальные — в
  `/Users/dmitry/Sites/my/vimp`.

---

## Этап 1. Запрет раздачи `*.map` обходится процентным кодированием (№1) ✅ выполнен

**Файлы:**

- `packages/engine/src/master/httpSecurity.js` — функция `denySourceMaps`;
- `tests/master/httpSecurity.test.js`.

**Причина.** Сейчас проверка такая: `req.path.endsWith('.map')`. В Express
`req.path` — это сырой pathname. `serve-static`/`send` вызывают
`decodeURIComponent` сами (`node_modules/send/index.js`, функция
`decode`). Поэтому:

- `/assets/index-X.js.%6dap` → карта отдаётся;
- `/assets/index-X.js%2Emap` → карта отдаётся;
- `/games/<id>/client-X.js.%6Dap` → карта отдаётся.

**Решение.** Заменить `denySourceMaps` на версию ниже. Остальной файл не
трогать.

```js
// Скрытые source maps лежат рядом с бандлами (plan/client-reports): их
// читает сам бокс, а снаружи они — исходники сборки по запросу любого.
// Только прод: в dev карты раздаёт Vite, и они нужны DevTools.
//
// Проверяется РАСКОДИРОВАННЫЙ путь и без учёта регистра: express.static
// (send) раскодирует pathname сам, и `/a.js.%6dap` или `/a.js%2Emap` иначе
// прошли бы мимо проверки и отдали карту
const SOURCE_MAP_RE = /\.map$/i;

export function denySourceMaps({ isProduction = false } = {}) {
  return (req, res, next) => {
    if (!isProduction) {
      next();
      return;
    }

    let pathname;

    try {
      pathname = decodeURIComponent(req.path);
    } catch {
      // битую процентную последовательность дальше отвергнет сам send (400)
      next();
      return;
    }

    if (SOURCE_MAP_RE.test(pathname)) {
      res.status(404).json({ error: 'notFound' });
      return;
    }

    next();
  };
}
```

**Тесты** (`tests/master/httpSecurity.test.js`). Существующие не трогать,
добавить:

1. Юнит: в проде каждый из путей ниже даёт 404, а `next` не вызывается:
   - `/assets/a.js.%6dap`;
   - `/assets/a.js%2Emap`;
   - `/assets/a.js.MAP`;
   - `/games/tanks/0.23.0/client-x.js.%6Dap`.
2. Юнит: в проде `/assets/%E0%A4%A.js` (битая последовательность) вызывает
   `next`.
3. Юнит: в dev `/assets/a.js.%6dap` вызывает `next`.
4. Интеграционный тест на настоящем express:
   - временный каталог (`fs.mkdtemp`) с файлами `a.js` и `a.js.map`;
   - `app.use(denySourceMaps({ isProduction: true }))`, затем
     `app.use(express.static(dir))`;
   - `app.listen(0)`, запросы через `fetch` на `http://127.0.0.1:<port>`;
   - ожидается: `/a.js.map`, `/a.js.%6dap`, `/a.js%2Emap` → 404, `/a.js` →
     200;
   - сервер и каталог закрываются в `afterAll`;
   - `import express from 'express'` — зависимость движка.

**Документация (en + ru):**

- `docs/{en,ru}/master.md`, абзац «Stack symbolication» / «Расшифровка
  стеков»: в предложение о `denySourceMaps` дописать, что проверяется
  раскодированный путь и без учёта регистра.
- Найти grep'ом `denySourceMaps` и `*.map` в `docs/{en,ru}/dedicated.md` и
  `deployment.md` и выровнять формулировки там же.

**Журнал** `packages/engine/CHANGELOG.md` → `[Unreleased]` → `### Security`:

```
- Source maps could still be downloaded in production through a
  percent-encoded path (`/assets/index-*.js.%6dap`); `denySourceMaps` now
  checks the decoded path, case-insensitively.
```

**Проверка:** `npx eslint .` и `npx vitest run --reporter=dot` зелёные.

---

## Этап 2. Auth: индекс в `ingest` и детали служебной строки (№2, №14) ✅ выполнен

**Файлы:**

- `packages/auth/src/ClientReportRepository.js`;
- `tests/auth/ClientReportRepository.test.js`;
- `docs/{en,ru}/auth.md`.

### 2.1 Запрос известных отпечатков идёт мимо индекса

Колонка `fingerprint` имеет тип `CHAR(64)` (`bpchar`, миграция
`013_client_reports.sql`). Сравнение с `text[]` приводит колонку к `text`,
и индекс `client_reports_fingerprint_key` (по `bpchar`) не применяется.
`EXPLAIN` на dev-базе показывает:

```
Filter: ((fingerprint)::text = ANY ('{a,b}'::text[]))   ← без Index Cond
```

С `::bpchar[]` получается нужный план: `Index Cond: (fingerprint = ANY
(...::bpchar[]))`.

**Решение.** В `ingest`, строка ~109, заменить запрос. Колонку не менять:
миграции перезапускаются на каждом деплое, и `ALTER TYPE` там лишний.

```js
    // ::bpchar[], а не ::text[]: колонка CHAR(64), и сравнение с text
    // приводит её к text — UNIQUE-индекс тогда не работает, и каждая пачка
    // проходила бы таблицу целиком
    const { rows } = await this._db.query(
      'SELECT fingerprint FROM client_reports WHERE fingerprint = ANY($1::bpchar[])',
      [merged.map(item => item.fingerprint)],
    );
```

### 2.2 `details` служебной строки застывают на первом окне

Служебная строка `reports.dropped` (`source: 'box'`) — одна на бокс и
версию движка. `count` в ней копится, а `details` (`{ budget, bufferFull,
windowMs }`) из-за `COALESCE` навсегда остаются от первого окна.

**Решение.** В `INSERT … ON CONFLICT DO UPDATE` (строка ~138) заменить
строку `details`:

```sql
           details    = CASE WHEN EXCLUDED.source = 'box'
                          THEN EXCLUDED.details
                          ELSE COALESCE(client_reports.details, EXCLUDED.details)
                        END`,
```

Над SQL добавить комментарий: у служебных записей бокса детали — разбивка
последнего окна, у остальных — первого присланного.

**Тесты** (`ClientReportRepository.test.js`, мок `createDbStub` уже есть):

- текст SELECT-вызова содержит `ANY($1::bpchar[])`;
- текст INSERT-вызова содержит `WHEN EXCLUDED.source = 'box'`.

**Документация (en + ru)** — `docs/{en,ru}/auth.md`, раздел журнала
клиентских ошибок. Одна фраза: у служебных строк `source: 'box'` поле
`details` показывает последнее окно, у остальных строк сохраняются первые
присланные `stack` и `details`.

**Журнал:** нет (auth приватный).

**Ручная проверка** (если локальный Postgres запущен и миграции
применены):

```bash
psql -d vimp_auth -X -c "SET enable_seqscan = off" \
  -c "EXPLAIN SELECT fingerprint FROM client_reports WHERE fingerprint = ANY(ARRAY['a']::bpchar[])"
```

В плане должен быть `Index Cond`.

---

## Этап 3. Расшифровка стеков: Firefox/Safari и бюджет загрузок (№3, №4) ✅ выполнен

**Файлы:**

- `packages/engine/src/master/clientReports/symbolicate.js`;
- `tests/master/clientReportsSymbolicate.test.js`;
- `docs/{en,ru}/master.md`.

### 3.1 Верхний кадр Firefox/Safari

Сейчас код такой: `const [head, ...frames] = String(stack).split('\n')`, и
строка `head` никогда не расшифровывается. В V8 это сообщение
(`TypeError: …`). В Firefox и Safari у `error.stack` строки-сообщения нет:
первая строка — и есть верхний кадр (`Tr@https://…:84:46108`).

**Решение.** Кадром считать строку, которая похожа на кадр **и** которую
разобрал `parseFrame`. Первая строка сохраняется как есть только тогда,
когда не похожа на кадр. Ввести константу:

```js
// строка стека — кадр: V8 `    at …`, Firefox/Safari `fn@scheme://…`.
// Первая строка V8 — сообщение, у Firefox/Safari её нет вовсе: там первая
// строка и есть верхний (самый нужный) кадр. Сообщение V8, оканчивающееся
// на `url:line:col`, кадром не считается — у него нет ни `at `, ни `@`
const FRAME_LINE_RE = /^\s*at\s|@[a-z][a-z0-9+.-]*:\/\//i;
```

Функция `symbolicateFrame(text)` становится `symbolicateFrame(text, frame)`
и берёт уже разобранный `frame` (второй вызов `parseFrame` убрать).
Итоговая функция:

```js
  return async stack => {
    const out = [];
    let decoded = 0;

    for (const line of String(stack).split('\n')) {
      const frame =
        decoded < maxFrames && FRAME_LINE_RE.test(line) ? parseFrame(line) : null;

      if (!frame) {
        out.push(line);
        continue;
      }

      decoded += 1;

      try {
        out.push(await symbolicateFrame(line, frame));
      } catch {
        // одна битая карта не ломает весь стек
        out.push(line);
      }
    }

    return out.join('\n').slice(0, STACK_SYMBOLICATED);
  };
```

### 3.2 Бюджет холодных загрузок и склейка параллельных

Замеры: разбор карты `index-*.js.map` (1,3 МБ) — около 35 мс синхронно
(`JSON.parse` + первый `originalPositionFor`) и около 7 МБ кучи. В лобби
корни — это `dist` движка, хранилище игр со всеми версиями и
`node_modules`. Стек с 12 кадрами из разных карт и 60 новых отпечатков в
минуту гоняют LRU (20 карт) по кругу и блокируют event loop. Две
одновременные загрузки одной карты сейчас читают её дважды.

**Решение.**

1. Новые параметры `createSymbolicator`:
   - `maxColdLoadsPerMinute = 20`;
   - `now = Date.now`.

   Дописать их в JSDoc.
2. Кэш хранит **промис** `Promise<SourceMapConsumer|null>`, а не результат.
3. Кэшировать:
   - карту, которой нет (`ENOENT`) → `null`: имя бандла хешировано, и
     карта уже не появится;
   - слишком большую карту или не-файл → `null`.
4. Прочие сбои чтения и разбора (EIO, битый JSON) **не** кэшировать —
   убирать запись из кэша.
5. Бюджет — фиксированное минутное окно, как `_budgetLeft` в
   `ClientReportBuffer.js`. Нет бюджета → `loadMap` возвращает `null`
   (кадр остаётся сырым) и ничего не кэширует.

Каркас (проверки корня и расширения в `loadMap` остаются как есть, до
обращения к кэшу):

```js
  // mapPath → Promise<SourceMapConsumer|null>: промис, а не результат, —
  // два одновременных отчёта про одну карту читают её с диска один раз.
  // Порядок вставки Map и есть порядок LRU
  const cache = new Map();
  let coldMinute = null;
  let coldLoads = 0;

  // Разбор карты — синхронные десятки мс в event loop бокса (у dedicated
  // там же идёт матч), а корни лобби держат все версии всех игр: без
  // бюджета стеки с разными картами гоняли бы LRU по кругу
  const takeColdLoad = () => {
    const minute = Math.floor(now() / 60000);

    if (minute !== coldMinute) {
      coldMinute = minute;
      coldLoads = 0;
    }

    if (coldLoads >= maxColdLoadsPerMinute) {
      return false;
    }

    coldLoads += 1;

    return true;
  };

  // null — карты нет (и не появится: имя бандла хешировано) или она не
  // годится; прочие сбои — исключение
  const readMap = async mapPath => {
    let stat;

    try {
      stat = await fs.stat(mapPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null;
      }

      throw err;
    }

    if (!stat.isFile() || stat.size > maxMapBytes) {
      return null;
    }

    return new SourceMapConsumer(JSON.parse(await fs.readFile(mapPath, 'utf8')));
  };
```

В `loadMap` после проверок корня и расширения:

```js
    const mapPath = `${resolved}.map`;

    if (cache.has(mapPath)) {
      const pending = cache.get(mapPath);

      cache.delete(mapPath);
      cache.set(mapPath, pending);

      return pending;
    }

    if (!takeColdLoad()) {
      return null;
    }

    const pending = readMap(mapPath);

    cache.set(mapPath, pending);

    if (cache.size > cacheSize) {
      cache.delete(cache.keys().next().value);
    }

    // сбой чтения не кешируется: один EIO не должен выключить карту навсегда
    pending.catch(() => {
      if (cache.get(mapPath) === pending) {
        cache.delete(mapPath);
      }
    });

    return pending;
```

**Тесты** (`clientReportsSymbolicate.test.js`). Существующие должны пройти
без правок; добавить:

1. Настоящий Firefox-стек **без** `HEAD`: `['Tr@https://h/assets/bundle.js:1:11',
   'f@https://h/assets/bundle.js:1:11'].join('\n')`. Расшифрованы обе
   строки, первая тоже — ожидается `DECODED` в формате
   `    at modelLean (src/…:42:5) [/assets/bundle.js:1:11]`.
2. V8-сообщение, которое оканчивается на URL с позицией:
   `'Error: failed https://h/assets/bundle.js:1:11'` + `V8_FRAME`. Первая
   строка остаётся дословно, вторая расшифрована.
3. Склейка: два параллельных вызова (`Promise.all`) на один и тот же новый
   стек — `vi.spyOn(fs, 'readFile')` вызван один раз. Модуль импортирует
   `fs` из `node:fs/promises` дефолтом, поэтому шпион работает.
4. Нет карты: два вызова со стеком на бандл без `.map` — `fs.stat` вызван
   один раз.
5. Бюджет:
   - в `beforeAll` создать вторую пару `assets/bundle2.js` +
     `bundle2.js.map`;
   - `make({ maxColdLoadsPerMinute: 1, now: () => t })`;
   - стек из кадра `bundle.js` и кадра `bundle2.js`: первый расшифрован,
     второй сырой;
   - `t += 60000` и тот же вызов — оба расшифрованы.
6. Битая карта (тест уже есть) после исправления читается заново при
   следующем вызове: `readFile` вызван дважды.

**Документация (en + ru)** — `docs/{en,ru}/master.md`, абзац «Stack
symbolication». Дописать:

- у стеков Firefox/Safari расшифровывается и первая строка;
- не больше 20 холодных загрузок карт в минуту (сверх — кадр сырой);
- отсутствующая карта запоминается;
- одновременные загрузки одной карты склеиваются.

**Журнал** `[Unreleased]`:

- `### Fixed`: `Client error reports from Firefox and Safari get their top
  stack frame symbolicated too (their stacks have no message line).`
- `### Security`: `Stack symbolication on the server loads at most 20 source
  maps a minute, so crafted reports cannot stall the event loop.`

---

> **Порядок этапов.** Этапы 1–5 и 7 независимы друг от друга. Этап 6
> выполняется после этапа 2: оба правят SQL в `ClientReportRepository.js`.

---

## Этап 4. Бокс и мастер: журнал процесса, таймаут, остановка, DRY (№9–№12) ✅ выполнен

### 4.1 Подделка строк журнала процесса (№9)

**Файлы:** `packages/engine/src/master/clientReports/createClientReportRoute.js`,
`tests/master/clientReportRoute.test.js`.

`item.message` — данные любого браузера. В `log.warn(... new ${fp} ...)`
(строка ~117) он уходит как есть, и перевод строки подделывает строку
`docker logs`. `code` уже ограничен регэкспом.

**Решение.** Рядом с `LOG_PREFIX` объявить функцию:

```js
// сообщение отчёта — данные любого браузера: перевод строки в нём подделал
// бы строку журнала процесса (docker logs)
const oneLine = text => String(text).replace(/\p{Cc}+/gu, ' ');
```

`\p{Cc}` вместо `[\x00-\x1f]` — чтобы не сработало правило ESLint
`no-control-regex`. В строке журнала: `${oneLine(item.code ??
item.message.slice(0, 120))}`.

**Тест:** отчёт с `message: 'boom\n[vimp:client-report] new deadbeef fake'`
— аргумент `log.warn` не содержит `\n`.

### 4.2 Таймаут прокси админки (№10)

**Файлы:** `packages/engine/src/master/ClientReportsProxy.js`,
`tests/master/ClientReportsProxy.test.js`.

Повторить приём `GameRegistryProxy.js`:

- конструктор `constructor(authServiceUrl, { fetchImpl = fetch, timeout =
  15000 } = {})` и поле `this._timeout = timeout`;
- в `_request` передавать в `fetch` параметр `signal: this._timeout ?
  AbortSignal.timeout(this._timeout) : undefined`;
- комментарий: «зависший auth не должен держать запрос админки — тот же
  приём, что у GameRegistryProxy».

Таймаут, как и любой сетевой сбой, уже превращается в `502
authServiceUnavailable` через `clientReportsRoutes.js`.

**Тесты:**

- `fetchImpl` получает `init.signal instanceof AbortSignal`;
- при `timeout: 0` — `signal === undefined`.

### 4.3 Финальный flush при остановке: общий хелпер и лобби (№11)

**Файлы:**

- `packages/engine/src/master/clientReports/index.js`;
- `packages/engine/src/dedicated/main.js`;
- `packages/engine/src/master/lobby.js`;
- `tests/master/clientReportsIndex.test.js`.

1. В `clientReports/index.js` экспортировать функцию:

   ```js
   /**
    * Последний flush журнала при остановке бокса — с потолком: недоступный
    * auth не должен подвешивать остановку.
    * @param {Object} forwarder - ClientReportForwarder.
    * @param {Object} [options]
    * @param {number} [options.timeoutMs=3000]
    * @param {Object} [options.log=console]
    * @returns {Promise<void>} Никогда не отклоняется.
    */
   export async function stopClientReports(forwarder, { timeoutMs = 3000, log = console } = {}) {
     let timer;

     try {
       await Promise.race([
         forwarder.stop(),
         new Promise(resolve => {
           timer = setTimeout(resolve, timeoutMs);
         }),
       ]);
     } catch (err) {
       log.error(`${LOG_PREFIX} final flush failed:`, err.message);
     } finally {
       clearTimeout(timer);
     }
   }
   ```

2. `dedicated/main.js`:
   - в `close()` (строки ~685–695) блок `Promise.race([...])` заменить на
     `await stopClientReports(clientReports.forwarder);`;
   - константу `CLIENT_REPORTS_STOP_TIMEOUT` (строка ~103) удалить: её
     значение стало умолчанием хелпера;
   - импорт `stopClientReports` добавить к импорту `createClientReports`.
3. `master/lobby.js`: сразу после `clientReports.forwarder.start();`
   (строка ~403) добавить:

   ```js
   // docker stop шлёт SIGTERM, а node в образе — PID 1 без init: без
   // обработчика сигнал игнорируется до SIGKILL, и буфер журнала (до
   // flushIntervalMs отчётов) терялся на каждом деплое. Dedicated делает то
   // же в своём shutdown
   let stopping = false;
   const shutdownLobby = () => {
     if (stopping) {
       return;
     }

     stopping = true;
     stopClientReports(clientReports.forwarder).finally(() => process.exit(0));
   };

   process.on('SIGTERM', shutdownLobby);
   process.on('SIGINT', shutdownLobby);
   ```

   В dev пересылка выключена (нет токена), поэтому `stop()` мгновенный и
   Ctrl+C работает как раньше. nodemon перезапускает процесс по SIGUSR2 —
   его обработчик не трогает.

**Тесты** (`clientReportsIndex.test.js`) для `stopClientReports`:

- `forwarder.stop` разрешился → хелпер разрешился, `log.error` не вызван;
- `stop` висит → с `vi.useFakeTimers()` хелпер разрешается после
  `advanceTimersByTime(3000)`;
- `stop` отклонился → `log.error` вызван, хелпер разрешился.

`lobby.js` из тестов не импортируется (поднимает сервер) — это
существующее правило модуля.

### 4.4 Один валидатор origin в dedicated (№12)

**Файл:** `packages/engine/src/dedicated/main.js`.

Сейчас валидатора два:

- для журнала (строки ~461–466) — `security.createOriginValidator({...})`
  собирается на **каждый** запрос;
- для WS (строки ~570–574) — `const checkOrigin =
  security.createOriginValidator({...})` с `port: actualPort`.

**Решение:**

- переименовать WS-валидатор в `originValidator` (оставить его на месте,
  после `listen`);
- WS-обработчик вызывает `originValidator(requestOrigin, err => …)`;
- в `createClientReports` передать `checkOrigin: (origin, cb) =>
  originValidator(origin, cb)` с комментарием: «валидатор собирается после
  listen (порт известен только тогда), а запросы приходят позже»;
- `actualPort` оставить: он ещё и в возвращаемом объекте.

Тесты — существующие `tests/dedicated/*`, должны остаться зелёными.

**Документация этапа 4 (en + ru):**

- `docs/{en,ru}/master.md`: лобби делает финальный flush журнала по
  SIGTERM/SIGINT с потолком 3 с;
- `docs/{en,ru}/dedicated.md`: ссылка на тот же хелпер, если там описан
  потолок 3 с;
- `docs/{en,ru}/deployment.md`: одна фраза, что лобби теперь
  останавливается по сигналу сразу, а не по SIGKILL через таймаут.

**Журнал** `[Unreleased]` → `### Fixed`:

```
- The lobby master flushes buffered client error reports on SIGTERM/SIGINT
  (at most 3 s) instead of losing them on every deploy.
- Client error messages are written to the server log on one line: a line
  break in a report can no longer forge log lines.
- The admin error journal proxy gives up on a hung auth service after 15 s.
```

---

## Этап 5. Клиентский репортёр (№5–№8, №13) ✅ выполнен

**Файлы:**

- `packages/engine/src/client/network/HostController.js`;
- `packages/engine/src/host/host.worker.js`;
- `packages/engine/src/client/lib/diagnostics.js`;
- `packages/engine/src/config/master.js`;
- тесты `tests/client/network/HostController.test.js`,
  `tests/client/lib/diagnostics.test.js`;
- документация `docs/{en,ru}/client.md`, `master.md`, `configuration.md`.

### 5.1 `worker.onerror` без места (№5)

У `ErrorEvent`, который Worker бросает в главный поток, `error === null`:
исключение между потоками не клонируется. Место есть только в
`filename`/`lineno`/`colno`. Проверено в Chrome 153: `{ error: null,
message: "Uncaught TypeError: …", filename: ".../w.js", lineno: 1, colno:
38 }`.

**Решение.** В `HostController.js` на уровне модуля (не экспортировать)
добавить функцию:

```js
// ErrorEvent Worker'а в главном потоке: `error` там null (исключение между
// потоками не клонируется) — есть только message и filename/lineno/colno.
// Кадр собирается из них: без него у отчёта нет верхнего кадра, то есть ни
// различимого отпечатка, ни расшифровки по source map. Пустой message
// (Worker не загрузился) бокс отбросил бы — отсюда запасной текст
function workerErrorReport(event) {
  if (typeof event?.error?.stack === 'string') {
    return event.error;
  }

  const message = event?.message || 'Worker error';
  const stack = event?.filename
    ? `${message}\n    at ${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
    : null;

  return { message, stack };
}
```

В `_watchWorkerErrors`: `worker.onerror = event =>
this._diagnostics?.capture(workerErrorReport(event), { source:
'host-worker', kind: 'worker' });`.

Формат `    at <url>:<l>:<c>` разбирают и `topFrame` клиента, и
`parseFrame`/`rawTopFrame` бокса (регэксп `FRAME_RE` в `fingerprint.js`).

### 5.2 Стек сбоя init — от Worker'а (№6)

1. `host/host.worker.js`, `catch` в `case 'init'` (строки ~175–182): к
   сообщению `error` добавить поле

   ```js
   // стек Worker'а — для журнала клиентских ошибок: в главном потоке его
   // уже не восстановить
   stack: e && typeof e.stack === 'string' ? e.stack : null,
   ```

2. `HostController.js`: методы `_reportWorkerError` и
   `_reportWorkerDiagnostic` заменить одним:

   ```js
   // сбой Worker'а, присланный сообщением ('error' — провал init,
   // 'diagnostic' — необработанный reject): стек — самого Worker'а, а не
   // главного потока
   _reportWorkerMessage(msg, kind) {
     this._diagnostics?.capture(
       { message: msg.message, stack: msg.stack ?? null },
       { source: 'host-worker', kind },
     );
   }
   ```

   Вызовы в `_onWorkerMessage` и `_onNextWorkerMessage`:
   - `'error'` → `this._reportWorkerMessage(msg, 'error')`;
   - `'diagnostic'` → `this._reportWorkerMessage(msg, msg.kind)`.

   Откат эстафеты и `onError` остаются как были.

**Тесты** (`HostController.test.js`):

- переделать тест «onerror без error — сообщение события»: ожидается
  `capture({ message: 'Script error.', stack: null }, …)`;
- новый: `onerror({ error: null, message: 'Uncaught TypeError: x',
  filename: 'https://h/assets/host.worker-abc.js', lineno: 1, colno: 38 })`
  → `stack === 'Uncaught TypeError: x\n    at
  https://h/assets/host.worker-abc.js:1:38'`;
- новый: `onerror({ message: '' })` → `message === 'Worker error'`;
- новый: сообщение `{ type: 'error', message: 'init failed', stack:
  'Error: init failed\n    at https://h/assets/host.worker-abc.js:5:7' }`
  от рабочего и от нового (эстафета) Worker'а → в `capture` уходит
  **этот** стек;
- существующие тесты эстафеты (откат, `resume`, `onError` не вызван)
  остаются зелёными.

### 5.3 Контекст меняется — накопленное уходит со своим (№7)

`diagnostics.js`, функция `setContext` (строки ~380–386) — заменить на:

```js
  // смена контекста (игра, роль): накопленное уходит СО СВОИМ контекстом —
  // иначе отчёт игры A, отправленный уже под игрой B, получил бы на боксе
  // отпечаток и source maps игры B
  function setContext(patch) {
    try {
      if (Object.keys(patch).some(key => ctx[key] !== patch[key])) {
        flush();
      }

      Object.assign(ctx, patch);
    } catch {
      // контекст — вспомогательный, его сбой отчёты не останавливает
    }
  }
```

`main.js` не меняется: `syncDiagnosticsGame()` и `setContext({ role })` и
так вызываются в нужных местах.

**Тесты** (`diagnostics.test.js`):

- `setContext({ gameId: 'a' })`, затем `capture(err)`, затем
  `setContext({ gameId: 'b' })` → `send` вызван сразу, в теле
  `context.gameId === 'a'`. Следующий `capture` + `flush()` → `gameId ===
  'b'`;
- `setContext` с теми же значениями → `send` не вызван.

### 5.4 Каденс отправки против лимита бокса (№8)

1. `diagnostics.js`:
   - новая опция `minIntervalMs = 10000` (дописать в JSDoc) и состояние
     `let lastSentAt = null;`;
   - `schedule()`:

     ```js
     function schedule() {
       if (timer !== null) {
         return;
       }

       // первая отправка — через flushDelayMs, следующие — не чаще
       // minIntervalMs: бокс режет приём лимитом запросов с адреса, и 429
       // молча съедал бы приросты счётчиков непрерывно повторяющейся ошибки
       const sinceLast = lastSentAt === null ? Infinity : now() - lastSentAt;

       timer = setTimeout(flush, Math.max(flushDelayMs, minIntervalMs - sinceLast));
     }
     ```

   - в `flush()` внутри `guarded`, после сбора `items`: `if (items.length >
     0) { lastSentAt = now(); }`. Прямой `flush()` (`pagehide`, смена
     контекста) идёт без ограничения — так и задумано.
   - Шапку модуля поправить: «отправка — пачками: первая через 2 с,
     следующие не чаще раза в 10 с».
2. `config/master.js`, блок `clientReports.rateLimit` (строка ~178):
   `{ limit: 30, windowMs: 60000 }` с комментарием: «клиент шлёт не чаще
   раза в 10 с — запас на несколько вкладок за одним адресом (NAT); главная
   защита — бюджет новых отпечатков».

**Тесты** (`diagnostics.test.js`, `vi.useFakeTimers()` — он подменяет и
`Date.now`):

- `capture` → `advanceTimersByTime(2000)` → 1 отправка;
- `capture` на t = 3 с → `advanceTimersByTime(2000)` → всё ещё 1;
- доводим до t = 12 с → 2 отправки;
- `flush()` вручную шлёт сразу, без ожидания.

Существующий тест «несколько capture — одна отправка через flushDelayMs»
остаётся зелёным.

### 5.5 Исключение из `sendBeacon` (№13)

`diagnostics.js`, `defaultSend`: вызов `sendBeacon` обернуть в `try`:

```js
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    try {
      if (navigator.sendBeacon(url, new Blob([json], { type: 'application/json' }))) {
        return;
      }
    } catch {
      // старые Chromium бросали SecurityError на Blob с application/json
      // (crbug.com/490015) — тогда запасной fetch
    }
  }
```

**Тест:** `sendBeacon` бросает → вызван `fetch` с `keepalive: true`.
Шаблон — существующий тест «sendBeacon вернул false».

**Документация этапа 5 (en + ru):**

- `docs/{en,ru}/client.md`, раздел «Error reporting» / «Журнал ошибок»:
  - абзац «Limits»: вместо «debounced by 2 s» написать «the first send 2 s
    after the first report, later sends at most every 10 s; `pagehide` and
    a context change send at once»;
  - добавить: при смене игры или роли накопленное уходит со старым
    контекстом;
  - ошибка Worker'а несёт кадр `filename:lineno:colno`; сбой init —
    собственный стек Worker'а;
  - исключение `sendBeacon` → запасной `fetch`.
- `docs/{en,ru}/master.md` и `docs/{en,ru}/configuration.md`: лимит «10
  requests a minute» → 30.

**Журнал** `[Unreleased]` → `### Fixed`:

```
- A recurring client error no longer loses its repeat counts to the server's
  rate limit: the reporter sends at most every 10 s (the first batch still
  after 2 s), and `POST /client-reports` allows 30 requests a minute per
  address.
- Client error reports buffered before a game or role switch are sent with
  the context they happened in.
- Host Worker errors are reported with their location
  (`filename:line:column`), and a failed Worker init with the Worker's own
  stack instead of the main thread's.
- The error reporter falls back to `fetch` when `navigator.sendBeacon`
  throws.
```

`contract/surface.json` не меняется: сервис `diagnostics` и его API
прежние.

---

## Этап 6. Контекст `role`/`page` доходит до журнала (№15) ✅ выполнен

Поля `context.role` (`client`/`host`) и `context.page` клиент собирает
(`main.js`), бокс проверяет (`sanitize.js`), а потом выбрасывает: их нет ни
в записи буфера (`createClientReportRoute.js`, `buffer.add`), ни в таблице.
Документация (`client.md` → «Privacy») обещает их в отчёте. Задумка этапа 3
исходного плана — различать ошибки вкладки хоста, поэтому поля доводятся
до журнала. Как `box`/`mode`/`user_agent`, они по правилу «первый прислал»
и в отпечаток не входят.

**Файлы и шаги:**

1. Новая миграция
   `packages/auth/src/db/migrations/014_client_reports_context.sql`
   (миграции перезапускаются на каждом деплое, поэтому `IF NOT EXISTS`):

   ```sql
   -- Контекст отчёта (plan/client-reports-review): роль вкладки и страница.
   -- Как box/mode/user_agent — «первый прислал», в отпечаток не входят
   ALTER TABLE client_reports ADD COLUMN IF NOT EXISTS role TEXT;  -- client | host
   ALTER TABLE client_reports ADD COLUMN IF NOT EXISTS page TEXT;  -- pathname страницы, ≤ 128
   ```

2. Бокс, `master/clientReports/createClientReportRoute.js`: в объект
   `buffer.add({...})` после `mode` добавить `role: context.role, page:
   context.page,`. В `master/clientReports/index.js` → `makeDroppedEntry`
   добавить `role: null, page: null,` — форма записи должна быть одинаковой.
3. Auth:
   - `config/auth.js` → `clientReports.limits` дополнить `page: 128`;
   - `lib/clientReportValidators.js`: экспорт `REPORT_ROLES = ['client',
     'host']`; в `normalizeReportItem` поля `role:
     REPORT_ROLES.includes(raw.role) ? raw.role : null` и `page:
     cut(raw.page, limits.page)`.
4. `ClientReportRepository.js`:
   - `REPORT_COLUMNS` — добавить `r.role, r.page`;
   - `mapReport` — `role: row.role, page: row.page`;
   - `toRecord` — `role: item.role, page: item.page`;
   - в `INSERT` дописать `role, page` в список колонок, в `SELECT` из
     recordset и в описание `r(... role text, page text)`;
   - `ON CONFLICT` их **не** обновляет.
5. Панель, `client/components/view/ClientReports.js`, метод `_details`:
   после строки «User agent» добавить `this._line(\`Role: ${report.role ??
   '—'}; page: ${report.page ?? '—'}\`)`. Только через `_line`, то есть
   `textContent`.

**Тесты:**

- `tests/master/clientReportRoute.test.js`: в буфер уходят `role`/`page` из
  контекста;
- `tests/auth/clientReportValidators.test.js`: верная роль проходит, чужая
  → `null`; `page` режется до 128;
- `tests/auth/ClientReportRepository.test.js`: JSON INSERT'а содержит
  `role`/`page`; `list`/`get` отдают их в camelCase;
- `tests/client/ClientReportsView.test.js`: роль и страница выводятся
  текстом; `<img onerror>` в `page` не создаёт элемент.

**Документация (en + ru):**

- `docs/{en,ru}/auth.md` — колонки таблицы и поля записи;
- `docs/{en,ru}/master.md` — какие поля бокс пересылает в auth;
- `docs/{en,ru}/client.md` — что показывает развёрнутая строка панели.

**Журнал** `[Unreleased]` → `### Fixed`: `Client error reports keep the
tab's role (client/host) and page from their context; the server used to
drop them before forwarding. The Errors panel shows both.`

**Выкладка:** миграция `014` применится сама при деплое auth-стека
(`node src/db/migrate.js` в `deploy.yml`).

---

## Этап 7. vimp-tanks: устаревший комментарий (№16) ✅ выполнен

**Репозиторий:** `/Users/dmitry/Sites/my/vimp-tanks`. **Файл:**
`src/client/levelView.js`, комментарий над `warnNoCamera` (строки ~70–74).

Последнюю фразу «один раз сказать в консоль — единственный способ прижать
причину на проде, где идут опубликованные сборки» заменить на:

```
// … поэтому тихо он бы и остался. Один раз сказать — в консоль и в журнал
// клиентских ошибок движка (`diagnostics`, если движок его даёт), —
// единственный способ прижать причину на проде, где идут опубликованные
// сборки
```

Код не меняется, поэтому ни журнала, ни документации не нужно
(`docs/en/architecture.md` уже описывает `setDiagnostics`). Проверка в
tanks: `npx eslint .` и `npx vitest run --reporter=dot`.

---

## Влияние на релиз

| Этап | Артефакт | Уровень |
| --- | --- | --- |
| 1, 3, 4 | образ бокса (`src/master`, `src/dedicated` в npm не входят); выкладка — push в `main` | записи `### Security`/`### Fixed` → ближайший npm-релиз `vimp-engine` будет patch |
| 2, 6 (auth) | auth-сервис; миграция `014` — автоматически при деплое | журнала нет |
| 5, 6 (клиент) | npm `vimp-engine` (`src/client`, `src/host`, `src/config`) | patch (`### Fixed`) |
| 7 | vimp-tanks, только комментарий | без релиза |

- `contract/surface.json` не меняется. vimp-tanks следовать за движком не
  обязан.
- **Отдельно и срочно (вручную, разработчик):**
  1. Релиз `@vimp-games/tanks` 0.23.0: в `[Unreleased]` лежат фикс падения
     4092a28 и этап 6.
  2. Передеплой dedicated-бокса.
  3. После этого во вкладке «Errors» ждать строку `tanks.camera.missing`:
     она покажет первопричину.

## Проверка по окончании

1. Из корня `/Users/dmitry/Sites/my/vimp`: `npx eslint .` и `npx vitest run
   --reporter=dot` — зелёные.
2. Этап 1: интеграционный тест `httpSecurity.test.js` зелёный. Все
   варианты `.%6dap`/`%2Emap`/`.MAP` дают 404.
3. Этап 2: ручной `EXPLAIN` показывает `Index Cond`.
4. Этап 5, ручная проверка в dev-лобби (`npm run dev`, без
   `VIMP_CLIENT_REPORTS_TOKEN` — только журнал процесса):
   - в консоли страницы выполнить `setTimeout(() => { throw new
     Error('probe'); })`;
   - через ~2 с в выводе мастера появляется `[vimp:client-report] new …
     error/client probe`.
5. Этап 6: `npm run auth:db:migrate` дважды подряд — без ошибок; `\d
   client_reports` показывает `role` и `page`.
6. Этап 7: в `/Users/dmitry/Sites/my/vimp-tanks` — `npx eslint .` и `npx
   vitest run --reporter=dot` зелёные.
