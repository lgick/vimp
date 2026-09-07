# Этап 2. `SoundManager`: профили, санитаризация, новая геометрия

Репозиторий: `/Users/dmitry/Sites/my/vimp`.
Предварительное чтение: [`README.md`](README.md) — единицы измерения,
эталонная математика, схема конфигурации.
Зависит от: [этапа 1](stage_1.md).

Единственный файл этапа: `packages/engine/src/client/SoundManager.js`
(593 строки, `import { Howl, Howler } from 'howler'`, комментарии по-русски).

Тесты этого этапа пишутся на [этапе 5](stage_5.md) — до него `npm test`
будет красным на трёх существующих тестах, это ожидаемо.

## 2.1. Модульный уровень (строки 3–22)

Удалить `MIN_SPATIAL_DISTANCE` и `PANNER_SETTINGS` целиком вместе с их
комментариями. На их место:

```javascript
// глобальный лимит звуков
const WORLD_VOICE_LIMIT = 30;

// Дефолты пространственного звука. Второй экземпляр этих значений живёт в
// src/config/clientDefaults.js (parts.sounds.spatial) и приезжает сюда
// через CONFIG_DATA; здешний нужен на случай пустого или битого конфига —
// SoundManager обязан звучать и без объявления игры. Значения должны
// совпадать.
const SPATIAL_DEFAULTS = {
  mode: 'topDown',
  virtualElevation: 180,
  innerRadius: 40,
  verticalFactor: 0.2,
  distanceModel: 'inverse',
  refDistance: 200,
  maxDistance: 1200,
  rolloffFactor: 0.9,
};

// Конусные атрибуты узла: звук распространяется во все стороны одинаково.
// Игрой не настраиваются — направленных источников в 2D нет
const CONE_SETTINGS = {
  coneInnerAngle: 360,
  coneOuterAngle: 0,
  coneOuterGain: 0,
};

// Профиль проекции: как мировой вектор (sx, sy) и высота слушателя H
// ложатся на оси Web Audio. Слушатель смотрит в -Z (верх экрана), его
// «вверх» — +Y, поэтому мировой y (растёт вниз) входит со знаком минус
// везде, где попадает на ось Y.
const SPATIAL_PROFILES = {
  // вид сверху 360°: уши над полем боя, источник под ними
  topDown: {
    panningModel: 'HRTF',
    mapCoords: (sx, sy, h) => [sx, -h, sy],
  },

  // вид сбоку: слышимость лево/право, вертикаль занижена, глубина фиксирована
  sideScroller: {
    panningModel: 'equalpower',
    mapCoords: (sx, sy, h, cfg) => [sx, -sy * cfg.verticalFactor, -h],
  },

  // вид из кабины: сфера перед глазами, глубина фиксирована
  cockpit: {
    panningModel: 'HRTF',
    mapCoords: (sx, sy, h) => [sx, -sy, -h],
  },
};

const SPATIAL_MODES = Object.keys(SPATIAL_PROFILES);
const PANNING_MODELS = ['HRTF', 'equalpower'];
const DISTANCE_MODELS = ['linear', 'inverse', 'exponential'];

/**
 * Кубическая интерполяция Эрмита: 0 при value <= min, 1 при value >= max,
 * гладкая (вместе с первой производной) между ними. Гладкость здесь и есть
 * смысл: любой порог с разрывом слышен как щелчок.
 * @param {number} min
 * @param {number} max
 * @param {number} value
 * @returns {number} Значение в [0, 1].
 */
function smoothstep(min, max, value) {
  // вырожденный интервал (innerRadius: 0) — деления не делаем
  if (max <= min) {
    return value > min ? 1 : 0;
  }

  const x = Math.max(0, Math.min(1, (value - min) / (max - min)));

  return x * x * (3 - 2 * x);
}
```

## 2.2. Конструктор (строки 32–56)

После блока `_pannedIds` (строка 51) добавить:

```javascript
    // разрешённая геометрия пространственного звука: числа профиля + его
    // mapCoords. Ставится в init(), между матчами (reset) не меняется
    this._spatial = this._resolveSpatialConfig();

    // множитель зума камеры: 1 — покой, < 1 — динамическое отдаление
    this._listenerScale = 1;
```

Комментарий к `_pannedIds` (строки 46–51) переписать: множество теперь
обслуживает только возврат в центр для `spatial: false`, потому что мировой
источник получает узел сразу, на первом же кадре.

