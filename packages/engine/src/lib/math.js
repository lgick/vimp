/**
 * Линейная интерполяция
 * @param {number} a
 * @param {number} b
 * @param {number} t - значение от 0 до 1
 */
export const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Интерполяция угла в радианах по кратчайшему пути
 * @param {number} a
 * @param {number} b
 * @param {number} t - значение от 0 до 1
 */
export const lerpAngle = (a, b, t) => {
  let diff = b - a;

  while (diff > Math.PI) {
    diff -= Math.PI * 2;
  }

  while (diff < -Math.PI) {
    diff += Math.PI * 2;
  }

  return a + diff * t;
};

/**
 * Ограничивает число в диапазоне [min, max]
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Перевод градусов в радианы
 * @param {number} degrees
 * @returns {number}
 */
export const degToRad = degrees => degrees * (Math.PI / 180);

/**
 * Перевод радиан в градусы
 * @param {number} radians
 * @returns {number}
 */
export const radToDeg = radians => radians * (180 / Math.PI);

/**
 * Нормализует угол в радианах к диапазону [-PI, PI]
 * @param {number} angle
 * @returns {number}
 */
export const normalizeAngle = angle => {
  while (angle > Math.PI) {
    angle -= Math.PI * 2;
  }

  while (angle < -Math.PI) {
    angle += Math.PI * 2;
  }

  return angle;
};

/**
 * Случайное число в диапазоне [min, max)
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export const randomRange = (min, max) => Math.random() * (max - min) + min;
