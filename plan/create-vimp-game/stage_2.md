# Этап 2. Пакет `packages/create-vimp-game`: CLI и генератор

Каркас без содержимого шаблона: после этапа команда работает, но
разворачивает пока пустой/черновой `templates/default`. Этап независим от
этапа 1.

## 2.1. Манифест пакета

`packages/create-vimp-game/package.json`:

- `name: "create-vimp-game"` (проверено — имя в npm свободно), `version:
  "0.1.0"`, `type: "module"`, `license: "MIT"`, `engines.node: ">=20.11.0"`
  (как у движка);
- `bin: { "create-vimp-game": "./bin/create-vimp-game.js" }`;
- `files: ["bin", "src", "templates"]` — сюда попадает и
  `src/versions.generated.json`;
- `scripts.prepack: "node ./scripts/write-versions.js"` — пины версий
  записываются в момент публикации автоматически, шаг нельзя забыть;
- `publishConfig.access: "public"`;
- **нулевые рантайм-зависимости**: интерактив на `node:readline/promises`,
  цвета — собственный 20-строчный ANSI-хелпер. Пакет ставится через `npm
  create`, каждая зависимость здесь — секунда ожидания пользователя.

Регистрация в монорепозитории:

- корневой `package.json` → `workspaces` += `"packages/create-vimp-game"`;
- корневой `package.json` → `scripts.create:game` =
  `"node packages/create-vimp-game/bin/create-vimp-game.js"`;
- `eslint.config.js`: новый блок `files: ['packages/create-vimp-game/bin/**/*.js',
  'packages/create-vimp-game/src/**/*.js']` с `globals.node` + `globals.es2023`
  (существующие блоки не покрывают вложенные пути глубже одного сегмента —
  без этого `console`/`process` падают на `no-undef`); и
  `'packages/create-vimp-game/templates/**'` в финальный `ignores` — файлы
  шаблона содержат токены `{{…}}` и намеренно отклоняются от конвенций
  репозитория;
- `vitest.config.js`: в проект `engine-node` добавляется
  `'tests/scaffold/**/*.test.js'` (CI уже гоняет этот проект, менять
  workflow не нужно).

## 2.2. Структура

```text
packages/create-vimp-game/
├── bin/create-vimp-game.js     # shebang + разбор argv → src/cli.js
├── scripts/write-versions.js   # prepack: пишет src/versions.generated.json
├── src/
│   ├── cli.js                  # флаги, интерактив, оркестрация
│   ├── prompts.js              # node:readline/promises, --yes пропускает всё
│   ├── tokens.js               # вычисление подстановок из ответов
│   ├── versions.js             # пины vimp-engine / vimp-engine-core
│   ├── generator.js            # обход шаблона, подстановка, переименования
│   ├── preflight.js            # проверка cargo/wasm-pack/node, git init
│   └── ui.js                   # цвета, «next steps»
├── templates/default/          # этапы 3–5
├── CHANGELOG.md                # Keep a Changelog, как у движка
└── package.json
```

## 2.3. CLI

Текст интерфейса — английский, как у `bin/vimp-sim.js`; комментарии в коде
русские, по конвенции репозитория.

```
Usage: create-vimp-game <directory> [options]

  --id <id>          game id, kebab-case (default: directory name)
  --title <title>    human-readable title
  --package <name>   npm package name (default: @vimp-games/<id>)
  --author <name>
  --yes, -y          accept all defaults, no prompts
  --force            allow a non-empty target directory
  --no-git           skip `git init`
  --engine-path <p>  dev only: link a local engine checkout
  --core-path <p>    dev only: [patch.crates-io] for vimp-engine-core
  --help, --version
```

Валидация: `id` по `^[a-z][a-z0-9-]*$`; имя пакета — валидное имя npm;
целевой каталог должен отсутствовать или быть пустым (иначе `--force`).

`git init` выполняется, но коммит **не** создаётся — первый коммит остаётся
за автором игры.

## 2.4. Токены

