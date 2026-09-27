# Кодревью `camera-nan-freeze` и план исправлений

> План самодостаточен: исполнителю не нужен контекст беседы, в которой он
> составлен. Перед каждым этапом прочитать разделы «Контекст», «Найденные
> проблемы», «Общие правила исполнения» и сам этап. Все правки — в
> репозитории движка `/Users/dmitry/Sites/my/vimp`, пути ниже — от его корня.
> Репозиторий игры `vimp-tanks` не трогать.

## Контекст

Задача `camera-nan-freeze` (`plan/done/camera-nan-freeze.md`) исправляла два
сбоя на проде: картинка пропадала, а игра зависала с ошибкой

```
TypeError: Failed to execute 'setValueAtTime' on 'AudioParam': The provided float value is non-finite.
```

**Первопричина.** `renderTick` читал hot-буфер клиентского ядра через view
поверх `wasm.memory.buffer` уже после `take_frames()`. Если при этом
вырастала память WASM, view отцеплялся, и камера читалась как
`[undefined, undefined]`:

- NaN оседал в сглаживании камеры, и масштаб сцены становился NaN;
- слушатель звука получал NaN, и `Howl.pos(NaN)` бросал исключение, которое
  останавливало тикер Pixi.

**Коммиты:**

| Коммит | Что в нём |
| --- | --- |
| `de5bcfe6` | само исправление |
| `d78f01bc` | релиз `vimp-engine` 0.35.3 |
| `6791842a` | релиз `create-vimp-game` 0.4.34 |

Что сделано в `de5bcfe6`:

- `packages/engine/src/client/lib/hotTick.js` (новый): hot-буфер копируется
  до `take_frames()`, а применяется в прежнем порядке «кадры → горячие
  данные → камера»;
- `main.js`: `renderTick` вызывает `runHotTick`; `reportBadCamera` отправляет
  `warn` с кодом `engine.camera.non-finite`;
- `lib/applyCamera.js`: неконечная камера не применяется, вызывается
  `onInvalid`;
- `SoundManager.js`: `_writePos` не пишет неконечную позицию; `_applyVolume`
  глушит источник с NaN-дистанцией;
- тесты, документация en/ru, запись в `CHANGELOG`.

Прод подтвердил диагноз: звуковая ошибка пришла через
`processAudibility → _updateSpatialSound → _writePos`, то есть при старте
нового звука, который гейт 30 Гц не ограничивает. Через 9 мс пришло
`tanks.camera.missing` из того же сбоя.

**Как проверялось:**

- прочитаны все три коммита целиком: код, тесты, документация, журналы;
- затронутые тесты (`hotTick`, `applyCamera`, `SoundManager`) — 73 штуки,
  все зелёные;
- ESLint по изменённым файлам чистый, Prettier по новым файлам чистый;
- в исходнике Howler (`node_modules/howler/dist/howler.js`) проверено, какие
  его методы пишут в `AudioParam` и проверяют ли они значение;
- grep подтвердил: `applyCamera` — единственный вызывающий
  `canvasManager.updateCoords`; других view над памятью WASM в движке,
  vimp-tanks и vimp-snakes нет.

**Итог.** Первопричина устранена верно и полностью. Порядок чтения защищён
тестом на настоящей `WebAssembly.Memory`, и регрессия ловится. Найдено одно
существенное замечание (№1): тот же класс сбоя остался открытым через
`rate`. Остальные четыре — пробелы в тестах и неточности в тексте.

## Итог по критериям

| Критерий | Оценка | Замечания |
| --- | --- | --- |
| Читаемость | хорошо | `hotTick.js` короткий, комментарии объясняют «почему» (порядок чтения, `hot_ptr()` до `memory.buffer`) |
| Работоспособность | есть дефект | №1: NaN в `rate` зацикленного звука по-прежнему замораживает игру |
| Тестируемость | хорошо, есть пробелы | логика вынесена в тестируемый модуль; нет теста реального пути прода (№2) и флага `PREDICTED` без `GAME` (№3) |
| Поддерживаемость | хорошо, мелочь | №5: комментарии headless-раннера ссылаются на старое место последовательности тика |
| Безопасность | хорошо | новой поверхности нет; в `details` отчёта — только строковые числа; №1 — это устойчивость движка к ошибке плагина |
| Производительность | без регрессий | копия буфера — тот же `Array.from`, что и раньше; `reportBadCamera` дёшев и склеивается дедупом репортёра |
| Масштабируемость | не затронута | работа на тик постоянная |
| DRY | приемлемо | headless-раннер повторяет последовательность тика — см. «Принято без исправления» |
| Документированность | хорошо, мелочь | №4: фрагмент кода в «Render tick» показывает небезопасный порядок вычисления |
| Стандартизация | соответствует | ESM, скобки, `eslint-disable camelcase` в тесте — как в других тестах с фейком ядра |

