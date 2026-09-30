# Кодревью `client-reports-review` (второй круг) и план исправлений

> План самодостаточен: исполнителю не нужен контекст беседы, в которой он
> составлен. Перед каждым этапом прочитать разделы «Контекст», «Найденные
> проблемы», «Общие правила исполнения» и сам этап.

## Контекст

Задача `client-reports-review`
(`vimp/plan/done/client-reports-review.md`, 17 замечаний, 7 этапов)
исправляла журнал клиентских ошибок. Коммиты:

- движок: `deaa60d1` (`/Users/dmitry/Sites/my/vimp`);
- игра: `9314ff7` (`/Users/dmitry/Sites/my/vimp-tanks`, только
  комментарий в `src/client/levelView.js`).

**Как проверялось:**

- прочитан весь дифф: auth, бокс, клиент, документация, тесты;
- `npx eslint .` чистый, `npx vitest run` — 209 файлов, 2733 теста,
  зелёные;
- эксперименты на настоящем коде (скрипты в scratchpad):
  - **расшифровку стеков можно выключить двумя отчётами в минуту** —
    подтверждено (№1);
  - ошибки парсера тела `POST /client-reports` уходят в обработчик Express по
    умолчанию — подтверждено (№2);
  - обработчик ошибок на уровне маршрута в Express 5 их перехватывает —
    проверено (основа решения №2);
  - миграция `014` применяется до пересоздания контейнера auth
    (`deploy.yml`, строки 207 и 222) — порядок верный.

**Итог:** все 16 пунктов прошлого плана выполнены по плану, отступления
исполнителя обоснованы. Найдено 5 новых замечаний: одна регрессия,
внесённая самим исправлением (№1), одна старая дыра, найденная только
сейчас (№2), и три мелочи.

## Итог по критериям

| Критерий            | Оценка         | Замечания                                                                                                                       |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Читаемость          | хорошо         | `_reportWorkerMessage` вместо двух методов, `workerErrorReport`, `stopClientReports` — понятные имена, комментарии про «почему» |
| Работоспособность   | есть дефект    | №1 (регрессия), №3                                                                                                              |
| Тестируемость       | хорошо         | каждое исправление начато с падающего теста; для №1 не хватило теста на «выдуманные» пути                                       |
| Поддерживаемость    | хорошо         | общий `stopClientReports`, один `originValidator`                                                                               |
| Безопасность        | есть дефекты   | №1 (дешёвый отказ в обслуживании расшифровки), №2 (шум в журнале процесса от любого клиента)                                    |
| Производительность  | хорошо         | бюджет разборов карт ограничивает CPU (≤ 20 × ~35 мс в минуту); индекс в `ingest` работает                                      |
| Масштабируемость    | хорошо         | лимит 30 запросов в минуту и каденс 10 с согласованы                                                                            |
| DRY                 | мелочь         | №4: правило «строка — кадр» есть в расшифровке, но не в отпечатке                                                               |
| Документированность | хорошо, мелочь | en/ru зеркальны; №5 — длинные строки в en                                                                                       |
| Стандартизация      | соответствует  | ESM, `===`, скобки, порядок импортов                                                                                            |

## Найденные проблемы

