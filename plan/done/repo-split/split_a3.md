# A3. Вынос репозитория игры

> Необратимая операция вне текущего репозитория (создание нового git-репо и
> перенос истории). Claude готовит содержимое и инструкции; само создание
> репозитория, `git push` и переключение CI-секретов делает пользователь
> вручную. Ниже — детальный чек-лист по подэтапам; каждый подэтап
> самодостаточен, отмечать ✅ по мере выполнения.

## Предусловие

Начинать только после A1–A2 (публикуемые артефакты движка и конфиг-список игр
на мастере готовы) и после направления B (B2–B5, авторизация в монорепо) —
см. `plan/README.md`, раздел «Порядок и зависимости». Оба условия сейчас
выполнены (A1 ✅, A2 ✅, B1–B6 ✅) — можно приступать.

## A3.1. Перенос содержимого игры в новый репозиторий ✅ выполнен

Новый репозиторий, например `vimp-tanks` (пользователь создаёт вручную на
GitHub/etc.). В него переносится **с сохранением истории**
(`git filter-repo --path games/tanks --path scripts/build-game-manifest.js
--path scripts/copy-game-sounds.js --path scripts/export-maps.js
--path scripts/process-audio.js`, либо `git subtree split`, если история не
нужна — проще, но теряет blame) следующее:

- `games/tanks/**`, кроме `dist/`, `core/pkg-web/`, `core/pkg-node/`,
  `build/` (генерируемые, уже в `.gitignore` корня — перенести и правило в
  `.gitignore` нового репо);
- четыре скрипта сборки, которые сегодня лежат в корневом `scripts/` движка,
  но целиком игро-специфичны (ни один не трогает `packages/engine/`):
  `scripts/build-game-manifest.js`, `scripts/copy-game-sounds.js`,
  `scripts/export-maps.js`, `scripts/process-audio.js`. В новом репозитории
  кладутся в `scripts/` на корне (пути `../games/tanks/...` внутри них
  становятся `../...`, т.к. игра теперь сама корень репо — поправить
  относительные `new URL(...)`/импорты).
- В новом репо структура становится плоской: `src/`, `core/`, `assets/`,
  `vite.config.js`, `package.json`, `scripts/` — т.е. `games/tanks/` как
  префикс путей исчезает (то, что было `games/tanks/src/...`, становится
  `src/...`).

После переноса — **в старом репозитории** `git rm -r games/tanks
scripts/build-game-manifest.js scripts/copy-game-sounds.js
scripts/export-maps.js scripts/process-audio.js` (делается в A3.5 вместе с
остальной чисткой, не раньше, чем новый репозиторий проверен).

Сделано: история перенесена `git filter-repo` (708 → 22 коммита, касавшихся
игры) во временный клон, затем зафетчена в `vimp-tanks` как ветка
`game-import`; пути сплющены (`--path-rename games/tanks/:''`); 4 скрипта
перенесены в `scripts/` с поправленными относительными путями; добавлен
`.gitignore`. Ветка `game-import` не смёржена в `main` — оставлено на
усмотрение пользователя.

## A3.2. Rust-крейт игры ✅ выполнен (с оговоркой)

- `games/tanks/core/Cargo.toml` (в новом репо — `core/Cargo.toml`):
  - убрать из `[workspace]` — крейт становится самостоятельным (не член
    workspace `vimp-engine-core`), т.е. в новом репо нужен **свой**
    `Cargo.toml` верхнего уровня с `[workspace] members = ["core"]` (тот же
    паттерн, что сейчас у движка) — иначе `wasm-pack build core` не найдёт
    workspace-корень;
  - зависимость `vimp-engine-core = { path = "../../../packages/engine/core" }`
    заменяется на версию из crates.io: `vimp-engine-core = "x.y.z"` (версия —
    результат `cargo publish -p vimp-engine-core`, ещё не выполнялся в A1 —
    см. предостережение ниже);
  - `workspace.dependencies` (`indexmap`, `rapier2d`, `serde`, `serde_json`,
    `wasm-bindgen`) — в старом Cargo.toml они наследуются из корневого
    workspace; в новом репо их нужно продублировать в собственном
    `[workspace.dependencies]` нового корневого `Cargo.toml` (версии — как
    сейчас в `/Cargo.toml:6-10`);
  - добавить `repository`/`license` поля по образцу
    `packages/engine/core/Cargo.toml` (уже сделано в A1).
