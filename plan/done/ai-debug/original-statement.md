# План: среда отладки игровых плагинов VIMP для нейросети

## Контекст

`docs/ai/` позволяет LLM сгенерировать игровой плагин целиком, но не даёт
способа его отладить. Архитектура (Web Worker + WASM-ядро + предикция +
WebRTC) прячет состояние в бинарных потоках и браузерных вкладках — LLM их
не видит.

Ключевое наблюдение: `docs/ai/10-pitfalls.md` сам ставит диагноз — «**Silence
is the failure mode**», и завершается строкой «No debug mode». После
генерации плагина отказы распределены так:

| Тир | Симптом | Частота |
| --- | --- | --- |
| 1 | Игра не в лобби / чёрный холст: `engineApi`, порядок полей схемы, `entitiesOnCanvas`, part не создан | доминирует |
| 2 | Загрузилось, но врёт: позиции/углы перепутаны, панель не обновляется, раунд не кончается | часто |
| 3 | Физика/предикция: танк в стене, дрейф предикта | редко, но дорого |

Существующие предложения нацелены на тир 3, а время уходит на тир 1–2.
Поэтому центр плана — **headless-контур, замыкающий
host → бинарный кадр → ClientCore → hot-буфер → сцена в JSON** в одном
Node-процессе, плюс **автоматические проверки инвариантов**, превращающие
молчаливый сбой в именованное нарушение контракта. Остальные четыре
предложения насаживаются на него: детектор рассинхрона становится точным и
бесплатным (обе стороны в одном процессе), реплей — записанным сценарием для
того же runner'а, сборщик контекста — его отчётом.

**Результат:** `npm run sim -- --scenario X.json` даёт LLM автономный цикл
«правка → запуск → проверка по тексту» без браузера и без человека.

### Инварианты плана

1. **Ноль новых обязательных требований к плагину.** Всё приезжает через
   ABI-макросы движка (`export_game_core_abi!`/`export_client_core_abi!` в
   `packages/engine/core/src/abi.rs`) — сгенерированный плагин получает
   методы даром — и через trait-методы с дефолтом. `ENGINE_API_VERSION` не
   бампается.
2. **Прод не меняет поведение.** Все инъекции — с дефолтами на текущие
   `Date.now`/`Math.random`/`setTimeout`.
3. **Runner переиспользует боевую инициализацию**, а не дублирует её —
   иначе разъедется с `host.worker.js`.

### Шаг 0

Разложить план по конвенции репозитория: `plan/done/ai-debug/README.md` (индекс со
статусами) + `plan/done/ai-debug/stage_N.md` по этапам ниже.

---

## Этап 1 — Детерминированное время и случайность

Фундамент: без управляемого времени 10-минутный матч не прогнать за секунды.

**`packages/engine/src/lib/clock.js`** (новый, идиома существующего
`lib/config.js` — синглтон с `install()`): `now()`, `random()`,
`setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`. Дефолты —
текущие глобалы. Виртуальная реализация `VirtualClock` (в devtools этапа 2)
ведёт очередь отложенных задач и метод `advance(ms)`.

**`packages/engine/src/lib/AbstractTimer.js`** — единственная точка, через
которую идут **все** таймеры хоста (`_startTimer` строки 22–40). Берёт
таймер-функции из `clock`. Одна правка покрывает `TimerManager`,
голосования, idle-check, RTT-пинги и сам игровой цикл.

**Замена call-site** (сигнатуры не меняются):

| Файл | Что |
| --- | --- |
| `host/HostGame.js:316,401,743,769,794` | `Date.now()` → `clock.now()` |
| `host/meta/modules/TimerManager.js:69,82,98,109,116,123,149` | `Date.now()`/`performance.now()` → `clock.now()` |
| `host/meta/modules/RTTManager.js:99,144` | `Date.now()` |
| `host/meta/modules/SocketManager.js:281` | `Date.now()` (serverTime) |
| `host/meta/player/HumanParticipant.js:27` | `Date.now()` |
| `host/meta/modules/Vote.js:174` | `Math.random()` → `clock.random()` — розыгрыш ничьей влияет на ротацию карт, то есть виден в реплее |
| `host/host.worker.js:139` | `Math.random()` для seed → `clock.random()`, seed принимается из `room.seed`, если задан |

