# Этап 5 — Удаление гейта `ENGINE_API_VERSION` ✅ выполнен

**Идёт строго после этапов 1–4.** Снимать гейт до того, как поверхность
заморожена (1), поля получили умолчания (2), словари стали append-only (3) и
ABI перестал расти (4), означает принимать старые плагины без гарантии, что
они заработают. После 1–4 гарантия есть, и гейт становится вредным.

**Результат этапа:** плагин не отвергается за возраст. Единственная причина
отказа — плагин просит возможность, которой у этого движка нет, то есть
плагин **новее** движка. Это направление отказа остаётся и обязано остаться:
движок не может выдать то, чего в нём не существует.

## 5.1 Что происходит с самим числом

`ENGINE_API_VERSION` (`src/config/opcodes.js:14`) **замораживается на 4
навсегда** и не удаляется:

```js
// ЗАМОРОЖЕНО на 4. Больше не гейт совместимости и больше не бампается:
// после этапов 1-4 плагинная поверхность append-only, и отвергать плагин
// за возраст стало не за что (plan/plugin-forward-compat/).
// Остаётся как метка поколения контракта в манифестах и диагностике.
// Совместимость решается capability-переговорами, см. lib/capabilities.js.
export const ENGINE_API_VERSION = 4;
```

Удалять константу нельзя: её импортируют скрипты сборки всех уже
существующих игр (`build-game-manifest.js` в каждом репозитории игры) и
правило контракта `b2`. Удаление сломало бы сборку игр — прямое нарушение
цели плана.

## 5.2 `assertEngineApiCompatible` → `checkPluginCompatibility`

`src/lib/gamePlugin.js:32-40` заменяется. Новая функция не сравнивает числа,
а сверяет запрошенные возможности:

```js
// Плагин отвергается, только если просит то, чего в этом движке нет
// (то есть он НОВЕЕ движка). Плагин любого возраста принимается: после
// этапов 1-4 поверхность append-only и старое имя работает вечно.
export function checkPluginCompatibility(manifest) {
  const wanted = manifest.requires ?? [];
  const missing = wanted.filter(name => !ENGINE_CAPABILITIES.has(name));

  if (missing.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: 'engine-too-old',
    missing,
    text: `игра "${manifest.id}" требует возможностей, которых нет в этой ` +
      `сборке движка: ${missing.join(', ')} — обновите движок`,
  };
}
```

Функция **возвращает вердикт, а не бросает**. Бросание — решение
вызывающего: у четырёх входов разная правильная реакция (см. 5.4).

Обратная совместимость имени: `assertEngineApiCompatible` остаётся
экспортом-обёрткой, которая бросает при `!ok` — на неё ссылаются
существующие тесты и, возможно, внешний код (И1 действует и на экспорты
движка).

## 5.3 Реестр возможностей движка

`packages/engine/src/lib/capabilities.js` — append-only реестр (форма из
этапа 3), перечисляющий всё, что движок предоставляет плагину и что плагин
может потребовать явно:

```js
// Append-only (И1). Имя, однажды объявленное, поддерживается вечно:
// опубликованная игра могла записать его в manifest.requires.
export const ENGINE_CAPABILITIES = createRegistry('engine-capabilities', [
  { value: 'accolades',   since: '0.20.0' },  // порт ACCOLADES_DATA + сервис
  { value: 'stat.leaderboard', since: '0.20.0' },
  { value: 'dispatch',    since: '0.23.0' },  // dispatch/abi_describe в ядре
  // …
]);
```

Поле `requires` в `GameManifest` — **необязательное**; манифест без него
означает «ничего сверх базового не требуется», то есть все ранее
опубликованные манифесты валидны без правок. Само введение `requires` —
аддитивное изменение и не требует бампа (И4).

## 5.4 Четыре входа: разная реакция

| Вход | Файл | Реакция при `!ok` |
| --- | --- | --- |
| Мастер (каталог) | `src/master/GameCatalog.js:59-67` | игра **остаётся** в каталоге с пометкой недоступности (см. 5.5) |
| Dedicated / `vimp-sim` / InlineHostBridge | `src/lib/loadGamePackage.js:35` | `throw` с текстом вердикта — игра одна, подменить нечем |
| Браузерный клиент | `src/lib/gamePlugin.js:126` (`loadClientPlugin`) | `throw` с текстом вердикта |
| Standalone SDK | `src/standalone/index.js:60-61` | `throw` с текстом вердикта |

Во всех случаях текст обязан называть **сторону, которую надо обновить**:
«обновите движок», а не «несовместимая версия». Это единственный оставшийся
режим отказа, и он должен быть однозначным.

Проверка «плагин против манифеста» (`gamePlugin.js:127-133` и
`loadGamePackage.js:assertPluginMatchesManifest`) — про рассинхрон сборки
внутри одного пакета, а не про версии движка. **Остаётся как есть.**

## 5.5 Мягкая деградация каталога

`GameCatalog.js` перестаёт молча выкидывать игру (`continue` на строке 66).
Вместо этого запись сохраняется с полем совместимости:

```js
manifest: { ...withPackage, compat: { ok: false, missing, text } }
```