- **Предостережение**: A1 подготовил `vimp-engine-core` к публикации
  (`cargo package` проверен), но **не опубликовал** его в crates.io/приватный
  registry (сознательное решение пользователя на тот момент). A3.2
  невозможно закрыть с настоящей version-зависимостью, пока публикация не
  произошла — на время разработки можно временно использовать git- или
  path-зависимость (`vimp-engine-core = { git = "...", tag = "vX" }`), но
  финальный вид — версия из registry. Синхронизировать с пользователем, когда
  публиковать `vimp-engine-core` (можно сделать непосредственно перед A3, как
  отдельный ручной шаг).
- `Cargo.lock` нового репозитория — генерируется заново (`cargo generate-lockfile`
  или первый `cargo build`), не переносится из старого.

Сделано: свой корневой `Cargo.toml` в `vimp-tanks` (`members = ["core"]` +
продублированные `workspace.dependencies`); `core/Cargo.toml` —
`repository` добавлен, `vimp-engine-core` временно на git-зависимости
(`{ git = "https://github.com/lgick/vimp-engine", branch = "engine" }`,
помечено `TODO` — заменить на версию из registry после `cargo publish`,
который ещё не выполнялся). `Cargo.lock` нового репо не генерировался (нет
Rust-тулчейна доступа к сборке в этой сессии — сделать при первой сборке
`vimp-tanks`).

## A3.3. package.json игры ✅ выполнен (с оговоркой)

`games/tanks/package.json` (в новом репо — корневой `package.json`):

- `"private": true` → убрать (пакет публикуется), добавить `publishConfig`
  (по образцу `packages/engine/package.json` из A1);
- добавить `"files"`: `["dist"]` — пакет ставится только ради собранного
  `dist/` (манифест + бандлы + карты + звуки), исходники `src/` в опубликованный
  таргет не нужны (в отличие от `@vimp/engine`, у которого `src/`/`lib`
  публикуются как есть — игра ничего не экспортирует другим пакетам через
  `exports`, кроме собственного `dist/manifest.json`, который читает
  `GameCatalog`);
- `exports` (`./data/*`, `./config/*`, `./host/*`, `./client/*`) — эти
  подпути сегодня используются только **скриптами сборки самой игры**
  (`build-game-manifest.js` импортирует `../games/tanks/src/config/game.js`
  напрямую по относительному пути, не через `exports`) — проверить, не
  остаётся ли внешних потребителей `@vimp/tanks/data/*` и т.п. после переноса;
  если нет — можно упростить/убрать, но не обязательно для A3 (не ломает
  функциональность, можно отложить);
- `dependencies."@vimp/engine": "*"` → зафиксировать реальную версию
  (`^x.y.z`, версия опубликованного в A1 пакета) — сейчас `*` работал только
  потому, что оба пакета в одном npm workspace и `*` резолвился локально;
- `scripts.build:assets` (`node ../../scripts/export-maps.js && node
  ../../scripts/copy-game-sounds.js`) и `scripts.build:manifest`
  (`node ../../scripts/build-game-manifest.js`) — пути `../../scripts/`
  становятся `./scripts/` (скрипты теперь лежат в самом репо игры, см. A3.1);
- добавить `repository`/`bugs`/`homepage` для нового репо (по аналогии с
  корневым `package.json` движка);
- `devDependencies.vite` — оставить как есть, добавить свои `eslint`/`vitest`
  (в монорепо они были общими корневыми `devDependencies`, изолированный
  репозиторий должен иметь их своими).

Сделано: `private` убран, `files: ["dist"]`, `publishConfig` добавлены;
`exports` оставлены как есть (используются только собственными файлами
репо после переноса — упрощение отложено, не обязательно для A3); пути
`scripts.build:assets`/`build:manifest` поправлены на `./scripts/`;
`repository`/`bugs`/`homepage` добавлены; свои `eslint`/`vitest`/
`@vitest/coverage-v8`/`happy-dom` в devDependencies. Оговорка:
`@vimp/engine` временно закреплён на `^0.1.0` (тоже не опубликован в
registry — `npm install` в `vimp-tanks` заработает только после публикации
или `npm link`).

## A3.4. Тесты игры ✅ выполнен

Переносятся в новый репозиторий (это игровые/интеграционные тесты, не
движковые):

