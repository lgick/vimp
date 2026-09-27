# Этап 4. Source maps и расшифровка стеков на боксе ✅ выполнен

Репозиторий: `vimp`. Зависит от этапа 2 (хук `symbolicate` в
`createClientReportRoute`). Карты игр появятся с этапом 6 (vimp-tanks);
до тех пор кадры игры остаются сырыми — это штатно.

## Цель

Стек `client-BvkP3FTH.js:84:46108` в журнале превращается в
`src/client/tank3d/project.js:36:…`. Для этого:

1. сборка движка выпускает **скрытые** source maps (`sourcemap: 'hidden'`:
   файлы `*.map` есть, ссылки `//# sourceMappingURL` в бандле нет);
2. бокс в проде **никогда не отдаёт `*.map`** наружу;
3. бокс расшифровывает стек **нового** отпечатка по картам со своего диска
   (движок — в образе, игры — в `VIMP_GAMES_DIR` / `node_modules`) до
   пересылки в auth.

## Что прочитать перед началом

- `packages/engine/vite.config.js` — блок `build` (`rollupOptions.external:
  ['pixi.js', 'pixi.js/unsafe-eval']`).
- `Dockerfile` (корень) — runner-стадия копирует `packages/engine/dist/`
  целиком: убедиться, что `*.map` туда попадают (glob не отсекает).
- `packages/engine/src/master/lobby.js`: `engineDir` (стр. ~40), порядок
  middleware — `securityHeaders` (стр. ~317) → … → `app.use('/games',
  gameStatic.handler)` (стр. ~750) → `ViteExpress.bind(app, server)`
  (стр. ~832, в проде раздаёт `packages/engine/dist/` статикой).
- `packages/engine/src/master/gameStatic.js` — разбор
  `/games/<id>[/<version>]/…` (`GAME_VERSION_PATTERN` из `gameRefs.js`,
  `catalog.getDistDir(id, version?)`).
- `packages/engine/src/dedicated/main.js` — `distDir` (стр. ~316) и маунты
  `express.static(distDir)` на `/games/${id}/${packageVersion}` и
  `/games/${id}` (стр. ~501–504); `ViteExpress` там тоже есть.
- `packages/engine/src/master/httpSecurity.js` — `securityHeaders`.
- Этап 2: `packages/engine/src/master/clientReports/createClientReportRoute.js`
  (параметр `symbolicate`) и `index.js` (`createClientReports`).

## Шаги

### 4.1. Скрытые карты в сборке движка

`packages/engine/vite.config.js`, в `build`:

```js
// скрытые source maps (plan/client-reports, этап 4): файлы *.map ложатся в
// dist/, но бандл на них не ссылается — браузер их не просит, а бокс в проде
// их не раздаёт (denySourceMaps). Нужны самому боксу: он расшифровывает
// стеки журнала клиентских ошибок
sourcemap: 'hidden',
```

После `npm run build:app` проверить: `ls packages/engine/dist/assets/*.map`
есть, `grep -L sourceMappingURL packages/engine/dist/assets/*.js` — все
бандлы без ссылки. Постбилд-проверка CSP-хэша importmap
(`scripts/check-importmap-csp-hash.mjs`) не должна измениться — если
изменилась, следовать её выводу.

### 4.2. Запрет раздачи `*.map` — `packages/engine/src/master/httpSecurity.js`

```js
// Скрытые source maps лежат рядом с бандлами (plan/client-reports): их
// читает сам бокс, а снаружи они — исходники сборки по запросу любого.
// Только прод: в dev карты раздаёт Vite, и они нужны DevTools
export function denySourceMaps({ isProduction }) {
  return (req, res, next) => {
    if (isProduction && req.path.endsWith('.map')) {
      res.status(404).json({ error: 'notFound' });
      return;
    }

    next();
  };
}
```

Подключить **сразу после** `app.use(securityHeaders(...))` и в
`lobby.js`, и в `dedicated/main.js` — тогда он стоит раньше и `/games`, и
`express.static`, и `ViteExpress`.

### 4.3. Общий разбор игрового пути — `packages/engine/src/master/gameStatic.js`

Вынести разбор пути из `handler` в экспортируемую функцию, `handler`
перевести на неё (поведение раздачи **не меняется**, существующие тесты
раздачи обязаны остаться зелёными):

