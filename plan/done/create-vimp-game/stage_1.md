# Этап 1. `vimp-contract` — валидатор контракта в движке ✅ выполнен

Первый этап независим от скаффолдера и полезен сам по себе: он сразу
применим к `@vimp-games/tanks` и `vimp-street-fighters`.

## Что делаем

Новый исполняемый файл `packages/engine/bin/vimp-contract.js` и модуль
правил `packages/engine/src/devtools/contract/` — статическая проверка
игрового пакета на «тихие» нарушения контракта из `docs/ai/10-pitfalls.md`.

### 1.1. Сбор контекста

`src/devtools/contract/loadContext.js` — по каталогу пакета игры собирает
всё, что доступно, и помечает недостающее:

- `package.json`, `vite.config.js` (как текст), `core/Cargo.toml` (как
  текст), корневой `Cargo.toml`;
- `dist/manifest.json`, содержимое `dist/` (если игра собрана);
- **живые объекты плагинов**: динамический `import()` `src/host/index.js` и
  `src/client/index.js` (не парсинг исходников). Отсюда берутся
  `gameConfig`, `authSchema`, `chatCommands`, `systemMessages`,
  `buildClientGameConfig()`, `parts`, `bakers`, `hooks`;
- карты: `src/data/maps/*` через тот же `import()` либо `dist/maps/*.json`.

Ни одно правило не падает на отсутствии входа — оно возвращает `skip`.
Словарь результатов тот же, что у headless-раннера: `pass` / `fail` /
`skip`, плюс уровень `error` / `warn`.

Переиспользуем существующее, а не пишем заново:
`assertGameConfigShape` и `assertEngineApiCompatible` из
`packages/engine/src/lib/gamePlugin.js`, загрузчик пакета
`packages/engine/src/lib/loadGamePackage.js`, `ENGINE_API_VERSION` из
`packages/engine/src/config/opcodes.js`, формат отчёта —
`packages/engine/src/devtools/report.js`.

### 1.2. Правила

Одно правило — один файл в `src/devtools/contract/rules/`, чистая функция
`(ctx) => Finding[]`. Группы и состав:

**A. Пакет и сборка**
- `A1` `type: "module"`; `files: ["dist"]`; `pixi.js` только в
  `peerDependencies` + `devDependencies`; `vimp-engine` в
  `devDependencies`, **не** в `dependencies`; `publishConfig.access:
  "public"` при scoped-имени.
- `A2` присутствуют скрипты `build`, `build:client`, `build:host`,
  `build:assets`, `build:manifest`, `core:build:web`, `core:build:node`,
  `core:test`, `test`.
- `A3` точки входа лежат ровно по `src/client/index.js` и
  `src/host/index.js` — dev-режим мастера (`GameCatalog._toDevManifest`)
  эти пути хардкодит.
- `A4` `vite.config.js` содержит `emptyOutDir: false`,
  `assetsInlineLimit: 0`, `preserveEntrySignatures: 'strict'`,
  `inlineDynamicImports: true`, `external` с `pixi.js`, `[hash]` в
  `entryFileNames`; не содержит `build.lib`.
- `A5` `core/Cargo.toml`: `crate-type = ["cdylib", "rlib"]`; `rapier2d` с
  фичей `enhanced-determinism`; `vimp-engine-core` не старше минорной
  версии крейта движка (сегодня `0.3.2`) — ровно та ошибка, что живёт в
  street-fighters.
- `A6` (только если собрано) `dist/manifest.json`: `engineApi ===
  ENGINE_API_VERSION`; `id` совпадает с `hostPlugin.id` и
  `clientPlugin.id`; все `entries.*` существуют на диске; `entries.wasmNode`
  указывает внутрь `dist/`; `roomDefaults` покрывает каждое поле `roomForm`.

**B. Host**
- `B1` наличие `id`, `engineApi`, `createCore`, `gameConfig`, `authSchema`,
  `chatCommands` (именно массив), `createModules`, `buildClientGameConfig`.
- `B2` `engineApi` хоста, клиента и манифеста равны `ENGINE_API_VERSION`
  (и импортируются, а не записаны литералом — проверка по исходнику).
- `B3` `assertGameConfigShape` не бросает (9 обязательных путей).
- `B4` `spectatorTeam` — ключ `teams`; играющих команд ≥ 1.
- `B5` `roomForm`: контролы только `text|select|checkbox|radio`; имена полей
  только из белого списка `maps|maxPlayers|map|roundTime|mapTime|friendlyFire`
  (остальные хост молча выбрасывает).
- `B6` `panel.fields` хоста не объявляет ключ `t` (зарезервирован движком).
- `B7` `chatCommands` не перекрывают `/name`, `/nr`, `/timeleft`,
  `/mapname`, `/rank`.
- `B8` `systemMessages`: только группы `s|v|m|c|n`, индексы вне
  зарезервированных диапазонов (`s` 0-6, `v` 0-5, `m` 0-1, `c` 0-1, `n` 0-1).
- `B9` кастомные голосования не называются `mapChange` / `teamChange`.
- `B10` у каждой играющей команды непустой `respawns`; `roomDefaults.maxPlayers`
  не превышает суммарную вместимость респаунов (иначе часть игроков молча
  не войдёт).

**C. Client**
- `C1` наличие `id`, `engineApi`, `createClientCore`, `parts`, `bakers`,
  `styles` и всех трёх хуков `onAuth`, `onPanel`, `onLocalAction`.
