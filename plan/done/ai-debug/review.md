# Кодревью направления F (среда отладки плагинов)

Ревью коммитов `9831c53` (движок `vimp`) и `b8f6b68`/`76213b2` (`vimp-tanks`),
2026-08-05. Разбор по критериям: читаемость, работоспособность,
тестируемость, поддерживаемость, безопасность, производительность,
масштабируемость, DRY, документированность, стандартизация.

## Что проверено фактически

| Проверка | Результат |
| --- | --- |
| `npx eslint .` | чисто |
| `npm test` | 100 файлов, 996 тестов — зелёные |
| `npm run core:test` | 67 cargo-тестов — зелёные |
| `npm run sim:check` (фикстура) | 9 pass / 0 fail / 3 skip |
| `vimp-sim --game <чекаут vimp-tanks>` (movement) | 10 pass / 0 fail / 2 skip |
| `… --determinism` (movement) | 11 pass / 0 fail / 1 skip — инвариант 12 зелёный на настоящем WASM |
| `… round.json` (1800 тиков) | 10 pass / 0 fail, **0,31 с** wall-time |
| `vimp-sim --game node_modules/@vimp-games/tanks` | **падает** (см. находку 1) |

## Что сделано хорошо

- **Инварианты плана соблюдены и проверяемы.** Прод-путь действительно не
  изменился: `clock` делегирует в глобалы, секции `divergence` в боевом
  конфиге нет (`Option` в Rust), рекордер в проде не создаётся,
  `ENGINE_API_VERSION` не тронут. Runner не дублирует инициализацию —
  `lib/createHostRuntime.js` вызывают и Worker, и `ScenarioRunner`.
- **Тестируемость выше средней по репозиторию.** На каждый инвариант — свой
  точечный разлом (31 тест), плюс «проверка самой проверки» на живом
  сценарии (инвариант 9 с нулевым порогом), плюс `replayRecording.test.js`,
  замыкающий браузерную и headless-половины.
- **Производительность.** 1800 тиков реальной игры с WASM-ядром и настоящим
  клиентским ядром — треть секунды; цикл «правка → вердикт» действительно
  интерактивный.
- **Курированный дамп детерминирован по построению** (сортировка тел,
  коллайдеров, ячеек сетки) — дампы сравнимы дифом, что и было целью.
- **Безопасность браузерной половины продумана**: маршрут `/debug/report`
  поднимается только вне прода, вид выгрузки — закрытый список, имя файла
  собирается из префикса+метки времени+счётчика (не из тела запроса), лимит
  8 МБ, `window.__vimpDebug` живёт только в dev-сборке, а `room.isDevMode`
  выставляет сама вкладка хоста, а не удалённая сторона.
- **Документация совпадает с кодом.** Формат сценария в
  `docs/en/debugging.md` сверен с `parseScenario` пополе — включая дефолты
  `ticks: 600`, `dumpTicks`, `room`, семантику `divergence: null`.

---

## 🔴 1. Опубликованный `@vimp-games/tanks` объявляет `entries.wasmNode`, но не содержит его

**Симптом (воспроизведено):**

```
$ node packages/engine/bin/vimp-sim.js --game node_modules/@vimp-games/tanks --no-write
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '…/node_modules/@vimp-games/tanks/core/pkg-node/vimp_tanks_core.js'
  imported from …/node_modules/@vimp-games/tanks/dist/host-k5DE8h6h.js
```

**Причина.** В манифесте опубликованного пакета `entries.wasmNode`
присутствует (на машине сборки `core/pkg-node/` существовал, `existsSync` в
`build-game-manifest.js` вернул `true`), но самого каталога в тарболе нет:

```
$ ls node_modules/@vimp-games/tanks   # README.md dist package.json
$ cd vimp-tanks && npm pack --dry-run # 33 файла, ни одного pkg-node
```

`package.json:files` содержит `core/pkg-node`, однако `.gitignore` содержит
`core/pkg-node/`, и npm применяет ignore-правила внутри каталогов,
добавленных через `files` (для `dist` это не сработало, для вложенного пути
— сработало). То есть заявленная в этапе 8 цель «раннер работает и из
установленной копии» не достигнута, и это не видно ни из одного теста:
CI гоняет сценарии из чекаута (`--game <root>`), где `core/pkg-node/` лежит
на диске.

