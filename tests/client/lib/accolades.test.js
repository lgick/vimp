import { describe, it, expect } from 'vitest';
import { createAccolades } from '../../../packages/engine/src/client/lib/accolades.js';

// snakes-v3 этап 4: сервис пула зависимостей — «какое место у этой сущности
// в глобальном топе?». Движок раздаёт числа, знак рисует part игры
describe('accolades (сервис пула зависимостей)', () => {
  it('незнакомый id получает объект с нулями мест, а не undefined', () => {
    const accolades = createAccolades();

    expect(accolades.placeOf(7)).toEqual({ daily: null, monthly: null });
  });

  it('приводит id к строке: ключи рассылки — строки', () => {
    const accolades = createAccolades();

    accolades.apply({ 3: { daily: 1, monthly: null } });

    expect(accolades.placeOf(3)).toEqual({ daily: 1, monthly: null });
    expect(accolades.placeOf('3')).toEqual({ daily: 1, monthly: null });
  });

  it('рассылка заменяет прошлую целиком', () => {
    const accolades = createAccolades();

    accolades.apply({ 3: { daily: 1, monthly: 2 } });
    accolades.apply({ 4: { daily: 5, monthly: null } });

    expect(accolades.placeOf(3)).toEqual({ daily: null, monthly: null });
    expect(accolades.placeOf(4).daily).toBe(5);
  });

  it('пустая рассылка не ломает placeOf', () => {
    const accolades = createAccolades();

    accolades.apply(null);

    expect(accolades.placeOf(1)).toEqual({ daily: null, monthly: null });
  });
});