## 2.3. `init(soundsConfig)` (строка 70)

Три правки.

Деструктуризация (строка 71):

```javascript
    const { codecList, path, sounds, spatial } = soundsConfig;
```

Сразу после неё — разрешение геометрии. Важно, что это происходит **до**
загрузки звуков: `pannerAttr` вызывается в `onload`.

```javascript
    this._spatial = this._resolveSpatialConfig(spatial);
```

Строку 105 (`sound: soundInstance.pannerAttr(PANNER_SETTINGS),`) заменить на
передачу только тех ключей, которые понимает узел — Howler кладёт
незнакомые ключи в `_pannerAttr`, где они бессмысленны:

```javascript
                sound: soundInstance.pannerAttr({
                  panningModel: this._spatial.panningModel,
                  distanceModel: this._spatial.distanceModel,
                  refDistance: this._spatial.refDistance,
                  maxDistance: this._spatial.maxDistance,
                  rolloffFactor: this._spatial.rolloffFactor,
                  ...CONE_SETTINGS,
                }),
```

Обновить JSDoc `init` (строки 62–68): добавить
`@param {object} [soundsConfig.spatial]` с перечислением ключей.

## 2.4. Новый приватный метод `_resolveSpatialConfig`

Разместить среди приватных, перед `_updateSpatialSound`.

```javascript
  /**
   * @private Сводит объявленную игрой геометрию с движковыми дефолтами.
   * Плагин объявляет её в parts.sounds.spatial; неверное значение не
   * должно ломать аудиоконтекст, поэтому каждый ключ проверяется отдельно
   * и по одному падает на дефолт с предупреждением в консоль. Статически
   * то же самое ловит правило контракта E6 — здесь страховка на прод.
   * @param {object} [custom] - Блок parts.sounds.spatial из конфига игры.
   * @returns {object} Числа геометрии + panningModel + mapCoords профиля.
   */
  _resolveSpatialConfig(custom = {}) {
    const source = custom && typeof custom === 'object' ? custom : {};
    const warn = (key, value, fallback) =>
      console.warn(
        `[SoundManager] spatial.${key}: invalid value ${JSON.stringify(
          value,
        )}, using ${JSON.stringify(fallback)}`,
      );

    // число нужного знака, иначе дефолт
    const num = (key, positiveOnly) => {
      const value = source[key];
      const fallback = SPATIAL_DEFAULTS[key];

      if (value === undefined) {
        return fallback;
      }

      const ok =
        Number.isFinite(value) && (positiveOnly ? value > 0 : value >= 0);

      if (!ok) {
        warn(key, value, fallback);
      }

      return ok ? value : fallback;
    };

    // значение из закрытого списка, иначе дефолт
    const pick = (key, list, fallback) => {
      const value = source[key];

      if (value === undefined) {
        return fallback;
      }

      if (!list.includes(value)) {
        warn(key, value, fallback);

        return fallback;
      }

      return value;
    };

    const mode = pick('mode', SPATIAL_MODES, SPATIAL_DEFAULTS.mode);
    const profile = SPATIAL_PROFILES[mode];

    let refDistance = num('refDistance', true);
    let maxDistance = num('maxDistance', true);

    // PannerNode с maxDistance <= refDistance ведёт себя неопределённо
    if (maxDistance <= refDistance) {
      warn('maxDistance', maxDistance, SPATIAL_DEFAULTS.maxDistance);
      refDistance = SPATIAL_DEFAULTS.refDistance;
      maxDistance = SPATIAL_DEFAULTS.maxDistance;
    }

    return {
      mode,
      virtualElevation: num('virtualElevation', true),
      innerRadius: num('innerRadius', false),
      verticalFactor: num('verticalFactor', false),
      distanceModel: pick(
        'distanceModel',
        DISTANCE_MODELS,
        SPATIAL_DEFAULTS.distanceModel,
      ),
      panningModel: pick('panningModel', PANNING_MODELS, profile.panningModel),
      refDistance,
      maxDistance,
      rolloffFactor: num('rolloffFactor', false),
      mapCoords: profile.mapCoords,
    };
  }
```

## 2.5. `setListenerPosition` (строка 148)

