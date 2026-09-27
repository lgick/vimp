# Этап 6. vimp-tanks: скрытые source maps, `levelView` → сервис `diagnostics` ✅ выполнен

Репозиторий: **`vimp-tanks`** (`/Users/dmitry/Sites/my/vimp-tanks`, npm
`@vimp-games/tanks`). Зависит от этапов 3 и 4, **выпущенных в npm**
(`vimp-engine` с сервисом `diagnostics` и capability `diagnostics`).
Правила репозитория — его `CLAUDE.md` (документация `docs/en` + `docs/ru`,
`CHANGELOG.md` в корне, релиз вручную, без коммитов).

## Цель

1. Сборка плагина выпускает скрытые карты, чтобы бокс расшифровывал кадры
   игры (`client-BvkP3FTH.js:84:46108` → `src/client/tank3d/project.js:36`).
2. Предупреждение `levelView` «центра камеры нет» (сейчас — только
   `console.warn` один раз за сессию) дополнительно уходит в журнал через
   сервис `diagnostics`, если движок его даёт.
3. Плагин продолжает работать на движке **без** этого сервиса.

## Предыстория (что уже есть в плагине)

`src/client/levelView.js` — сервис игры (`ClientPlugin.hooks.services(core)`
в `src/client/index.js`, один экземпляр на ядро): центр камеры кадра
`camera()`, привязка к сцене `attachStage(stage, renderer)` (зовут
`Tank._updateView`, `MapLayer` и `createLighting.attachStage`), и
`warnNoCamera()` — одноразовый `console.warn('[tanks] levelView: центра
камеры нет — кадр без трансформа сцены', { destroyed, position, scale,
screen })`, который срабатывает, когда сцена привязана, но центр не
вычисляется (уничтоженная сцена или нулевой масштаб). Сервис игры создаётся
**до** полотна и движковых сервисов не видит — `diagnostics` ему передают
парты, у которых он есть в `dependencies`.

## Что прочитать перед началом

- `vimp-tanks/CLAUDE.md`.
- `src/client/levelView.js` (целиком: состояние `state`, `warnNoCamera`,
  `camera`, `attachStage`).
- `src/config/client.js` → `componentDependencies` (стр. ~262–330):
  формат «имя сервиса → список партов».
- `src/client/parts/Tank.js` — конструктор (`this._renderer =
  dependencies.renderer || null` стр. ~249, `this._levelView = … ` стр. ~334).
- `src/client/parts/map/MapLayer.js` — конструктор
  (`this._levelView = dependencies.levelView || null` стр. ~38).
- `vite.config.js` — ветка сборки (`build: { outDir: 'dist', … }`,
  прогоны `--mode client` и `--mode host`).
- `scripts/check-pack.js` — страховка тарбола (`REQUIRED`), `prepack`.
- Движок: `docs/en/plugin-api.md` → сервис `diagnostics` (добавлен этапом 3).

## Шаги

### 6.1. Скрытые карты — `vite.config.js`

В возвращаемый для сборки объект, в `build`:

```js
// скрытые source maps (vimp plan/client-reports): *.map ложатся в dist/ и
// уезжают в npm, но бандлы на них не ссылаются. Бокс движка расшифровывает
// по ним стеки журнала клиентских ошибок и наружу их не отдаёт
sourcemap: 'hidden',
```

Касается обоих прогонов (`client` и `host`). Проверить после `npm run
build`: `ls dist/*.map` есть; `grep -l sourceMappingURL dist/*.js` —
пусто; `scripts/build-game-manifest.js` не записал `.map` в `entries`
манифеста (если записал — отфильтровать). `scripts/check-pack.js` менять
не нужно, если он не запрещает лишние файлы (он проверяет только
обязательные) — убедиться.

Оговорка для документации: на движке **без** этапа 4 бокс раздаёт `dist/`
игры целиком, и карты будут скачиваемы. Репозиторий открытый — это
допустимо, но записать.

### 6.2. `levelView` принимает сервис — `src/client/levelView.js`

- В `state`: `diagnostics: null` с комментарием (движковый журнал ошибок;
  сервис игры создаётся до полотна, отдают его парты).
- Метод в возвращаемом объекте:

```js
// журнал клиентских ошибок движка (сервис пула `diagnostics`, vimp-engine
// ≥ 0.35.0): его отдают парты, у которых он есть в dependencies. Первый
// непустой — навсегда; на старом движке сервиса нет, и остаётся console.warn
setDiagnostics(diagnostics) {
  if (!state.diagnostics && diagnostics) {
    state.diagnostics = diagnostics;
  }
},
```

- В `warnNoCamera` — после `console.warn(...)` тем же объектом:

```js
state.diagnostics?.warn('tanks.camera.missing', payload);
```

  (`payload` — вынести объект, который сейчас собирается прямо в вызове
  `console.warn`, в переменную.) Одноразовость остаётся прежней —
  `state.warned`: и консоль, и журнал получают по одному сообщению за
  сессию.

### 6.3. Парты передают сервис

- `src/client/parts/Tank.js`, конструктор, рядом с `this._levelView = …`:

```js
// журнал ошибок движка (необязательный сервис): отдаём его levelView —
// сам сервис игры создаётся до полотна и движковых сервисов не видит
this._levelView?.setDiagnostics(dependencies.diagnostics ?? null);
```

- `src/client/parts/map/MapLayer.js`, конструктор, после
  `this._levelView = …` — то же самое (карта может появиться раньше танка:
  наблюдатель).
- `src/config/client.js` → `componentDependencies`:

```js
// журнал клиентских ошибок движка (сервис `diagnostics`, vimp-engine
// ≥ 0.35.0): необязательный — на старом движке парт получает undefined, и
// в requires манифеста его нет намеренно
diagnostics: ['Tank', 'Map'],
```

  Проверить, что `MapLayer` получает `dependencies` парта `Map` целиком
  (сервис объявляется для `Map`, а читается в `MapLayer`); если `Map`
  передаёт слоям урезанный объект — дописать туда `diagnostics`.
- **Не** добавлять `'diagnostics'` в `requires` манифеста / плагина.

### 6.4. Движок в devDependencies

`package.json` → `devDependencies.vimp-engine` — поднять до версии с
этапами 3–4 (например `^0.35.0`), `npm install`. Затем контракт:
`npx vimp-contract --game .` (или как это описано в
`docs/en/getting-started.md` плагина) — правило C4 не должно ругаться на
`diagnostics`.

## Тесты

- `tests/client/levelView.test.js`:
  - `setDiagnostics` + сцена с нулевым масштабом: `camera()` дважды →
    `diagnostics.warn` вызван **один** раз с `'tanks.camera.missing'` и тем
    же объектом, что ушёл в `console.warn` (`vi.spyOn(console, 'warn')
    .mockImplementation(() => {})`);
  - первый непустой побеждает: второй `setDiagnostics` не подменяет;
  - без `setDiagnostics` — только `console.warn`, без падения.
- `tests/client/parts/Tank.test.js` — `dependencies.diagnostics` есть →
  `levelView.setDiagnostics` вызван с ним; нет — вызван с `null` и ничего
  не падает (двойник `makeView()` в тесте дополнить методом
  `setDiagnostics`).
- `tests/client/parts/map/*` — то же для `MapLayer` (найти тест слоя).
- `tests/client/tanksClientPlugin.test.js` — если там проверяются ключи
  `componentDependencies`, добавить `diagnostics`.

## Документация (en + ru)

- `docs/en/architecture.md` + `docs/ru/architecture.md` — в абзаце про
  `levelView.camera()` и одноразовое предупреждение (добавлен недавно): оно
  уходит и в журнал движка через `diagnostics`, если сервис есть.
- `docs/en/configuration.md` + ru — `componentDependencies.diagnostics`.
- `docs/en/getting-started.md` + ru — сборка выпускает скрытые source maps
  (`dist/*.map`), зачем они и кто их читает; оговорка про старые движки.

## Журнал

`CHANGELOG.md` (корень vimp-tanks), `## [Unreleased]` → `### Added`:

- The build emits hidden source maps (`dist/*.map`), so the engine's
  client error log shows game stack frames as source files and lines.
- The one-time "no camera centre" warning also goes to the engine's
  `diagnostics` service when the engine provides it.

## Проверка

```bash
npx eslint .
npm test --silent
npm run build && ls dist/*.map && ! grep -l sourceMappingURL dist/*.js
npm run check:pack
```

Сквозная (движок с этапами 1–5 локально, плагин прилинкован, см.
`docs/en/getting-started.md` плагина): в матче обнулить масштаб сцены
(`app.stage.scale.set(0)` из консоли или скрыть полотно) → в журнале
лобби («Errors») запись `warn/plugin` с кодом `tanks.camera.missing` и
`details` (`destroyed`, `scale`, `screen`); бросить ошибку из кода игры
(временная правка или DevTools-брейкпойнт в бандле плагина) → стек в
журнале указывает на `src/client/…` плагина.

## Готово, когда

- `dist/` содержит скрытые карты, тарбол проходит `check:pack`;
- предупреждение `levelView` доходит до журнала на новом движке и не ломает
  ничего на старом;
- тесты, линт, документация (en+ru), журнал — готовы;
- этот файл и строка в `vimp/plan/client-reports/README.md` помечены
  «✅ выполнен»; релиз `@vimp-games/tanks` — вручную разработчиком (bump
  `version` в `package.json` и `core/Cargo.toml`, датировать журнал), затем
  передеплой dedicated-бокса.