- `tests/host/hostPlugin.test.js`, `tests/host/botCommand.test.js`,
  `tests/host/TanksBotManager.test.js`, `tests/client/tanksClientPlugin.test.js`
  (сейчас — vitest-проект `tanks`);
- `tests/host/HostGame.test.js`, `tests/core/**` (сейчас — vitest-проект
  `integration`; `describe.skipIf(!coreAvailable)`, гейтится на собранный
  `core/pkg-node/`) — эти тесты гоняют **движковый** `HostGame`-фасад поверх
  **игрового** WASM-ядра, поэтому их естественное место — репозиторий игры,
  который держит зависимость на `@vimp/engine` и может импортировать
  `HostGame` оттуда;
- в новом репо — свой `vitest.config.js` с проектами `tanks` и `integration`
  (копия соответствующих блоков из корневого `vitest.config.js:47-70`, без
  `engine-node`/`engine-client`/`auth`);
- путь `tests/core/helpers.js:16` (`'../../games/tanks/core/pkg-node/...'`)
  поправить на `'../../core/pkg-node/...'` (игра теперь корень репо).

Сделано: все перечисленные файлы + `tests/host/harness.js` (зависимость
`HostGame.test.js`) скопированы в `vimp-tanks/tests/`; импорты движковых
внутренностей переведены на `@vimp/engine/config/*`, `@vimp/engine/lib/*` и
новый `@vimp/engine/host/*` (добавлен в движке — `TanksBotManager.test.js`
импортировал `ParticipantManager` из `packages/engine/src/host/meta/player/`,
чего старый `exports`-map не открывал; экспорт добавлен как чисто аддитивное
изменение, `npm pack --dry-run` в движке проверен, `docs/en(ru)/extending.md`
обновлены). Свой `vitest.config.js` с проектами `tanks`/`integration`
создан. Не запускалось: `npm test` в `vimp-tanks` (нет собранного
`core/pkg-node/` и не установлен `@vimp/engine` — оба гейта верны и
ожидаемы на этом этапе, см. A3.2/A3.3).

## A3.5. Очистка репозитория движка ✅ выполнен

Только после того, как новый репозиторий игры собирается и проходит тесты
самостоятельно (A3.1–A3.4 зелёные там):

- Корневой `Cargo.toml` (`/Cargo.toml`): `members = ["packages/engine/core",
  "games/tanks/core"]` → `members = ["packages/engine/core"]`;
  `workspace.dependencies` (`indexmap`, `rapier2d`, ...) можно оставить —
  они больше не нужны `vimp-engine-core` per se, но если он сам их использует
  напрямую, не трогать; если использовались только игрой — удалить
  неиспользуемые;
- Корневой `package.json`: `workspaces` — убрать `"games/tanks"`; удалить
  скрипты `audio:process`, `core:build`, `core:build:web`, `core:build:node`,
  `maps:export`, `game:build` (все переехали в репо игры); `build` (сейчас
  `core:build:web && game:build && build:app`) → упростить до `build:app`
  (или оставить alias `"build": "npm run build:app"` для обратной
  совместимости команды);
- `git rm -r games/tanks scripts/build-game-manifest.js
  scripts/copy-game-sounds.js scripts/export-maps.js scripts/process-audio.js`
  (см. A3.1);
- Удалить перенесённые тестовые файлы (A3.4) из `tests/host/`, `tests/core/`,
  `tests/client/` в движке; `vitest.config.js` — убрать проекты `tanks` и
  `integration`, а также `exclude`-записи под них в проекте `engine-node`
  (`tests/host/HostGame.test.js`, `tests/host/hostPlugin.test.js`,
  `tests/host/botCommand.test.js`, `tests/host/TanksBotManager.test.js`) и
  `engine-client` (`tests/client/tanksClientPlugin.test.js`) — они больше не
  существуют в дереве, `exclude` не нужен;
- `eslint.config.js`: правило «движок не импортирует `@vimp/tanks`/`games/**`»
  (`eslint.config.js:114-138`) становится тривиально истинным (`games/**`
  физически отсутствует), но **не мешает** — можно оставить как есть
  (документирует инвариант) либо упростить, убрав паттерн `**/games/**`
  (`@vimp/tanks` паттерн стоит оставить — если пакет случайно попадёт в
  `node_modules` через будущую зависимость, барьер всё равно должен сработать);
  блок «игра импортирует движок только через `@vimp/engine`»
  (`eslint.config.js:140-157`) — переезжает в `eslint.config.js` **нового**
  репозитория (там и остаётся смысл);
  секции `files: ['games/*/...']` (клиентский код, `packages/engine/src/lib` и
  т.п. блок на строке 98, конфиг корневых `*.js` на строке 26) — убрать
  `games/*/*.js` паттерны, если по ним ничего больше не матчится;
