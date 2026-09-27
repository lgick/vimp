# Пропадание картинки и зависание игры: NaN в камере из отцепленного hot-буфера

> План самодостаточен: исполнителю не нужен контекст беседы, в которой он
> составлен. Перед каждым этапом прочитать разделы «Контекст», «Первопричина»,
> «Общие правила исполнения» и сам этап. Все правки — в репозитории движка
> `/Users/dmitry/Sites/my/vimp` (пути ниже — от его корня). Репозиторий игры
> `/Users/dmitry/Sites/my/vimp-tanks` **не трогать**: дефекта в игре нет.

## Контекст

На проде (страницу раздаёт бокс движка: `index-CgH2zC3x.js` движка,
`vendor/pixi/chunks/chunk-HYVYVELD.js`, `client-CUg2hnAe.js` игры tanks 0.22.7)
произошли два сбоя в одной игре.

**Сбой 1.** Пропало изображение. В консоли одна строка:

```
[tanks] levelView: центра камеры нет — кадр без трансформа сцены Object
```

Картинка вернулась только после смены команды.

**Сбой 2.** Через некоторое время игра зависла насовсем. В консоли:

```
Uncaught TypeError: Failed to execute 'setValueAtTime' on 'AudioParam': The provided float value is non-finite.
  at Howl.pos
  at SoundManager._writePos
  at SoundManager._updateSpatialSound
  at SoundManager.updateActiveSounds
  at renderTick          (Hi [as _fn], движок)
  at TickerListener.emit → Ticker.update → Ticker._tick   (Pixi)
```

Журнал клиентских ошибок («Errors») пуст. Причина выяснена и к коду не
относится: не задан GitHub-секрет `CLIENT_REPORTS_TOKEN`, и бокс только пишет
отчёты в свой `docker logs`. В этот план это **не входит**.

## Первопричина (одна на оба сбоя)

Файл `packages/engine/src/client/main.js`, функция `renderTick` (~строки
960–1000). Сейчас она выглядит так:

```js
function renderTick() {
  if (!clientCore) { return; }
  // … pendingAutostart …
  const len = clientCore.sample(performance.now());

  // view пересоздаётся каждый тик: рост памяти WASM детачит buffer
  const hot = new Float32Array(wasm.memory.buffer, clientCore.hot_ptr(), len);
  const flags = hot[0];

  if (flags & HOT_FLAGS.FRAMES) {
    JSON.parse(clientCore.take_frames()).forEach(frame => {   // ← аллокация в WASM
      applyShot(frame.game, frame.camera);                    // ← парты тоже зовут ядро
    });
  }

  if (flags & (HOT_FLAGS.GAME | HOT_FLAGS.PREDICTED)) {
    applyGameData(reconstructHot(hot, snapshotKeysById));     // ← чтение view ПОСЛЕ
  }

  if (flags & HOT_FLAGS.CAMERA) {
    applyCamera(modules.canvasManager, soundManager, [hot[1], hot[2]]);  // ← и здесь
  }

  soundManager.processAudibility();
  soundManager.updateActiveSounds();
}
```

1. `hot` — view над `wasm.memory.buffer` без копирования (zero-copy).
   `take_frames()` собирает строку JSON в куче WASM (`serde_json::to_string` в
   `packages/engine/core/src/client/game.rs`, `take_frames`), а парты при
   разборе кадров сами зовут ядро. Если куче не хватает места, WASM вызывает
   `memory.grow`, и **старый `ArrayBuffer` отцепляется**. У view длина
   становится 0, а `hot[1]`/`hot[2]` читаются как `undefined`. Проверено в
   Node:

   ```js
   const memory = new WebAssembly.Memory({ initial: 1, maximum: 100 });
   const view = new Float32Array(memory.buffer, 0, 4);
   view[1] = 42;
   memory.grow(1);
   view[1];            // undefined
   view[1] - 10;       // NaN
   ```

   Комментарий в коде учитывал отцепление только **между** тиками, а не внутри
   тика. Headless-раннер (`packages/engine/src/devtools/VirtualClient.js`)
   читает буфер копией (`hot_values()`), поэтому сценарии `npm run sim` этого
   не ловят.
