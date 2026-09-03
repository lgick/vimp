# Этап 1 (замечание № 7). `Cannot find package 'pixi.js'` в dedicated ✅ выполнен

Исполняется первым: без него dedicated-сервер не поднимается на игре из
реестра вовсе, и проверять этапы 3–5 нечем.

## Что подтвердилось

Симптом воспроизводится, но объяснение из замечания описывает **следствие**,
а не причину. Резолвинг `node_modules` вверх по дереву работает именно так,
как написано, и `/var/vimp/games/…` действительно вне `/app`. Настоящий
вопрос другой: **зачем Node вообще импортирует клиентскую сборку игры.**

`loadGamePackage` импортирует обе половины плагина безусловно:

```
packages/engine/src/lib/loadGamePackage.js:46  const hostPlugin   = await importDefault(…, manifest.entries.host, …);
packages/engine/src/lib/loadGamePackage.js:55  const clientPlugin = await importDefault(…, manifest.entries.client, …);
```

А dedicated-сервер клиентскую половину **не использует ни разу**: во всём
`packages/engine/src/dedicated/main.js` от `pkg` берутся только `pkg.id`,
`pkg.manifest`, `pkg.distDir`, `pkg.wasmUrl` и `pkg.hostPlugin` (строки
322–354). Клиентская сборка нужна ему только как статика для браузера — её
раздаёт `GameCatalog`/`gameStatic`, и в браузере `pixi.js` резолвится import
map'ом.

Раньше это не вылезало, потому что dedicated поднимали с прилинкованным
пакетом: `/app/node_modules/@vimp-games/tanks/dist/` лежит **внутри** `/app`,
и подъём по дереву находил `/app/node_modules/pixi.js`. Игра из реестра
легла в том — и тот же импорт перестал резолвиться.

Клиентскую половину продолжает использовать headless-runner
(`packages/engine/src/devtools/ScenarioRunner.js:435` → `VirtualClient`),
поэтому просто удалить импорт нельзя.

## Почему не вбандлить pixi.js в игру

Отвергнуто: это прямой запрет контракта. Правило A1
(`packages/engine/src/devtools/contract/rules/a1-package-fields.js:39-52`)
требует, чтобы `pixi.js` был в `peerDependencies` + `devDependencies` и
отсутствовал в `dependencies`, а `vite.config.js:43-51` держит его в
`external`. Причина в комментарии там же: движок и игра обязаны резолвить
**один и тот же экземпляр** PixiJS через import map
(`public/vendor/pixi/`, `scripts/sync-pixi-vendor.mjs`). Вторая копия — это
второй реестр расширений PixiJS и сломанный рендер.

Симлинк `${VIMP_GAMES_DIR}/node_modules -> /app/node_modules` в образе тоже
отвергнут (`NODE_PATH` для ESM не работает вовсе). `pixi.js` — прод-
зависимость движка (`packages/engine/package.json:48`), так что симлинк бы
сработал, и в этом его вред: host-половина, оставившая внешний импорт, молча
резолвилась бы против версии пакета, которую держит движок. Такая игра
работает на этом мастере и нигде больше, а дефект упаковки виден только по
тонкому расхождению версий.

## Решение

Клиентская половина грузится по требованию, а неразрешимый импорт даёт
именованный отказ вместо сырого `ERR_MODULE_NOT_FOUND`.

### 1. `packages/engine/src/lib/loadGamePackage.js`

Сигнатура:

```js
export async function loadGamePackage(distDir, { core = null, client = 'lazy' } = {})
```

- `client: 'lazy'` (умолчание):
  - `clientPlugin` в результате **не заполняется** (поле отсутствует либо
    `null` — выбрать одно и описать в JSDoc);
  - в результат добавляется `loadClientPlugin()` — функция без аргументов,
    которая при первом вызове делает
    `importDefault(baseDir, manifest.entries.client, assetsBase)`, прогоняет
    по импортированной половине `assertPluginMatchesManifest(manifest,
    { client })` и **кеширует промис**; повторный вызов отдаёт тот же
    объект.
- `client: true` — импорт обеих половин сразу, как сейчас; `clientPlugin`
  заполнен; `loadClientPlugin()` тоже присутствует и отдаёт уже
  импортированную половину, чтобы у результата была одна форма при любом
  режиме.
