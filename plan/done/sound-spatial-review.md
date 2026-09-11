# План: исправления по итогам кодревью задачи `sound-spatial`

Ревью коммитов `e33af858` (vimp-engine), `2b62ca6` (vimp-tanks),
`d39a754` (vimp-snakes) против исходного плана
[`plan/done/sound-spatial/README.md`](done/sound-spatial/README.md).

**Общая оценка: задача сделана хорошо.** Математика корректна и совпадает с
эталоном плана, санитаризация конфига честная, документация (en/ru/ai)
полная и зеркальная, тесты содержательные — они проверяют поведение
(непрерывность, углы, профили), а не вызовы. Ниже — только то, что стоит
доделать; ничего из этого не является блокером релиза.

Отметка о готовности этапа — «✅ выполнен» рядом с его заголовком.

---

## Сводка находок

| № | Этап | Severity | Критерий |
| --- | --- | --- | --- |
| 1 ✅ | [Гейт 30 Гц глушит не только позицию](#этап-1) | средняя | работоспособность, документированность |
| 2 ✅ | [`getCameraZoom()` игнорирует `currentScale`](#этап-2) | средняя | работоспособность |
| 3 ✅ | [E6 не воспроизводит правило `maxDistance > refDistance`](#этап-3) | средняя | работоспособность |
| 4 ✅ | [Тройное дублирование дефолтов и списков](#этап-4) | средняя | DRY, поддерживаемость |
| 5 ✅ | [Мелкие дефекты `SoundManager`](#этап-5) | низкая | производительность, поддерживаемость |
| 6 ✅ | [Тестовые фабрики и непокрытые места](#этап-6) | низкая | тестируемость |
| 7 ✅ | [Точечные правки документации](#этап-7) | низкая | документированность |

Безопасность: замечаний нет. Конфиг пишет автор игры, каждый ключ
санитаризуется по отдельности, `JSON.stringify` в `console.warn` не даёт
инъекции, произвольные ключи в узел не попадают (`pannerAttr` собирается
из закрытого списка).

Масштабируемость: `WORLD_VOICE_LIMIT = 30` не тронут, стоимость кадра
после правки **упала** (порог смещения + гейт частоты) — см. этап 5.6 о
единственном оставшемся вопросе (пиковая нагрузка в кадр).

---

## Этап 1 — гейт 30 Гц глушит не только позицию ✅ выполнен

### Проблема

`packages/engine/src/client/SoundManager.js:452-503`. Гейт частоты
завёрнут вокруг **всего** вызова `_updateSpatialSound`:

```javascript
if (writePosition) {
  this._updateSpatialSound(sound, soundId, position.x, position.y, volume, spatial);
}
```

Но `_updateSpatialSound` — единственное место, где для зацикленного звука
применяется громкость: `sound.volume(volume, soundId)` (строки 678 и 697)
и глушение за радиусом `sound.volume(0, soundId)` (строка 692). Под гейт,
таким образом, попали:

1. изменение `volume` через `updateSoundData` — в танках громкость
   двигателя ведётся от скорости, теперь она приезжает с задержкой до
   33 мс и ступеньками по 30 Гц вместо 60;
2. глушение при пересечении `maxDistance`;
3. вся ветка `spatial === false` (собственный двигатель игрока) —
   `sound.volume` + `_recenterIfPanned` тоже раз в два кадра.

Слышимость эффекта невелика, но **три текста утверждают обратное**:

- комментарий `SoundManager.js:453-455` — «Уборка мёртвых экземпляров и
  rate под гейт не попадают»;
- `docs/en/client.md` → «Only the position is gated»;
  `docs/ru/client.md` → «Под гейт попадает только позиция»;
- `packages/engine/CHANGELOG.md`, `### Fixed` → «a rate gate holds position
  writes to 30 Hz».

То есть код и документация разошлись, и разошлись именно там, где следующий
человек будет искать причину «громкость двигателя дёргается».

### Решение

Разделить два действия: громкость — покадрово, позиция — под гейтом.

1. Выделить из `_updateSpatialSound` приватный `_applyVolume(sound, soundId,
   volume, spatial)`, который возвращает `true`, если источник слышим
   (внутри `maxDistance`), и `false`, если заглушен:

   ```javascript
   _applyVolume(sound, soundId, volume, spatial) {
     if (spatial === false) {
       sound.volume(volume, soundId);
       return true;
     }

     const dx = ...; const dy = ...;
     if (Math.hypot(dx, dy) >= this._spatial.maxDistance) {
       sound.volume(0, soundId);
       return false;
     }

     sound.volume(volume, soundId);
     return true;
   }
   ```

   Дистанция считается дважды за кадр (в `_applyVolume` и
   `_updateSpatialSound`) — это два `hypot` на голос, на порядки дешевле
   одного `pos()`; ради читаемости это приемлемо. Альтернатива, если не
   нравится: вернуть из `_applyVolume` саму дистанцию и передать её
   параметром в `_updateSpatialSound`.

2. `_updateSpatialSound` оставить **только про геометрию**: убрать из него
   вызовы `sound.volume` и раннее возвращение по `maxDistance` (перенести
   в `_applyVolume`), оставить ветку `spatial === false` →
   `_recenterIfPanned` + `return`. Переименование не нужно — имя уже
   точное.

3. В `updateActiveSounds` порядок:

   ```javascript
   const audible = this._applyVolume(sound, soundId, volume, spatial);

   if (audible && writePosition) {
     this._updateSpatialSound(sound, soundId, position.x, position.y, spatial);
   }
   ```

4. В `processAudibility` (строки 431-438) заменить одиночный вызов на ту же
   пару — при старте звука позиция обязана записаться сразу, гейт там не
   применяется.

5. Обновить комментарий `SoundManager.js:453-455`: «Под гейт попадает
   только запись позиции. Громкость, уборка мёртвых экземпляров и `rate`
   идут каждый кадр».

6. Обновить `docs/en/client.md` и `docs/ru/client.md`, раздел «How often the
   position is written» / «Как часто пишется позиция»: перечислить, что
   именно остаётся покадровым (громкость, `rate`, уборка).

7. `packages/engine/CHANGELOG.md`: правка внутри существующего `### Fixed` —
   уровень релиза не поднимает.

### Критерий приёмки

- `npx eslint .` чисто, `npm test` зелёный;
- новый тест: `updateActiveSounds` внутри интервала гейта **не** зовёт
  запись позиции, но громкость применяет (`sound.volume` вызван на каждом
  из двух кадров, `sound.pos` — на одном);
- новый тест: источник, ушедший за `maxDistance` между кадрами, глушится
  в том же кадре, а не через 33 мс.

---

## Этап 2 — `getCameraZoom()` игнорирует `currentScale` ✅ выполнен

### Проблема

`packages/engine/src/client/components/model/CanvasManager.js:100-102`:

```javascript
getCameraZoom() {
  return this._hasDynamicCamera ? this._camZoomModifier : 1;
}
```

Отдаётся только **динамический** множитель. Но реальный экранный масштаб —
это (строка 309) `finalScale = currentScale * this._camZoomModifier`, где
`currentScale = baseScale * (ширина окна / 1920)` (строка 147, `_designWidth
= 1920`).

Обоснование самой правки, записанное в коде и в документации, звучит так:
«при отдалении картинка сжимается, и стереобаза обязана сжаться так же,
иначе звук шире того, что видит глаз» (`SoundManager.js:699-701`,
`docs/en|ru/client.md`). Но ровно тот же аргумент относится к размеру окна,
и он **не учтён**. Более того, документация сама даёт формулу калибровки
`H ≈ (высота полотна / 2) / currentScale` — то есть признаёт зависимость
от `currentScale`, но в рантайм её не проводит.

Числовой пример на танках (`baseScale 5`, `virtualElevation: 108`,
статичная камера, `zoom = 1`):

| Ширина окна | `currentScale` | Видимая полувысота, мировых ед. | `H` | Угол на краю экрана |
| --- | --- | --- | --- | --- |
| 1920 | 5.0 | 108 | 108 | ~60° (расчётный) |
| 1280 | 3.33 | 162 | 108 | ~72° |
| 800 | 2.08 | 259 | 108 | ~80° |

На окне вполовину экрана панорама оказывается заметно шире картинки —
именно тот дефект, ради которого зум и пробрасывали. Игрок на ноутбуке
получает не ту геометрию, под которую подобраны числа игры.

### Решение

Отдавать полный масштабный множитель относительно расчётного дизайна.

1. В `CanvasManagerModel` завести приватный геттер эталонного полотна.
   Полотном по умолчанию логично взять то же, по которому считается
   указатель, — `this._pointerCanvasId` (у игры оно, как правило, одно и
   именно оно игровое):

   ```javascript
   // множитель масштаба сцены относительно расчётного 1920: и размер окна
   // (currentScale), и динамический зум. Звук обязан сжиматься вместе с
   // картинкой, иначе стереобаза шире того, что видит глаз
   getCameraZoom() {
     const canvas = this._data[this._pointerCanvasId];

     if (!canvas) {
       return 1;
     }

     const windowScale = canvas.currentScale / canvas.baseScale;
     const zoom = this._hasDynamicCamera ? this._camZoomModifier : 1;

     return windowScale * zoom;
   }
   ```

   `currentScale / baseScale` — это ровно `ширина окна / 1920` (см. строку
   147), но записанное через уже посчитанные поля: если формула масштаба
   когда-нибудь изменится, геттер не отстанет.

2. `SoundManager.setListenerPosition` уже страхует значение
   (`Number.isFinite(scale) && scale > 0`) — правок не требует. Проверить,
   что при свёрнутом окне `currentScale` не уходит в 0: в `resize()`
   (строки ~150) нулевой resize уже отсекается, но геттер обязан пережить
   и вызов до первого `resize`.

3. Обновить `docs/en/client.md` + `docs/ru/client.md`: сейчас там сказано
   «Camera zoom divides the elevation and the spread radius» — заменить на
   «масштаб сцены (размер окна × динамический зум)», и снять из формулы
   калибровки оговорку про `currentScale`, потому что после правки
   `virtualElevation` калибруется **в расчётном окне 1920×1080**, а
   остальные размеры движок компенсирует сам. Это упрощает игровую
   документацию: числа `108` (tanks) и `180` (snakes) остаются верными и
   становятся размеро-независимыми.

4. Обновить абзацы про калибровку в `vimp-tanks/docs/en|ru/configuration.md`
   и `vimp-snakes/docs/en|ru/configuration.md`: значение не меняется,
   меняется формулировка — «для окна 1920×1080; движок сам пересчитает под
   другое окно».

5. `packages/engine/CHANGELOG.md` → `### Fixed`: «позиция слушателя учитывает
   и размер окна, а не только динамический зум».

### Риск и оговорка

Правка **меняет звучание на не-1920 окнах**. Это исправление, а не
регрессия, но подтвердить его можно только ручным смоуком (окно 1280 и
окно на полный 4K), который в исходной задаче так и не был проведён.
Поэтому этап держать отдельным коммитом.

### Критерий приёмки

- тест `CanvasManagerModel.getCameraZoom`: после `resize({width: 960, ...})`
  геттер отдаёт `0.5` при статичной камере и `0.5 * _camZoomModifier` при
  динамической;
- тест: до первого `resize` геттер отдаёт `1`, а не `NaN`;
- `npx eslint .`, `npm test` зелёные.

---

## Этап 3 — E6 не воспроизводит правило `maxDistance > refDistance` ✅ выполнен

### Проблема

Два места проверяют одно условие по-разному.

Рантайм, `SoundManager._resolveSpatialConfig` (строки 621-629), сравнивает
**разрешённые** значения — объявленное против дефолта:

```javascript
let refDistance = num('refDistance', true);   // объявлено ИЛИ дефолт 200
let maxDistance = num('maxDistance', true);   // объявлено ИЛИ дефолт 1200

if (maxDistance <= refDistance) { /* откат ОБОИХ на дефолт */ }
```

Правило контракта E6 (`e6-sound-spatial.js:102-110`) сравнивает только
если объявлены **оба**:

```javascript
if (Number.isFinite(spatial.refDistance) && Number.isFinite(spatial.maxDistance) && ...)
```

Дыра: игра объявляет `spatial: { maxDistance: 150 }` (например, маленькая
арена). Контракт — `pass`. Рантайм: `150 <= 200` → `console.warn` и откат
на `200 / 1200`, то есть **ровно противоположное тому, что просила игра**,
молча, в браузере, в проде. Это тот самый «тихий отказ», ради которого
правило E6 и написано (см. его собственный комментарий, строки 26-28).

Второй, меньший дефект — в самом рантайме: при нарушении откатываются
**оба** ключа, включая корректно объявленный `refDistance`, а
предупреждение печатается только про `maxDistance`. Читая консоль, автор
игры не узнает, что его `refDistance` тоже выброшен.

### Решение

1. **E6** — сравнивать разрешённые значения, ровно как рантайм:

   ```javascript
   // дефолты движка: сравнение обязано совпадать с
   // SoundManager._resolveSpatialConfig, иначе контракт пропустит то,
   // что рантайм молча откатит
   const refDistance = Number.isFinite(spatial.refDistance)
     ? spatial.refDistance
     : SPATIAL_DEFAULTS.refDistance;
   const maxDistance = Number.isFinite(spatial.maxDistance)
     ? spatial.maxDistance
     : SPATIAL_DEFAULTS.maxDistance;

   if (maxDistance <= refDistance) {
     violations.push(
       `maxDistance (${maxDistance}) must be greater than refDistance ` +
       `(${refDistance}); undeclared values fall back to engine defaults`,
     );
   }
   ```

   `SPATIAL_DEFAULTS` берётся из общего модуля — см. этап 4.

2. **Рантайм** — печатать одно внятное предупреждение про обе величины:

   ```javascript
   if (maxDistance <= refDistance) {
     console.warn(
       `[SoundManager] spatial.maxDistance (${maxDistance}) must exceed ` +
       `spatial.refDistance (${refDistance}); both fall back to ` +
       `${SPATIAL_DEFAULTS.refDistance}/${SPATIAL_DEFAULTS.maxDistance}`,
     );
     refDistance = SPATIAL_DEFAULTS.refDistance;
     maxDistance = SPATIAL_DEFAULTS.maxDistance;
   }
   ```

   Откат обоих оставить: пара должна остаться согласованной, чинить один
   ключ «наполовину» хуже. Но сказать об этом вслух.

3. Заодно закрыть смежную мелочь: E6 не отмечает `verticalFactor`,
   объявленный при `mode` ≠ `sideScroller`, — это тихий no-op. Добавить
   `warn`-нарушение:

   ```javascript
   if (spatial.verticalFactor !== undefined && (spatial.mode ?? 'topDown') !== 'sideScroller') {
     violations.push('verticalFactor is only used by mode "sideScroller"');
   }
   ```

4. Обновить строку E1–E6 в `docs/en/debugging.md` и `docs/ru/debugging.md`:
   упомянуть, что сравнение идёт с учётом движковых дефолтов, и про
   `verticalFactor`.

### Критерий приёмки

- `tests/devtools/contract/rules.test.js`: `{ maxDistance: 150 }` (без
  `refDistance`) → **fail**; `{ refDistance: 50 }` (без `maxDistance`) →
  pass; `{ verticalFactor: 0.3 }` при `topDown` → fail; при
  `sideScroller` → pass;
- `tests/client/SoundManager.test.js`: существующий тест «`maxDistance` не
  больше `refDistance` откатывает обе дистанции» дополнить проверкой, что
  предупреждение упоминает оба ключа;
- `node packages/engine/bin/vimp-contract.js --game ../vimp-tanks` и
  `--game ../vimp-snakes` — E6 по-прежнему `pass`.

---

## Этап 4 — тройное дублирование дефолтов и списков ✅ выполнен

### Проблема

Одно и то же знание живёт в трёх файлах, и синхронность держится на
комментарии.

| Файл | Что дублирует |
| --- | --- |
| `packages/engine/src/client/SoundManager.js:11-20` | `SPATIAL_DEFAULTS` (8 чисел и строк) |
| `packages/engine/src/config/clientDefaults.js:15-45` | те же 8 значений в `parts.sounds.spatial` |
| `packages/engine/src/client/SoundManager.js:68-70` | `SPATIAL_MODES` / `PANNING_MODELS` / `DISTANCE_MODELS` |
| `packages/engine/src/devtools/contract/rules/e6-sound-spatial.js:3-17` | те же три списка + знаки числовых полей |

Комментарий `SoundManager.js:6-10` честно говорит: «Значения должны
совпадать» — и ничто их совпадение не проверяет. Сценарий поломки прямой:
кто-то правит дефолт в `clientDefaults.js` (это «конфиг», туда и полезут),
а `SPATIAL_DEFAULTS` остаётся старым. Расхождение проявится только в
`standalone`/пустом конфиге и будет неотличимо от «звук просто другой».

Второй, более коварный случай: в `clientDefaults.js` **намеренно нет**
ключа `panningModel` — он должен приходить из профиля, чтобы
`sideScroller` получал `equalpower`. Это отсутствие несущее, но в самом
файле ничем не помечено. Первый же человек, который «добавит забытый ключ»,
молча сломает профиль `sideScroller` для всех игр.

### Решение

1. Новый модуль `packages/engine/src/config/spatialDefaults.js` — один
   источник:

   ```javascript
   // Дефолты и словарь допустимых значений пространственного звука.
   // Единственный источник для трёх потребителей: clientDefaults.js
   // (движковый конфиг игры), SoundManager (страховка на пустой конфиг)
   // и правило контракта E6 (статическая проверка).
   export const SPATIAL_DEFAULTS = { mode: 'topDown', virtualElevation: 180, ... };

   // знак каждого числового поля: 'positive' | 'non-negative'
   export const SPATIAL_NUMERIC = { virtualElevation: 'positive', ... };

   export const SPATIAL_MODES = ['topDown', 'sideScroller', 'cockpit'];
   export const PANNING_MODELS = ['HRTF', 'equalpower'];
   export const DISTANCE_MODELS = ['linear', 'inverse', 'exponential'];
   ```

   `panningModel` в `SPATIAL_DEFAULTS` **не входит** — с комментарием,
   объясняющим почему (значение приносит профиль; жёсткий дефолт отнял бы
   у `sideScroller` его `equalpower`).

   Проверить границы: `src/config/` уже импортируется и клиентом, и
   devtools (`clientDefaults` тянет `createHostRuntime`), новый файл —
   чистые данные без Node-глобалов, `host/meta/`-инвариант не нарушает,
   правило «devtools не попадает в бандл приложения» — тоже (зависимость
   односторонняя: devtools → config).

2. `SoundManager.js` — импортирует всё из нового модуля, локальные
   константы удаляются. `SPATIAL_PROFILES` (с `mapCoords`) остаётся в
   `SoundManager.js`: это код рендера звука, а не конфиг; ключи профилей
   `SPATIAL_MODES` уже приезжают из общего модуля — добавить `assert`-тест
   на совпадение `Object.keys(SPATIAL_PROFILES)` и `SPATIAL_MODES`.

3. `clientDefaults.js` — раскладывает `SPATIAL_DEFAULTS` в
   `parts.sounds.spatial`, комментарии (они полезные, объясняют «почему»)
   остаются на месте:

   ```javascript
   parts: { sounds: { spatial: { ...SPATIAL_DEFAULTS } } },
   ```

   Ниже добавить комментарий про намеренно отсутствующий `panningModel`.

4. `e6-sound-spatial.js` — импортирует `SPATIAL_DEFAULTS`,
   `SPATIAL_NUMERIC`, три списка; локальные копии удаляются. `KNOWN`
   собирается как `['mode', 'panningModel', 'distanceModel',
   ...Object.keys(SPATIAL_NUMERIC)]`.

5. `_resolveSpatialConfig` — `num(key, positiveOnly)` заменить на чтение
   знака из `SPATIAL_NUMERIC[key]`, чтобы знак поля тоже был объявлен один
   раз.

### Критерий приёмки

- новый тест `tests/config/spatialDefaults.test.js`:
  `clientDefaults.parts.sounds.spatial` строго равен `SPATIAL_DEFAULTS`;
  `Object.keys(SPATIAL_PROFILES)` равен `SPATIAL_MODES`;
  `'panningModel' in SPATIAL_DEFAULTS === false`;
- `grep -rn "topDown" packages/engine/src` — литерал остаётся только в
  `spatialDefaults.js` и в `SPATIAL_PROFILES`;
- `npx eslint .`, `npm test`, оба прогона `vimp-contract` зелёные.

---

## Этап 5 — мелкие дефекты `SoundManager` ✅ выполнен

Пять независимых правок, каждая небольшая.

### 5.1 `_recenterIfPanned` не пользуется собственным порогом

`SoundManager.js:740-754`. Метод **пишет** `_pannerPos`, но не **читает**
его: `sound.pos(0, 0, 0, soundId)` уходит в узел на каждом кадре, где
источник непространственный и уже панорамировался.

Автор оставил это сознательно («одиночный экземпляр, в общий поток вносит
почти ничего»), и это верно по объёму. Но по смыслу это ровно тот
источник, который в Safari звучит **непрерывно и всегда** (собственный
двигатель игрока), то есть последний кандидат на исключение из
оптимизации, сделанной ради Safari.

**Решение**: вынести сравнение с порогом в приватный
`_writePos(sound, soundId, px, py, pz)` и звать его из обоих мест —
`_updateSpatialSound` и `_recenterIfPanned`:

```javascript
_writePos(sound, soundId, px, py, pz) {
  const written = this._pannerPos.get(soundId);

  if (
    written !== undefined &&
    Math.abs(written[0] - px) < POSITION_EPSILON &&
    Math.abs(written[1] - py) < POSITION_EPSILON &&
    Math.abs(written[2] - pz) < POSITION_EPSILON
  ) {
    return;
  }

  sound.pos(px, py, pz, soundId);
  this._pannerPos.set(soundId, [px, py, pz]);
  this._pannedIds.add(soundId);
}
```

Существующий тест «мировой источник в дед-зоне…» / тесты `_recenterIfPanned`
поправить: ожидание «`pos(0,0,0)` на каждом кадре» заменить на «один раз».
Это заодно снимает дублирование блока порога (сейчас он выписан один раз,
но при второй точке записи выписался бы второй).

### 5.2 Дублирование уборки экземпляра — пять точек

Блок из четырёх удалений повторяется дословно:

- `updateActiveSounds` (строки 473-477), `_internalPlay` (537-540),
  `_internalStop` (557-560), плюс `reset()` (803-807) в форме `.clear()`.

Пятый набор (когда он появится) придётся дописывать в четыре места, и
пропуск одного даст утечку, которую не поймает ни один тест.

**Решение**: приватный `_forgetInstance(soundId)`:

```javascript
// забывает всё, что помнилось про экземпляр Howler. Единственная точка:
// набор полей растёт, а пропущенная точка уборки — это утечка, которую
// видно только по памяти
_forgetInstance(soundId) {
  this._activeInstances.delete(soundId);
  this._equalPowerIds.delete(soundId);
  this._pannedIds.delete(soundId);
  this._pannerPos.delete(soundId);
}
```

Позвать из трёх мест; в `reset()` оставить `.clear()` на каждой коллекции
(там семантика другая — очистка целиком).

### 5.3 Гейт даёт нерегулярный такт

`SoundManager.js:456-462`: `this._lastPositionWrite = now` без накопления и
без допуска. При кадре 60 Гц (16.67 мс) и джиттере такт скачет между 30 и
20 Гц: кадр, пришедший на 33.30 мс, отсекается, и запись уезжает на 50 мс.
Слышно это не будет, но неравномерный шаг панорамы — не то, ради чего
гейт ставили.

**Решение**: допуск в полкадра:

```javascript
// допуск: кадр, опоздавший к границе интервала на доли миллисекунды, не
// должен уезжать на следующий — иначе такт скачет между 30 и 20 Гц
const POSITION_UPDATE_TOLERANCE = 2;

const writePosition =
  now - this._lastPositionWrite >= POSITION_UPDATE_INTERVAL - POSITION_UPDATE_TOLERANCE;
```

Тест: три «кадра» на 0 / 32 / 64 мс дают три записи, а не две.

### 5.4 Пиковая нагрузка вместо равномерной

Гейт общий на весь менеджер: все до 30 голосов пишут позицию **в одном
кадре**, следующие два кадра простаивают. В пике это ~90 `setValueAtTime`
за один кадр — то есть та самая пачка автоматизации, из-за которой WebKit
и захлебнулся; средняя нагрузка упала вдвое, пиковая осталась прежней.

**Решение (по желанию, после ручного смоука в Safari)**: хранить время
последней записи на экземпляр (`_pannerPos` уже per-instance — добавить в
него четвёртым элементом или завести `_pannerWriteAt: Map`) и разносить
фазу по `soundId % 2`. Делать это стоит **только** если после этапов 1 и
5.1 в Safari останутся артефакты: сложность здесь платная, а выигрыш
гипотетический. Записать как открытый вопрос, а не как обязательную
правку.

### 5.5 `equalpower` необратим

`_applyEqualPower` (строки 760-767) кладёт `soundId` в `_equalPowerIds`
навсегда — HRTF не возвращается никогда. Между тем JSDoc
`_recenterIfPanned` (строки 736-738) обещает: «миру HRTF сохраняется — он
снова понадобится, как только источник выйдет из дед-зоны», а
`registerSound` документирует `updateSoundData(id, { spatial })` как
двусторонний переключатель.

Практически недостижимо (в танках флаг переключается один раз, из `true`
в `false`, когда владелец узнаёт, что танк локальный), поэтому **кода
менять не нужно**. Достаточно снять обещание: переписать JSDoc
`_recenterIfPanned` и абзац `spatial` в `registerSound` — сказать, что
перевод на `equalpower` односторонний и рассчитан на однократное
переключение флага. Если когда-нибудь понадобится обратный переход,
восстановить HRTF придётся явно.

### 5.6 Аллокация на каждую запись позиции

`this._pannerPos.set(soundId, [px, py, pz])` — новый массив на каждую
запись: до 30 массивов раз в 33 мс, ~900 в секунду. Для GC это шум, а не
проблема, но правится в одну строку — переиспользовать уже лежащий массив:

```javascript
const written = this._pannerPos.get(soundId);

if (written === undefined) {
  this._pannerPos.set(soundId, [px, py, pz]);
} else {
  written[0] = px; written[1] = py; written[2] = pz;
}
```

Делать внутри `_writePos` из 5.1, чтобы точка записи осталась одна.

### Критерий приёмки этапа 5

- `npx eslint .` чисто, `npm test` зелёный;
- тест 5.1: `spatial: false` на неподвижном источнике зовёт `pos` один раз
  за три кадра;
- тест 5.2: после `_internalStop` все четыре коллекции не содержат
  `soundId` (один тест вместо проверок вразнобой);
- тест 5.3: кадры 0 / 32 / 64 → три записи.

---

## Этап 6 — тестовые фабрики и непокрытые места ✅ выполнен

### Проблема

`tests/client/SoundManager.test.js` собирает `this` вручную и зовёт методы
через прототип. Подход осознанный и рабочий, но фабрик уже **четыре**
(`makeCtx`, `makeRegistryCtx`, `makeSpatialCtx`, `makeLoopCtx`) плюс
`makeZoomCtx`, и этот коммит был вынужден дописать `_pannerPos`,
`_lastPositionWrite`, `_pannedIds`, `_spatial` в каждую по отдельности.
Цена ошибки не «тест упал», а «тест зелёный на объекте, который класс
никогда не создаёт»: любое поле, забытое в фабрике, просто не участвует, и
проверка молча становится слабее.

Не покрыты:

- **порядок в `applyCamera`** (`main.js:903-914`) — весь смысл этапа 3
  плана: `updateCoords` обязан идти **до** `setListenerPosition`, иначе
  слушатель получает зум прошлого кадра. Перестановка двух строк не сломает
  ни один тест;
- **согласованность `SPATIAL_DEFAULTS` и `clientDefaults`** (см. этап 4).

### Решение

1. Общая фабрика поверх настоящего прототипа:

   ```javascript
   // состояние настоящего экземпляра без конструктора (тот трогает Howler).
   // Одна точка: новое поле класса добавляется здесь, а не в пяти литералах
   const makeManager = (overrides = {}) =>
     Object.assign(Object.create(SoundManager.prototype), {
       _sounds: new Map(),
       _activeInstances: new Map(),
       _registeredSounds: new Map(),
       _equalPowerIds: new Set(),
       _pannedIds: new Set(),
       _pannerPos: new Map(),
       _lastPositionWrite: -Infinity,
       _spatial: P._resolveSpatialConfig.call({}),
       _listenerScale: 1,
       _listenerX: 0,
       _listenerY: 0,
     }, overrides);
   ```

   Существующие фабрики переписать как тонкие обёртки над ней
   (`makeSpatialCtx = (spatial, scale) => makeManager({ _listenerX: 100, ... })`),
   чтобы диффы тестов остались читаемыми. Методы больше не подставляются
   поимённо — они приходят из прототипа.

2. Тест на порядок в `applyCamera`. `main.js` — модуль с побочными
   эффектами, целиком его не поднять; вместо этого вынести тело
   `applyCamera` в тестируемую чистую функцию рядом с ней:

   ```javascript
   // порядок важен: зум пересчитывается внутри updateCoords, а слушателю
   // нужен зум ЭТОГО кадра, а не прошлого
   export function applyCameraTo(canvasManager, soundManager, camera) { ... }
   ```

   и покрыть её тестом, который проверяет, что `getCameraZoom` вызван
   **после** `updateCoords` (через `mock.invocationCallOrder`).

3. Тест согласованности дефолтов — в этапе 4.

### Критерий приёмки

- в `tests/client/SoundManager.test.js` нет литералов состояния, кроме
  `makeManager`;
- новый тест на порядок вызовов в `applyCamera` падает, если поменять две
  строки местами (проверить руками);
- `npm test` зелёный.

---

## Этап 7 — точечные правки документации ✅ выполнен

Документация задачи сделана заметно лучше среднего: `docs/en` и `docs/ru`
зеркальны по содержанию, формула, таблица профилей и обоснование «почему
именно так» на месте, в игровых репозиториях объяснено происхождение
каждого числа. Правки — точечные.

### 7.1 «Под гейт попадает только позиция»

Три текста (комментарий, `client.md` en/ru, `CHANGELOG.md`) утверждают
неверное — закрывается этапом 1, здесь только отметка, что все три надо
проверить вместе.

### 7.2 `docs/ai/07-maps-and-assets.md` — чужие числа как пример

Строка 207:

```javascript
spatial: { mode: 'topDown', virtualElevation: 108, innerRadius: 5 },
```

Это конкретные числа `vimp-tanks`, привязанные к `mapScale 0.3` /
`baseScale 5`. Файл читает LLM, генерирующая **новую** игру с другим
масштабом, — и скопирует их дословно. Заменить на движковые дефолты с
пояснением:

```javascript
// optional: spatial geometry; omit it and the engine defaults apply.
// The numbers are WORLD units — recalculate them for your scale,
// see 04-client-plugin.md
spatial: { mode: 'topDown', virtualElevation: 180, innerRadius: 40 },
```

### 7.3 `vimp-tanks/CHANGELOG.md` — несуществующее требование

Запись `[Unreleased] → Changed` заканчивается фразой:

> Requires a `vimp-engine` that supports `parts.sounds.spatial`.

Это неверно и не подкреплено:

- старый движок **не ломается**: `SoundManager.init` берёт из конфига
  `{ codecList, path, sounds }`, лишний ключ `spatial` просто
  игнорируется — деградация мягкая, игра звучит по-старому;
- зависимость не поднята (`vimp-engine: ^0.32.3` в `package.json`);
- в `GameManifest.requires` возможности не добавлено — и правильно, потому
  что инвариант 1 плана прямо говорит: блок необязателен, а
  `src/lib/capabilities.js` заводится только под то, без чего игра **не
  может** работать. Здесь — может.

Убрать фразу либо заменить на «более старый движок ключ игнорирует, звук
остаётся прежним». То же проверить в `vimp-snakes/CHANGELOG.md` (там
формулировка та же).

### 7.4 `virtualElevation: 108` в танках так и не проверен на слух

Исходный план (`plan/done/sound-spatial/README.md`, «Что осознанно
оставлено на исполнителя») задавал `108` как расчётную отправную точку с
диапазоном подбора 90–150 и критерием приёмки «ручной смоук этапа 9».
Отчёт по этапу 9 фиксирует: «ручной браузерный смоук не проводился».

Формально этап закрыт, фактически число не подтверждено — и после этапа 2
(учёт `currentScale`) его тем более надо переслушать. Добавить в
`vimp-tanks/docs/en|ru/configuration.md` одну строку о том, что значение
расчётное и диапазон подбора 90–150, чтобы следующий человек не принял его
за выверенное на слух.

### Критерий приёмки

- `docs/en` и `docs/ru` остаются зеркальными (проверить оглавления и
  наличие одинаковых подразделов);
- `npx eslint .` (markdown не трогает, но прогон обязателен),
  `npm test` зелёный.

---

## Порядок выполнения

Этапы независимы, кроме двух связок: **этап 3 опирается на общий модуль
из этапа 4**, а **пункт 7.1 закрывается этапом 1**. Разумный порядок:

```
4 (общий модуль)  →  3 (E6)
1 (гейт и громкость)  →  7.1
5 (мелочи SoundManager)
6 (тесты)
2 (масштаб окна)      ← отдельным коммитом, требует ручного смоука
7.2–7.4 (документация)
```

## Релизное влияние (по итогам ревью самой задачи)

Отчёт исполнителя по этапу 9 верен и полон, подтверждаю:

- **артефакт** — npm-пакет `vimp-engine` (`packages/engine/src/**` входит в
  `files`); крейт `vimp-engine-core` и `create-vimp-game` не затронуты;
- **бамп — minor, `0.32.3 → 0.33.0`**: в `[Unreleased]` есть `### Added`;
- `packages/engine/contract/surface.json` не редактировался, из
  замороженной поверхности ничего не удалено, `ENGINE_API_VERSION`
  остаётся 4 — `⚠️ Breaking` не применяется;
- играм следовать не обязательно: конфиг без блока `spatial` остаётся
  валидным;
- предпубликационные проверки, перечисленные в отчёте, воспроизводятся;
  **ручной браузерный смоук по-прежнему не проведён** — и после этапа 2
  этого плана он становится обязательным условием релиза.

Правки этого плана уровень релиза не поднимают: этапы 1, 2, 3, 5 — `Fixed`,
этапы 4, 6, 7 — рефакторинг, тесты и документация, то есть не записи
журнала вовсе.

---

## Отступления от плана при исполнении

1. **Проверка `verticalFactor` в E6 (пункт 3.3) не добавлена.** Она была
   написана и сразу же провалила новый тест «движковые дефолты сами проходят
   E6»: `SPATIAL_DEFAULTS` содержит `verticalFactor: 0.2` при
   `mode: 'topDown'`, и именно этот полный блок документация показывает как
   образец (`docs/en|ru/client.md`, `docs/ai/04-client-plugin.md`). Правило
   кричало бы на честный копипаст из собственной документации, а лишний ключ
   безвреден — неверное *число* и так ловится проверкой знака. Проверка
   удалена, причина записана комментарием в самом правиле, чтобы её не
   добавили повторно.

2. **Пункт 5.4 (пиковая нагрузка) не выполнен — как и предписано планом.**
   Он был помечен «по желанию, только если после этапов 1 и 5.1 в Safari
   останутся артефакты». Ручного смоука не было, так что решать нечего:
   остаётся открытым вопросом.

3. **`applyCamera` вынесен отдельным модулем**, а не функцией внутри
   `main.js` (пункт 6.2): экспорт из `main.js` заставил бы тест поднимать
   весь клиентский вход с его побочными эффектами. Новый файл —
   `packages/engine/src/client/lib/applyCamera.js`, рядом с остальными
   мелкими хелперами клиента.

4. **`SPATIAL_PROFILES` получил `export`** (этап 4): иначе тест не мог
   сверить список профилей с их реализацией. Это константа без зависимостей,
   в `contract/surface.json` не входит.

## Итоговые проверки

| Проверка | Результат |
| --- | --- |
| движок `npx eslint .` | чисто |
| движок `npm test` | 185 файлов, **2382 passed** (было 2365, +17) |
| `vimp-contract --game ../vimp-tanks` | 37 passed, 0 failed, **E6 pass** |
| `vimp-contract --game ../vimp-snakes` | 35 passed, 0 failed, 2 skipped, **E6 pass** |
| `npm run sim` + `sim:check` | 9 passed, 0 failed, 3 skipped |
| tanks `eslint` + `npm test` | чисто, 303 passed |
| snakes `eslint` + `npm test` | чисто, 157 passed, 1 skipped |

`npm run core:test` не запускался — Rust-ядро не затрагивалось. Ручной
браузерный смоук по-прежнему не проведён и остаётся условием релиза:
этап 2 меняет звучание на окнах, отличных от 1920 в ширину.