2. **Сбой 1.** `applyCamera` → `CanvasManagerModel.updateCoords(undefined,
   undefined)` (`packages/engine/src/client/components/model/CanvasManager.js`):
   - `dx = undefined - _coordX = NaN`;
   - дальше `lerp` навсегда держит `NaN` в `_coordX`, `_avgDx/_avgDy/_avgSpeed`,
     `_camOffsetX/Y` и `_camZoomModifier`;
   - `stage.scale = NaN`, и Pixi ничего не рисует;
   - `cameraCenter` в tanks отдаёт `null`, отсюда предупреждение `levelView`.

   Сбросить накопители может только `cameraReset` (респаун, смена команды) —
   ровно то, что наблюдалось.
3. **Сбой 2.** В том же тике `soundManager.setListenerPosition(undefined,
   undefined)` (`packages/engine/src/client/SoundManager.js`):
   - в `_applyVolume` проверка `Math.hypot(NaN) >= maxDistance` даёт `false`,
     и источник считается слышимым;
   - `_updateSpatialSound` → `_writePos` → `Howl.pos(NaN)`, и Web Audio бросает
     `TypeError`;
   - исключение внутри `Ticker` Pixi не даёт запросить следующий
     `requestAnimationFrame`, и игра замирает навсегда.

   Если гейт записи позиций (30 Гц) в этом тике закрыт и новых звуков нет,
   тик переживает NaN — и получается сбой 1.
4. В игре (vimp-tanks) дефекта нет. Предиктор уже отсекает неконечную позу
   (`vimp-tanks/core/src/client/predictor.rs`, `TankState::is_finite`).
   Интерполятор движка (`packages/engine/core/src/client/interpolator.rs`)
   делит на строго положительный интервал.

## Общие правила исполнения

Правила взяты из `CLAUDE.md` репозитория `vimp` и глобальных правил
разработчика.

- **Никаких коммитов**, правок `version` и публикаций: всё остаётся в рабочем
  дереве.
- Каждый этап заканчивается зелёными проверками из корня `vimp`:
  `npx eslint .` и `npx vitest run --reporter=dot`.
- Исправление начинается с теста, который воспроизводит баг. Тесты лежат в
  `tests/` и зеркалят `packages/engine/src/`, рядом с кодом их нет.
- Код:
  - ESM, `===`, `let`/`const`, фигурные скобки у каждого блока;
  - никаких двух заглавных подряд в camelCase;
  - порядок импортов: Node built-ins → npm → внутренние → относительные;
  - комментарии — по-русски, кратко, про «почему»;
  - новый модуль повторяет ближайший существующий паттерн (здесь —
    `packages/engine/src/client/lib/applyCamera.js`).
- **Документация — в том же изменении.** `docs/en/<page>.md` — канон, в нём
  ширина строки ~80 символов. `docs/ru/<page>.md` — точное зеркало, абзац
  пишется одной строкой.
- **Журнал** `packages/engine/CHANGELOG.md`: только раздел `## [Unreleased]`
  (сейчас он есть и пуст), подзаголовок `### Fixed`. Выпущенные секции
  (`## [0.35.2]` и ниже) не трогать.
- Файлы с префиксом `_` не читать и не трогать.
- Готовый этап помечать в его заголовке меткой «✅ выполнен». Когда выполнены
  все — `git mv plan/camera-nan-freeze.md plan/done/` (без коммита).

---

## Этап 1. Hot-буфер читается целиком до любого другого вызова ядра ✅ выполнен

### 1.1 Новый модуль `packages/engine/src/client/lib/hotTick.js`

Он повторяет паттерн `lib/applyCamera.js`: логику вынесли из `main.js` потому,
что `main.js` целиком в тесте не поднять, а порядок вызовов нужно защитить
тестом. Содержимое файла:

```js
import { HOT_FLAGS } from '../../config/opcodes.js';
import { reconstructHot } from '../../lib/reconstructHot.js';

// Рендер-тик клиентского ядра: сэмпл, событийные кадры, горячие данные,
// камера. Вынесено из main.js ради одной вещи — порядка ЧТЕНИЯ, который
// ничем больше не защищён: main.js целиком в тесте не поднять.
//
// Hot-буфер читается view поверх памяти WASM (zero-copy), а view живёт
// ровно до следующего роста этой памяти: `memory.grow` отцепляет старый
// ArrayBuffer, длина view становится 0, hot[i] — undefined. Растить память
// может любой аллоцирующий вызов ядра: take_frames() собирает строку JSON
// в куче WASM, парты при разборе кадров сами зовут ядро. Поэтому всё нужное
// из буфера снимается копией СРАЗУ, а применяется в прежнем порядке.
// Раньше камера читалась после take_frames(): undefined в ней становился
// NaN, NaN навсегда оседал в сглаживании камеры (картинка пропадала до
// cameraReset), а слушатель звука с NaN ронял Howl.pos() — и тикер Pixi.

/**
 * Один рендер-тик клиентского ядра.
 * @param {Object} deps
 * @param {Object} deps.core - ClientCore: sample, hot_ptr, take_frames.
 * @param {WebAssembly.Memory} deps.memory - Память WASM клиентского ядра.
 * @param {Object} deps.snapshotKeysById - Результат buildSnapshotKeysById.
 * @param {number} deps.now - Время рендера (performance.now()).
 * @param {Function} deps.applyShot - (game, camera): событийный кадр.
 * @param {Function} deps.applyGameData - (game): горячие данные сущностей.
 * @param {Function} deps.applyCamera - ([x, y]): камера тика.
 */
export default function runHotTick({
  core,
  memory,
  snapshotKeysById,
  now,
  applyShot,
  applyGameData,
  applyCamera,
}) {
  const len = core.sample(now);
  // указатель — раньше memory.buffer: аргументы `new Float32Array(...)`
  // вычисляются слева направо, и buffer, взятый до вызова ядра, мог бы уже
  // оказаться отцепленным
  const ptr = core.hot_ptr();
  const hot = new Float32Array(memory.buffer, ptr, len);
  const flags = hot[0];
  // reconstructHot копирует поля (Array.from): после разбора view не нужен
  const game =
    flags & (HOT_FLAGS.GAME | HOT_FLAGS.PREDICTED)
      ? reconstructHot(hot, snapshotKeysById)
      : null;
  const camera = flags & HOT_FLAGS.CAMERA ? [hot[1], hot[2]] : null;

  if (flags & HOT_FLAGS.FRAMES) {
    JSON.parse(core.take_frames()).forEach(frame => {
      applyShot(frame.game, frame.camera);
    });
  }

  if (game) {
    applyGameData(game);
  }

  // камера уже разрешена ядром: предсказанная позиция либо интерполированная
  if (camera) {
    applyCamera(camera);
  }
}
```

Порядок **применения** прежний: кадры → горячие данные → камера. Меняется
только момент чтения.

### 1.2 `packages/engine/src/client/main.js`

1. Импорт — сразу после `import applyCamera from './lib/applyCamera.js';`
   (~строка 101):

   ```js
   import runHotTick from './lib/hotTick.js';
   ```

2. Тело `renderTick` от `const len = clientCore.sample(...)` до блока
   `if (flags & HOT_FLAGS.CAMERA) { … }` включительно заменить вызовом ниже.
   Проверка `if (!clientCore)`, блок `pendingAutostart` и две строки
   `soundManager.*` в конце остаются как есть.

   ```js
     runHotTick({
       core: clientCore,
       memory: wasm.memory,
       snapshotKeysById,
       now: performance.now(),
       applyShot,
       applyGameData,
       applyCamera: camera =>
         applyCamera(modules.canvasManager, soundManager, camera, reportBadCamera),
     });
   ```

   Функцию `reportBadCamera` добавляет этап 2. Этапы 1 и 2 делаются подряд;
   если нужен зелёный прогон между ними, на этапе 1 передать `applyCamera`
   без четвёртого аргумента.
3. Комментарий над `renderTick` («рендер-тик: ядро выдаёт пересечённые кадры
   … плоским Float32-буфером zero-copy из памяти WASM») дополнить: порядок
   чтения буфера — в `lib/hotTick.js`.
4. Неиспользуемые импорты. После замены `HOT_FLAGS` (~строка 90) и
   `reconstructHot` (~строка 57) в `main.js` больше не используются (сейчас
   это проверено: их ссылки только в `renderTick`). Удалить:
   - строку `import { HOT_FLAGS } from '../config/opcodes.js';`;
   - `reconstructHot` из импорта `../lib/reconstructHot.js`, оставив
     `buildSnapshotKeysById`.

   Перед удалением ещё раз проверить: `grep -n "HOT_FLAGS\|reconstructHot"
   packages/engine/src/client/main.js`.