| №   | Серьёзность                                                      | Где                                                  | Суть                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Этап |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 1   | **Средняя** (регрессия, отказ в обслуживании)                    | бокс, `master/clientReports/symbolicate.js`          | Бюджет «20 карт в минуту» списывается ещё до `fs.stat`, то есть и за путь, которого нет. Отсутствующая карта (`null`) ложится в тот же LRU на 20 мест и вытесняет настоящие карты. Подтверждено: 2 отчёта в минуту по 12 кадров на выдуманные `https://box/assets/fake-N.js:1:1` выключают расшифровку всем. Карты вытеснены, бюджет минуты выжжен, стоимость для атакующего — 2 запроса. До исправления №4 так не было: отсутствующие карты не кэшировались | 1    |
| 2   | Низкая–средняя (гигиена журнала, найдено сейчас, есть с этапа 2) | бокс, `createClientReportRoute.js`                   | Сбой `express.json` уходит в обработчик Express по умолчанию: битый JSON → 400, тело больше 16 КБ → 413. Этот обработчик печатает **полный стек** в stderr на каждый такой запрос и отвечает HTML-страницей. Подтверждено: 2 запроса → 2 вызова `console.error`. Любой браузер может писать многострочный мусор в `docker logs` (до 30 раз в минуту с адреса) — мимо санитайза `oneLine`                                                                     | 2    |
| 3   | Низкая                                                           | клиент, `lib/diagnostics.js`                         | После исправления №8 отчёты до 10 с ждут таймера, а отправка «сразу» есть только на `pagehide`. Мобильный браузер убивает фоновую вкладку без `pagehide`, последний надёжный момент — `visibilitychange` → `hidden`. Окно потери выросло с 2 до 10 с                                                                                                                                                                                                         | 3    |
| 4   | Низкая (DRY/согласованность)                                     | бокс, `fingerprint.js` ↔ `symbolicate.js`            | Расшифровка считает кадром только строку с `at ` или `@scheme://` (`FRAME_LINE_RE`). Отпечаток (`rawTopFrame`) берёт первую строку, которая оканчивается на `url:line:col`, — в том числе V8-сообщение. Одно правило живёт в двух местах по-разному                                                                                                                                                                                                          | 4    |
| 5   | Низкая (стандарт оформления)                                     | `docs/en/client.md`, `configuration.md`, `master.md` | Дописанные фразы вылезли за ширину ~80 символов, которой держится остальной en-текст (до 121 символа). В ru абзац — одна строка, там правка не нужна                                                                                                                                                                                                                                                                                                         | 5    |

**Принято без исправления:**

- №17 прошлого плана — снятие слушателей SDK после `stop()`. Остаётся
  отложенным по той же причине: у `main.js` нет харнесса.
- Ключ дедупа на клиенте (`topFrame` в `diagnostics.js`) не приводится к
  правилу №4. Он влияет только на склейку внутри вкладки, живёт в
  браузерном бандле, а `fingerprint.js` импортирует `node:crypto`.
- `details` служебной строки `reports.dropped` при слиянии. Свежая запись
  тика всегда идёт первой в пачке (`[...pending, ...drain]` в
  `ClientReportForwarder._flush`), поэтому auth получает последнее окно.
  Всё верно.

## Общие правила исполнения

Правила взяты из `CLAUDE.md` репозитория `vimp`.

- **Никаких коммитов**, правок `version` и публикаций.
- Все этапы — в `/Users/dmitry/Sites/my/vimp`. Каждый заканчивается
  зелёными `npx eslint .` и `npx vitest run --reporter=dot` из корня.
- Исправление начинается с теста, который воспроизводит баг: на текущем
  коде он падает.
- **Документация — в том же изменении**: `docs/en/<page>.md` канон,
  `docs/ru/<page>.md` — зеркало. В en ширина строки ~80 символов; в ru
  абзац пишется одной строкой.
- **Журнал** `packages/engine/CHANGELOG.md`, раздел `## [Unreleased]`
  (0.35.x ещё не выпущен). Если исправление уточняет **уже лежащую там**
  запись, править её, а не добавлять вторую. Подзаголовки — только
  `### Security` / `### Fixed`.
- Комментарии в коде — по-русски, кратко, про «почему».
- Готовый этап помечать в заголовке «✅ выполнен». Когда выполнены все —
  `git mv plan/client-reports-review-2.md plan/done/` (без коммита).

---

## Этап 1. Выдуманные пути бандлов выключают расшифровку (№1) ✅ выполнен

**Файлы:**

- `packages/engine/src/master/clientReports/symbolicate.js`;
- `tests/master/clientReportsSymbolicate.test.js`;
- `docs/{en,ru}/master.md`;
- `packages/engine/CHANGELOG.md`.

**Причина.** Сейчас в `loadMap` порядок такой:

1. `takeColdLoad()` списывает бюджет;
2. `readMap()` делает `fs.stat`;
3. при `ENOENT` возвращает `null`;
4. промис с `null` лежит в том же `cache` (LRU, `cacheSize = 20`), что и
   настоящие карты.

`resolveFile` для любого пути вне `/games/` строит `path.join(engineDist,
pathname)`, поэтому любой `https://box/assets/<что-угодно>.js` проходит
проверки корня и расширения. Два отчёта по 12 таких кадров в минуту:

- выжигают бюджет 20;
- заполняют LRU нулями и вытесняют настоящие карты.

В итоге расшифровка выключена у всех.

**Решение.** Три правила:

- в LRU живут только настоящие карты (`SourceMapConsumer`);
- отсутствующие и негодные пути хранятся в отдельном ограниченном `Set`;
- бюджет списывается только перед настоящим чтением и разбором.