- `assertPluginMatchesManifest` вызывается с `{ host: hostPlugin }` в
  ленивом режиме и с `{ host, client }` при `client: true`.
  `warnOnRequiresMismatch` — по тем же половинам; правило «половина, вовсе
  не объявившая `requires`, из сверки исключена» сохраняется без изменений.
- Размен зафиксировать комментарием рядом с кодом: расхождение `engineApi`
  между манифестом и клиентской сборкой в Node-контуре ничего не ломает —
  клиента собирает браузер, а совместимость манифеста уже проверена
  `checkPluginCompatibility` (`loadGamePackage.js:39`) и структура пакета —
  `checkGamePackage` на стороне `GameStore`.

`importDefault` оборачивает `import()` в `try/catch`:

```js
function importDefault(baseDir, entry, assetsBase, manifestPath) {
  const file = path.resolve(baseDir, stripBase(entry, assetsBase));

  return import(pathToFileURL(file).href).then(
    module => module.default,
    err => {
      if (err?.code !== 'ERR_MODULE_NOT_FOUND') {
        throw err;
      }

      // имя ненайденного пакета — из текста ошибки; не нашлось — не подставляем
      const missing = /Cannot find package '([^']+)'/.exec(err.message)?.[1];

      throw new Error(
        `${manifestPath}: entry '${entry}'${missing ? ` imports '${missing}', which` : ''} ` +
          'cannot be resolved by Node — a plugin half loaded in Node must be ' +
          'self-contained; external dependencies (pixi.js) are allowed only in ' +
          'the client half and only in the browser',
      );
    },
  );
}
```

Применяется к обеим половинам: host-половина падает на загрузке пакета,
client-половина — на первом `loadClientPlugin()`.

### 2. Потребители, которым нужен `client: true`

Найти все вызовы:

```bash
grep -rn "loadGamePackage\|clientPlugin" packages/engine/src packages/engine/bin
```

Явный `client: true` проставить там, где виртуальные клиенты обязательны и
ранний отказ лучше отказа посреди прогона:
`packages/engine/src/devtools/pluginLoader.js`,
`packages/engine/bin/vimp-sim.js`. Если какой-то другой потребитель читает
`pkg.clientPlugin`, перевести его на `await pkg.loadClientPlugin()` либо на
`client: true` — на усмотрение по месту, но `ScenarioRunner` должен
продолжать работать без изменений в своей логике.

### 3. `packages/engine/src/dedicated/main.js`

Правок нет: умолчание уже ленивое, `loadGame(packageDir)` вызывается одним
аргументом (строка ~322).

### 4. `Dockerfile`

**Не трогается.**

## Тесты

`tests/lib/loadGamePackage.test.js`:

- фикстура, чья client-entry делает `import 'nonexistent-pkg'`: при
  умолчании `loadGamePackage` отрабатывает успешно, а
  `await pkg.loadClientPlugin()` падает отказом, текст которого содержит
  `self-contained`;
- та же фикстура при `client: true` падает сразу в `loadGamePackage`;
- два вызова `loadClientPlugin()` отдают один и тот же объект (кеширование);
- фикстура, чья **host**-entry делает неразрешимый импорт, даёт именованный
  отказ на загрузке;
- существующие проверки `requires` не должны требовать client-половины:
  первый тест перестаёт проверять `pkg.clientPlugin` и проверяет
  host-половину.

`tests/dedicated/dedicatedServer.test.js` — старт на фикстуре, чья
клиентская половина в Node неразрешима.

## Документация и changelog

- `docs/en/dedicated.md` + `docs/ru/dedicated.md` — клиентская половина в
  Node не грузится (её раздаёт статика, а собирает браузер).
- `docs/en/plugin-api.md` + `docs/ru/plugin-api.md` — внешние зависимости
  (`pixi.js`) допустимы только в client-половине; host-половина и `wasmNode`
  обязаны быть самодостаточны; неразрешимый импорт даёт именованный отказ.
- `packages/engine/CHANGELOG.md` → `### Fixed` (dedicated падал на игре,
  приехавшей из реестра). **Уровень: patch.**

## Готовность

`npx eslint . && npm test -- --silent` зелёные, `npm run sim:check` проходит,
`node packages/engine/bin/vimp-contract.js --game <dir>` даёт прежний
вердикт. После этого пометить этап «✅ выполнен» в этом файле и в
`README.md`.