### 1.3 Тесты: `tests/client/lib/hotTick.test.js` (новый файл)

Проект vitest для `tests/client` работает в окружении happy-dom, глобальный
`WebAssembly` там есть. Каркас:

```js
import { describe, it, expect, vi } from 'vitest';
import runHotTick from '../../../packages/engine/src/client/lib/hotTick.js';
import { buildSnapshotKeysById } from '../../../packages/engine/src/lib/reconstructHot.js';
import { HOT_FLAGS } from '../../../packages/engine/src/config/opcodes.js';

const keysById = buildSnapshotKeysById({
  a1: { id: 1, kind: 'indexed8', fields: [{ name: 'x' }, { name: 'y' }] },
});

// [flags, camX, camY, N, keyId, id, x, y, M]: одна запись Indexed8, без
// динамики и хвоста
const ALL = HOT_FLAGS.GAME | HOT_FLAGS.CAMERA | HOT_FLAGS.FRAMES;
const makeHot = (flags = ALL) => [flags, 120, -40, 1, 1, 5, 10, 20, 0];

// настоящая память WASM и ядро, которое растит её на названном вызове —
// так же, как это делает аллокация в куче ядра
function makeCore({ hot = makeHot(), growOn = null } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 16 });

  new Float32Array(memory.buffer, 0, hot.length).set(hot);

  const grow = name => {
    if (growOn === name) {
      memory.grow(1);
    }
  };
  const core = {
    sample: vi.fn(() => hot.length),
    hot_ptr: vi.fn(() => {
      grow('hot_ptr');
      return 0;
    }),
    take_frames: vi.fn(() => {
      grow('take_frames');
      return JSON.stringify([{ game: { a1: {} }, camera: 0 }]);
    }),
  };

  return { core, memory };
}

const run = (core, memory, overrides = {}) => {
  const deps = {
    applyShot: vi.fn(),
    applyGameData: vi.fn(),
    applyCamera: vi.fn(),
    ...overrides,
  };

  runHotTick({ core, memory, snapshotKeysById: keysById, now: 1000, ...deps });

  return deps;
};
```

Кейсы. Первым пишется кейс 1: это воспроизведение бага.

1. **«рост памяти в take_frames не портит камеру и горячие данные»** —
   `makeCore({ growOn: 'take_frames' })`:
   - `applyCamera` вызван с `[120, -40]`;
   - `applyGameData` вызван с `{ a1: { 5: [10, 20] } }`.
2. **«рост памяти в парте при разборе кадра — то же»** —
   `makeCore()` и `run(core, memory, { applyShot: vi.fn(() => memory.grow(1)) })`;
   ожидания как в кейсе 1.
3. **«рост памяти в hot_ptr — буфер читается уже новой памяти»** —
   `makeCore({ growOn: 'hot_ptr' })`; ожидания как в кейсе 1.
4. **«порядок применения: кадры → горячие данные → камера»** — через
   `mock.invocationCallOrder` у трёх колбэков. `applyShot` получает
   `({ a1: {} }, 0)`.
5. **«без флагов ничего не применяется»** — `makeCore({ hot: makeHot(0) })`:
   ни один колбэк не вызван, `core.take_frames` не вызван.
6. **«sample получает now»** — `core.sample` вызван с `1000`.

Как проверить, что кейс 1 настоящий (временно, без сохранения): в
`hotTick.js` перенести `const camera = …` и `const game = …` ниже блока
`FRAMES`. Кейс 1 должен упасть: в камере `[undefined, undefined]`, а
`applyGameData` не вызван или получил `{}`. Затем вернуть порядок.

---

## Этап 2. Страховки: неконечная камера и позиция звука не роняют кадр ✅ выполнен

### 2.1 `packages/engine/src/client/lib/applyCamera.js`

Добавить четвёртый параметр `onInvalid` и проверку сразу после раннего
выхода для пустого кадра:

```js
/**
 * … (прежний текст JSDoc) …
 * @param {Function} [onInvalid] - Зовётся с кадром, у которого x или y — не
 * конечное число (NaN, Infinity, undefined, null); такой кадр не применяется.
 */
export default function applyCamera(canvasManager, soundManager, camera, onInvalid) {
  if (!camera || camera === 0) {
    return;
  }

  // Неконечная координата не применяется ни к полотну, ни к слушателю.
  // Полотну один NaN вредит надолго: CanvasManagerModel сглаживает камеру
  // через lerp, NaN оседает в его накопителях до cameraReset — масштаб
  // сцены NaN, картинки нет. Слушателю — сразу: NaN уходит в Howl.pos(),
  // тот бросает, и тикер Pixi останавливается. null отсекается тоже: serde
  // пишет неконечное число JSON-кадра как null, а в арифметике null молча
  // стал бы нулём — прыжок камеры в начало координат
  if (!Number.isFinite(camera[0]) || !Number.isFinite(camera[1])) {
    onInvalid?.(camera);
    return;
  }

  canvasManager.updateCoords(camera);
  // … дальше без изменений
}
```

### 2.2 `packages/engine/src/client/main.js`: отчёт в журнал

1. Рядом с функцией `applyShot` (~строка 955) объявить:

   ```js
   // Камеру с NaN/undefined applyCamera не применяет (lib/applyCamera.js), но
   // молчать о ней нельзя: это симптом сбоя выше по течению (ядро, чтение
   // hot-буфера), и журнал — единственный способ узнать о нём с прода.
   // String(): JSON.stringify превратил бы NaN в null, а undefined потерял бы
   function reportBadCamera(camera) {
     diagnostics.warn(
       'engine.camera.non-finite',
       { x: String(camera[0]), y: String(camera[1]) },
       { source: 'client' },
     );
   }
   ```

   `diagnostics` — константа модуля (~строка 158), она создаётся до первого
   тика. Код `engine.camera.non-finite` проходит `CODE_RE` репортёра и бокса.
   `source: 'client'` есть в списке `SOURCES`
   (`packages/engine/src/master/clientReports/sanitize.js`). Повторы
   репортёр склеивает в счётчик.
2. В `applyShot` передать тот же колбэк:
   `applyCamera(modules.canvasManager, soundManager, camera, reportBadCamera);`.
   Через `applyShot` идут первый кадр (`PS_FIRST_SHOT_DATA`) и событийные
   кадры.

### 2.3 `packages/engine/src/client/SoundManager.js`

1. `_writePos` (~строка 797) — единственная точка записи в паннер. Первой
   строкой тела добавить:

   ```js
       // Неконечная координата в узел не пишется: Web Audio бросает на ней
       // TypeError из setValueAtTime, исключение уходит из рендер-тика в тикер
       // Pixi, и тот больше не запрашивает кадр — игра замирает целиком.
       // Позиции источников задаёт и игра (registerSound/updateSoundData),
       // поэтому одного фильтра камеры (lib/applyCamera.js) здесь мало.
       // Запомненная позиция не трогается: следующую конечную сравним с
       // настоящей
       if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
         return;
       }
   ```

   Дописать в JSDoc метода одну строку: неконечная позиция пропускается.
2. `_applyVolume` (~строка 720). Отсечку переписать так, чтобы NaN считался
   неслышимым:

   ```js
       // отсечка в мировых координатах: … (прежний комментарий)
       // «не ближе maxDistance», а не «дальше»: NaN-дистанция (координата
       // источника или слушателя не число) иначе считалась бы слышимой на
       // полной громкости
       if (!(Math.hypot(dx, dy) < this._spatial.maxDistance)) {
         sound.volume(0, soundId);

         return false;
       }
   ```

`processAudibility` не трогать. Одноразовый звук с NaN-позицией станет
кандидатом, но прозвучит молча: громкость 0, позиция не пишется.

### 2.4 Тесты

**`tests/client/applyCamera.test.js`** — дописать в существующий
`describe('applyCamera')`; фабрика `makeDeps` уже есть:

1. «неконечная камера не применяется и уходит в onInvalid» — для каждого из
   `[NaN, 1]`, `[1, Infinity]`, `[undefined, undefined]`, `[null, 2]`, со
   свежими `makeDeps()` и `onInvalid = vi.fn()`:
   - `updateCoords` и `setListenerPosition` не вызваны;
   - `onInvalid` вызван с этим кадром.