**Почему это 🔴.** Это ровно тот сценарий, ради которого всё направление и
делалось: нейросеть ставит пакет игры и гоняет `vimp-sim`. Отказ приходит
сырым стектрейсом резолвера модулей — «silence is the failure mode»,
переписанный в «stack trace is the failure mode».

**Решение — две независимые части.**

*(a) `vimp-tanks` — сделать так, чтобы файл физически ехал.* Надёжнее всего
не бороться с ignore-правилами, а положить node-глюe внутрь уже
публикуемого `dist/`:

```js
// scripts/build-game-manifest.js
const NODE_CORE_SRC = path.resolve(root, 'core/pkg-node');
const NODE_CORE_DIST = path.resolve(distPath, 'core-node');
const hasNodeCore = fs.existsSync(NODE_CORE_SRC);

if (hasNodeCore) {
  fs.cpSync(NODE_CORE_SRC, NODE_CORE_DIST, { recursive: true });
}
// entries: { …, ...(hasNodeCore ? { wasmNode: './core-node/vimp_tanks_core.js' } : {}) }
```

Путь остаётся относительным манифесту (движок его так и резолвит), а
`files: ["dist"]` покрывает его без исключений в `.gitignore`. Альтернативы
— негативное правило `!core/pkg-node/**` в `.gitignore` либо отдельный
`.npmignore`; обе работают, но обе — про то, чтобы «не забыть».

*Обязательно к любому из вариантов* — страховка в CI/`prepack`, иначе
регрессия вернётся молча:

```json
"prepack": "node -e \"const {execSync}=require('child_process');const f=JSON.parse(execSync('npm pack --dry-run --json'))[0].files;if(!f.some(x=>/wasm_?tanks_core\\.js$/.test(x.path)&&x.path.includes('core')))throw new Error('node core is missing from the tarball')\""
```

*(b) Движок — превратить отказ в именованное нарушение контракта.*
`pluginLoader.loadGameForSim` проверяет только наличие поля, но не файла:

```js
// packages/engine/src/devtools/pluginLoader.js
const corePath = path.resolve(baseDir, nodeCore);

try {
  await access(corePath);
} catch {
  throw new Error(
    `${manifestPath}: entries.wasmNode points at '${nodeCore}', but ` +
      `${corePath} does not exist — the game package was published without ` +
      `its node core (npm run core:build:node) or pass --core <path>`,
  );
}
```

Тест: манифест с `wasmNode` на несуществующий путь → внятная ошибка
(в `tests/devtools/pluginLoader.test.js` уже есть соседний кейс «без
node-сборки ядра говорит об этом, а не гадает»).

---

## 🟠 2. `VirtualClient` игнорирует порт CLEAR: ни `core.reset()`, ни очистки сцены

**Что не так.** В браузере `socketMethods[PS_CLEAR]` (`client/main.js:585`)
снимает сущности с холста **и** вызывает `clientCore?.reset()` (сброс буфера
интерполяции и предиктора) и `soundManager.reset()`. Хост шлёт `sendClear`
на **каждом** рестарте раунда (`RoundManager.js:252`, со списком setId) и на
смене карты (`RoundManager.js:144`, без списка). В headless этого порта нет
ни в `RECORDED_PORTS`, ни в `routeFrame` — кадр просто выбрасывается.

**Последствия.**

- После первого же завершения раунда клиентское ядро headless-прогона живёт
  в состоянии, которого в игре не бывает: буфер и предиктор не сброшены.
  Инвариант 9 (дрейф предикта) считает расхождения через границу раунда,
  где браузер начинает с чистого предиктора — то есть на длинных сценариях
  он измеряет не то, что в браузере.
- Сцена (`this.scene`) накапливает сущности, которые в браузере уже сняты с
  холста, — а сцена и есть материал для дампов `scene-*.json` и половина
  материала инвариантов. Заявленная в «Итоговой проверке» плана связка
  «длинный сценарий со сменой карты и голосованием» страдает сильнее всего.