Клиент лобби показывает такую игру в списке как недоступную с причиной,
создание комнаты по ней запрещено. Это чинит отдельный давний дефект:
сегодня несовместимая игра выглядит как пустое лобби, а не как ошибка
(диагноз записан в `docs/en/plugin-api.md`, таблица версий).

Правки на клиенте: `src/client/` — рендер списка игр в лобби; поле `compat`
необязательно, старый клиент его просто не увидит.

## 5.6 Правило контракта `b2`

`devtools/contract/rules/b2-engine-api.js` инвертируется. Сейчас оно требует
равенства `engineApi` установленному `ENGINE_API_VERSION` во всех трёх местах
(`b2-engine-api.js:29-33`) — то есть буквально запрещает разрабатывать игру
против движка не последней версии.

Новое поведение:

1. **Согласованность внутри пакета** (`ERROR`): `engineApi` в манифесте,
   `HostPlugin` и `ClientPlugin` совпадают между собой. Это осмысленно —
   рассинхрон сборки.
2. **Импорт, а не литерал** (`ERROR`): проверка `text.includes('ENGINE_API_VERSION')`
   (`b2-engine-api.js:41`) сохраняется.
3. **Возможности существуют** (`ERROR`): каждое имя из `manifest.requires`
   есть в реестре возможностей установленного движка.
4. Расхождение `engineApi` с установленным движком — **больше не нарушение
   вообще**, даже не `WARN`: это нормальное состояние игры, собранной год
   назад.

## 5.7 Снятие `todo` с корпуса

`tests/devtools/conformance.test.js` (этап 1): `it.todo` для `gen-api3`
превращается в настоящий тест. Зелёный headless-матч на плагине с
`engineApi: 3`, отсутствующим `accolades` и `control: 'range'` в форме — это
формальное доказательство, что план достиг цели.

Если он не зелёный, значит один из этапов 2–4 не доделан; чинить надо там, а
не подгонять фикстуру.

## Файлы этапа

Создаются:
- `packages/engine/src/lib/capabilities.js`
- `tests/lib/capabilities.test.js`
- `tests/master/gameCatalogCompat.test.js`

Правятся:
- `packages/engine/src/config/opcodes.js` — комментарий-заморозка
- `packages/engine/src/lib/gamePlugin.js` — `checkPluginCompatibility` + обёртка
- `packages/engine/src/lib/loadGamePackage.js`
- `packages/engine/src/standalone/index.js`
- `packages/engine/src/master/GameCatalog.js`
- `packages/engine/src/client/` — рендер недоступной игры в лобби
- `packages/engine/src/devtools/contract/rules/b2-engine-api.js`
- `tests/devtools/conformance.test.js` — снятие `todo`
- `packages/engine/contract/surface.json`
- `packages/engine/src/devtools/surface/collect.js` + `tests/devtools/surface.test.js`
  — раздел `engineCapabilities` в слепке (имя из реестра игра пишет в
  `requires`, значит И1 действует и на него)

## Проверка этапа

- `npm test`, `npx eslint .` — зелёные, **включая `gen-api3`**.
- Ручной опыт, ради которого всё делалось: взять опубликованную сборку игры
  под `engineApi: 3` (либо собрать `vimp-tanks` на теге до бампа v4),
  положить в `node_modules`, поднять `npm start` — игра видна в лобби,
  комната создаётся, матч идёт.
- Манифест с `requires: ['телепортация']` — игра показана в лобби как
  недоступная с текстом «обновите движок»; `npm run sim` по ней падает с тем
  же текстом.
- `node packages/engine/bin/vimp-contract.js --game <dir>` на обеих играх —
  зелёный.

## Changelog

`packages/engine/CHANGELOG.md`, `### Added`:

- «`GameManifest.requires` — an optional list of engine capabilities a game
  needs; the engine rejects a plugin only when it asks for something this
  build does not have»;
- «`ENGINE_API_VERSION` is frozen at 4 and is no longer a compatibility gate:
  a plugin built against an older engine now loads and runs»;
- «`GameCatalog` keeps an incompatible game in the catalog marked
  unavailable with a reason, instead of dropping it silently».

Формально снятие гейта — расширение принимаемого множества, поэтому
`⚠️ Breaking` здесь **не ставится** (И4). Единственное поведение, которое
меняется в сторону строгости, — `b2` в `vimp-contract`, но это инструмент
разработки, а не рантайм-гейт.

## Документация

`docs/{en,ru}/plugin-api.md` — таблица «Versions and compatibility»
переписывается полностью: `ENGINE_API_VERSION` описывается как замороженная
метка, добавляется раздел про `requires` и реестр возможностей. Удаляется
фраза «A game built against an older version silently disappears from the
lobby» — она перестаёт быть правдой.
`docs/{en,ru}/master.md` — про поле `compat` в манифесте каталога.
`docs/{en,ru}/publishing.md` — раздел «Changelog headings set the version»
дополняется: `ENGINE_API_VERSION` больше не бампается, вместо этого
регистрируется возможность.
`docs/ai/` — соответствующая страница спецификации.