2. «без onInvalid неконечная камера молча пропускается» —
   `expect(() => applyCamera(cm, sm, [NaN, NaN])).not.toThrow()`, и
   `updateCoords` не вызван.
3. «конечная камера onInvalid не зовёт» — `[0, 0]` с `onInvalid`: он не
   вызван, `updateCoords` вызван.

**`tests/client/SoundManager.test.js`** — новый блок
`describe('SoundManager: неконечные координаты', …)` в конце файла.
Использовать готовые хелперы файла: `makeManager`, `makeHowl`,
`makeSpatialCtx` (слушатель в `(100, 100)`) и `frame(ctx, sound, id, x, y,
volume, spatial)`. Howl, который бросает так же, как настоящий:

```js
const makeStrictHowl = () => ({
  ...makeHowl(),
  pos: vi.fn((x, y, z) => {
    if (![x, y, z].every(Number.isFinite)) {
      throw new TypeError(
        "Failed to execute 'setValueAtTime' on 'AudioParam': The provided float value is non-finite.",
      );
    }
  }),
});
```

Кейсы. Первые два на текущем коде падают:

1. «слушатель с undefined (отцепленный hot-буфер) не роняет кадр и глушит
   источник» — `ctx = makeSpatialCtx()`, `ctx._listenerX = undefined`,
   `sound = makeStrictHowl()`:
   - `expect(() => frame(ctx, sound, 1, 400, 100, 1)).not.toThrow()`;
   - `sound.pos` не вызван;
   - `sound.volume` вызван с `(0, 1)`.
2. «updateActiveSounds с NaN-позицией лупа не бросает» —
   `makeManager({ _registeredSounds: new Map([['owner', { position: { x: NaN,
   y: 0 }, volume: 1, loop: true }]]), _activeInstances: new Map([[7, { sound,
   ownerId: 'owner', loop: true }]]) })`. `_updateSpatialSound` **не**
   мокать; `_lastPositionWrite` в `makeManager` уже `-Infinity`, так что гейт
   открыт:
   - `expect(() => ctx.updateActiveSounds()).not.toThrow()`;
   - `sound.pos` не вызван.
3. «_writePos не пишет и не запоминает неконечную позицию»:
   - `ctx._writePos(sound, 1, NaN, 0, 0)`, затем `ctx._writePos(sound, 1, 0,
     Infinity, 0)` — `pos` не вызван, `ctx._pannerPos.has(1) === false`;
   - затем `ctx._writePos(sound, 1, 5, 0, 0)` — `pos` вызван один раз с
     `(5, 0, 0, 1)`.
4. Существующие тесты («за maxDistance источник глушится», «innerRadius: 0 не
   даёт NaN», гейт и порог записи) остаются зелёными без правок.

---

## Этап 3. Документация и журнал ✅ выполнен

### 3.1 `docs/en/client.md` и зеркально `docs/ru/client.md`

1. Раздел `## main.js — bootstrap, dispatcher, and render loop` (ru:
   `## main.js — бутстрап, диспетчер и рендер-цикл`), пункт **The render
   loop** (en ~строка 216, ru ~строка 58). Новый смысл: `clientCore.sample(now)`
   → hot-буфер читается zero-copy **целиком, до любого другого вызова ядра**
   → `take_frames()` для редких событийных кадров → применение прежним
   `parse`-конвейером в порядке «кадры → горячие данные → камера»
   (`lib/hotTick.js`).
2. Раздел `## Client Core (ClientCore)` (ru: `## Клиентское ядро
   (ClientCore)`), пункт **Render tick** (en ~строка 793, ru ~строка 235).
   Скобку «(the view is recreated every tick: WASM memory growth detaches
   the buffer)» заменить смыслом:
   - view пересоздаётся каждый тик и живёт только до роста памяти WASM:
     рост отцепляет буфер, и отцепленный view читает `undefined`;
   - растить память может любой аллоцирующий вызов ядра: `take_frames()`
     строит строку JSON в куче WASM, парты зовут ядро при разборе кадров;
   - поэтому `lib/hotTick.js` снимает копию всего нужного до первого такого
     вызова;
   - раньше камера читалась после `take_frames()` и становилась NaN:
     полотно пустело до сброса камеры, а слушатель звука ронял `Howl.pos()`
     и с ним тикер.