```javascript
  /**
   * Устанавливает позицию слушателя и текущий зум камеры.
   * @param {number} x - Мировая координата X слушателя.
   * @param {number} y - Мировая координата Y слушателя.
   * @param {number} [scale=1] - Множитель зума камеры: 1 в покое, меньше
   * единицы при динамическом отдалении. Вызов с двумя аргументами
   * сохраняет прежнее поведение полностью.
   */
  setListenerPosition(x, y, scale = 1) {
    this._listenerX = x;
    this._listenerY = y;
    this._listenerScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }
```

## 2.6. `_updateSpatialSound` (строки 443–492) — переписать целиком

```javascript
  /**
   * Обновляет громкость и 3D-позицию источника. Позиция считается ОДНОЙ
   * непрерывной формулой на каждом кадре: слушатель поднят над плоскостью
   * игры на virtualElevation, а внутри innerRadius вектор на источник
   * плавно гасится к нулю (smoothstep). Прежняя дед-зона по направлению
   * (MIN_SPATIAL_DISTANCE) убрана: она переключала источник между двумя
   * разными состояниями — «узла нет, сухое стерео» и «HRTF в крайнем ухе»
   * — и этот разрыв тембра был слышен на дистанции в пару единиц.
   * @private
   * @param {Howl} sound - Экземпляр Howl.
   * @param {number} soundId - ID конкретного проигрываемого экземпляра.
   * @param {number} x - Мировая координата X источника.
   * @param {number} y - Мировая координата Y источника.
   * @param {number} volume - Громкость.
   * @param {boolean} [spatial=true] - Принадлежит ли звук миру.
   */
  _updateSpatialSound(sound, soundId, x, y, volume, spatial = true) {
    if (!sound || typeof soundId !== 'number') {
      return;
    }

    if (spatial === false) {
      // источник игрока: звук не принадлежит миру, он принадлежит игроку.
      // Паннер ему не нужен ни в каком виде — ни HRTF (на нулевой
      // дистанции это не тишина панорамы, а фронтальная свёртка:
      // гребенчатая окраска, из-за которой двигатель слышен как гул), ни
      // equalpower (тот схлопывает стерео сэмпла в моно). Пока узла нет,
      // pos() не зовётся вовсе: Howler создал бы паннер и щёлкнул
      // pause()/play()
      sound.volume(volume, soundId);
      this._recenterIfPanned(sound, soundId, true);

      return;
    }

    const dx = x - this._listenerX;
    const dy = y - this._listenerY;
    const distance = Math.hypot(dx, dy);

    // отсечка в мировых координатах: она обязана совпадать с maxDistance
    // самого PannerNode, поэтому зумом НЕ масштабируется — иначе движок
    // считал бы источник слышимым там, где узел уже отдал тишину
    if (distance >= this._spatial.maxDistance) {
      sound.volume(0, soundId);

      return;
    }

    sound.volume(volume, soundId);

    // зум камеры поднимает уши вместе с камерой: при отдалении картинка
    // сжимается, и стереобаза обязана сжаться так же, иначе звук шире
    // того, что видит глаз
    const zoom = this._listenerScale;
    const elevation = this._spatial.virtualElevation / zoom;
    const spread = smoothstep(0, this._spatial.innerRadius / zoom, distance);

    const [px, py, pz] = this._spatial.mapCoords(
      dx * spread,
      dy * spread,
      elevation,
      this._spatial,
    );

    sound.pos(px, py, pz, soundId);
    this._pannedIds.add(soundId);
  }
```

`_recenterIfPanned` (строка 503) и `_applyEqualPower` (строка 519) остаются
без изменений: они обслуживают ветку `spatial: false`.

## 2.7. `processAudibility` (строки 264–265)

```javascript
    const maxDistSquared =
      this._spatial.maxDistance * this._spatial.maxDistance;
```

## 2.8. `reset()` (строка 560)

Рядом с обнулением позиции слушателя добавить `this._listenerScale = 1;`.
`this._spatial` **не** сбрасывать: конфиг приходит один раз в `init`, а
`reset` вызывается на `CLEAR` между матчами.

## Готово, когда

- `npx eslint .` зелёный;
- в файле не осталось упоминаний `MIN_SPATIAL_DISTANCE` и `PANNER_SETTINGS`
  (`grep -n "MIN_SPATIAL_DISTANCE\|PANNER_SETTINGS" packages/engine/src/client/SoundManager.js`
  ничего не выводит);
- `npm test` красный ровно на трёх тестах старой математики из
  `tests/client/SoundManager.test.js` — их чинит [этап 5](stage_5.md).