## Найденные проблемы

| № | Серьёзность | Где | Суть | Этап |
| --- | --- | --- | --- | --- |
| 1 | **Средняя** | `packages/engine/src/client/SoundManager.js`, `updateActiveSounds` (~стр. 518) | Проверка `typeof rate === 'number'` пропускает `NaN` и `±Infinity` в `sound.rate(rate, soundId)` (подробности ниже) | 1 |
| 2 | Низкая (тесты) | `tests/client/SoundManager.test.js` | Реальный путь прода не покрыт: `processAudibility` (старт нового звука) → `_applyVolume` → `_updateSpatialSound` → `_writePos` (подробности ниже) | 2 |
| 3 | Низкая (тесты) | `tests/client/lib/hotTick.test.js` | Нет кейса «`PREDICTED` без `GAME`» и кейса «`GAME` без `CAMERA`» (подробности ниже) | 2 |
| 4 | Низкая (документация) | `docs/en/client.md` (~стр. 798), `docs/ru/client.md` (~стр. 235–236) | В «Render tick» написано `new Float32Array(wasm.memory.buffer, hot_ptr(), len)` (подробности ниже) | 3 |
| 5 | Низкая (поддерживаемость) | `packages/engine/src/devtools/VirtualClient.js`, стр. 11 и 219 | Комментарии называют headless-тик «зеркалом `client/main.js:renderTick`», хотя последовательность тика теперь в `client/lib/hotTick.js` (подробности ниже) | 3 |

**№1 подробно.** `Howl.rate` значение не проверяет (`howler.js`, ~стр.
1522: только `typeof rate === 'number'`) и пишет его прямо в
`sound._node.bufferSource.playbackRate.setValueAtTime(rate, …)` (~стр. 1557):

- Web Audio бросает тот же `TypeError: … non-finite`;
- исключение выходит из `renderTick`, и тикер Pixi останавливается — игра
  замирает, как в исходном сбое;
- `NaN !== NaN`, поэтому вызов повторялся бы каждый кадр;
- `Howl.volume`, для сравнения, NaN отбрасывает сам (`vol >= 0 && vol <= 1`,
  ~стр. 1238) и не бросает.

`rate` задаёт игра (`registerSound` / `updateSoundData`). Путь реальный:
vimp-tanks уже натыкалась на него и закрывала у себя (`src/client/parts/Tank.js`,
~стр. 147: «NaN в rate — нефинитное значение параметра»; ~стр. 516: «в
`sound.rate` каждый кадр уезжает NaN»). Движок же после исправления защищает
только позицию.

**№2 подробно.** Тест через `frame()` повторяет пару вызовов из
`processAudibility`, но сам `processAudibility` с неконечной координатой не
вызывает ни один тест. Исправление закрывает этот путь, однако тест на него
не опирается.

**№3 подробно.** Условие `flags & (GAME | PREDICTED)` пришло из `main.js` и
теперь живёт в тестируемом модуле. Если маску сузить до `GAME`, пропадёт
свой танк в кадрах, где есть только предсказанный хвост. Такую регрессию
тесты не заметят.

**№4 подробно.** Аргументы вычисляются слева направо, поэтому показанный
фрагмент берёт `buffer` до вызова ядра. Именно этот порядок комментарий в
`hotTick.js` называет небезопасным: код делает `hot_ptr()` первым, а
документация учит обратному.

**№5 подробно.** Кто будет менять порядок, найдёт в `main.js` только вызов
`runHotTick` и пропустит зеркало в headless-раннере.

**Принято без исправления:**