Склейка параллельных загрузок переезжает в отдельную `Map` загрузок «в
полёте».

1. Новый параметр `createSymbolicator`: `maxMissing = 1000`. Дописать в
   JSDoc: «сколько отсутствующих/негодных карт помнить; при переполнении
   множество чистится целиком».
2. Заменить объявление `cache` и добавить состояние:

   ```js
   // mapPath → SourceMapConsumer: только настоящие карты. Порядок вставки
   // Map и есть порядок LRU
   const cache = new Map();
   // mapPath → Promise<SourceMapConsumer|null>: одновременные загрузки одной
   // карты читают её с диска один раз
   const inflight = new Map();
   // карты, которых нет или которые не годятся (не файл, больше maxMapBytes),
   // — отдельно от LRU: поток выдуманных путей бандлов иначе вытеснял бы из
   // него настоящие карты. При переполнении чистится целиком — как
   // `_logged` в ClientReportBuffer
   const missing = new Set();

   const rememberMissing = mapPath => {
     if (missing.size >= maxMissing) {
       missing.clear();
     }

     missing.add(mapPath);
   };
   ```

3. `readMap`: бюджет — после проверок, перед чтением.

   ```js
   // null — карты нет, она не годится или кончился бюджет минуты; прочие
   // сбои — исключение. Бюджет тратит только настоящее чтение с разбором:
   // stat дёшев, а выдуманные пути бандлов не должны выжигать бюджет
   const readMap = async mapPath => {
     let stat;

     try {
       stat = await fs.stat(mapPath);
     } catch (err) {
       if (err.code === 'ENOENT') {
         rememberMissing(mapPath);
         return null;
       }

       throw err;
     }

     if (!stat.isFile() || stat.size > maxMapBytes) {
       rememberMissing(mapPath);
       return null;
     }

     if (!takeColdLoad()) {
       return null;
     }

     return new SourceMapConsumer(JSON.parse(await fs.readFile(mapPath, 'utf8')));
   };
   ```

4. В `loadMap` всё после `const mapPath = …` заменить на код ниже.
   Проверки корня и расширения выше не трогать. Старый блок
   `pending.catch(...)` удалить.

   ```js
   const mapPath = `${resolved}.map`;
   const cached = cache.get(mapPath);

   if (cached) {
     cache.delete(mapPath);
     cache.set(mapPath, cached);

     return cached;
   }

   if (missing.has(mapPath)) {
     return null;
   }

   let pending = inflight.get(mapPath);

   if (!pending) {
     pending = readMap(mapPath).finally(() => inflight.delete(mapPath));
     inflight.set(mapPath, pending);
   }

   const consumer = await pending;

   // в LRU попадают только настоящие карты: пустой ответ ничего не
   // вытесняет. Карты нет — её помнит `missing`; кончился бюджет —
   // прочитается в следующую минуту. Сбой чтения (EIO, битый JSON)
   // исключением уходит к вызывающему и тоже не кешируется
   if (consumer && !cache.has(mapPath)) {
     cache.set(mapPath, consumer);

     if (cache.size > cacheSize) {
       cache.delete(cache.keys().next().value);
     }
   }

   return consumer;
   ```

5. Комментарий над `takeColdLoad` дополнить: «списывается только перед
   чтением существующей карты».

**Тесты** (`clientReportsSymbolicate.test.js`).

Сначала — тест-воспроизведение. На текущем коде он **падает**:

1. «выдуманные бандлы не выключают расшифровку»:
   - `let t = 0; const symbolicate = make({ now: () => t })` (умолчания:
     бюджет 20, LRU 20);
   - расшифровать `[HEAD, V8_FRAME]` при t = 0;
   - `t = 60000`;
   - два вызова со стеком `[HEAD, ...12 кадров '    at f
(https://h/assets/fake-<n>-<i>.js:1:1)']` (пути у всех кадров разные);
   - затем `[HEAD, V8_FRAME]` → `DECODED` (карта не вытеснена);
   - и `[HEAD, frame2]` (`bundle2.js`) → `decoded2` (бюджет цел).

Затем:

2. «выдуманные бандлы не вытесняют карты»: `make({ cacheSize: 1 })`,
   расшифровать `bundle.js`, затем стек из трёх кадров `fake-*.js`, затем
   снова `bundle.js`. `vi.spyOn(fs, 'readFile')` вызван **один** раз,
   результат — `DECODED`.