| Токен | Пример | Где используется |
| --- | --- | --- |
| `{{GAME_ID}}` | `space-arena` | `manifest.id`, `HostPlugin.id`, URL `/games/<id>/` |
| `{{GAME_TITLE}}` | `Space Arena` | `manifest.title`, README, `CLAUDE.md` |
| `{{PACKAGE_NAME}}` | `@vimp-games/space-arena` | `package.json` |
| `{{CRATE_NAME}}` | `space-arena-core` | `core/Cargo.toml` |
| `{{CRATE_SNAKE}}` | `space_arena_core` | `pkg-web/<crate>_bg.wasm`, импорты ядра, `dist/core-node/<crate>.js` |
| `{{ENGINE_VERSION}}` | `^0.10.0` | `devDependencies.vimp-engine` |
| `{{CORE_VERSION}}` | `0.3.2` | `core/Cargo.toml` |
| `{{AUTHOR}}`, `{{YEAR}}` | | `LICENSE`, `package.json` |

`src/versions.js` — ключевое решение против дрейфа пинов (болезнь
street-fighters, приехавшего на `vimp-engine-core = "0.1.0"`):

1. при запуске из монорепозитория версии читаются напрямую из
   `packages/engine/package.json` и `packages/engine/core/Cargo.toml`;
2. при установке из npm — из `src/versions.generated.json`, который пишет
   `scripts/write-versions.js`, подключённый хуком `prepack` (файл
   перечислен в `files` и не попадает под `.gitignore`);
3. тест `tests/scaffold/versions.test.js` сверяет сгенерированный файл с
   фактическими версиями репозитория и падает при расхождении.

## 2.5. Генератор

`src/generator.js` — рекурсивный обход `templates/default`:

- подстановка токенов только в текстовых файлах (allowlist расширений:
  `.js .json .rs .toml .md .html .css .txt .gitignore`); бинарные файлы
  (`.webm`, `.mp3`) копируются байт-в-байт;
- переименования: `_gitignore` → `.gitignore`, `*.tpl` → снятие суффикса
  (суффикс нужен, чтобы `package.json.tpl` и `Cargo.toml.tpl` не ломали
  инструменты внутри репозитория движка);
- неизвестный токен `{{…}}`, оставшийся после подстановки, — ошибка
  генерации, а не тихий мусор в файлах игры;
- режим `--engine-path`: `devDependencies.vimp-engine` переписывается в
  `file:<abs>`; `--core-path`: в корневой `Cargo.toml` дописывается
  `[patch.crates-io] vimp-engine-core = { path = "<abs>" }`. Оба флага нужны
  этапу 6 (E2E против несобранного релиза).

`src/preflight.js` проверяет наличие `cargo` и `wasm-pack` и, если их нет,
печатает подсказку по установке — но **не блокирует** генерацию: файлы
создаются, ошибка всплывёт на `npm run core:build`.

## Тесты (в том же изменении)

`tests/scaffold/` (проект `engine-node`), по образцу
`tests/scripts/release/*.test.js` (`mkdtemp` + уборка в `afterEach`):

- `generator.test.js` — подстановка токенов, переименования, отказ на
  непустом каталоге без `--force`, ошибка на незаменённом токене,
  побайтовая сохранность бинарных файлов;
- `tokens.test.js` — вывод `CRATE_SNAKE`/`CRATE_NAME` из `id`, валидация
  kebab-case и имени npm-пакета;
- `versions.test.js` — см. 2.4;
- `cli.test.js` — запуск `bin/create-vimp-game.js` как дочернего процесса в
  tmpdir с `--yes`, проверка кода выхода и дерева файлов. Прецедента
  «spawn собственного bin» в репозитории пока нет; берём обёртку
  `scripts/release/shell.js` как образец работы с `child_process`.

Тесты этапа не запускают `npm install`, `cargo` и `wasm-pack` — это объём
этапа 6.

## Готовность этапа

- [ ] `npm create vimp-game` (через `npm run create:game`) разворачивает
      дерево шаблона в пустой каталог и печатает next steps.
- [ ] `npx eslint .` зелёный (новый блок `files` и `ignores` на месте).
- [ ] `npm test` зелёный, новый проект тестов подхватывается.
- [ ] Пины `vimp-engine`/`vimp-engine-core` в сгенерированном проекте
      совпадают с фактическими версиями репозитория.
