# Этап 2 — `gameConfigView`: умолчания вместо обязательных полей

**Проблема.** `assertGameConfigShape` (`packages/engine/src/lib/gamePlugin.js:44-113`)
держит список обязательных путей `gameConfig`:

```
roomDefaults.maxPlayers, snapshot, parts.models, parts.weapons,
parts.friendlyFire, panel.fields, playerKeys, teams
+ spectatorTeam (если не noSpectators)
```

Каждое новое обязательное поле мгновенно отвергает все существующие игры.
Список за историю проекта только рос — это прямое нарушение И2.

Вторая половина проблемы: движок читает конфиг игры **россыпью по коду**,
прямыми разыменованиями. Точки чтения:

- `src/lib/coreConfig.js:23-38` — `parts.models`, `parts.weapons`,
  `parts.friendlyFire`, `mapScale`, `mapSetId`, `playerKeys`, `panel.fields`,
  `snapshot`
- `src/lib/applyRoomOverrides.js:7` — `structuredClone({ ...hostDefaults, ...plugin.gameConfig })`,
  далее `maps`, `currentMap`, `roomDefaults.maxPlayers`, таймеры
- `src/lib/buildClientConfig.js:36-49` — `timers.voteTime`, `timers.timeStep`,
  `playerKeys`, `parts.models`, `parts.weapons`, `snapshot`
- `src/standalone/index.js:72,113-117` — `roomDefaults`, `title`, `maps`
- `src/lib/createHostRuntime.js:43-79` — оркестрация всего вышеперечисленного
- `src/host/HostGame.js` — `statMode`, `noSpectators`, `teams`,
  `spectatorTeam` (через уже собранный `game`)

Пока чтения разбросаны, добавить умолчание централизованно негде.

**Результат этапа:** движок читает `gameConfig` только через один модуль, у
каждого поля есть значение по умолчанию, список обязательных полей заморожен
и может только сокращаться.

## 2.1 Модуль `packages/engine/src/lib/gameConfigView.js`

Экспортирует `createGameConfigView(gameConfig)` → замороженный объект с
геттером на каждое поле, которое движок читает. Не класс: `structuredClone`
и spread по коду ожидают простой объект.

Шаблон записи одного поля:

```js
// Каждая строка ниже — обещание совместимости: поле, которого нет в
// конфиге старой игры, отдаёт умолчание, а не роняет загрузку (И2).
// Умолчание обязано быть безопасным для игры, которая о поле не знает.
const FIELDS = {
  'parts.friendlyFire': { default: false },
  'mapScale':           { default: 1 },
  'statMode':           { default: 'table' },
  'noSpectators':       { default: false },
  'title':              { default: null },   // null → вызывающий берёт plugin.id
  // ...
};
```

Обязательные поля остаются отдельным замороженным списком:

```js
// ЗАМОРОЖЕНО (И2). Этот список может только СОКРАЩАТЬСЯ.
// Добавление сюда отвергнет все ранее опубликованные игры — вместо этого
// заведи поле в FIELDS с умолчанием. Страж: tests/devtools/surface.test.js.
const REQUIRED = [
  'snapshot',      // раскладка кадра; синтезировать нечем
  'teams',         // ParticipantManager выбирает команду входа
  'playerKeys',    // без них ядро не знает ввода
  'parts.models',
];
```

Список `REQUIRED` короче нынешнего: `roomDefaults.maxPlayers`,
`parts.weapons`, `parts.friendlyFire`, `panel.fields` и `spectatorTeam`
получают умолчания и уезжают в `FIELDS`. Каждое сокращение обосновывается
комментарием — что происходит при отсутствии поля.

Разумные умолчания для выводимых:
- `roomDefaults.maxPlayers` → `hostDefaults.maxPlayers` (30,
  `src/config/hostDefaults.js:8`)
- `parts.weapons` → `{}` (игра без оружия — `vimp-snakes` уже такая)
- `parts.friendlyFire` → `false`
- `panel.fields` → `[]` (пустая панель рисуется корректно)
- `spectatorTeam` → выводится: если `noSpectators` — `null`, иначе первый ключ
  `teams`, помеченный как спектаторский, иначе `null` с `console.warn`

Связанные проверки из `assertGameConfigShape` (`teams[spectatorTeam]`
существует; `noSpectators` ⇒ ровно одна команда, `gamePlugin.js:96-113`)
переезжают сюда и **сохраняются** — это не «новое требование», а проверка
внутренней согласованности того, что игра уже прислала.

## 2.2 Перевод точек чтения

