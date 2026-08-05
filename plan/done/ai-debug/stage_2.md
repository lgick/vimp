# Этап 2 — Headless-runner и формат сценария ✅ выполнен

## 2.1 `packages/engine/src/lib/createHostRuntime.js` ✅ выполнен

Чистая часть `host.worker.js:onInit`: загрузка HostPlugin,
`assertGameConfigShape`, `applyRoomOverrides`, `buildCoreConfig`,
`createCore`, `buildClientConfig`, `new HostGame`, `setHostId`. Worker теперь
вызывает её и оставляет себе только postMessage-обвязку — общий код вместо
копии (инвариант 3 плана).

Точки расширения (в проде не задаются, дефолты сохраняют поведение):
`loadHostPlugin`, `createSocketManager`, `hostOptions`, `overrideGameConfig`
(правка собранного конфига игры до создания ядра — сценарий подкручивает
`networkSendRate` и таймеры).

## 2.2 `packages/engine/src/lib/reconstructHot.js` ✅ выполнен

Вынесено из `client/main.js` двумя экспортами: `buildSnapshotKeysById`
(обратный индекс схемы) и `reconstructHot(hot, snapshotKeysById)`.
Импортируется и браузерным клиентом, и runner'ом.

## 2.3 `packages/engine/src/devtools/` ✅ выполнен

- `RecordingSocketManager.js` — обобщение `FakeSocketManager` из
  `tests/host/fixtureHarness.js`; копия в `tests/` удалена, харнесс
  ре-экспортирует движковый класс. Добавлен колбэк `onFrame` — runner
  раздаёт кадры клиентам сразу, не дожидаясь конца прогона.
- `VirtualClient.js` — настоящий `ClientCore` на каждого участника,
  кормится реальными байтами `sendShot` → `push_frame` → `sample` →
  `hot_values` → `reconstructHot` → сцена. Ключ снапшота, которого нет в
  `parts.gameSets`, и part, которого нет в `entitiesOnCanvas`, попадают в
  `decodeErrors` — это и есть класс «чёрный холст», названный по имени.
- `VirtualClock.js` — очередь задач, `advance(ms)`, детерминированный
  PRNG (mulberry32) для `random()`.
- `ScenarioRunner.js` — `parseScenario` + `runScenario`.
- `report.js` — `writeReport`/`formatMarkdown`.
- `pluginLoader.js` — `--game` (каталог пакета или `dist/manifest.json`) →
  `--core` → фикстура `miniGame`. Читает опциональное поле манифеста
  `entries.wasmNode`.
- `resetHostSingletons.js` — см. «Отклонения», п. 1.

## 2.4 CLI ✅ выполнен

`packages/engine/bin/vimp-sim.js` (+ `bin: vimp-sim` в
`packages/engine/package.json`), скрипты `sim`, `sim:replay`, `sim:check`.
Ненулевой код возврата при нарушениях контракта. Без `--scenario`
прогоняется встроенный смоук на фикстуре.

## 2.5 Формат сценария ✅ выполнен

```json
{ "version": 1, "seed": 3812, "map": "arena",
  "config": { "networkSendRate": 1 },
  "participants": [{ "id": "p1", "name": "P1", "model": "m1" }],
  "timeline": [
    { "tick": 0,  "op": "join", "who": "p1", "team": "team1" },
    { "tick": 12, "op": "key",  "who": "p1", "action": "down", "name": "forward" },
    { "tick": 30, "op": "chat", "who": "p1", "text": "/nr" }
  ],
  "ticks": 1200, "dumpTicks": [6, 1200] }
```

Операции: `join`, `leave`, `key`, `chat`, `vote`. `seed` уезжает в
`room.seed` (этап 1). Шаг тика берётся из `timers.timeStep` конфига игры, а
не из сценария: виртуальные часы прокручиваются ровно на шаг, и боевой
самокорректирующийся игровой цикл `TimerManager` делает ровно один тик —
runner не подменяет цикл, а крутит настоящий.

Ввод применяется синхронно при приходе сообщения (`HostGame.updateKeys`),
очереди нет — поэтому сценарий пишет **номер тика**, на границе которого
ввод приземлился. `op: key` дублируется на клиент (`core.apply_input`),
иначе дрейф предикта (этап 5) будет не с чем сравнивать.

## 2.6 Выход ✅ выполнен