**Проброс seed наружу:** `postMessage({type:'ready', mapName, seed})` — сейчас
seed не сохраняется нигде и теряется (`host.worker.js:139`).

Тесты: `tests/lib/clock.test.js`; прогон существующих host-тестов на
`VirtualClock` вместо `vi.useFakeTimers()`.

---

## Этап 2 — Headless-runner и формат сценария

**`packages/engine/src/lib/createHostRuntime.js`** (новый) — чистая часть
`host.worker.js:onInit` (строки 132–165): загрузка HostPlugin,
`assertGameConfigShape`, `applyRoomOverrides`, `buildCoreConfig`,
`createCore`, `buildClientConfig`, `new HostGame`. Вызывается и Worker'ом, и
runner'ом — общий код вместо копии.

**`packages/engine/src/lib/reconstructHot.js`** — вынести из
`client/main.js:642-670` (чистая функция, зависит только от
`snapshotKeysById`). Импортируется и браузерным клиентом, и runner'ом.

**`packages/engine/src/devtools/`** (новое):
- `RecordingSocketManager.js` — обобщение `tests/host/fixtureHarness.js:43`
  (`FakeSocketManager`); тесты переезжают на него, копия в `tests/` удаляется.
- `VirtualClient.js` — на каждого подключённого игрока настоящий `ClientCore`
  (`buildClientCoreConfig` + node-ядро), кормится реальными байтами из
  `sendShot` → `push_frame` → `sample` → `reconstructHot` → сцена в JSON.
- `VirtualClock.js`, `ScenarioRunner.js`, `report.js`.
- `pluginLoader.js` — поиск node-ядра: новое **опциональное** поле манифеста
  `entries.wasmNode` → флаг `--core <path>` → фикстура `miniGame`.
  Конвенция `core/pkg-node/` уже прописана в `docs/ai/02-packaging.md`, не
  хватало только пути в манифесте.

**CLI** `packages/engine/bin/vimp-sim.js`, скрипты `sim`, `sim:replay`,
`sim:check`.

**Формат сценария** — один файл для трёх ролей: скриптованный прогон,
записанный реплей, эталон регрессии.

```json
{ "version": 1, "seed": 3812, "game": "tanks", "map": "pool mini",
  "config": { "networkSendRate": 1 },
  "participants": [{ "id": "p1", "name": "P1", "model": "m1", "kind": "human" }],
  "timeline": [
    { "tick": 0,   "op": "join", "who": "p1", "team": "team1" },
    { "tick": 12,  "op": "key",  "who": "p1", "action": "down", "name": "forward" },
    { "tick": 300, "op": "chat", "who": "p1", "text": "/nr" }
  ],
  "ticks": 1200, "dt": 0.008333 }
```

Важно: ввод применяется синхронно при приходе сообщения
(`HostGame.updateKeys:734`), очереди нет — поэтому сценарий пишет **номер
тика**, на границе которого ввод приземлился, а не только порядок.

Выход: `.debug/run-<ts>/{report.json, report.md, scene-<tick>.json}`.

Оговорка: мета-модули — синглтоны (`TimerManager`, `Panel`, `Stat`, `Vote`,
`Chat`), поэтому >1 матча в процессе требует изоляции модулей, как в
`fixtureHarness`.

---

## Этап 3 — Проверки инвариантов

Самая ценная часть: превращает молчаливый отказ в строку текста. Runner
выполняет после прогона и печатает нарушения с именем контракта.

1. Ни одного `NaN`/`Infinity` в декодированных полях и hot-буфере.
2. Каждый ключ из `gameConfig.snapshot` дал ≥1 строку (или явно объявлен
   неиспользуемым) — ловит «сущность не спавнится»/несовпадение id ключа.
3. Число декодированных полей на ключ == числу полей схемы — ловит
   позиционную привязку `interpolator.rs` к индексу поля.
4. Байт версии кадра == `SNAPSHOT_FORMAT_VERSION`; `decode_frame` не падает.
5. Обход `reconstructHot` потребляет ровно `len` float'ов — ловит дрейф
   раскладки hot-буфера.
