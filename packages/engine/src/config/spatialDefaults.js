// Дефолты и словарь допустимых значений пространственного звука.
// Единственный источник для трёх потребителей: clientDefaults.js (движковый
// конфиг игры), SoundManager (страховка на пустой или битый конфиг) и
// правило контракта E6 (статическая проверка). Держать их синхронными
// «по договорённости» не получается: расхождение проявляется только на
// слух и неотличимо от «звук просто другой».
//
// Числа — в МИРОВЫХ единицах игры, не в экранных пикселях: у игры с
// mapScale 0.3 и baseScale 5 мировая единица впятеро меньше пикселя.
// Дефолты рассчитаны на масштаб 1:1, игра со своим масштабом объявляет
// parts.sounds.spatial сама.
//
// panningModel здесь НЕТ намеренно: его приносит профиль проекции
// (SPATIAL_PROFILES в SoundManager.js), иначе sideScroller потерял бы свой
// equalpower — жёсткий дефолт перекрыл бы профиль на уровне слияния
// конфигов.
export const SPATIAL_DEFAULTS = {
  mode: 'topDown',
  virtualElevation: 180,
  innerRadius: 40,
  verticalFactor: 0.2,
  distanceModel: 'inverse',
  refDistance: 200,
  maxDistance: 1200,
  rolloffFactor: 0.9,
};

// Требуемый знак каждого числового поля. Список закрыт: лишний ключ в
// spatial — всегда опечатка, deepMerge молча положит его в конфиг, а
// SoundManager молча проигнорирует
export const SPATIAL_NUMERIC = {
  virtualElevation: 'positive',
  innerRadius: 'non-negative',
  verticalFactor: 'non-negative',
  refDistance: 'positive',
  maxDistance: 'positive',
  rolloffFactor: 'non-negative',
};

// Профили проекции; геометрия каждого живёт в SPATIAL_PROFILES
// (SoundManager.js), здесь — только имена для валидации
export const SPATIAL_MODES = ['topDown', 'sideScroller', 'cockpit'];

export const PANNING_MODELS = ['HRTF', 'equalpower'];

export const DISTANCE_MODELS = ['linear', 'inverse', 'exponential'];

// Все ключи, которые SoundManager читает из блока spatial
export const SPATIAL_KEYS = [
  'mode',
  'panningModel',
  'distanceModel',
  ...Object.keys(SPATIAL_NUMERIC),
];
