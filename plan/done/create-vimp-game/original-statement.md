# Детальный план реализации: VIMP Game Plugin SDK & CLI Scaffolder (`create-vimp-game`)

Ниже представлен подробный инженерный план для реализации этой задачи.

---

## 1. Архитектурный каркас нового пакета

Пакет создаётся как новый воркспейс в монорепозитории: `packages/create-vimp-game`.

```text
packages/create-vimp-game/
├── bin/
│   └── create-vimp-game.js       # Исполняемый файл (Node shebang, запуск CLI)
├── src/
│   ├── cli.js                    # Парсинг аргументов, интерактивный режим (prompts)
│   ├── generator.js              # Движок шаблонизации (копирование, подстановка токенов)
│   ├── spec-loader.js            # Загрузка и валидация внешнего JSON-спецификатора (GDD)
│   └── utils.js                  # Валидация kebab-case, git init, форматирование логов
├── templates/
│   └── default/                  # Полный эталонный шаблон новой игры
│       ├── _gitignore            # Переименовывается в .gitignore
│       ├── CLAUDE.md.tpl          # Инструкция для AI-агентов внутри игры
│       ├── Cargo.toml.tpl        # Корневой workspace Rust
│       ├── package.json.tpl      # package.json игры
│       ├── vite.config.js        # Двойная сборка client/host
│       ├── vitest.config.js      # Конфигурация тестов
│       ├── core/                 # Rust-ядро с макросами vimp-engine-core
│       ├── src/                  # host, client, config, data
│       ├── dev/                  # Standalone SDK среда для npm run dev
│       └── scripts/              # Сборщики и валидатор check-contract.js
└── package.json                  # Конфигурация npm-пакета create-vimp-game
```

---

## 2. Поэтапный план реализации

### ЭТАП 1. Инициализация пакета `packages/create-vimp-game`

1. Создать манифест `packages/create-vimp-game/package.json`:
   - Имя: `create-vimp-game`.
   - Бинарник: `"bin": { "create-vimp-game": "./bin/create-vimp-game.js" }`.
   - `type: "module"`, `files: ["bin", "src", "templates"]`.
   - Зависимости: легковесный интерактивный ввод (`prompts` или нативный `node:readline`), утилиты форматирования консоли (`picocolors`).
2. Зарегистрировать пакет в корневом `package.json` движка в секции `workspaces`.

---

### ЭТАП 2. Создание эталонного шаблона (`templates/default`)

Шаблон должен содержать минимально необходимый, компилируемый код без внешних зависимостей кроме `vimp-engine` и `pixi.js`.

#### 2.1. Конфигурация сборщика и тестов

- **`package.json.tpl`**:
  - Содержит переменные `{{PACKAGE_NAME}}`, `{{GAME_ID}}`, `{{GAME_TITLE}}`.
  - Скрипты:
    - `"build"`: полный цикл сборки (`build:client`, `build:host`, `build:assets`, `build:manifest`).
    - `"check:contract"`: запуск статического валидатора контрактов (`node ./scripts/check-contract.js`).
    - `"core:build"`: `wasm-pack` для web (`pkg-web`) и nodejs (`pkg-node`).
    - `"dev"`: запуск локального Vite-сервера для Standalone SDK (`dev/index.html`).
    - `"sim"`: запуск headless-симулятора движка (`vimp-sim --game .`).
    - `"test"`: запуск `vitest run`.
- **`vite.config.js`**:
  - Настроен на две раздельные сборки по `--mode client` и `--mode host`.
  - Обязательные флаги: `assetsInlineLimit: 0`, `preserveEntrySignatures: 'strict'`, `emptyOutDir: false`, экстернализация `pixi.js`.
- **`Cargo.toml.tpl`**:
  - Корневой Workspace с участником `core`.

#### 2.2. Полноценное Rust-ядро (`core/`)

- **`core/Cargo.toml.tpl`**:
  - Имя крейта: `{{CRATE_NAME}}` (например, `vimp_space_arena_core`).
  - `crate-type = ["cdylib", "rlib"]`.
  - Зависимости: `vimp-engine-core = "0.2"`, `rapier2d` (с `enhanced-determinism`), `wasm-bindgen`, `serde`, `serde_json`.