6. Каждое объявленное поле `panel` получило хотя бы один `panelSet`; все
   ключи панели есть в клиентском конфиге.
7. `entitiesOnCanvas`/`gameSets` покрывают каждый ключ снапшота, реально
   встретившийся в кадре — класс «чёрный холст».
8. `playerKeys` хоста ↔ keyset клиента; каждое имя клавиши из сценария принято.
9. Дрейф предикции ниже порога (этап 5).
10. Жизненный цикл раунда: раунд закончился, победитель назначен, респауны
    прошли, участники не утекли.
11. Нет утечки акторов: `players_data()` == активные в `ParticipantManager`.
12. Самопроверка детерминизма: два прогона сценария в одном процессе дают
    побайтово одинаковый поток кадров.

---

## Этап 4 — `debug_json()` в ядре

`EngineSim::serialize_state()` (`core/src/game.rs:343`) уже дампит мир, но в
сыром serde-формате rapier — нечитаемо. Нужен **курированный** дамп рядом,
через тот же `serde_json` (зависимость уже есть, новых не нужно):

- тела: `{ tag, gameId?, translation, rotation, linvel, angvel, mass, bodyType, ccd }`
- коллайдеры: `{ shape, halfExtents|radius, isSensor, collisionGroups (hex), solverGroups, parent }`
- статика карты, счётчики ячеек spatial-сетки, число узлов nav, состояние
  `rng`, аккумулятор фикс-шага.

Зеркало на клиенте (`ClientState::debug_json`): глубина буфера
интерполятора, окно `seq`, `offset`, `seq`/`serverTime` последнего кадра.

Экспорт — через `abi.rs` (`export_game_core_abi!` строка 17,
`export_client_core_abi!` строка 265), значит каждый плагин получает метод
даром. Прокидывается в `GameCoreAdapter.js` и в отчёт runner'а.

---

## Этап 5 — Детектор рассинхрона предикта

Два уровня, чтобы не требовать ничего от плагина в базовом случае.

**Уровень 0 (без правок плагина):** сравнивать авторитетный player-блок
`[f32;8]` из кадра с `render_overlay().camera` (`core/src/client/game.rs:24`)
— для предсказывающего плагина это предсказанная позиция. Даёт дрейф по x/y.

**Уровень 1 (один опциональный trait-метод):**
`GameClientDef::predicted_state(&self) -> Option<[f32; PLAYER_STATE_LEN]>` с
дефолтом `None`. Движок в `ClientState` снимает его **непосредственно перед**
`on_server_state` (`core/src/client/game.rs:42`) — то есть до затирания
состояния авторитетным — и сравнивает покомпонентно с порогами из конфига.
Записи кладутся в кольцевой буфер, вычерпываются новым методом
`take_divergence()` из `export_client_core_abi!`.

Формат отчёта — как предложено, плюс `serverTime`, `offset` и окно истории
вводов, которое переигрывалось: именно они позволяют локализовать формулу.
Существенно: предиктор реконсилится **по времени**, а не по `seq`
(`vimp-tanks/core/src/client/predictor.rs:274`) — отчёт должен это отражать,
иначе сравнение «по тому же seq» вводит в заблуждение.

Прогоняется в runner'е (основное) и в браузере (этап 6).

---

## Этап 6 — Браузерная половина

Записывает то, что headless не воспроизводит: реальный WebRTC, PixiJS,
живой ввод человека.

- **Рекордер в хосте**: под уже существующим флагом `gameConfig.isDevMode`
  (`config/hostDefaults.js:6`) `HostGame` пишет seed + joins + каждый
  `updateKeys`/`pushMessage`/`parseVote` с номером тика и
  последовательностью `dt` — ровно формат сценария этапа 2.
- **Выгрузка**: Worker → главный поток → `POST /debug/report` на мастере,
  маршрут только в dev (гвард `isProduction`, `master/main.js:34`) → пишет в
  `.debug/`. Добавить `.debug/` в `.gitignore`.