`assertGameConfigShape` остаётся экспортом `gamePlugin.js` (его зовёт
`createHostRuntime.js:43` и правила контракта), но становится тонкой
обёрткой: строит view и валидирует `REQUIRED`.

`createHostRuntime.js` строит view один раз и передаёт её вниз вместо
`hostPlugin.gameConfig`:

- `buildCoreConfig(view, …)` вместо `buildCoreConfig(hostPlugin.gameConfig, …)`
  (`createHostRuntime.js:60`)
- `applyRoomOverrides(room, plugin)` (`applyRoomOverrides.js:6`) принимает
  view третьим аргументом либо строит её сам — предпочтительно принимает,
  чтобы view была одна на прогон

`standalone/index.js:113-117` (`buildManifest`) — через view: `title`,
`maps`, `roomDefaults`.

**ESLint-правило.** После перевода прямое `hostPlugin.gameConfig.` /
`plugin.gameConfig.` в `src/` (кроме `gameConfigView.js` и правил
`devtools/contract/`) запрещается кастомным правилом `no-restricted-syntax`
в `eslint.config.js`, с сообщением: «читай через createGameConfigView —
прямое чтение обходит умолчания (И2)». Без этого запрета правило разъедется
через три релиза.

## 2.3 Правила контракта

`devtools/contract/rules/b3-game-config-shape.js` синхронизируется с новым
`REQUIRED`: перестаёт требовать поля, у которых теперь есть умолчание, но
продолжает **предупреждать** (`WARN`, не `ERROR`), если игра их не объявила —
разработчику полезно знать, что он полагается на умолчание движка.

Правила `b4`, `b6`, `b10`, `c11`, `d1-d3` читают `ctx.gameConfig` напрямую —
они работают с конфигом *разрабатываемой* игры, а не загружаемой в рантайме,
поэтому остаются как есть. Проверить, что каждое из них корректно
`skip`-ается при отсутствии поля (сейчас — да, см.
`b10-respawns.js:18`, `d1-snapshot-ids.js:16`).

## 2.4 Слепок

Раздел `requiredGameConfig` в `contract/surface.json` начинает браться из
`REQUIRED` модуля view. Страж из этапа 1 автоматически запрещает его рост:
добавление элемента в `REQUIRED` — это добавление в слепок, а не удаление,
поэтому нужен **отдельный явный тест** в `tests/devtools/surface.test.js`:

```
requiredGameConfig может только сокращаться (И2)
```

то есть для этого одного раздела правило инвертировано относительно общего.

## Файлы этапа

Создаются:
- `packages/engine/src/lib/gameConfigView.js`
- `tests/lib/gameConfigView.test.js`

Правятся:
- `packages/engine/src/lib/gamePlugin.js` — `assertGameConfigShape` становится обёрткой
- `packages/engine/src/lib/coreConfig.js`
- `packages/engine/src/lib/applyRoomOverrides.js`
- `packages/engine/src/lib/buildClientConfig.js`
- `packages/engine/src/lib/createHostRuntime.js`
- `packages/engine/src/standalone/index.js`
- `packages/engine/src/devtools/contract/rules/b3-game-config-shape.js`
- `packages/engine/src/devtools/surface/collect.js` — источник `requiredGameConfig`
- `eslint.config.js` — запрет прямого чтения
- `packages/engine/contract/surface.json` — через `npm run surface:update`

## Проверка этапа

- `npm test`, `npx eslint .` — зелёные.
- Новый тест `tests/lib/gameConfigView.test.js`: конфиг без
  `parts.weapons` / `panel.fields` / `roomDefaults.maxPlayers` / `spectatorTeam`
  строит валидную view с умолчаниями; конфиг без `teams` — падает с внятным
  текстом.
- Существующие тесты хоста (`tests/host/`, `tests/lib/`) проходят без правок —
  если какой-то потребовал правки, значит поведение изменилось, и это надо
  разобрать, а не подогнать тест.
- `npm run sim` на фикстуре `miniGame` — зелёный.

## Changelog

`### Added` — «`gameConfig` fields the engine reads now resolve through a
single view with documented defaults; a game may omit `parts.weapons`,
`panel.fields`, `roomDefaults.maxPlayers` and `spectatorTeam`».
Формально это ещё и `Fixed` для игр, которые падали на отсутствующем поле, но
одной записи `Added` достаточно.

## Документация

`docs/{en,ru}/plugin-api.md` — таблица полей `gameConfig` с колонкой
«default» и пометкой, какие четыре поля обязательны. `docs/{en,ru}/host.md` —
про view как единственную точку чтения. `docs/ai/` — соответствующая страница
спецификации плагина.
