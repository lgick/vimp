# Этап 5. Тесты движка ✅ выполнен

Репозиторий: `/Users/dmitry/Sites/my/vimp`.
Предварительное чтение: [`README.md`](README.md) — эталонная математика (по
ней посчитаны все ожидаемые значения ниже).
Зависит от: этапов [2](stage_2.md), [3](stage_3.md), [4](stage_4.md).

Правило репозитория: любое функциональное изменение приносит тесты в том же
изменении; `npx eslint .` и `npm test` заканчивают работу зелёными.

## 5.1. `tests/client/SoundManager.test.js`

Файл — 424 строки, проект `engine-client`, окружение happy-dom
(`vitest.config.js`). Стиль обязателен к сохранению: `howler` **не**
мокается, класс **не** инстанцируется, методы прототипа (`P`) вызываются на
самодельном `this`; имена тестов — по-русски.

### Правка хелпера

`makeSpatialCtx` (строки 291–299) без правки не заработает: новая
реализация читает `this._spatial` и `this._listenerScale`.

```javascript
const makeSpatialCtx = (spatial, scale = 1) => ({
  _listenerX: 100,
  _listenerY: 100,
  _listenerScale: scale,
  _equalPowerIds: new Set(),
  _pannedIds: new Set(),
  _spatial: P._resolveSpatialConfig.call({}, spatial),
  _updateSpatialSound: P._updateSpatialSound,
  _recenterIfPanned: P._recenterIfPanned,
  _applyEqualPower: P._applyEqualPower,
  _resolveSpatialConfig: P._resolveSpatialConfig,
});
```

`makeHowl()` (строки 300–306) — без изменений:
`{ pos, volume, rate, stop, pannerAttr }` из `vi.fn()`.

### Существующие тесты, которые обязаны измениться

| Тест (строки) | Что делать |
| --- | --- |
| «мировой источник по умолчанию панорамируется», ожидает `pos(300, 0, 0, 1)` (346–350) | ожидание → `pos(300, -180, 0, 1)`: слушатель `(100,100)`, источник `(400,100)`, `d2d = 300 > innerRadius 40`, `spread = 1` |
| «внутри дед-зоны направления панорама не строится», ожидает, что `pos` не вызван (352–362) | переименовать в «источник вплотную к слушателю звучит из-под него»: `pos` теперь вызывается. При `d2d = 2` и `R = 40` `spread = smoothstep(0,40,2) ≈ 0.007249`, то есть `X ≈ 0.0145`. Сравнивать через `expect(sound.pos.mock.calls[0][0]).toBeCloseTo(0.0145, 3)` и `toBe(-180)` по Y |
| «мировой источник в дед-зоне возвращается в центр, но HRTF сохраняет» (364–375) | удалить: дед-зоны больше нет. Его смысл (миру `equalpower` не навязывается) переносится в новый тест № 5 |
| Два теста ветки `spatial: false` (309–341) | **не трогать** — поведение сохранено дословно |

### Новые тесты

Слушатель везде `(100, 100)`, дефолты `H = 180`, `innerRadius = 40`,
`maxDistance = 1200`.

1. **«источник ровно под слушателем звучит из-под него»** — источник
   `(100, 100)` → `pos(0, -180, 0, 1)`.
2. **«вблизи слушателя панорама мягкая»** — источник `(120, 100)`:
   `spread = smoothstep(0, 40, 20) = 0.5` → `pos(10, -180, 0, 1)`;
   дополнительно `expect(Math.atan2(10, 180)).toBeLessThan(0.1)` (< 6°).
3. **«панорама непрерывна там, где раньше была ступенька»** — главный тест
   регрессии. Прогнать источник по `x` = 114, 115, 116, 117, 118 (то есть
   `d2d` = 14…18, вокруг снятого порога 16), собрать первый аргумент каждого
   вызова `pos` и проверить: последовательность строго возрастает, а
   максимальная разница между соседями меньше `1.5`.
4. **«за радиусом рассеивания вектор не гасится»** — источник `(200, 180)`:
   `d2d = hypot(100, 80) ≈ 128 > 40`, `spread = 1` →
   `pos(100, -180, 80, 1)`.
5. **«мировой источник не переводится на equalpower»** — после обычного
   панорамирования `expect(sound.pannerAttr).not.toHaveBeenCalled()`.