- **`core/src/lib.rs`**:
  - Объявление структур `GameCore` и `ClientCore`.
  - Вызов макросов `export_game_core_abi!(GameCore)` и `export_client_core_abi!(ClientCore)`.
- **`core/src/motion.rs`**:
  - Единая чистая функция движения, разделяемая авторитетной симуляцией и предикцией.
- **`core/src/sim.rs`**:
  - Реализация `GameSim`: спавн акторов, детерминированный шаг физики, упаковка снапшот-блоков (игроки в `indexed8`, события в `list16`).
- **`core/src/client/predictor.rs`**:
  - Реализация `GameClientDef`: предикция на 8 float-компонентов (`PLAYER_STATE_LEN`), сглаживание ошибок, parity-тест.

#### 2.3. Конфигурационные файлы (`src/config/`)

- **`snapshot.js`**:
  - Актор `a1` (`kind: 'indexed8'`, `class: 'hot'`, поля: `x`, `y`, `angle`, `team`).
  - Событие `e1` (`kind: 'list16'`, `class: 'event'`, поля: `startX`, `startY`, `endX`, `endY`, `author`).
- **`game.js`**:
  - `HostPlugin.gameConfig`: `teams`, `spectatorTeam`, `parts.models`, `parts.weapons`, `panel`, `stat`, `playerKeys`, `scripted`, `roomDefaults`, `roomForm` (контролы `text`, `select`, `checkbox`, `radio`).
- **`client.js`**:
  - Регистрация `gameSets: { m1: ['Actor'], c1: ['Map'] }`, `entitiesOnCanvas: { Actor: 'vimp', Map: 'vimp' }`, схемы HUD, чата, голосований.
- **`auth.js`**:
  - Корректный `elems.fieldsId: 'auth-fields'` (**без поля nickname**, ник поступает из JWT).
- **`sounds.js`**:
  - Реестр звуков с `codecList: ['webm', 'mp3']`.

#### 2.4. Слой Host и Client

- **`src/host/`**:
  - `index.js`: `default export HostPlugin` с ветвлением загрузки `wasmUrl` (веб-ассет или node-модуль).
  - `createModules.js` и `ScriptedManager.js`: реализация 5 методов бота (`createMap`, `createScripted`, `removeScripted`, `removeOneForHuman`, `getCountsPerTeam`).
  - `spawnCommand.js`: чат-команда `/spawn`.
- **`src/client/`**:
  - `index.js`: `default export ClientPlugin` (`createClientCore` возвращает `{ core, memory }`, хуки `onAuth`, `onPanel`, `onLocalAction`).
  - `parts/Actor.js` и `parts/Map.js`: базовые контейнеры PixiJS с `zIndex`, `update(data)` и `destroy()`.
  - `style.css`: стили HUD и команд.

#### 2.5. Среда Standalone SDK (`dev/`)

- **`dev/index.html`** и **`dev/main.js`**:
  - Полноэкранный запуск игры через `vimp-engine/standalone` с автоматическим переходом из зрителей (`startupVotes: [['teamChange', 'team1']]`) и спавном ботов (`startupCommands: ['/spawn 1']`).

#### 2.6. Скрипты сборки (`scripts/`)