```js
// '/<id>[/<version>]/<rest>' (путь ПОСЛЕ префикса /games) → { id, version, rest } | null
export function parseGamePath(pathname) { … }
```

`version` — строка, если второй сегмент проходит `GAME_VERSION_PATTERN`,
иначе `undefined` (тогда `rest` начинается со второго сегмента). Битая
процентная последовательность → `null`.

### 4.4. Зависимость

`npm install source-map-js@^1 -w packages/engine` (чистый JS, синхронный
`SourceMapConsumer`; им пользуется сам Vite). Попадает в `dependencies`
`packages/engine/package.json` → изменение npm-пакета, отметить в отчёте.

### 4.5. Расшифровщик — `packages/engine/src/master/clientReports/symbolicate.js`

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { SourceMapConsumer } from 'source-map-js';

/**
 * @param {Object} opts
 * @param {(pathname: string) => string|null} opts.resolveFile - URL-путь бандла → абсолютный файл
 * @param {string[]} opts.roots - корни, за которые файл выходить не вправе
 * @param {number} [opts.maxFrames=12]
 * @param {number} [opts.cacheSize=20] - сколько разобранных карт держать (LRU)
 * @param {number} [opts.maxMapBytes=20 * 1024 * 1024]
 * @returns {(stack: string) => Promise<string>}
 */
export function createSymbolicator(opts) { … }
```

Алгоритм `symbolicate(stack)`:

1. Разбить по `\n`. Первая строка (текст ошибки) — как есть.
2. Для первых `maxFrames` строк-кадров распознать `(fn?, url, line, col)`
   в форматах V8 (`at fn (URL:L:C)`, `at URL:L:C`) и Firefox/Safari
   (`fn@URL:L:C`) — тот же разбор, что `rawTopFrame` этапа 2 (вынести общий
   `parseFrame(line)` в `fingerprint.js` и переиспользовать).
3. URL не `http(s):` (например `blob:` Worker-а) → кадр как есть.
4. `pathname = new URL(url).pathname` → `file = resolveFile(pathname)`;
   `null` → как есть.
5. **Защита**: `path.resolve(file)` обязан начинаться с одного из
   `roots` + `path.sep`; расширение — `.js`/`.mjs`; `mapPath = file + '.map'`;
   `fs.stat(mapPath)` — файл и `size ≤ maxMapBytes`. Иначе — как есть.
6. Карта из LRU-кэша (`Map`, при попадании — переставить в конец; при
   переполнении — удалить первый) или `new SourceMapConsumer(JSON.parse(text))`.
7. `consumer.originalPositionFor({ line, column: col - 1 })`; нет `source` —
   как есть; иначе строка
   `    at ${pos.name ?? fn ?? '<anonymous>'} (${normalizeSource(pos.source)}:${pos.line}:${pos.column + 1}) [${pathname}:${line}:${col}]`
   (сырое место в скобках — на случай несовпадения карты).
8. Кадры после `maxFrames` — как есть. Любая ошибка на кадре — кадр как есть
   (одна битая карта не ломает весь стек).
9. Итог обрезать до `STACK_SYMBOLICATED` (8000) из `limits.js`.

`normalizeSource(source)`: убрать префиксы вида `webpack://`, `vite://`,
ведущие `../` и `./`; если в пути есть `src/` или `node_modules/` —
оставить хвост начиная с них (`/(?:^|\/)((?:src|node_modules)\/.*)$/`).

### 4.6. Резолверы путей и подключение

Лобби (`lobby.js`), только в проде (в dev бандлов на диске нет — Vite):

```js
const engineDist = path.join(engineDir, 'dist');

const symbolicate = isProduction
  ? createSymbolicator({
      roots: [engineDist, config.get('master:gameStore:dir')],
      resolveFile: pathname => {
        if (pathname.startsWith('/games/')) {
          const parsed = parseGamePath(pathname.slice('/games'.length));
          const dir = parsed && gameCatalog.getDistDir(parsed.id, parsed.version);

          return dir ? path.join(dir, parsed.rest) : null;
        }

        return path.join(engineDist, pathname);
      },
    })
  : null;
```