- Это прямо противоречит принципу, записанному в самом `VirtualClient`:
  «Порты, которые в браузере доходят до ядра, доводятся и здесь — иначе
  headless гоняет ядро в режиме, которого в игре не бывает».

**Решение.** В `ScenarioRunner.routeFrame` — до разбора `RECORDED_PORTS`:

```js
if (frame.method === 'sendClear') {
  client.clear(frame.args[0]); // setIdList | undefined
  return;
}
```

В `VirtualClient`:

```js
/**
 * CLEAR: зеркало client/main.js — снятие сущностей с «холста» и сброс ядра
 * (буфер интерполяции + предикт). Без него headless живёт через границу
 * раунда в состоянии, которого в браузере не бывает.
 * @param {Array} [setIdList] - Ключи схемы к снятию; без него — всё.
 */
clear(setIdList) {
  if (Array.isArray(setIdList)) {
    for (const setId of setIdList) {
      delete this.scene[setId];
    }
  } else {
    this.scene = {};
    this.camera = null;
  }

  this.core.reset?.();
}
```

Тест: сценарий с завершением раунда — после рестарта в сцене нет сущностей
предыдущего раунда, а `debug()` показывает пустой буфер интерполятора.
Заодно стоит проверить, не «позеленел» ли после этого инвариант 9 на
`round.json` (сейчас детектор там выключен `divergence: null` — возможно,
именно из-за этого расхождения).

---

## 🟠 3. `RecordingSocketManager` дублирует боевой `SocketManager` вместо того, чтобы им быть

**Что не так.** Файл держит ручной список из 22 имён отправителей и ручную
развёртку трёх составных (`sendFirstShot`/`sendPlayerDefaultShot`/
`sendSpectatorDefaultShot`) с комментарием «развёртка обязана повторять
host/meta/SocketManager.js». В этапе 8 по этой причине уже был инцидент
(клиент не получал ни `keySet`, ни панель, предикт не включался). Копия
по-прежнему неполна:

- `sendFirstShot` записывает `args: []`, тогда как боевой шлёт
  `[getPlayersData(), camera, serverTime, seq]` — первый снапшот мира. В
  браузере он применяется как сцена (`applyShot`), в headless теряется:
  сущность, доехавшая только первым кадром, не попадёт ни в сцену, ни в
  `client.observed`, и инвариант 2 честно объявит «сущность не спавнится»;
- `injectServices` сохраняет `this._game`, который нигде не используется —
  мёртвое поле, оставшееся ровно от этой недоразвёртки.

**Решение (структурное, рекомендуемое).** Боевой `SocketManager` уже
спроектирован под подмену транспорта: `addUser(socketId, socket)` берёт у
сокета три метода (`send`, `sendBinary`, `close`), а вся остальная логика —
порты, составные отправители, формат — внутри. Значит, записывающий
транспорт не должен переопределять отправителей вообще:

```js
class RecordingSocketManager extends SocketManager {
  addUser(socketId) {
    super.addUser(socketId, {
      send: (port, data, reliable) =>
        this._record({ socketId, port, data, reliable }),
      sendBinary: (buffer, reliable) =>
        this._record({ socketId, port: this._PORT_SHOT_DATA, data: buffer, reliable }),
      close: (code, key, arr) =>
        this._record({ socketId, port: null, data: { code, key, arr } }),
    });
  }
}
```

Runner тогда маршрутизирует по **номеру порта** — ровно как порт-машина
`client/main.js`, — и расхождение «headless видит не то, что браузер»
становится структурно невозможным. Это же снимает половину находки 2
(CLEAR приедет сам) и делает `SENDER_METHODS` ненужным.

Правка затрагивает `tests/host/fixtureHarness.js` (он переехал на этот
класс), поэтому если бюджета на рефакторинг сейчас нет — **минимум**:
прокинуть нагрузку первого кадра и применить её в `VirtualClient`
(`_applyGameData(getPlayersData())`), либо убрать неиспользуемый `_game`,
чтобы код не обещал больше, чем делает.