- `.github/workflows/test.yml`: убрать jobs `tanks` и `integration`
  целиком (переезжают в CI нового репо, см. A3.6); в job `engine` убрать
  комментарий/шаг, ссылающийся на `auth`, если он был совмещён ради экономии
  раннеров с игрой — сейчас `engine` job уже самодостаточен
  (`cargo test -p vimp-engine-core` + `vitest --project engine-node
  --project engine-client` + `--project auth`), менять его не нужно, кроме
  комментария в шапке файла (строки 9-18), который сейчас описывает все 4
  job — сократить до реального состава (`lint`, `engine`);
- `.gitignore`: убрать строки `games/tanks/build/`, `games/tanks/core/pkg-node/`,
  `games/tanks/core/pkg-web/` (директории физически исчезают, но лучше
  явно убрать мёртвые правила, а не оставлять мусор).

Сделано: всё по списку выше выполнено (`Cargo.toml`, `package.json`,
`git rm -r games/tanks scripts/{build-game-manifest,copy-game-sounds,
export-maps,process-audio}.js`, перенесённые тестовые файлы удалены из
`tests/`, `vitest.config.js` — проекты `tanks`/`integration` и связанные
`exclude` убраны, `eslint.config.js` упрощён (барьер `@vimp/tanks` оставлен,
`games/**`-паттерны убраны), `.github/workflows/test.yml` — jobs `tanks`/
`integration` убраны, шапка сокращена, `.gitignore` почищен).
Дополнительно: `Cargo.lock` движка перегенерирован (`cargo
generate-lockfile`, крейт `vimp-tanks-core` и `wasm-bindgen` из
`workspace.dependencies` ушли); физически осиротевший каталог
`games/tanks/{dist,build,core/pkg-*}` (негенерируемые, но не отслеживаемые
git артефакты старых сборок) удалён с диска — иначе ловился ESLint'ом.
`CLAUDE.md` обновлён (Commands/Architecture/Testing/Deployment больше не
ссылаются на удалённые скрипты и `games/tanks`).

Три теста оказались тоньше, чем описано в A3.4/A3.5 — держали скрытую
зависимость на `@vimp/tanks`, не входившую в явный список переносимых
файлов, и падали после `git rm`: `tests/host/fixtureHarness.js`
ре-экспортировал `FakeSocketManager`/`connectPlayer`/`joinTeam`/`tick`/
`pressKey` из перенесённого `harness.js` — эти хелперы (движковые,
game-agnostic) продублированы прямо в `fixtureHarness.js`, без
WASM-декодирующих `lastShot`/`lastFrame` (fixture-тесты их не используют).
`tests/host/Chat.test.js` импортировал реальный `@vimp/tanks/host/
systemMessages.js` как пример данных для `registerCodes` — заменён на
инлайновую фикстуру той же формы. `tests/lib/validators.test.js` содержал
отдельный `describe` блок, тестирующий не движковый `validateAuth`, а само
игровое `@vimp/tanks/config/auth.js` — блок вырезан отсюда и перенесён в
`vimp-tanks/tests/config/auth.test.js` (добавлен в проект `tanks`
`vitest.config.js` игры).

Проверено после чистки: `cargo test -p vimp-engine-core` (59 passed),
`npx eslint .` (чисто), `npm test` (78 test files / 716 tests passed) — все
зелёные в движке.

Отклонение от предусловия плана: секция явно требует делать A3.5 только
после того, как `vimp-tanks` **сам** собирается и проходит тесты
(A3.2/A3.3 ещё держат временные git-/version-зависимости, не запускались
`npm install`/`cargo build` в новом репо). Сделано по прямому запросу
пользователя, осознанно раньше этого условия.

## A3.6. CI и локальная проверка нового репозитория ✅ выполнен (с оговоркой)