- **`window.__vimpDebug`**: `dump()`, `startRecording()`, `stopRecording()`,
  `divergence()`. Читается через Chrome MCP (`javascript_tool`,
  `read_console_messages`) без участия человека.
- **Структурированный `console.log`** с префиксом `[vimp:debug]`.
- Порт 12 `CONSOLE` (зарезервирован и не используется:
  `config/wsports.js`, обработчик — `client/main.js:605`,
  `_PORT_CONSOLE` — `SocketManager.js:35`) оживляется для проброса хостовых
  логов клиенту — добавить `sendConsole`.

---

## Этап 7 — Документация

Правило репозитория: функциональная правка обновляет `docs/en/` и `docs/ru/`
в том же изменении.

- **`docs/en/debugging.md` + `docs/ru/debugging.md`** (новые) — CLI, формат
  сценария, инварианты, `debug_json`, детектор рассинхрона, рекордер.
  Ссылки из обоих `README.md`.
- **`docs/ai/13-debugging.md`** (новый) + строки в `README.md` (карта файлов)
  и `12-questionnaire.md` (блок 14).
- **`docs/ai/10-pitfalls.md:210`** — строку «No debug mode» заменить.
- **`docs/ai/11-authoring-workflow.md`** — перед ручным 14-пунктовым
  смоуком в две вкладки (шаг 9) вставить **автоматический** шаг: «прогнать
  `npm run sim`, устранить все нарушения инвариантов, и только потом
  открывать браузер». Это главная правка для практической ценности.
- **`docs/ai/02-packaging.md`** — `entries.wasmNode` в манифесте.
- **`docs/en|ru/plugin-api.md`** — `entries.wasmNode`, `predicted_state`,
  `debug_json`, `take_divergence`; **`network.md`** — порт 12;
  **`master.md`** — `/debug/report`; **`host.md`**/**`client.md`**/**`core.md`**
  — новые модули; **`configuration.md`** — `clock`, флаги отладки.
- **`CLAUDE.md`** — новые npm-скрипты.

---

## Этап 8 — Парные правки в `vimp-tanks` (отдельная задача)

Движок не блокируется: фикстура `miniGame` даёт рабочий контур сразу.

1. `entries.wasmNode` в `scripts/build-game-manifest.js` (`core/pkg-node/`
   уже собирается скриптом `core:build:node`).
2. `impl GameClientDef::predicted_state` в
   `core/src/client/predictor.rs` — возврат текущего `TankState` как
   `[f32;8]` (порядок уже совпадает, `TankState::from_array:48`).
3. Смоук-сценарии в `tests/scenarios/` + прогон в CI.
4. Обновить `docs/en|ru/` игры.

---

## Порядок и польза по этапам

| Этапы | Что даёт |
| --- | --- |
| 1–3 | Автономный цикл LLM: правка → `npm run sim` → текстовый вердикт. Ядро ценности. |
| 4 | Дамп мира для багов физики («танк в стене»). |
| 5 | Точный отчёт по дрейфу предикта. |
| 6 | Захват багов из реального браузера в тот же формат сценария. |
| 7–8 | Закрепление в контракте и на референсной игре. |

---

## Проверка

- `npx eslint .` и `npm test` — зелёные (правило репозитория).
- `npm run core:test` — обязательно после правок ядра (этапы 4–5).
- Новые тесты: `tests/lib/clock.test.js`,
  `tests/devtools/{ScenarioRunner,invariants,VirtualClient}.test.js`,
  `tests/master/debugReport.test.js`; cargo-тесты на `debug_json` и
  `take_divergence`.
- `npm run sim` на фикстуре `miniGame` — все инварианты зелёные; затем
  намеренно сломать порядок полей в схеме фикстуры и убедиться, что
  инвариант №3 это ловит (проверка самой проверки).
- `npm run sim -- --core <путь к vimp-tanks/core/pkg-node>` на реальном ядре.
- Самопроверка детерминизма (инвариант №12) на длинном сценарии со сменой
  карты и голосованием — доказывает, что этап 1 закрыл источники недетерминизма.
- Браузер (этап 6): `npm run dev`, две вкладки, записать реплей, прогнать
  записанный файл через `npm run sim:replay`, сверить финальное состояние.
