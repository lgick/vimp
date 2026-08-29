# Этап 1 — Слепок поверхности и корпус совместимости ✅ выполнен

**Зачем первым.** Все остальные этапы — правки в коде движка. Этот этап
строит сеть, которая ловит нарушение И1/И3 в момент правки, в репозитории
движка, а не через полгода в чужом репозитории. Без него весь план держится
на дисциплине, а на ста играх дисциплина не работает.

**Результат этапа:** `npm test` в `vimp-engine` падает, если правка удаляет
или переименовывает что-либо из плагинной поверхности, меняет сигнатуру
ABI-метода или ломает матч на замороженной старой игре.

## 1.1 Извлечение поверхности

Новый модуль `packages/engine/src/devtools/surface/collect.js` —
экспортирует `collectSurface()`, возвращающую простой JSON-объект. Живёт в
`devtools/`, потому что в бандл приложения не попадает (граница из
`CLAUDE.md`).

Источники, из которых собирается поверхность (все — существующие модули, ни
один не дублируется руками):

| Раздел слепка | Источник |
| --- | --- |
| `requiredGameConfig` | `REQUIRED_GAME_CONFIG_PATHS` + `SPECTATOR_CONFIG_PATH` из `src/lib/gamePlugin.js:44-58` |
| `clientServices` | `SERVICES` из `src/devtools/contract/rules/c4-component-dependencies.js:10` |
| `formControls` | реестр контролов (этап 3; до него — литералы из `src/client/lib/formBuilder.js`) |
| `ports.server` / `ports.client` | `src/config/wsports.js` |
| `manifestFields` | список полей `GameManifest`, которые читает движок (собирается из `GameCatalog.js`, `loadGamePackage.js`, `gamePlugin.js`) |
| `hostPluginMembers` / `clientPluginMembers` | имена, которые движок читает с объектов плагина (`id`, `engineApi`, `gameConfig`, `createCore`, `authSchema`, `buildClientGameConfig`, `hooks`, …) |
| `abi.game` / `abi.client` | имена и сигнатуры методов из `packages/engine/core/src/abi.rs` (см. 1.2) |
| `abiOps` | реестр опкодов `dispatch` (появляется на этапе 4, до него — пустой массив) |

Формат записи ABI-метода — имя плюс нормализованная сигнатура, чтобы ловить
нарушение И3:

```json
{ "name": "pack_frame", "args": ["f64","u32","bool","f32","f32","bool","Option<String>","i32"], "ret": "usize" }
```

## 1.2 Разбор `abi.rs`

`collectSurface()` не может исполнить Rust, поэтому читает
`packages/engine/core/src/abi.rs` как текст и вытаскивает `pub fn` внутри
двух `macro_rules!`-блоков регулярным разбором.

Требование к разбору: он обязан **падать**, а не молча возвращать пустоту,
если структура файла изменилась (не нашлось ни одного `macro_rules!`, или в
блоке ноль `pub fn`). Молчаливо пустой раздел слепка — это дыра, через
которую пройдёт любое нарушение.

Нормализация типов: убрать `&`, `mut`, пробелы, префикс `::wasm_bindgen::`,
развернуть `Result<T, JsError>` в `Result<T>`. Цель — стабильная строка,
которая меняется тогда и только тогда, когда меняется бинарный контракт.

## 1.3 Закоммиченный слепок

`packages/engine/contract/surface.json` — результат `collectSurface()`,
записанный в репозиторий, отсортированный по ключам, с отступом 2 (стабильный
diff).

Новый npm-скрипт в корневом `package.json`:

```
"surface:update": "node packages/engine/bin/vimp-surface.js --write"
```

и CLI `packages/engine/bin/vimp-surface.js`: без флага печатает разницу и
возвращает ненулевой код при нарушении, с `--write` перезаписывает слепок.
В `bin` поля `packages/engine/package.json` не добавляется — это внутренний
инструмент репозитория движка, не часть публикуемого пакета.

## 1.4 Тест-страж

`tests/devtools/surface.test.js`:

1. `collectSurface()` сравнивается с `contract/surface.json`.
2. **Добавление проходит.** Новый порт, новое имя сервиса, новый ABI-метод —
   тест зелёный, но печатает подсказку «слепок устарел, запусти
   `npm run surface:update`». Чтобы это не превращалось в вечный шум, тест
   после успешной проверки супермножества сравнивает и полное равенство:
   при расхождении — не падение, а `console.info` со списком добавленного.
3. **Удаление, переименование, смена сигнатуры — падение** с текстом,
   называющим И1/И3 и конкретное имя:

   ```
   surface: 'range' исчез из formControls.
   Инвариант И1 (plan/plugin-forward-compat/README.md): имя, которое игра
   могла написать, существует вечно. Выведи его из эксплуатации алиасом,
   а не удалением. Если это осознанный security-фикс — удали строку из
   contract/surface.json тем же коммитом и опиши в CHANGELOG под
   ⚠️ Breaking + Migration.
   ```