- **Последовательность тика дублируется в headless-раннере**
  (`VirtualClient.render`). У раннера своя диагностика: заметки `nonFinite`
  по всему буферу, проверка раскладки `parseHot(...).consumed`, ранний выход
  при `len === 0`. Буфер он читает копией (`hot_values()`). Чтобы свести его
  к `runHotTick`, пришлось бы протащить в модуль стратегию чтения и хуки
  разбора — это сложнее выгоды. После этапа 3 зеркало хотя бы указывает на
  правильный файл.
- **`reportBadCamera` не покрыт тестом.** У `main.js` нет харнесса (правило
  модуля), а функция — три строки без ветвлений.
- **Объект параметров и замыкание в `renderTick` создаются на каждый тик.**
  Это две мелкие аллокации на кадр. `reconstructHot` на том же тике создаёт
  по массиву на каждую строку, так что разница несущественна.
- **У всех причин неконечной камеры один ключ дедупа.** Репортёр и auth
  сохраняют `details` первого случая, поэтому разные причины (`'null'` из
  JSON-кадра, `'undefined'` от отцепленного view, `'NaN'` из ядра) сливаются
  в одну строку журнала. Код отчёта нужен как сигнал «есть ещё источник
  NaN»; разбирать его — локальным воспроизведением.
- **`processAudibility` и NaN-позиция источника.** Одноразовый звук с
  NaN-позицией не удаляется по дистанции, а его `priorityScore` равен NaN, и
  при больше чем 30 кандидатах сортировка может выбрать голоса неоптимально.
  Такое возможно только при ошибке плагина; звук при этом заглушён, падения
  нет.