- `C2` каждый класс из `parts.gameSets` и `setId` карт объявлен в
  `parts.entitiesOnCanvas` и реально экспортирован в `parts`.
- `C3` каждый ключ схемы снапшота имеет запись в `gameSets`.
- `C4` `componentDependencies` только из `renderer|soundManager|assetsBase`.
- `C5` клиентская панель объявляет поле `type: 'time'` на ключе `t`.
- `C6` `stat.columns.length === 5` (движковая CSS рассчитана на пять
  колонок) — `warn`, если игра поставляет свои стили.
- `C7` `keySetList[0]` содержит `nextPlayer` и `prevPlayer`; ни один сет не
  использует коды `9`, `13`, `27`, `67`, `77`; множество экшенов
  `keySetList[1]` совпадает с ключами `gameConfig.playerKeys`.
- `C8` `bakedAssets` ссылается только на существующие `bakers`.
- `C9` `chat.params.messages` покрывает все коды из `systemMessages`.
- `C10` auth-схема: контейнер объявлен как `elems.fieldsId` (не `formId`);
  среди `params` нет поля ника (ник приходит из JWT); поле выбора модели
  названо ровно `model`.

**D. Снапшот**
- `D1` `id` блоков уникальны.
- `D2` `class: 'hot'` только у `indexed8` / `indexedNoNull8`; `list16` и
  `indexed32` — только `class: 'event'`.
- `D3` `interp` только на полях `ty: 'f32'` внутри `class: 'hot'`.

**E. Ассеты**
- `E1` каждый зарегистрированный звук имеет пару `.webm` + `.mp3` в
  `dist/sounds/`.
- `E2` каждый `spriteSheet.img` и `physicsDynamic[].img` карт существует в
  `dist/img/`.
- `E3` пустой реестр звуков — `warn`, не ошибка.

### 1.3. CLI

`packages/engine/bin/vimp-contract.js`, флаги по образцу `bin/vimp-sim.js`:
`--game <path>` (по умолчанию `.`), `--json`, `--quiet`, `--strict`
(предупреждения считаются ошибками), `--help`. Код выхода `0` — все правила
`pass`/`skip`, `1` — есть `fail` уровня `error`. Регистрируем в
`packages/engine/package.json` → `bin.vimp-contract`; `files` уже содержит
`bin` и `src/devtools`, менять его не нужно.

## Тесты (в том же изменении)

- `tests/devtools/contract/rules.test.js` — по negative-фикстуре на каждое
  правило. Фикстуры собираются во временной папке через `mkdtemp`, как это
  уже делают `tests/scripts/release/games.test.js` и `steps.test.js`.
- `tests/devtools/contract/miniGame.test.js` — прогон на
  `packages/engine/tests/fixtures/miniGame/`: правила групп B/C/D дают
  `pass`, упаковочные A/E — `skip` (у фикстуры нет `package.json` и `dist/`).
  Если фикстура нарушает какое-то правило, чинится фикстура, а не правило.
- Каталог `tests/devtools/**` уже входит в vitest-проект `engine-node` —
  правки `vitest.config.js` не требуются.

Ручная проверка на живых играх (в отчёте об этапе, не в CI):
`node packages/engine/bin/vimp-contract.js --game ../vimp-tanks` — ожидается
зелёный прогон; `--game ../vimp-street-fighters` — ожидается поимка всех
четырёх известных отклонений (A1 `vimp-engine` в `dependencies`, A5 пин
`0.1.0`, C10 `'character'` вместо `'model'`, плюс отсутствие `dist/`).

## Документация и релизное влияние

- `docs/en/debugging.md` + `docs/ru/debugging.md`: раздел «Contract check»
  рядом с headless-раннером (правило зеркальности — оба файла в одном
  изменении).
- `docs/ai/13-debugging.md`: `vimp-contract` как обязательный шаг перед
  `npm run sim`; `docs/ai/10-pitfalls.md`: пометка, какие пункты чек-листа
  теперь проверяются машиной.
- Корневой `CLAUDE.md`: одна строка в блок `Commands`.
- `packages/engine/CHANGELOG.md` → `## [Unreleased]` → `### Added`
  (новый bin + правила). Это **minor** npm-пакета `vimp-engine`
  (`0.9.0` → `0.10.0`). Крейт `vimp-engine-core` не трогаем,
  `ENGINE_API_VERSION` не меняется — играм следовать за релизом не
  обязательно.

## Готовность этапа

- [x] `npx eslint .` и `npm test` зелёные (129 файлов, 1293 теста).
- [x] `vimp-contract --game packages/engine/tests/fixtures/miniGame` — без
      `fail` (22 pass, 10 skip). Фикстура починена по трём правилам: `B10`
      (респауны под `maxPlayers`), `C3` (`gameSets` для ключа `e1`), `C7`
      (клавиши наблюдателя в `keySetList[0]`).
- [x] На tanks зелено (32 pass), на street-fighters пойманы `A1`
      (`vimp-engine` в `dependencies`), `A5` (пин `0.1.0` при `0.3.2`) и
      `E2` (карта ссылается на отсутствующие `dist/img/*`). Четвёртое
      известное отклонение (`'character'` вместо `'model'`, правило `C10`)
      в том репозитории уже исправлено — правило проверено тестом.
- [x] Обе страницы `debugging.md` обновлены, `docs/ai/13-debugging.md` и
      `docs/ai/10-pitfalls.md` (маркеры ⚙) тоже, CHANGELOG заполнен.