3. «переполнение `missing` чистит множество»: `make({ maxMissing: 2 })` и
   шпион `fs.stat`. По одному стеку на `fake-1`, `fake-2`, `fake-3`, затем
   снова `fake-1` → `stat` вызван 4 раза. Третий путь очистил множество.
4. Существующие тесты остаются без правок и должны пройти:
   - «отсутствующая карта запоминается» (`stat` один раз);
   - «параллельные загрузки одной карты склеиваются»;
   - «бюджет холодных загрузок»;
   - «битая карта не кешируется».

**Документация (en + ru)** — `docs/{en,ru}/master.md`, абзац «Stack
symbolication». Фразу «At most 20 maps a minute are loaded from disk — past
that the frame stays raw; a missing map is remembered…» заменить смыслом:

- не больше 20 карт в минуту **читается и разбирается**, сверх — кадр
  сырой;
- отсутствующая или негодная карта бюджета не тратит, из кэша ничего не
  вытесняет и запоминается (до 1000 путей);
- одновременные загрузки одной карты склеиваются.

**Журнал** — уже лежащую в `[Unreleased]` → `### Security` запись «Stack
symbolication on the server loads at most 20 source maps a minute…»
заменить на:

```
- Stack symbolication on the server parses at most 20 source maps a minute,
  so crafted reports cannot stall the event loop; frames that point at
  bundles which do not exist cost nothing from that budget and never push
  real maps out of the cache.
```

---

## Этап 2. Битое тело `POST /client-reports` печатает стек в журнал (№2) ✅ выполнен

**Файлы:**

- `packages/engine/src/master/clientReports/createClientReportRoute.js`;
- `tests/master/clientReportRoute.test.js`;
- `docs/{en,ru}/master.md`;
- `packages/engine/CHANGELOG.md`.

**Причина.** Маршрут собран как `[limit, express.json({ limit: bodyLimit
}), handle]`. При битом JSON или теле больше 16 КБ `express.json` зовёт
`next(err)`. Своего обработчика ошибок в цепочке нет, и ни в `lobby.js`, ни
в `dedicated/main.js` нет общего `(err, req, res, next)`. Ошибка уходит в
`finalhandler` Express: `console.error(err.stack)` на каждый запрос и
HTML-ответ.

**Решение.** Добавить четвёртым элементом цепочки обработчик ошибок
маршрута. Express 5 вызывает middleware с четырьмя аргументами внутри
маршрута — проверено.

```js
// Сбой разбора тела (битый JSON — 400, больше bodyLimit — 413) без этого
// ушёл бы в обработчик Express по умолчанию: полный стек в журнал
// процесса на каждый такой запрос любого браузера и HTML в ответ. Отказ
// короткий и молчаливый, как у прочих отказов: частоту уже режет `limit`
const bodyError = (err, req, res, next) => {
  if (err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: err.status === 413 ? 'payloadTooLarge' : 'badRequest' });
    return;
  }

  next(err);
};

return [limit, express.json({ limit: bodyLimit }), handle, bodyError];
```

JSDoc у `createClientReportRoute` (`@returns`) — без изменений: это всё ещё
массив middleware для `app.post(...)`.

**Тесты** (`clientReportRoute.test.js`: там уже поднимается настоящий
express через `start()`):

1. Тело `'{bad'` с `content-type: application/json` → статус 400, JSON
   `{ error: 'badRequest' }`, заголовок `content-type` содержит
   `application/json`. `vi.spyOn(console, 'error')` не вызван.
2. Тело `'x'.repeat(20000)` → 413, `{ error: 'payloadTooLarge' }`,
   `console.error` не вызван.
3. Валидное тело — прежний `204` (существующие тесты).

На текущем коде тесты 1–2 падают: ответ HTML, `console.error` вызван.

**Документация (en + ru)** — `docs/{en,ru}/master.md`, список ответов
`POST /client-reports` (строки ~510–513 в en). Строку `→ 413 // body
parser` заменить на две:

```
→ 400 { "error": "badRequest" }      // also a malformed JSON body
→ 413 { "error": "payloadTooLarge" } // body over bodyLimit (16 KB)
```

Дописать одну фразу: отказ парсера тела не пишется в журнал процесса.

**Журнал** `[Unreleased]` → `### Fixed`:

```
- A malformed or oversized `POST /client-reports` body gets a short JSON
  `400`/`413` instead of Express's HTML error page and a stack trace in the
  server log.
```

