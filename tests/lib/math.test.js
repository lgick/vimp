import { describe, it, expect } from 'vitest';
import {
  lerp,
  lerpAngle,
  clamp,
  degToRad,
  radToDeg,
  normalizeAngle,
  randomRange,
} from '../../packages/engine/src/lib/math.js';

const PI = Math.PI;

describe('lerp', () => {
  it('возвращает граничные значения при t=0 и t=1', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
  });

  it('интерполирует середину', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(-10, 10, 0.5)).toBe(0);
  });

  it('экстраполирует за пределами [0,1]', () => {
    expect(lerp(0, 10, 2)).toBe(20);
  });
});

describe('clamp', () => {
  it('ограничивает снизу и сверху', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('возвращает значение внутри диапазона без изменений', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('работает на границах диапазона', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe('degToRad / radToDeg', () => {
  it('переводит градусы в радианы', () => {
    expect(degToRad(180)).toBeCloseTo(PI);
    expect(degToRad(90)).toBeCloseTo(PI / 2);
  });

  it('переводит радианы в градусы', () => {
    expect(radToDeg(PI)).toBeCloseTo(180);
  });

  it('обратимость преобразования', () => {
    expect(radToDeg(degToRad(45))).toBeCloseTo(45);
  });
});

describe('normalizeAngle', () => {
  it('оставляет угол в диапазоне [-PI, PI] без изменений', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(PI / 2)).toBeCloseTo(PI / 2);
  });

  it('сворачивает большие положительные углы', () => {
    expect(normalizeAngle(3 * PI)).toBeCloseTo(PI);
    expect(normalizeAngle(2 * PI)).toBeCloseTo(0);
  });

  it('сворачивает большие отрицательные углы', () => {
    // граница включается асимметрично: -3π сворачивается к -π (а не к +π)
    expect(normalizeAngle(-3 * PI)).toBeCloseTo(-PI);
    expect(normalizeAngle(-2 * PI)).toBeCloseTo(0);
  });
});

describe('lerpAngle', () => {
  it('интерполирует по кратчайшему пути через границу PI/-PI', () => {
    // от 170° к -170° кратчайший путь — через 180°, дельта +20°
    const a = degToRad(170);
    const b = degToRad(-170);
    const result = lerpAngle(a, b, 0.5);
    // середина должна быть около 180° (PI), а не около 0
    expect(Math.abs(normalizeAngle(result))).toBeCloseTo(PI);
  });

  it('при t=0 возвращает старт', () => {
    expect(lerpAngle(0.5, 1.5, 0)).toBeCloseTo(0.5);
  });
});

describe('randomRange', () => {
  it('возвращает значения в пределах [min, max)', () => {
    for (let i = 0; i < 1000; i += 1) {
      const v = randomRange(5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThan(10);
    }
  });
});