---

## 🟠 4. `report.json` тащит base64 всего потока кадров даже без `--determinism`

**Измерено:** на фикстуре (120 тиков) `shotBytes` — 6,7 КБ из 12,1 КБ
файла; на `round.json` танков (1800 тиков) `report.json` — 83 КБ. Рост
линейный по длине матча: записанный в браузере десятиминутный матч
(~72 000 тиков) даст многомегабайтный `report.json` — файл, который по
замыслу «читает нейросеть». Всё это ещё и держится в памяти процесса
целиком (`socketManager.frames` + массив base64).

**Причина.** `shotBytes` нужен ровно одному потребителю — инварианту 12
(`checkDeterminism`), который включается флагом. Сейчас он собирается всегда
и попадает в `report.json` (в отличие от `scenes`, которые из него
аккуратно вынесены).

**Решение.**

1. Собирать по флагу: `runScenario(scenario, { plugin, captureFrames })`,
   CLI выставляет его только при `--determinism`.
2. Хранить не сами байты, а **хеш на кадр** (например, FNV-1a по буферу) —
   для сравнения потоков этого достаточно, включая «frame #N differs»,
   а объём падает на порядок:
   ```js
   shotHashes: socketManager.framesOf('sendShot').map(f => hash32(toBytes(f.args[0]))),
   ```
3. В `writeReport` исключать поле из `report.json` так же, как `scenes`.

---

## 🟡 5. Отладочные промисы `HostController` не имеют таймаута

`_debug(action)` резолвится только ответом Worker'а; отклоняется лишь на
`destroy()` и на паузе эстафеты. Если Worker завис — а именно на зависшем
Worker'е отладка и нужна — `await window.__vimpDebug.dump()` в консоли висит
вечно и молча. Это тот же класс отказа, против которого написан весь этап.

```js
_debug(action, timeoutMs = 5000) {
  …
  return new Promise((resolve, reject) => {
    const timer = clock.setTimeout(() => {
      this._debugRequests.delete(requestId);
      reject(new Error(`debug request '${action}' timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    this._debugRequests.set(requestId, {
      resolve: value => { clock.clearTimeout(timer); resolve(value); },
      reject: error => { clock.clearTimeout(timer); reject(error); },
    });
    this._worker.postMessage({ type: 'debug', action, requestId });
  });
}
```

---

## 🟡 6. `pluginLoader` не сверяет `plugin.engineApi` с манифестом

`lib/gamePlugin.js:loadClientPlugin` делает **две** проверки: манифест
против движка и плагин против манифеста. Headless-загрузчик делает только
первую (`assertEngineApiCompatible`). Реальный сценарий: манифест пересобрали,
`dist/host-*.js` — нет; прогон идёт на старом плагине, и зелёный вердикт
лжёт. Решение — повторить проверку для обоих импортированных плагинов:

```js
for (const [half, plugin] of [['host', hostPlugin], ['client', clientPlugin]]) {
  if (plugin.engineApi !== manifest.engineApi) {
    throw new Error(
      `game "${manifest.id}": ${half} plugin engineApi v${plugin.engineApi} ` +
        `does not match manifest engineApi v${manifest.engineApi} — stale dist/`,
    );
  }
}
```

---

## 🟡 7. Уровень 0 детектора рассинхрона молча предполагает `state[0..1] == x, y`

`ClientState::observe_divergence` при отсутствии `predicted_state` сравнивает
`render_overlay().camera` с `player.state[0]`/`[1]`. Раскладка player-блока —
**игровая**, движок знает только её длину (`PLAYER_STATE_LEN`). Для игры, у
которой блок начинается не с мировых координат, инвариант 9 выдаст ложные
нарушения, и причина будет неочевидной (сообщение адресует компоненты
индексами: `#0 Δ…`).

Решение — не код, а контракт: зафиксировать требование в
`docs/ai/13-debugging.md` и `docs/en|ru/plugin-api.md` («уровень 0 считает,
что `state[0], state[1]` — это x/y в мировых координатах; если это не так,
реализуйте `predicted_state()` — иначе инвариант 9 будет врать»), и в
записях уровня 0 называть компоненты `x`/`y` вместо индексов.