---

## Этап 3. Отправка при скрытии вкладки (№3) ✅ выполнен

**Файлы:**

- `packages/engine/src/client/lib/diagnostics.js`, функция `install`;
- `tests/client/lib/diagnostics.test.js`;
- `docs/{en,ru}/client.md`;
- `packages/engine/CHANGELOG.md`.

**Причина.** Каденс 10 с (исправление №8) держит отчёты в буфере до 10 с.
«Сразу» отправка есть только на `pagehide`. Мобильные браузеры убивают
фоновую вкладку без `pagehide`, и последний надёжный момент — переход
документа в `hidden`.

**Решение.** В `install(target)` рядом с `onPageHide` добавить:

```js
// фоновую вкладку мобильный браузер убивает и без pagehide: скрытие —
// последний надёжный момент отправить накопленное (по таймеру отчёты
// ждут до minIntervalMs)
const onVisibility = () => {
  if (doc?.visibilityState === 'hidden') {
    flush();
  }
};
```

- Регистрация — в том же `try`, после `securitypolicyviolation`:
  `doc?.addEventListener('visibilitychange', onVisibility);`
- Снятие — в возвращаемой функции:
  `doc?.removeEventListener('visibilitychange', onVisibility);`
- Объявление `const doc = target.document;` стоит **выше** `onVisibility`:
  перенести его на первую строку `install`, если сейчас оно ниже.

**Тесты** (`describe('diagnostics: install')`, happy-dom `window` /
`document`):

1. `install(window)`, `capture(makeError('a'))`, затем:
   - `Object.defineProperty(document, 'visibilityState', { configurable:
true, get: () => 'hidden' })`;
   - `document.dispatchEvent(new Event('visibilitychange'))`;
   - ожидается `send` вызван один раз.

   В `finally` — `delete document.visibilityState` (или переопределить на
   `'visible'`) и `uninstall()`.

2. То же с `'visible'` → `send` не вызван.
3. После `uninstall()` событие `visibilitychange` при `hidden` → `send` не
   вызван.

На текущем коде тест 1 падает.

**Документация (en + ru)** — `docs/{en,ru}/client.md`, абзац «Limits» /
«Лимиты». Фраза «`pagehide` and a context change send at once» →
«`pagehide`, the tab becoming hidden (`visibilitychange`) and a context
change send at once». Зеркально в ru.

**Журнал** `[Unreleased]` → `### Fixed` — отдельная запись:

```
- The error reporter also sends what it has buffered when the tab is hidden,
  not only on `pagehide`: mobile browsers may kill a background tab without
  firing it.
```

---

## Этап 4. Одно правило «строка стека — кадр» для отпечатка и расшифровки (№4) ✅ выполнен

**Файлы:**

- `packages/engine/src/master/clientReports/fingerprint.js`;
- `packages/engine/src/master/clientReports/symbolicate.js`;
- `tests/master/clientReportsFingerprint.test.js`;
- `docs/{en,ru}/master.md`;
- `packages/engine/CHANGELOG.md`.

**Причина.** В `symbolicate.js` есть `FRAME_LINE_RE`
(`/^\s*at\s|@[a-z][a-z0-9+.-]*:\/\//i`): V8-сообщение, которое
оканчивается на `url:line:col`, кадром не считается. А `rawTopFrame` в
`fingerprint.js` перебирает строки через один `parseFrame`. Для стека
`Error: failed https://h/a.js:1:2\n    at f (https://h/b.js:3:4)`:

- верхний кадр отпечатка — `/a.js:1:2` (строка сообщения);
- расшифровка считает верхним кадром `/b.js:3:4`.

**Решение.**

1. `fingerprint.js`: перенести константу сюда и экспортировать проверку.

   ```js
   // строка стека — кадр: V8 `    at …`, Firefox/Safari `fn@scheme://…`.
   // Первая строка V8 — сообщение, у Firefox/Safari её нет вовсе. Сообщение,
   // оканчивающееся на `url:line:col`, кадром не считается — у него нет ни
   // `at `, ни `@`. Одно правило для отпечатка и расшифровки стеков
   const FRAME_LINE_RE = /^\s*at\s|@[a-z][a-z0-9+.-]*:\/\//i;

   export function isFrameLine(line) {
     return FRAME_LINE_RE.test(String(line));
   }
   ```

   В `rawTopFrame` в начале цикла по строкам добавить `if