6. **«зум камеры поднимает уши»** — `makeSpatialCtx(undefined, 0.5)`:
   источник `(400, 100)` → `pos(300, -360, 0, 1)`; источник `(140, 100)` →
   `spread = smoothstep(0, 80, 40) = 0.5` → `pos(20, -360, 0, 1)`.
7. **«`setListenerPosition` защищается от мусорного зума»** — контекст с
   `setListenerPosition: P.setListenerPosition`; вызовы `(0, 0)`,
   `(0, 0, 0)`, `(0, 0, NaN)`, `(0, 0, -1)` → `_listenerScale === 1`;
   `(0, 0, 0.5)` → `0.5`.
8. **«за maxDistance источник глушится»** — источник `(1400, 100)`
   (`d2d = 1300 >= 1200`): `volume(0, 1)`, `pos` не вызван. Повторить при
   зуме `0.5` — поведение то же (отсечка зумом не масштабируется).
9. **«профиль sideScroller кладёт вертикаль на ось Y»** —
   `makeSpatialCtx({ mode: 'sideScroller' })`, источник `(300, 300)`:
   `dx = 200`, `dy = 200`, `spread = 1`, `verticalFactor = 0.2` →
   `pos(200, -40, -180, 1)`.
10. **«профиль cockpit кладёт вертикаль полностью»** —
    `makeSpatialCtx({ mode: 'cockpit' })`, тот же источник →
    `pos(200, -200, -180, 1)`.
11. **`describe('SoundManager._resolveSpatialConfig')`** — вызывать как
    `P._resolveSpatialConfig.call({}, custom)`, `console.warn` глушить
    через `vi.spyOn(console, 'warn').mockImplementation(() => {})`:
    - `undefined` и `{}` → дефолты, `console.warn` **не** вызван;
    - `{ mode: 'side-scroller' }` → `mode === 'topDown'`, ровно один warn;
    - `{ virtualElevation: -1 }`, `{ innerRadius: NaN }`,
      `{ refDistance: '200' }` → дефолт + warn на каждый;
    - `{ panningModel: 'stereo' }` → `'HRTF'` + warn;
    - `{ mode: 'sideScroller' }` → `panningModel === 'equalpower'` без warn;
    - `{ refDistance: 500, maxDistance: 400 }` → оба на дефолт (`200`/`1200`);
    - `{ innerRadius: 0 }` → `innerRadius === 0` без warn (ноль легален).
12. **«`innerRadius: 0` не даёт NaN»** —
    `makeSpatialCtx({ innerRadius: 0 })`, источник `(101, 100)`:
    `spread = 1` → `pos(1, -180, 0, 1)`, все аргументы конечны
    (`Number.isFinite`).
13. **`processAudibility` берёт `maxDistance` из `_spatial`** — в хелпер
    `makeCtx` (строки 17–32) добавить `_spatial: { maxDistance: 100 }` и
    адаптировать существующий тест строк 35–49 (далёкий одноразовый
    отсеивается, далёкий зацикленный остаётся) под новое поле. Отдельный
    дубль не заводить.

## 5.2. `tests/devtools/contract/rules.test.js`

Рядом с блоками E1/E3 (строки 1211–1245) добавить `describe` для E6.
Контекст правила — объект с `clientConfig.parts.sounds`.

- нет `parts.sounds` → `status: 'skip'`;
- есть `sounds`, нет `spatial` → `status: 'skip'`;
- валидный блок (`{ mode: 'topDown', innerRadius: 5 }`) → `status: 'pass'`;
- `{ mode: 'side-scroller' }` → `fail`, в `violations` есть строка с
  `valid modes`;
- `{ innrRadius: 40 }` (опечатка) → `fail`, в `violations` есть
  `unknown key`;
- `{ virtualElevation: -1 }` → `fail`;
- `{ panningModel: 'stereo' }` → `fail`;
- `{ refDistance: 500, maxDistance: 400 }` → `fail`;
- уровень правила — `warn` (`rule.level`).

`tests/devtools/contract/report.test.js:138` сверяет длину отчёта с
`rules.length` и правится автоматически.

## 5.3. Клиентские компоненты

Если в `tests/client/` уже есть покрытие `CanvasManager` — добавить тест
`getCameraZoom()`: `1` при отсутствии полотна с `dynamicCamera`,
`_camZoomModifier` при наличии. Если покрытия нет — **не** заводить его в
этой задаче.

## Команды

```bash
npx eslint . && npm test
```

`npm run core:test` не нужен: Rust-ядро не затрагивается.

## Готово, когда

`npx eslint .` и `npm test` зелёные целиком.
