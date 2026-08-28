import { describe, it, expect } from 'vitest';
import { createAccolades } from '../../../packages/engine/src/client/lib/accolades.js';

// snakes-v3 этап 4: сервис пула зависимостей — всё, что комната знает о
// глобальном топе. Места считает и раздаёт ХОСТ; в матче клиент к мастеру
// не ходит вовсе
describe('accolades (сервис пула зависимостей)', () => {
  const payload = {
    places: { 3: { daily: 1, monthly: 2 } },
    boards: { day: [{ place: 1, nick: 'Alice', score: 90 }] },
    self: { 3: { day: { place: 1, score: 90 } } },
  };

  it('незнакомый id получает объект с нулями мест, а не undefined', () => {
    const accolades = createAccolades();

    expect(accolades.placeOf(7)).toEqual({ daily: null, monthly: null });
  });

  it('приводит id к строке: ключи рассылки — строки', () => {
    const accolades = createAccolades();

    accolades.apply(payload);

    expect(accolades.placeOf(3)).toEqual({ daily: 1, monthly: 2 });
    expect(accolades.placeOf('3')).toEqual({ daily: 1, monthly: 2 });
    expect(accolades.selfOf(3, 'day')).toEqual({ place: 1, score: 90 });
  });

  it('рассылка заменяет прошлую целиком', () => {
    const accolades = createAccolades();

    accolades.apply(payload);
    accolades.apply({ places: { 4: { daily: 5, monthly: null } }, boards: {}, self: {} });

    expect(accolades.placeOf(3)).toEqual({ daily: null, monthly: null });
    expect(accolades.placeOf(4).daily).toBe(5);
    expect(accolades.boardOf('day')).toEqual([]);
    expect(accolades.selfOf(3, 'day')).toBeNull();
  });

  it('отдаёт таблицу среза, которую привёз хост', () => {
    const accolades = createAccolades();

    accolades.apply(payload);

    expect(accolades.boardOf('day')).toEqual([{ place: 1, nick: 'Alice', score: 90 }]);
    // срез, которого в рассылке нет, — пустой список, а не undefined:
    // до первой рассылки это нормальное состояние, а не сбой
    expect(accolades.boardOf('month')).toEqual([]);
  });

  it('пустая рассылка не ломает ни один из трёх вопросов', () => {
    const accolades = createAccolades();

    accolades.apply(null);

    expect(accolades.placeOf(1)).toEqual({ daily: null, monthly: null });
    expect(accolades.boardOf('day')).toEqual([]);
    expect(accolades.selfOf(1, 'day')).toBeNull();
  });
});