(!isFrameLine(line)) { continue; }` перед `parseFrame(line)`.

2. `symbolicate.js`:
   - удалить локальную `FRAME_LINE_RE` и её комментарий;
   - импорт `import { isFrameLine, parseFrame } from './fingerprint.js';`;
   - в цикле `decoded < maxFrames && isFrameLine(line) ? parseFrame(line) :
null`.

**Тесты** (`clientReportsFingerprint.test.js`):

- `rawTopFrame('Error: failed https://h/a.js:1:2\n    at f
(https://h/b.js:3:4)') === '/b.js:3:4'` — на текущем коде падает;
- `isFrameLine`: `'    at f (https://h/a.js:1:2)'`, `'Tr@https://h/a.js:1:2'`,
  `'global code@https://h/a.js:1:2'` → `true`; `'TypeError: x'`, `'Error:
failed https://h/a.js:1:2'` → `false`;
- существующие тесты V8 и Firefox/Safari остаются зелёными. Тесты
  расшифровки не меняются.

**Влияние.** Отпечаток меняется только у стеков, где строка сообщения
оканчивается на `url:line:col`. Такие редкие ошибки после деплоя получат
новую строку журнала — это допустимо.

**Документация (en + ru)** — `docs/{en,ru}/master.md`, описание отпечатка
(пункт про `rawTopFrame`, «first frame … V8 and Firefox/Safari formats»).
Дописать: кадром считается строка `at …` или `fn@url`; строка сообщения
V8 кадром не бывает — то же правило, что у расшифровки.

**Журнал** `[Unreleased]` → `### Fixed`:

```
- A client error whose V8 message line ends with `url:line:column` no longer
  takes that line as the top frame of its fingerprint; fingerprints and
  symbolication share one rule for what a stack frame is.
```

---

## Этап 5. Ширина строк в английской документации (№5) ✅ выполнен

**Файлы:** `docs/en/client.md`, `docs/en/configuration.md`,
`docs/en/master.md`.

Найти строки, которые дописал `deaa60d1` и которые длиннее ~80 символов:

```bash
git show deaa60d1 -- docs/en | grep '^+' | grep -v '^+++' | awk 'length > 82'
```

Сейчас их 4, до 121 символа. Кроме того, проверить строки, которые
добавили этапы 1–4 этого плана. Абзацы с такими строками переформатировать
до ~78–80 символов, как соседний текст, **не меняя слов**. `docs/ru/` не
трогать: там абзац — одна строка по соглашению файла.

Журнала нет (`docs/` — не запись).

---

## Влияние на релиз

| Этап    | Артефакт                                                              | Уровень                                                             |
| ------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1, 2, 4 | образ бокса (`src/master` в npm не входит), выкладка push'ем в `main` | записи в `[Unreleased]` → ближайший npm-релиз `vimp-engine` — patch |
| 3       | npm `vimp-engine` (`src/client`)                                      | patch (`### Fixed`)                                                 |
| 5       | только документация                                                   | —                                                                   |

- `contract/surface.json` не меняется. vimp-tanks следовать не обязан.
- **Всё ещё не сделано с прошлого ревью (вручную, разработчик):** на npm
  по-прежнему `@vimp-games/tanks@0.22.6`, а фикс падения 4092a28 и этап 6
  `client-reports` лежат в `[Unreleased]` tanks. Нужны:
  1. релиз tanks 0.23.0;
  2. передеплой dedicated-бокса.

## Проверка по окончании

1. Из корня `/Users/dmitry/Sites/my/vimp`: `npx eslint .` и `npx vitest run
--reporter=dot` зелёные.
2. Этап 1: тест-воспроизведение (две «минуты», 24 выдуманных кадра)
   зелёный; до правки он падал.
3. Этап 2, вручную (dev-лобби, `npm run dev`):

   ```bash
   curl -sk -X POST https://localhost:3002/client-reports \
     -H 'content-type: application/json' --data '{bad'
   ```

   Ответ — `{"error":"badRequest"}`, в выводе мастера нет стека.

4. Этап 3: в dev-лобби выполнить в консоли `setTimeout(() => { throw new
Error('probe'); })` и в течение 2 с переключиться на другую вкладку. В
   выводе мастера сразу появляется `[vimp:client-report] new … probe`, не
   дожидаясь таймера.
5. Этап 5: команда из этапа по добавленным строкам ничего не выводит.