3. Раздел `## Error reporting (lib/diagnostics.js)` (ru: `## Журнал ошибок`),
   список **Caught:** (ru: «Ловится:») — новый пункт:
   - неконечная камера (`NaN`, `Infinity`, `undefined`, `null` в `x`/`y`):
     `applyCamera` не применяет такой кадр ни к полотну, ни к слушателю
     звука;
   - кадр уходит как `warn` с кодом `engine.camera.non-finite`, `source:
     'client'`, `details: { x, y }` строками.
4. Раздел `### How often the position is written` (ru: `### Как часто
   пишется позиция`) — в конец абзац:
   - **неконечная позиция в узел не пишется никогда**;
   - почему: `setValueAtTime` бросает на NaN/Infinity, а исключение в
     рендер-тике останавливает тикер Pixi, и игра замирает;
   - `_writePos` — единственная точка записи — пропускает такую позицию и
     не запоминает её;
   - `_applyVolume` считает NaN-дистанцию дальше `maxDistance` и глушит
     источник.

### 3.2 `docs/en/architecture.md` (~строка 174) и `docs/ru/architecture.md` (~строка 169)

К фразе «zero-copy flat Float32 buffer from WASM memory» (ru: «плоским
Float32-буфером zero-copy из памяти WASM») дописать уточнение: буфер
читается целиком до любого другого вызова ядра, потому что рост памяти WASM
отцепляет view.

### 3.3 `packages/engine/CHANGELOG.md`

Под `## [Unreleased]` (он есть и пуст, стоит над `## [0.35.2] — 2026-09-27`)
добавить:

```markdown
### Fixed

- The canvas could go blank until the next respawn, and the game could
  freeze on `Failed to execute 'setValueAtTime' on 'AudioParam'`: the render
  tick read the hot buffer through a view that WASM memory growth in
  `take_frames()` had detached, and the `undefined` camera turned into NaN.
  The tick now reads the whole buffer before any other call into the core;
  a non-finite camera is skipped and reported as `engine.camera.non-finite`,
  and no non-finite position ever reaches an audio panner.
```

`docs/ai/`, `contract/surface.json`, `CLAUDE.md` не меняются: контракт
плагина и команды прежние.

---

## Влияние на релиз (сообщить разработчику в отчёте)

- Затронут npm-пакет `vimp-engine` (`src/client` входит в `files`).
  Подзаголовок `### Fixed` означает **patch**: 0.35.2 → 0.35.3. Выпуск —
  `npm run release`, его делает разработчик.
- Прод получает исправление деплоем бокса (push в `main`): клиент движка
  раздаёт сам бокс. Standalone SDK получает его после npm-релиза.
- Крейт `vimp-engine-core` не меняется. `contract/surface.json` не меняется.
- vimp-tanks следовать не обязан: игра клиент движка не вшивает.

## Вне объёма

- **Живучесть цикла рендера.** Любое исключение в слушателе `Ticker.shared`
  (в `renderTick` или в `onRender` парта) по-прежнему навсегда останавливает
  тикер. Защита — обёртка тикера с `diagnostics.capture` — это отдельная
  задача.
- **Секрет `CLIENT_REPORTS_TOKEN`** для журнала «Errors» задаёт разработчик
  в GitHub → Settings → Secrets → Actions, затем деплой.

## Проверка по окончании

1. Из корня `/Users/dmitry/Sites/my/vimp`: `npx eslint .` и `npx vitest run
   --reporter=dot` — зелёные.
2. Регрессия настоящая: временная перестановка чтения из этапа 1.3 роняет
   кейс 1 `hotTick.test.js`. Кейсы 1–2 `SoundManager` падают, если временно
   убрать новую проверку из `_writePos` и вернуть `>=` в `_applyVolume`.
   После проверки всё вернуть.
3. `npm run build:app` проходит.
4. После деплоя: предупреждение `[tanks] levelView: центра камеры нет` и
   зависание на `setValueAtTime` больше не повторяются. Если после установки
   `CLIENT_REPORTS_TOKEN` во «Errors» появится `engine.camera.non-finite`,
   значит, есть ещё один источник NaN, выше по течению (ядро), и это повод
   для отдельного расследования.
