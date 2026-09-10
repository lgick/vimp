# Этап 4. Правило контракта E6 ✅ выполнен

Репозиторий: `/Users/dmitry/Sites/my/vimp`.
Предварительное чтение: [`README.md`](README.md) — схема конфигурации.
Зависит от: [этапа 1](stage_1.md) (набор ключей).

## Зачем

Блок `parts.sounds.spatial` необязателен, но объявленный блок с опечаткой —
тихий отказ: `deepMerge` молча положит `innrRadius` в конфиг, `SoundManager`
молча его проигнорирует, разработчик услышит «звук как был» и не поймёт
почему. Уровень `warn`, а не `error`: отсутствие блока и мелкая ошибка в
нём не должны валить сборку игры (под `--strict` warn становится ошибкой).

## Новый файл

`packages/engine/src/devtools/contract/rules/e6-sound-spatial.js`

Образец стиля — соседний `e3-sound-registry.js`: уровень `WARN`, хелперы
`skip`/`verdict` из `../result.js`, сообщения по-английски, комментарий
сверху объясняет *почему* правило существует.

```javascript
import { WARN, skip, verdict } from '../result.js';

const MODES = ['topDown', 'sideScroller', 'cockpit'];
const PANNING_MODELS = ['HRTF', 'equalpower'];
const DISTANCE_MODELS = ['linear', 'inverse', 'exponential'];

// ключ -> требуемый знак; список закрыт, потому что лишний ключ здесь
// всегда опечатка: deepMerge молча положит его в конфиг, а SoundManager
// молча проигнорирует — не проявится вообще никак
const NUMERIC = {
  virtualElevation: 'positive',
  innerRadius: 'non-negative',
  verticalFactor: 'non-negative',
  refDistance: 'positive',
  maxDistance: 'positive',
  rolloffFactor: 'non-negative',
};

const KNOWN = [
  'mode',
  'panningModel',
  'distanceModel',
  ...Object.keys(NUMERIC),
];

// Блок spatial необязателен: игра без него получает движковые дефолты и
// звучит правильно. Но объявленный блок с опечаткой — это тихий отказ:
// движок падает на дефолт и ничего не говорит.
export default {
  id: 'E6',
  name: 'soundSpatial',
  level: WARN,
  title: 'the spatial sound block is well-formed',

  check(ctx) {
    const sounds = ctx.clientConfig?.parts?.sounds;

    if (!sounds) {
      return skip('no client sound config');
    }

    const spatial = sounds.spatial;

    if (spatial === undefined) {
      return skip('no spatial block — engine defaults apply');
    }

    if (!spatial || typeof spatial !== 'object' || Array.isArray(spatial)) {
      return verdict(['parts.sounds.spatial must be a plain object']);
    }

    const violations = [];

    for (const key of Object.keys(spatial)) {
      if (!KNOWN.includes(key)) {
        violations.push(
          `unknown key "${key}": valid keys are ${KNOWN.join(', ')}`,
        );
      }
    }

    if (spatial.mode !== undefined && !MODES.includes(spatial.mode)) {
      violations.push(
        `mode "${spatial.mode}" is unknown: valid modes are ${MODES.join(', ')}`,
      );
    }

    if (
      spatial.panningModel !== undefined &&
      !PANNING_MODELS.includes(spatial.panningModel)
    ) {
      violations.push(
        `panningModel "${spatial.panningModel}" is unknown: valid models are ${PANNING_MODELS.join(', ')}`,
      );
    }

    if (
      spatial.distanceModel !== undefined &&
      !DISTANCE_MODELS.includes(spatial.distanceModel)
    ) {
      violations.push(
        `distanceModel "${spatial.distanceModel}" is unknown: valid models are ${DISTANCE_MODELS.join(', ')}`,
      );
    }

    for (const [key, sign] of Object.entries(NUMERIC)) {
      const value = spatial[key];

      if (value === undefined) {
        continue;
      }

      const ok =
        Number.isFinite(value) &&
        (sign === 'positive' ? value > 0 : value >= 0);

      if (!ok) {
        violations.push(`${key} must be a ${sign} number, got ${value}`);
      }
    }

    if (
      Number.isFinite(spatial.refDistance) &&
      Number.isFinite(spatial.maxDistance) &&
      spatial.maxDistance <= spatial.refDistance
    ) {
      violations.push(
        `maxDistance (${spatial.maxDistance}) must be greater than refDistance (${spatial.refDistance})`,
      );
    }

    return verdict(violations);
  },
};
```

## Регистрация

`packages/engine/src/devtools/contract/rules/index.js`:

- импорт `import e6 from './e6-sound-spatial.js';` после строки с `e5`;
- `e6` в конец массива `rules` (порядок групп = порядок отчёта: A пакет,
  B host, C client, D снапшот, E ассеты).

## Чего НЕ делать

`packages/engine/contract/surface.json` **не трогать**. Правила контракта в
нём не перечислены; `parts.*` клиентского конфига представлены там только
тремя игровыми ключами. Из замороженной поверхности ничего не удаляется —
поводов останавливаться и обсуждать нет.

## Готово, когда

- `npx eslint .` зелёный;
- `node packages/engine/bin/vimp-contract.js --game ../vimp-tanks` выводит
  строку `E6` со статусом `skip` (блок ещё не объявлен — это этап 7);
- `npm test` не даёт новых падений, кроме уже известных из этапа 2
  (`tests/devtools/contract/report.test.js:138` сверяет длину отчёта с
  `rules.length` и правится сам).