## 🟡 8. `DivergenceConfig.capacity == 0` даёт бессмысленный `dropped`

`if self.records.len() >= self.cfg.capacity` при `capacity: 0` инкрементит
`dropped` на каждой записи, хотя одна запись всё равно остаётся в буфере.
Отчёт получает «вытеснено N» при N-1 реальных вытеснениях. Лечится строкой в
`DivergenceTracker::new`: `capacity: cfg.capacity.max(1)` (или явной
валидацией конфига с понятным сообщением).

## 🟡 9. `mergeConfig` молча роутит переопределение в таймеры

```js
if (key in game.timers) { game.timers[key] = value; }
```

Сценарий, который хотел переопределить одноимённый ключ верхнего уровня
конфига, получит правку таймера и не узнает об этом; плюс слияние
однослойное (`config: { parts: { models: … } }` затрёт остальное в `parts`).
Явное лучше неявного:

```js
const { timers = {}, ...rest } = overrides;

Object.assign(game.timers, timers);

for (const [key, value] of Object.entries(rest)) { … }
```

и одна строка в `docs/en|ru/debugging.md`: таймеры — только через
`config.timers`.

## 🟡 10. Записанный в браузере матч воспроизводится как **новый** матч

Рекордер стартует с `tick = 0` и пишет только вход/ввод; состояние мира на
момент старта записи (позиции, фаза раунда, счёт, ротация карт) не
сохраняется, а реплей крутится фиксированным `timeStep`, тогда как живой
матч шёл с плавающим `dt`. Значит «баг, пойманный в браузере, догоняется
`sim:replay`» верно только для багов, воспроизводимых **с начала матча**.

Это ограничение, а не дефект, но сейчас его нет в доках — а именно на него
и напорется первый же пользователь, начавший запись на пятой минуте.
Минимум — абзац в `docs/en|ru/debugging.md` и `docs/ai/13-debugging.md`.
Развитие (отдельной задачей): в движке уже есть `serialize_state()` для
эстафеты Worker'ов — сохранение снимка в `meta` записи и поле сценария
`initialState` закрыли бы это по-настоящему.

## 🟢 Мелочи

- `AbstractTimer._stopTimer`: `const handler = isInterval ? clock.clearInterval : clock.clearTimeout`
  отрывает метод от объекта; работает только потому, что `clock` экспортирует
  замыкания. Безопаснее `id => clock.clearInterval(id)`.
- `ScenarioRunner.execute`: `let host = null` объявлен **после** замыкания
  `onFrame`, которое его читает, а комментарий про ping/pong стоит над
  объявлением вместо обработчика. TDZ сейчас недостижим, но объявление стоит
  поднять выше конструктора `RecordingSocketManager`.
- `case 'leave'` не освобождает клиентское ядро (`core.free?.()`), а
  `socketManager.frames` растёт весь прогон — для многочасовых реплеев это
  память процесса.
- `packages/engine/package.json:files` теперь публикует `tests/fixtures`
  (нужно для фолбэка на `miniGame`). Решение сознательное, но не записано
  нигде, кроме этого плана — стоит строкой в `docs/en|ru/plugin-api.md` или
  `deployment.md`, иначе следующая чистка `files` тихо сломает `npm run sim`
  без `--game`.
- `pluginLoader.js:46-47` — единственные строки нового кода шире 80 колонок.
- `isNodeCore = wasmUrl => wasmUrl.endsWith('.js')` (`vimp-tanks/src/nodeCore.js`)
  ломается на URL с query-строкой (`?v=1`); для нынешнего вызова безопасно,
  но стоит проверить `pathname`.

---

## Порядок устранения

1. Находка 1 (🔴) — блокирует основной пользовательский сценарий.
2. Находки 2 и 3 (🟠) — вместе; правка 3 в структурном варианте закрывает 2.
3. Находка 4 (🟠) — до того, как кто-то запишет длинный матч из браузера.
4. Находки 5–10 (🟡) и мелочи — по мере правок в соответствующих файлах.