`.debug/run-<ts>/{report.json, report.md, scene-<tick>.json}`; `.debug/`
добавлен в `.gitignore`. Сцены вынесены в отдельные файлы (самые объёмные,
читаются точечно), в `report.json` остаются только их тики.

---

## Отклонения и находки

1. **Синглтоны мета-модулей — решены, а не обойдены.** План ограничивался
   оговоркой «>1 матча в процессе требует изоляции». Но самопроверка
   детерминизма (инвариант №12, этап 3) прогоняет сценарий дважды подряд,
   поэтому изоляция понадобилась уже здесь. Второй прогон молча не делал ни
   одного тика: `new TimerManager(...)` возвращал экземпляр первого прогона
   со ссылками на его `HostGame` и на выброшенные виртуальные часы.
   Добавлены именованные экспорты `resetTimerManager`/`resetPanel`/
   `resetStat`/`resetVote`/`resetChat` (по одной строке на модуль) и
   агрегатор `devtools/resetHostSingletons.js`. Прод их не зовёт.

2. **`HostGame` получил опцию `playerDataFetch`** (дефолт — глобальный
   `fetch`, поведение не меняется). В headless нет ни мастера, ни
   auth-сервиса, а `PlayerDataSync` ходит по относительному URL, который в
   Node не разрешается. Runner подаёт пустой профиль — это и есть корректное
   состояние прогона, а не заглушка ради тишины.

3. **Фикстура `miniGame` доведена до рабочего клиентского контура.**
   `fakeClientCore` был чистой заглушкой (`sample()` → 0): контур на нём не
   замыкался. Теперь он разбирает JSON-кадры фикстурного хост-ядра и
   собирает **настоящую** раскладку hot-буфера (флаги, две группы, ширина
   записи = 2 + поля схемы) — ту, которую читает движковый `reconstructHot`.
   `fakeCore.pack_body` теперь кладёт все четыре поля схемы (были только
   x/y).

4. **Найден баг фикстуры того самого класса, ради которого всё делается:**
   ключа снапшот-схемы `a1` не было в `parts.gameSets` вовсе (там лежал
   только `setId` карты `m1`). В браузере это дало бы ровно «чёрный холст».
   Добавлен `a1` — и это первое живое подтверждение, что инвариант №7 этапа
   3 ловит реальную ошибку.

5. **`hot_values()` вместо `hot_ptr()`** в Node: zero-copy через память
   WASM здесь не нужен, а копия не детачится при росте памяти ядра.

6. **`VirtualClient.snapshot()` копирует сцену** (`structuredClone`).
   Первая версия отдавала ссылку на живой объект — все срезы `scene-<tick>`
   выходили одинаковыми. Поймано тестом «игрок сместился вперёд».

## Инфраструктура ✅ выполнен

- `vitest.config.js` — проект `engine-node` включает `tests/devtools/**`.
- `eslint.config.js` — `src/devtools/**` и `bin/**` получили Node+browser
  глобалы (изоморфный код); стенд-ины ядра освобождены от `camelcase`.
- `packages/engine/package.json` — `bin.vimp-sim`, `files`/`exports`
  расширены на `src/devtools`, `bin`, `tests/fixtures` (фикстура — дефолтный
  fallback runner'а, значит часть поставки).

## Тесты ✅ выполнен

- `tests/devtools/VirtualClock.test.js` (9)
- `tests/devtools/ScenarioRunner.test.js` (13) — включая побайтовое
  совпадение двух прогонов и внятные ошибки на кривой сценарий
- `tests/devtools/VirtualClient.test.js` (10)
- `tests/devtools/report.test.js` (2)
- `tests/lib/reconstructHot.test.js` (4)
- `tests/lib/createHostRuntime.test.js` (7)

## Проверка ✅ выполнен

- `npx eslint .` — зелёный.
- `npm test` — 92 файла, 904 теста, зелёные.
- `npm run sim` — контур замкнут на фикстуре: 30 кадров, `entities: a1×1`,
  камера следует за поехавшим актором.
- Сценарий на двух участниках с чатом — оба клиента видят по два актора,
  камеры разъезжаются по своим позициям.

Документация (`docs/en|ru`, `docs/ai/`) — этап 7 по плану; в этом изменении
обновлён только `CLAUDE.md` (появились npm-скрипты).
