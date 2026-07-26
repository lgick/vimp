# A2. Конфиг-список игр на мастере ✅критично ✅ выполнен

- В `packages/engine/src/config/master.js` добавить блок `games` (рядом с
  `iceServers`/`servers`/`host`): массив `{ id, package, version }`. В проде —
  переопределяемый env/CI-переменной (по образцу `SERVERS_MATRIX`), например
  `GAMES_MATRIX` (JSON).
- `packages/engine/src/master/GameCatalog.js`: заменить скан `games/*` на чтение
  манифестов из установленных пакетов
  (`node_modules/<package>/dist/manifest.json`). Публичный API каталога
  (`ids`/`manifestList`/`getManifest`/`getMapCatalog`) и все `/games/*` роуты
  (`master/main.js`) остаются как есть. Убрать hardcode
  `gamesDir = <engineDir>/../../games` (`main.js:21-22`).
- `express.static('/games/:id', …)` (`main.js:176-178`) монтируется на
  `dist/`-директорию установленного пакета игры.
- Dev-режим (`_toDevManifest`, Vite `/@fs/`): для локальной разработки игры —
  через `npm link`/локальный path пакета, чтобы HMR работал по исходникам игры.
- Клиентская мапа URL-ов (`config/lobby.js`) и выбор игры (сейчас `[0]`, селектор
  скрыт) — без изменений; много игр в списке уже поддержано.

## Критические файлы

`packages/engine/src/config/master.js` (блок `games`),
`packages/engine/src/master/GameCatalog.js`, `packages/engine/src/master/main.js`
(`gamesDir`, static-mount).

## Реализация

- `packages/engine/src/config/master.js` — добавлен блок `games: [{ id, package, version }]`
  (дефолт: `@vimp/tanks`).
- `packages/engine/src/master/main.js` — `gamesDir` заменён на `nodeModulesDir`
  (`<engineDir>/../../node_modules`); добавлен env-override `GAMES_MATRIX`
  (JSON) в проде, по образцу `VIMP_AUTH_SERVICE_URL`; `GameCatalog` теперь
  принимает `(games, nodeModulesDir, options)`; статик-маунт `/games/:id`
  берёт директорию через новый `gameCatalog.getDistDir(id)`.
- `packages/engine/src/master/GameCatalog.js` — вместо скана директории
  резолвит каждую запись конфига `{id, package}` в
  `node_modules/<package>/dist/manifest.json`; публичный API (`ids`,
  `manifestList`, `getManifest`, `getMapCatalog`) не изменился, добавлен
  `getDistDir(id)`. До физического разъезда репозиториев (A3) `package`
  резолвится через npm workspace-симлинк `node_modules/@vimp/tanks ->
  games/tanks` — проверено вручную (`npm run dev`, лог "Games loaded: tanks").
- Dev-режим (`_toDevManifest`) не менялся по механике — просто использует
  резолвленную директорию пакета вместо директории `games/<id>`.
- Тесты: `tests/master/GameCatalog.test.js` переписаны под новую сигнатуру
  (фикстуры пишутся в `node_modules/<pkg>/dist/...`, добавлен тест на
  `getDistDir`).
- Документация: `docs/{en,ru}/master.md` (описание `GameCatalog`, роуты
  `/games/*`, список тестов), `docs/{en,ru}/configuration.md` (поле `games` в
  `config/master.js`, переменная `GAMES_MATRIX`).
- `npx eslint .` и `npm test` — зелёные (85 файлов / 796 тестов).