и передать `symbolicate` в `createClientReports({ … })` (этап 2).
Проверить при исполнении: в `roots` обязаны попасть **все** каталоги, из
которых `gameCatalog.getDistDir` отдаёт игры (хранилище пакетов и, если
есть, `node_modules` локально прилинкованных игр) — посмотреть
`GameCatalog.getDistDir`.

Dedicated (`dedicated/main.js`): тот же вызов; `engineDist` — путь к
`packages/engine/dist` от файла (`path.resolve(fileURLToPath(import.meta.url),
'..', '..', '..', 'dist')`, если нужной переменной ещё нет); `roots:
[engineDist, distDir]`; игровой путь резолвится, только если `parsed.id ===
id` (игра dedicated одна), в `distDir`.

## Тесты (`tests/master/`)

- `clientReportsSymbolicate.test.js`: во временном каталоге собрать
  фикстуру через `SourceMapGenerator` из `source-map-js`
  (`addMapping({ generated: { line: 1, column: 10 }, original: { line: 42,
  column: 4 }, source: '../../src/client/parts/Tank.js', name: 'modelLean' })`)
  → `bundle.js` + `bundle.js.map`; ожидания:
  - V8-кадр `at Tr (https://h/assets/bundle.js:1:11)` →
    `at modelLean (src/client/parts/Tank.js:42:5) [/assets/bundle.js:1:11]`;
  - Firefox-кадр `Tr@https://h/assets/bundle.js:1:11` — то же;
  - первая строка стека не меняется; кадры после `maxFrames` — сырые;
  - нет карты / `blob:` / чужой хост без файла → сырой кадр;
  - **обход**: `resolveFile`, вернувший путь вне `roots` (через `..`), и
    файл не `.js` → сырой кадр, `fs.readFile` не вызывается;
  - карта больше `maxMapBytes` → сырой кадр;
  - LRU: повторный вызов не читает карту с диска второй раз (шпион на
    `readFile` или счётчик).
- `gameStatic` — тесты `parseGamePath` (с версией, без версии, битый
  `%ZZ`); существующие тесты раздачи (`tests/master/lobbyGamesRoutes.test.js`)
  — без изменений и зелёные.
- `denySourceMaps` (новый тест в `tests/master/`, по образцу тестов
  `httpSecurity`, если есть): прод — `/assets/a.js.map` → 404, `/assets/a.js`
  → `next()`; dev — пропускает.
- `clientReportRoute.test.js` (этап 2) — кейс: `symbolicate` подменяет стек
  нового отпечатка, а повтор отпечатка его не вызывает.

## Документация (en + ru)

- `master.md` — в разделе «Client error reports»: расшифровка стеков по
  скрытым картам, только для нового отпечатка, карты наружу не отдаются
  (`denySourceMaps`), без карты кадр остаётся сырым.
- `dedicated.md` — то же кратко.
- `deployment.md` — образ содержит `*.map` движка; карты игр приезжают
  вместе с их `dist/`.
- `publishing.md` — сборка движка выпускает скрытые карты (если там описан
  состав `dist/`).

## Журнал

`packages/engine/CHANGELOG.md`, `## [Unreleased]` → `### Added`:

- Client error reports are symbolicated on the server from hidden source
  maps (`sourcemap: 'hidden'`); `*.map` files are never served in
  production.

## Проверка

```bash
npx eslint .
npx vitest run --project engine-node --reporter=dot
npm test --silent
npm run build:app && ls packages/engine/dist/assets/*.map | head
```

Ручная, прод-подобный запуск: `npm run build:app`, затем мастер с
`NODE_ENV=production` по `docs/en/getting-started.md` (или `npm start` с
`.env`); `curl -I https://<host>/assets/<любой>.js.map` → 404. Вызвать в
DevTools `setTimeout(() => { throw new TypeError('probe'); })` → в
`client_reports.stack` кадры вида `at … (src/client/…:L:C) [/assets/…]`.

## Готово, когда

- `dist/` движка содержит скрытые карты, прод их не раздаёт;
- стек нового отпечатка приходит в auth расшифрованным, битая/отсутствующая
  карта не мешает приёму;
- тесты, линт, документация, журнал — готовы;
- этот файл и строка в `README.md` помечены «✅ выполнен»; в отчёте —
  release impact: `packages/engine/package.json` (`source-map-js` в
  `dependencies`), сборка движка.
