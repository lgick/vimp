# create-vimp-game в `npm run release` ✅ выполнен

## Контекст

`packages/create-vimp-game` — публичный npm-пакет (`create-vimp-game`,
`publishConfig.access: public`), уже опубликованный 0.1.0 вручную. При этом:

- `scripts/release.js` и `scripts/release/` о нём не знают ни строкой
  (`grep create-vimp-game scripts/` → 0 попаданий): версия не бампится,
  `[Unreleased]` не проверяется, публикация не выполняется;
- `docs/{en,ru}/publishing.md` до сих пор пишет «Four artifacts» и не
  упоминает скаффолдер;
- CHANGELOG скаффолдера содержит весь контент 0.1.0 в `[Unreleased]` —
  выпущенное не датировано.

Это недоработка: требование — все публикуемые пакеты проходят через
`npm run release`, и наличие изменений + будущая версия должны быть видны
в его плане. (`packages/auth` — `private: true`, деплой-артефакт, в релиз не
входит и остаётся как есть.)

Отдельный риск, ради которого скаффолдер и обязан ехать вместе с движком:
хук `prepack` (`scripts/write-versions.js`) вшивает в тарбол снимок
`{engine, core}` из `packages/engine/`. Опубликованный скаффолдер, отставший
от движка, молча генерирует игру на устаревших пинах — ровно та поломка,
из-за которой пины и перестали хардкодить (`src/versions.js:5-8`).

## Решение

Скаффолдер становится **четвёртым артефактом** решателя (крейт → движок →
скаффолдер → игры → прод) и переиспользует уже существующую generic-логику
`decideArtifact()` — новых механизмов не заводим.

### 1. `scripts/release/plan.js`

- `export const SCAFFOLD_NAME = 'create-vimp-game';`
- `decideArtifact(artifact, name, extra)` — третий необязательный аргумент
  `{ required, reason }`. Влияние: `required` заставляет `publish: true`
  даже при пустом `[Unreleased]` и отсутствии изменений; при этом уровень
  остаётся тем, что даёт `suggestLevel` (пустая секция → `patch`, перепин
  движка новой фичей не является). Крейт и движок вызывают функцию как
  раньше — поведение не меняется, тесты `plan.test.js` остаются зелёными.
- В `decide()`:
  `const scaffold = decideArtifact(input.scaffold, SCAFFOLD_NAME, {...})`,
  где `required = crate.publish || engine.publish || input.scaffold.pinsStale`;
  причины формулируются словами («крейт публикуется → пины шаблона
  устарели», «шаблон запинен на vimp-engine X, локально Y»).
- `scaffold` добавляется в массив `releasable` (это он кормит
  `problems`/`warnings` по `[Unreleased]`).
- `prod` не трогаем: скаффолдер в прод не деплоится.
- В `collect()` — четвёртый блок по образцу движка:
  - версия из `packages/create-vimp-game/package.json`, опубликованная
    через `npmVersion(SCAFFOLD_NAME)`;
  - база — `findBase` с тегом `create-vimp-game@X.Y.Z` и needle
    `"version": "X.Y.Z"` по его `package.json`;
  - скоуп изменений — из его же поля `files` (`bin`, `src`, `templates`),
    как у движка, **плюс** `packages/create-vimp-game/scripts` (там живёт
    `write-versions.js`, чей вывод уезжает в тарбол);
  - `unreleased` — `parseUnreleased` его `CHANGELOG.md`;
  - `pinsStale` — новая функция `pinsChangedSince(root, ref)` по образцу
    `engineApiDiffers`: `git show <base>:packages/engine/package.json` и
    `:packages/engine/core/Cargo.toml`, сравнение с локальными версиями.
    Так ловится случай прерванного прогона, когда движок уже опубликован,
    а скаффолдер за ним не поехал.

### 2. `scripts/release/steps.js`

Новый `export async function publishScaffold({ shell, root, decision, report })`,
шаг **A3**, по образцу `publishEngine`:

1. `npx eslint .`
2. `npm test -- --reporter=dot`
3. `npm run test:scaffold` — E2E: разворачивает игру, гоняет cargo +
   wasm-pack + `check:contract` + build + test + sim. Обязателен, флага
   пропуска нет (как у остальных проверок релиза).
4. `bumpJsonVersion(packages/create-vimp-game/package.json)` + `npm install`
5. `dateChangelog(packages/create-vimp-game/CHANGELOG.md)`
6. коммит `chore: bump create-vimp-game to X.Y.Z`
   (`package.json`, `CHANGELOG.md`, `package-lock.json`)
7. `npm publish -w create-vimp-game --dry-run` → `npm publish -w create-vimp-game`
8. тег `create-vimp-game@X.Y.Z`, ожидание npm, `report.published`

`src/versions.generated.json` под `.gitignore` — `prepack` дерево не пачкает.

### 3. `scripts/release.js`

- `STEPS = ['crate', 'engine', 'scaffold', 'games', 'prod']` + `USAGE`;
- `scoped.scaffold` под `args.only.includes('scaffold')`;
- `askVersion(SCAFFOLD_NAME, …)` при `publish && bump`;
- строка в `ui.table` (с пометкой «да (обязательно)» при `required`);
- guard «публиковать нечего» учитывает `decision.scaffold.publish`;
- `ensureNpmLogin()` вызывается и ради скаффолдера;
- `needsRust` в `preflightGames` включается и при публикации скаффолдера
  (E2E требует rustup/wasm-pack);
- вызов `publishScaffold` в try-блоке — после движка, до игр.

### 4. CHANGELOG скаффолдера

Задатировать уже отгруженное: содержимое `[Unreleased]` → `## [0.1.0] — 2026-08-18`,
добавить link-ref в конце (форма — как в `packages/engine/CHANGELOG.md:568`),
`[Unreleased]` оставить пустым.

### 5. Тесты

- `tests/scripts/release/plan.test.js` — `decide()` со скаффолдером:
  своя версия впереди опубликованной; пустой `[Unreleased]` + публикация
  движка → `publish: true, required: true, level: 'patch'`; `pinsStale` →
  то же без публикации движка; ничего не изменилось → `publish: false`.
- `tests/scripts/release/steps.test.js` — `publishScaffold` на фейковом
  shell: порядок команд, наличие E2E, пути коммита, имя тега.

### 6. Документация

`docs/en/publishing.md` + зеркало `docs/ru/publishing.md`:

- «Four artifacts» → пять, новый буллет `create-vimp-game`;
- диаграмма порядка: крейт → движок → **скаффолдер** → игра → прод, с
  пояснением про `prepack`-снимок пинов;
- строка в таблице «What actually needs publishing» (изменения в
  `packages/create-vimp-game/{bin,src,templates}` и обязательная
  пересборка при бампе движка/крейта);
- строка в таблице «Versions»;
- новый раздел `## Step A3: publish create-vimp-game` между A2 и B;
- `--only=…` в списке флагов получает `scaffold`.

`docs/{en,ru}/scaffolding.md` — короткая ссылка на publishing.md в части
«как выпускается сам скаффолдер».

## Проверка

```bash
npx eslint . && npm test -- --reporter=dot     # включая новые тесты решателя
npm run release -- --dry-run --only=scaffold   # план: строка create-vimp-game,
                                               # предложенная версия и причина
npm run release -- --dry-run                   # общая таблица из 5 строк
```

`--dry-run` выполняет все `check`-команды (включая E2E) и не делает ни
одной изменяющей — публикации и коммитов не будет.
