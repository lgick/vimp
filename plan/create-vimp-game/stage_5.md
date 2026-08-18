# Этап 5. Шаблон: JS-слой (config / data / host / client)

Порядок внутри этапа — предписанный `docs/ai/11-authoring-workflow.md`
(шаг 4 и 6): `config/snapshot.js` → `data/` → `config/game.js` →
`config/client.js` → `config/auth.js` → `config/sounds.js` → парты и
bakers → `client/index.js` → `host/index.js`.

Ориентир по форме — фикстура `packages/engine/tests/fixtures/miniGame/`
(она уже валидна по контракту и покрыта `miniGame.contract.test.js`).
Ориентир по **содержанию** — только `docs/ai/`: из tanks не берётся ничего.

## 5.1. `src/config/`

- **`snapshot.js`** — два блока:
  - `a1`: `kind: 'indexed8'`, `class: 'hot'`, поля `x` (`f32`, `lerp`),
    `y` (`f32`, `lerp`), `angle` (`f32`, `lerpAngle`), `team` (`u8`),
    `model` (`u8`). Только `indexed8`/`indexedNoNull8` живут в hot-буфере;
    `interp` допустим лишь на `f32` внутри `hot`.
  - `e1`: `kind: 'list16'`, `class: 'event'`, поля `startX`, `startY`,
    `endX`, `endY`, `author` — идентификатор автора последним полем, по
    конвенции блоков оружия.
  - Порядок полей позиционно связан со строками, которые пакует Rust:
    комментарий в файле указывает на `core/src/game.rs`.
- **`game.js`** — `HostPlugin.gameConfig`. Обязаны присутствовать все
  девять путей движковой валидации (`roomDefaults.maxPlayers`, `snapshot`,
  `parts.models`, `parts.weapons`, `parts.friendlyFire`, `panel.fields`,
  `playerKeys`, `teams`, `spectatorTeam`), плюс `scripted`, `maps`,
  `currentMap`, `mapScale`, `mapsInVote`, `stat`, `soundCues` (ровно пять
  ключей), `initialVote`, `playerState.defaultState`, `roomForm`.
  `roomForm` использует только контролы `text|select|checkbox|radio` и
  только поля белого списка (`maxPlayers`, `map`, `roundTime`, `mapTime`,
  `friendlyFire`) — остальное хост молча выбрасывает. Ключ `t` в панели
  хоста не объявляется.
- **`client.js`** — результат `buildClientGameConfig()`:
  `parts.gameSets = { a1: ['Actor'], e1: ['ShotEffect'], c1: ['Map'] }`,
  `parts.entitiesOnCanvas` для всех трёх классов, `bakedAssets`,
  `componentDependencies` только из `renderer|soundManager|assetsBase`,
  один канвас, панель с ячейками `hp` (`bar`), `am` (`value`) и
  обязательным `t` (`type: 'time'`), `stat` на пяти колонках, тексты чата,
  шаблоны голосований, `controls.keySetList`: `[0]` — сет зрителя с
  `nextPlayer`/`prevPlayer`, `[1]` — игровой сет, чьи экшены совпадают с
  ключами `gameConfig.playerKeys`; коды `9`, `13`, `27`, `67`, `77` не
  используются.
- **`auth.js`** — `elems.fieldsId` (не `formId`), поле выбора модели
  названо ровно `model`, поля ника нет (ник приходит из JWT), `validators`
  — функции, исполняемые на хосте.
- **`sounds.js`** — `codecList: ['webm', 'mp3']`, два звука `shot` и
  `death` с `priority`/`volume`; `path` проставляет движок.

## 5.2. `src/data/`

- `models.js` — одна модель актора (скорость, ускорение, hp, радиус).
- `weapons.js` — одно hitscan-оружие (`fireRate` в секундах, урон,
  дальность, боезапас).
- `maps/arena.js` + `maps/index.js` — сетка стен `physicsStatic`, `step`,
  `scale`, по восемь респаунов на `team1` и `team2`. Респауны — жёсткая
  вместимость команды: их число согласовано с `roomDefaults.maxPlayers`.
  `spriteSheet` и `layers` отсутствуют — карта рисуется процедурно.

## 5.3. `src/host/`

- `index.js` — `default export` со всеми обязательными полями: `id`,
  `engineApi` (импорт `ENGINE_API_VERSION`), `createCore`, `gameConfig`,
  `authSchema`, `chatCommands` (массив, пусть и из одной команды),
  `systemMessages`, `createModules`, `buildClientGameConfig`.
- `nodeCore.js` — ветвление загрузки wasm: `core/pkg-web` в браузере,
  `dist/core-node/` в Node (headless-раннер).
- `ScriptedManager.js` — ровно пять методов контракта ботов: `createMap`,
  `getCountsPerTeam`, `removeScripted`, `createScripted`,
  `removeOneForHuman`.
- `createModules.js` — возвращает `{ scripted }` (движок читает только это
  поле).
- `spawnCommand.js` — `/spawn <n>`; имя не пересекается с встроенными
  `/name`, `/nr`, `/timeleft`, `/mapname`, `/rank`.
- `systemMessages.js` — коды в группах `s|v|m|c|n`, каждому соответствует
  текст в `client.js` по тому же индексу.

Файлы `src/host/**` обязаны оставаться Worker-safe: ни DOM, ни PixiJS, ни
Node-глобалей.

## 5.4. `src/client/`

- `index.js` — `ClientPlugin`: `createClientCore` возвращает
  `{ core, memory }` (без `memory` клиент молча не читает hot-буфер),
  `parts`, `bakers`, `styles` (импорт CSS с `?inline`) и **все три** хука
  `onAuth`, `onPanel`, `onLocalAction` — движок зовёт их безусловно.
- `parts/Actor.js` — контейнер PixiJS на запечённой текстуре, `update(data)`
  по раскладке `a1`, явный `zIndex` (в PixiJS v8 `sortChildren()` не
  принимает компаратор движка), `destroy()`.
- `parts/Map.js` — процедурная отрисовка стен по данным карты.
- `parts/ShotEffect.js` — парт событийного блока: дополнительно реализует
  `run()`.
- `bakers/actorTexture.js` — процедурная текстура актора; имя бейкера
  совпадает с записью в `bakedAssets`.
- `style.css` — минимальные стили HUD.

## 5.5. Тесты внутри сгенерированной игры

`tests/` шаблона, два проекта vitest:

- `tests/config/contract.test.js` — форма `gameConfig` через движковый
  `assertGameConfigShape`, совпадение `engineApi` хоста и клиента,
  перекрёстные проверки `gameSets` ↔ `entitiesOnCanvas` ↔ `snapshot`
  (локальная страховка поверх `vimp-contract`);
- `tests/host/hostPlugin.test.js` — наличие всей поверхности, поведение
  `ScriptedManager` и `/spawn`;
- `tests/client/parts.test.js` — конструирование партов на фейковом
  `renderer` в `happy-dom`;
- `tests/core/nodeCore.test.js` (проект `integration`, `node`) —
  инстанцирование ядра из `core/pkg-node`, один шаг симуляции; `skip`,
  если ядро не собрано.

## Готовность этапа

- [ ] `npm run check:contract` в сгенерированной игре — без единого `fail`.
- [ ] `npm test` внутри игры зелёный (оба проекта).
- [ ] `npm run sim` — код выхода `0`.
- [ ] `npm run dev` открывает вкладку, где актор двигается, стреляет,
      убивает бота, раунд заканчивается и начинается заново (ручной смоук
      по чек-листу `docs/ai/11-authoring-workflow.md`, шаг 10).