Обновление слепка требует осознанного удаления строки из закоммиченного
файла — это видно в ревью и не происходит случайно.

## 1.5 Корпус совместимости

Слепок ловит статические нарушения. Корпус ловит семантические: движок может
сохранить все имена и сигнатуры и всё равно перестать запускать старую игру.

`packages/engine/tests/fixtures/` уже содержит `miniGame` — единственный
плагин-фикстуру. Превращаем его в набор поколений:

```
packages/engine/tests/fixtures/
├─ miniGame/            # существующий, «текущее поколение» — не трогаем
└─ generations/
   ├─ gen-api3/         # engineApi: 3, без accolades, control 'range' в roomForm
   └─ gen-api4/         # engineApi: 4, снимок сегодняшнего miniGame
```

Правила корпуса:

- Фикстура поколения **заморожена**: её файлы не правятся вместе с движком
  никогда. Если для прохождения теста хочется поправить фикстуру — это и есть
  тот самый слом, ради обнаружения которого корпус существует.
- Комментарий-шапка в каждом каталоге: `// ЗАМОРОЖЕНО. Снимок плагина
  <дата>. Не править: правка фикстуры маскирует слом совместимости.`
- Новое поколение добавляется **только** при осознанном изменении контракта,
  копированием текущего `miniGame`.
- `gen-api3` пишется вручную как реконструкция плагина до бампа v4:
  `engineApi: 3` в манифесте и обеих половинах, отсутствие `accolades` в
  `componentDependencies`, `control: 'range'` хотя бы в одном поле `roomForm`
  — то есть ровно те черты, за которые нынешний движок его отвергает.

`tests/devtools/conformance.test.js` гоняет по каждому поколению
headless-матч существующим контуром: `packages/engine/src/devtools/ScenarioRunner.js`
через `pluginLoader.js`, короткий сценарий (join двух участников, ~300 тиков,
несколько нажатий), проверка отсутствия `decodeErrors` и нарушений
инвариантов.

**До этапа 5 тест на `gen-api3` помечается `it.todo`** — сегодняшний гейт его
законно отвергает. Этап 5 снимает `todo`, и зелёный `gen-api3` становится
формальным доказательством, что план достиг цели.

## 1.6 CI

`.github/workflows/` — оба новых теста попадают в общий прогон `npm test`
автоматически (проект `engine-node` в `vitest.config.js` уже включает
`tests/devtools/**/*.test.js` и `packages/engine/tests/fixtures/**/*.test.js`).
Отдельный workflow не нужен; проверить, что новые пути покрыты `include`, и
дописать `packages/engine/tests/fixtures/generations/**` при необходимости.

## Файлы этапа

Создаются:
- `packages/engine/src/devtools/surface/collect.js`
- `packages/engine/src/devtools/surface/abiParse.js`
- `packages/engine/bin/vimp-surface.js`
- `packages/engine/contract/surface.json`
- `packages/engine/tests/fixtures/generations/gen-api3/**`
- `packages/engine/tests/fixtures/generations/gen-api4/**`
- `tests/devtools/surface.test.js`
- `tests/devtools/conformance.test.js`

Правятся:
- `package.json` (корневой) — скрипт `surface:update`
- `vitest.config.js` — при необходимости расширить `include`

## Проверка этапа

- `npm test` зелёный; `tests/devtools/surface.test.js` проходит.
- Ручная проверка стража: временно удалить `'accolades'` из `SERVICES`
  в `c4-component-dependencies.js` → `npm test` падает с текстом про И1.
  Вернуть.
- Ручная проверка стража И3: временно добавить аргумент в `pack_frame` в
  `abi.rs` → `npm test` падает. Вернуть. (`npm run core:test` после возврата.)
- `conformance.test.js` зелёный на `gen-api4`, `gen-api3` в `todo`.

## Changelog

`packages/engine/CHANGELOG.md`, `## [Unreleased]` → `### Added`: инструмент
слепка плагинной поверхности и корпус совместимости. Тесты сами по себе не
являются записью в changelog (правило `CLAUDE.md`), но `vimp-surface.js` —
новый инструмент, и `contract/surface.json` — новый публичный артефакт
контракта, поэтому запись нужна.

## Документация

`docs/en/plugin-api.md` и `docs/ru/plugin-api.md` — новый раздел
«Compatibility invariants» с формулировками И1–И6 и описанием слепка.
`docs/en/debugging.md` + `docs/ru/debugging.md` — про `npm run surface:update`.