- **У `CanvasManagerModel` нет собственной проверки на конечность.**
  `applyCamera` — единственный вызывающий `updateCoords` (проверено grep'ом),
  и эта точка защищена.

## Общие правила исполнения

Правила взяты из `CLAUDE.md` репозитория `vimp` и глобальных правил
разработчика.

- **Никаких коммитов**, правок `version` и публикаций: всё остаётся в рабочем
  дереве.
- Каждый этап заканчивается зелёными проверками из корня `vimp`:
  `npx eslint .` и `npx vitest run --reporter=dot`.
- Исправление начинается с теста, который воспроизводит баг: на текущем коде
  он падает.
- Тесты лежат в `tests/` и зеркалят `packages/engine/src/`.
- Код:
  - ESM, `===`, `let`/`const`, фигурные скобки у каждого блока;
  - никаких двух заглавных подряд в camelCase;
  - комментарии — по-русски, кратко, про «почему».
- **Документация — в том же изменении.** `docs/en/<page>.md` — канон, строки
  до ~80 символов. `docs/ru/<page>.md` — точное зеркало.
  - В `docs/ru/client.md` раздел «SoundManager» пишется абзацем в одну
    строку, а пункт «Рендер-тик» в разделе «Клиентское ядро» — с переносами
    ~80 символов. Сохранять стиль того места, которое правится.
- **Журнал** `packages/engine/CHANGELOG.md`: писать только под
  `## [Unreleased]`. Сейчас он пуст и стоит над `## [0.35.3] — 2026-09-27`.
  Выпущенные секции (`[0.35.3]` и ниже) **не править**: это правило
  `CLAUDE.md` — уточнение выпущенной записи оформляется новой записью.
  Подзаголовок — только `### Fixed`.
- Файлы с префиксом `_` не читать и не трогать.
- Готовый этап помечать в его заголовке меткой «✅ выполнен». Когда выполнены
  все — `git mv plan/camera-nan-freeze-review.md plan/done/` (без коммита).

---

## Этап 1. Неконечный `rate` не уходит в Howler (№1) ✅ выполнен

**Файлы:**

- `packages/engine/src/client/SoundManager.js`;
- `tests/client/SoundManager.test.js`;
- `docs/en/client.md`, `docs/ru/client.md`;
- `packages/engine/CHANGELOG.md`.

### 1.1 Тест-воспроизведение (пишется первым)

В `tests/client/SoundManager.test.js` фабрика `makeStrictHowl` сейчас
объявлена внутри `describe('SoundManager: неконечные координаты', …)` (в
конце файла).

1. Перенести её на уровень модуля — сразу после `makeHowl` (~стр. 30) — и
   сделать строгим ещё и `rate`:

   ```js
   // Howl, который бросает так же, как настоящий: Web Audio не принимает
   // неконечное значение в setValueAtTime. pos() — три AudioParam позиции,
   // rate() — playbackRate; громкость Howler проверяет сам и NaN молча
   // отбрасывает, поэтому volume здесь обычный
   const NON_FINITE_ERROR =
     "Failed to execute 'setValueAtTime' on 'AudioParam': The provided float value is non-finite.";

   const makeStrictHowl = () => ({
     ...makeHowl(),
     pos: vi.fn((x, y, z) => {
       if (![x, y, z].every(Number.isFinite)) {
         throw new TypeError(NON_FINITE_ERROR);
       }
     }),
     rate: vi.fn(rate => {
       if (!Number.isFinite(rate)) {
         throw new TypeError(NON_FINITE_ERROR);
       }
     }),
   });
   ```

2. Из `describe('SoundManager: неконечные координаты')` удалить локальное
   объявление `makeStrictHowl` и комментарий над ним. Сам блок
   переименовать в `describe('SoundManager: неконечные значения', …)`.
3. В этот блок добавить кейс. `makeLoopCtx` уже есть на уровне модуля (~стр.
   47): экземпляр с id `7`, `_updateSpatialSound` замокан.

   ```js
   it('неконечный rate не уходит в Howler, прежний остаётся до конечного', () => {
     const sound = makeStrictHowl();
     const reg = { position: { x: 0, y: 0 }, volume: 1, rate: NaN, loop: true };
     const ctx = makeLoopCtx(reg, sound);

     expect(() => ctx.updateActiveSounds()).not.toThrow();

     reg.rate = Infinity;

     expect(() => ctx.updateActiveSounds()).not.toThrow();
     expect(sound.rate).not.toHaveBeenCalled();

     reg.rate = 1.2;
     ctx.updateActiveSounds();

     expect(sound.rate).toHaveBeenCalledTimes(1);
     expect(sound.rate).toHaveBeenCalledWith(1.2, 7);
   });
   ```

   На текущем коде первый `expect(...).not.toThrow()` падает с
   `TypeError: … non-finite`.

### 1.2 Исправление

`packages/engine/src/client/SoundManager.js`, метод `updateActiveSounds`,
блок в конце цикла (~стр. 514–521). Сейчас:

```js
      // rate только на изменение: Howler на каждый вызов делает два seek(),
      // переписывает _rateSeek/_playStart и пересоздаёт таймер конца петли
      // — на 60 Гц это лишняя нагрузка и лишние события 'end' на каждом
      // обороте
      if (typeof rate === 'number' && rate !== activeInstance.rate) {
```

Заменить условие и дописать к комментарию:

```js
      // rate только на изменение: Howler на каждый вызов делает два seek(),
      // переписывает _rateSeek/_playStart и пересоздаёт таймер конца петли
      // — на 60 Гц это лишняя нагрузка и лишние события 'end' на каждом
      // обороте.
      // И только конечный: громкость Howler проверяет сам, а rate — нет,
      // NaN/Infinity уходят прямо в playbackRate.setValueAtTime, тот
      // бросает TypeError, и тикер Pixi останавливается (как с позицией в
      // _writePos). К тому же NaN !== NaN — вызов повторялся бы каждый кадр.
      // До первого конечного значения звучит прежний rate
      if (Number.isFinite(rate) && rate !== activeInstance.rate) {
```

Тело блока (`sound.rate(rate, soundId); activeInstance.rate = rate;`) не
менять. Поведение для `rate === undefined` прежнее: звук пропускается.

### 1.3 Документация

`docs/en/client.md`, раздел `### How often the position is written`, абзац
**A non-finite position never reaches the node.** (~стр. 1137). Дописать в
конец абзаца:

```
The same holds for `rate`: Howler validates volume but hands `rate`
straight to `playbackRate.setValueAtTime`, so `updateActiveSounds` passes
it on only when it is finite; until then the previous rate plays.
```

`docs/ru/client.md`, раздел `### Как часто пишется позиция`, тот же абзац
(~стр. 428, одна строка). В конец строки дописать:

```
То же с `rate`: громкость Howler проверяет сам, а `rate` отдаёт прямо в `playbackRate.setValueAtTime`, поэтому `updateActiveSounds` передаёт его, только если он конечный; до тех пор звучит прежний.
```

### 1.4 Журнал

`packages/engine/CHANGELOG.md`: под пустым `## [Unreleased]` добавить

```markdown
### Fixed

- A game that passes a non-finite `rate` for a looping sound
  (`registerSound` / `updateSoundData`) no longer freezes the client: Howler
  hands it straight to `playbackRate.setValueAtTime`, which throws inside the
  render tick. The sound keeps its previous rate until a finite one arrives.
```

Запись 0.35.3 («…no non-finite position ever reaches an audio panner») **не
трогать**: она точна для позиции и уже выпущена.

---

## Этап 2. Тесты: реальный путь прода и маска флагов тика (№2, №3) ✅ выполнен

Этап меняет только тесты; журнала и документации нет.

### 2.1 `tests/client/SoundManager.test.js` — путь `processAudibility` (№2)

В блок `describe('SoundManager: неконечные значения')` (после этапа 1)
добавить кейс. `makeManager` берёт настоящий прототип, `_spatial` в нём —
дефолтный конфиг с конечным `maxDistance`. `_internalPlay` мокается так же,
как в настоящем коде: регистрирует экземпляр и возвращает числовой id.

```js
it('старт нового звука в processAudibility с NaN не роняет кадр', () => {
  const sound = makeStrictHowl();
  const reg = {
    id: 'shot',
    position: { x: 400, y: 100 },
    priority: 1,
    loop: false,
    activeSoundId: null,
    volume: 1,
    spatial: true,
    sound,
  };
  const ctx = makeManager({
    // так слушателя оставлял отцепленный hot-буфер
    _listenerX: undefined,
    _listenerY: 100,
    _registeredSounds: new Map([['shot', reg]]),
    _cleanupUnplayedOneShots: vi.fn(),
  });

  ctx._internalPlay = vi.fn(candidate => {
    ctx._activeInstances.set(1, { sound, ownerId: candidate.id, loop: false });

    return 1;
  });

  expect(() => ctx.processAudibility()).not.toThrow();
  expect(ctx._internalPlay).toHaveBeenCalledTimes(1);
  expect(sound.pos).not.toHaveBeenCalled();
  expect(sound.volume).toHaveBeenCalledWith(0, 1);
});
```

Почему кейс проходит:

- дистанция NaN, `NaN >= maxDistSquared` ложно — звук становится
  кандидатом, `_internalPlay` вызывается;
- `_applyVolume` с исправлением глушит источник (`volume(0, 1)`) и возвращает
  `false`;
- `_updateSpatialSound` не вызывается.

Контроль. Временно вернуть **обе** старые строки — `>=` в `_applyVolume` и
отсутствие проверки в `_writePos`: кейс падает с `TypeError`. Затем вернуть
исправление.

### 2.2 `tests/client/lib/hotTick.test.js` — маска флагов (№3)

В `describe('runHotTick')` добавить два кейса. Хелперы `makeCore`, `makeHot`
и `run` уже есть в файле.

```js
it('только PREDICTED (без GAME) — горячие данные всё равно разбираются', () => {
  const { core, memory } = makeCore({
    hot: makeHot(HOT_FLAGS.PREDICTED | HOT_FLAGS.CAMERA),
  });
  const deps = run(core, memory);

  expect(deps.applyGameData).toHaveBeenCalledWith({ a1: { 5: [10, 20] } });
  expect(deps.applyCamera).toHaveBeenCalledWith([120, -40]);
  expect(core.take_frames).not.toHaveBeenCalled();
});

it('без CAMERA камера не применяется', () => {
  const { core, memory } = makeCore({ hot: makeHot(HOT_FLAGS.GAME) });
  const deps = run(core, memory);

  expect(deps.applyGameData).toHaveBeenCalledTimes(1);
  expect(deps.applyCamera).not.toHaveBeenCalled();
});
```

Контроль. Временно сузить в `hotTick.js` условие до `flags &
HOT_FLAGS.GAME`: первый кейс падает. Затем вернуть.

---

## Этап 3. Точность документации и комментариев (№4, №5) ✅ выполнен

Журнала нет: `docs/` и комментарии записями не считаются.

### 3.1 Фрагмент «Render tick» (№4)

`docs/en/client.md`, раздел `## Client Core (ClientCore)`, пункт
**Render tick** (~стр. 798–800). Сейчас:

```
- **Render tick**: `sample(now)` returns the length of the flat **hot
  buffer** — `new Float32Array(wasm.memory.buffer, hot_ptr(), len)` read
  zero-copy. The view is recreated every tick and lives only until the WASM
```

Заменить начало пункта до слов «The view is recreated…» (сами эти слова и
всё дальше не менять):

```
- **Render tick**: `sample(now)` returns the length of the flat **hot
  buffer**, read zero-copy: `hot_ptr()` first, then
  `new Float32Array(wasm.memory.buffer, ptr, len)` — the buffer is taken
  after the call into the core, never before it. The view is recreated
  every tick and lives only until the WASM
```

Переносы строк выровнять до ~80 символов, не меняя слов.

`docs/ru/client.md`, пункт **Рендер-тик** (~стр. 235–236, с переносами).
Сейчас:

```
- **Рендер-тик**: `sample(now)` возвращает длину плоского **hot-буфера** —
  `new Float32Array(wasm.memory.buffer, hot_ptr(), len)` читается zero-copy.
```

Заменить на:

```
- **Рендер-тик**: `sample(now)` возвращает длину плоского **hot-буфера**, он
  читается zero-copy: сначала `hot_ptr()`, затем
  `new Float32Array(wasm.memory.buffer, ptr, len)` — buffer берётся после
  вызова ядра, а не до него.
```

Следующее предложение («View пересоздаётся каждый тик…») не менять.

### 3.2 Зеркало тика в headless-раннере (№5)

`packages/engine/src/devtools/VirtualClient.js`.

1. Шапка модуля, стр. 11–13. Сейчас:

   ```js
   // Рендер-конвейер повторяет client/main.js:renderTick, но hot читается через
   // hot_values() (копия), а не hot_ptr()+память WASM: в Node нет смысла в
   // zero-copy, а копия не детачится при росте памяти ядра.
   ```

   Заменить на:

   ```js
   // Рендер-конвейер повторяет client/lib/hotTick.js (его зовёт renderTick в
   // client/main.js): порядок применения тот же — кадры → горячие данные →
   // камера. Hot читается через hot_values() (копия), а не hot_ptr()+память
   // WASM: в Node нет смысла в zero-copy, а копия не детачится при росте
   // памяти ядра — поэтому порядок ЧТЕНИЯ, ради которого hotTick.js вынесен
   // из main.js, здесь не важен.
   ```

2. JSDoc метода `render`, стр. 219. Строку
   `* Рендер-тик: зеркало client/main.js:renderTick без PixiJS.` заменить на
   `* Рендер-тик: зеркало client/lib/hotTick.js без PixiJS.`

---

## Влияние на релиз (сообщить разработчику в отчёте)

- Этап 1 меняет `src/client/SoundManager.js`, а он входит в `files`
  npm-пакета `vimp-engine`. Подзаголовок `### Fixed` означает **patch**:
  0.35.3 → 0.35.4. Выпуск — `npm run release`, его делает разработчик.
  Прод получает правку деплоем бокса (push в `main`).
- Этапы 2–3 не меняют опубликованное поведение: тесты, документация,
  комментарии. `src/devtools/` входит в `files`, но правка там — только
  комментарий.
- `contract/surface.json`, крейт `vimp-engine-core` и `docs/ai/` не
  меняются. vimp-tanks следовать не обязан: свой `rate` игра уже защищает
  сама.

## Проверка по окончании

1. Из корня `/Users/dmitry/Sites/my/vimp`: `npx eslint .` и `npx vitest run
   --reporter=dot` — зелёные.
2. Все проверки из этапов выполнены, после каждой код возвращён:
   - этап 1: без правки в `updateActiveSounds` новый кейс падает с
     `TypeError`;
   - этап 2.1: при возврате `>=` и снятии проверки в `_writePos` кейс
     `processAudibility` падает;
   - этап 2.2: при маске `flags & HOT_FLAGS.GAME` кейс «только PREDICTED»
     падает.
3. В английских абзацах, которые правил этот план, нет строк длиннее ~80
   символов. Проверка: `git diff -U0 -- docs/en | grep '^+' | grep -v '^+++'
   | awk 'length > 82'` ничего не выводит.
4. `sed -n '/^## \[Unreleased\]/,/^## \[0.35.3\]/p'
   packages/engine/CHANGELOG.md` показывает одну запись `### Fixed` про
   `rate`. Секция `[0.35.3]` не изменилась: `git diff
   packages/engine/CHANGELOG.md` затрагивает только строки выше неё.