- **`scripts/build-game-manifest.js`**:
  - Хеширует бандлы, собирает `dist/manifest.json`, генерирует regex для[118;1:3u `roomForm`, копирует `core/pkg-node/` в `dist/core-node/` (с удалением `.gitignore` от `wasm-pack`).
- **`scripts/export-maps.js`** & **`scripts/copy-game-sounds.js`**:
  - Экспорт JSON-карт и копирование звуков.

---

### ЭТАП 3. Разработка Contract Linter (`scripts/check-contract.js`)

Инструмент автоматической проверки всех известных «тихих» ошибок (из `10-pitfalls.md`) перед коммитом и сборкой:

1. `manifest.engineApi === 3`.
2. Контейнер инпутов в `auth.js` назван `fieldsId` (а не `formId`), и в `params` нет поля `name`/`nick`.
3. `spectatorTeam` объявлен и присутствует в ключах `teams`.
4. Все классы из `parts.gameSets` объявлены в `parts.entitiesOnCanvas`.
5. Все snapshot-ключи зарегистрированы в `gameSets`.
6. В хосте нет поля панели `t` (зарезервировано движком), а на клиенте поле `t` имеет `type: 'time'`.
7. `roomForm` использует только контролы `text`, `select`, `checkbox`, `radio` и поля из белого списка хоста.
8. Все звуки из `sounds.js` имеют физические файлы `.webm` и `.mp3` в `dist/sounds/`.

---

### ЭТАП 4. Генерация инструкций для нейросети (`CLAUDE.md`)

В корень созданной игры скаффолдер генерирует компактный файл **`CLAUDE.md`**:

```markdown
# AI Developer Guide for {{GAME_TITLE}}

This project is a game plugin for **VIMP Engine (API v3)**.

## Core Rules:

1. Physics, damage, and movement math MUST be written in Rust (`core/src/sim.rs` and `core/src/motion.rs`).
2. Thread boundaries: `src/host/` runs in Web Worker (NO DOM/PixiJS), `src/client/` runs in Main thread.
3. Prediction budget: `PLAYER_STATE_LEN` is exactly 8 floats.
4. Hot buffer supports only `indexed8` and `indexedNoNull8`. Events use `list16`/`indexed32`.

## Verification Commands:

- `npm run check:contract` — validates engine contracts and schema.
- `npm run core:test` — runs Rust unit tests and motion parity tests.
- `npm run sim` — runs headless simulation (must exit with code 0).
- `npm run dev` — runs standalone browser match against bots.

## Implementation Order:

1. Schema & Configs (`src/config/snapshot.js`, `core/src/config.rs`).
2. Rust Simulation (`core/src/sim.rs`, `core/src/motion.rs`).
3. Contract & Sim Check (`npm run check:contract && npm run sim`).
4. Rendering Parts (`src/client/parts/`).
```

---

### ЭТАП 5. Реализация логики CLI (`packages/create-vimp-game/src/`)

1. **`src/cli.js`**:
   - Обработка флагов CLI: `--yes`, `--spec=<file>`, `--template=<name>`, `--id=<id>`, `--title=<title>`.
   - Запуск интерактивного диалога, если параметры не переданы.
2. **`src/spec-loader.js`**:
   - Если передан `--spec=game-spec.json`, парсит готовую спецификацию игры и автоматически наполняет `models.js`, `weapons.js`, `snapshot.js` и `arena.js`.
3. **`src/generator.js`**:
   - Рекурсивное копирование `templates/default` в целевую папку.
   - Замена строковых плейсхолдеров (`{{GAME_ID}}`, `{{PACKAGE_NAME}}`, `{{GAME_TITLE}}`, `{{CRATE_NAME}}`).
   - Переименование файлов (`_gitignore` -> `.gitignore`, `CLAUDE.md.tpl` -> `CLAUDE.md`).

---

### ЭТАП 6. E2E Тестирование скаффолдера

Создать интеграционный тест `tests/devtools/createVimpGame.test.js` в движке:

1. Запуск CLI во временной папке: `node packages/create-vimp-game/bin/create-vimp-game.js temp-game --yes --id=temp-game`.
2. Проверка создания файлового дерева.
3. Проверка запуска `npm run check:contract` внутри сгенерированной папки.
4. Проверка запуска `npm test` и `npm run build`.

---

### ЭТАП 7. Документация и минимальный апдейт `CLAUDE.md`

1. **В проектный `CLAUDE.md` движка** добавляется ровно одна компактная строка в секцию `Commands`:
   ```bash
   npm run create:game <name>   # scaffold a new game plugin (create-vimp-game)
   ```
2. **В `docs/en/` и `docs/ru/`** создаётся страница `scaffolding.md` (или обновляется `standalone.md` / `plugin-api.md`) с описанием команды `npm create vimp-game`.

---

## 3. Критерии готовности (Definition of Done)

- [ ] Пакет `packages/create-vimp-game` создан и собирается.
- [ ] Шаблон `templates/default` содержит полный набор файлов (Rust, JS Host/Client, Configs, Dev Standalone).
- [ ] Команда `npm create vimp-game test-game --yes` разворачивает проект, в котором команды `npm run core:build`, `npm run check:contract`, `npm run sim`, `npm run build` и `npm test` завершаются с кодом `0`.
- [ ] `npm run dev` в сгенерированной игре запускает рабочий матч в браузере.
- [ ] В сгенерированной игре присутствует файл `CLAUDE.md` с точными директивами для AI.
- [ ] Проектный `CLAUDE.md` движка остался компактным (<600 токенов).