- `vimp-tanks/.github/workflows/test.yml` создан: job'ы `lint`, `tanks`,
  `integration`, перенесены из старого
  `.github/workflows/test.yml` (версия до чистки A3.5, восстановлена из
  `git show <commit-A3.5>`) почти без изменений — пути `games/tanks/core` →
  `core` (крейт теперь в корне репо игры), `cargo test -p vimp-tanks-core`,
  `npm run core:build[:web|:node]`. `npm ci` в CI игры будет ставить
  `@vimp/engine` из registry — упадёт, пока `@vimp/engine`/`vimp-engine-core`
  не опубликованы (см. оговорку A3.2/A3.3); сам workflow не запускался в
  GitHub Actions (нет доступа из этой сессии) — только статически собран по
  образцу старого.
- В `vimp-tanks/package.json` добавлены скрипты `core:build`,
  `core:build:web`, `core:build:node`, `core:test` (были только в корневом
  `package.json` монорепо движка, потерялись при A3.1 переносе — без них
  `npm run core:build` из workflow и из `docs` не существовал).
- Найден и исправлен мёртвый симлинк `node_modules/@vimp/tanks ->
  ../../games/tanks` (не удалённый при A3.5 — `games/tanks` там больше нет)
  и устаревший `packages/engine/package.json` `dev`-скрипт
  (`nodemon ... -w ../../games/tanks/src`, тоже переживший A3.5).
- Локальная связка через `npm link` выполнена и проверена: `npm link` в
  `vimp-tanks` → `npm link @vimp/tanks` в движке; `npm link` в
  `packages/engine` → `npm link @vimp/engine` в `vimp-tanks`. Результат:
  - `cargo test --workspace` в `vimp-tanks` — 50 passed (git-зависимость на
    `vimp-engine-core` собралась и слинковалась);
  - `npm run core:build` (web+node таргеты) прошёл;
  - `npx eslint .` и `npx vitest run` в `vimp-tanks` — 8 файлов / 87 тестов,
    зелено (включая `integration`-проект на реальном WASM);
  - `npx eslint .` и `npm test` в движке (с прилинкованной игрой в
    `node_modules/@vimp/tanks`) — 78 файлов / 716 тестов, зелено;
  - `npm run build` в `vimp-tanks` (client+host+assets+manifest) — собрал
    `dist/manifest.json`;
  - `npm run dev` в движке поднял мастер, лог подтвердил `Games loaded:
    tanks` (т.е. `GameCatalog` резолвит `@vimp/tanks` через `npm link`-симлинк
    так же, как раньше через workspace-симлинк — подтверждает раздел
    «Границы» плана A2), `GET /servers` и `GET /` (лобби) ответили 200.
  - `vimp-tanks/.gitignore` — добавлена строка `target/` (Rust build
    artifacts, отсутствовала после переноса из монорепо, где это
    игнорировалось на корневом уровне); `Cargo.lock` сгенерирован
    (`cargo generate-lockfile` через сборку), не закоммичен — оставлено
    пользователю.
- **Не сделано** (требует браузера/UI, недоступно в этой сессии): пункт 1
  верификации A целиком — «две вкладки играют (движение/выстрел/панель/
  звук)». Проверено программной частью (мастер видит игру, манифест и
  ассеты раздаются, `/servers` отвечает), но живой P2P-матч в двух вкладках
  браузера нужно прогнать вручную.
- Пункт 2 верификации A выполнен полностью (eslint+test зелёные в обоих
  репозиториях, `core:test` — тоже, см. выше).
- Пункты 3 (Docker без Rust-тулчейна) и 4 (проверка версии `engineApi`) —
  вне рамок A3.6, это A4.

## Критические файлы

Корневые `Cargo.toml` / `package.json` (снятие workspace-членов игры),
`eslint.config.js` (барьер), `vitest.config.js` (проекты `tanks`/`integration`),
`.github/workflows/test.yml` (jobs `tanks`/`integration`), `.gitignore`,
`games/tanks/package.json` и `games/tanks/core/Cargo.toml` (переезжают и
переписываются как корневые файлы нового репо).

## Границы A3 (что НЕ входит, остаётся A4/A5)

- Dockerfile движка, `deploy.yml`, проверка версии `engineApi` при
  несовпадении — Этап A4.
- Разделение документации (`docs/en`, `docs/ru`) между двумя репозиториями —
  Этап A5. На время A3 документация может временно остаться в движковом
  репозитории с пометкой, что часть контента переедет.
