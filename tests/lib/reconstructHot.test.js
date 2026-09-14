import { describe, it, expect } from 'vitest';
import {
  buildSnapshotKeysById,
  parseHot,
  reconstructHot,
} from '../../packages/engine/src/lib/reconstructHot.js';
import { HOT_FLAGS } from '../../packages/engine/src/config/opcodes.js';

const schema = {
  a1: {
    id: 1,
    kind: 'indexed8',
    fields: [{ name: 'x' }, { name: 'y' }],
  },
  d1: {
    id: 7,
    kind: 'indexedNoNull8',
    fields: [{ name: 'state' }],
  },
};

const keysById = buildSnapshotKeysById(schema);

describe('buildSnapshotKeysById', () => {
  it('индексирует схему по числовому id и считает ширину записи', () => {
    expect(keysById).toEqual({
      1: { key: 'a1', kind: 'indexed8', width: 4 },
      7: { key: 'd1', kind: 'indexedNoNull8', width: 3 },
    });
  });
});

describe('reconstructHot', () => {
  it('разбирает обе группы: акторы и динамику карты', () => {
    const hot = new Float32Array([
      HOT_FLAGS.GAME,
      0,
      0,
      // группа Indexed8: две записи ключа a1
      2,
      1,
      10,
      1.5,
      2.5,
      1,
      11,
      3.5,
      4.5,
      // группа IndexedNoNull8: одна запись ключа d1
      1,
      7,
      4,
      9,
    ]);

    expect(reconstructHot(hot, keysById)).toEqual({
      a1: { 10: [1.5, 2.5], 11: [3.5, 4.5] },
      d1: { d4: [9] },
    });
  });

  it('строка динамики с байтом состояния читается шириной схемы', () => {
    // схема c1 со слоями и ролью state: 9 полей, запись — 11 чисел
    const keys = buildSnapshotKeysById({
      c1: {
        id: 5,
        kind: 'indexedNoNull8',
        optionalFrom: 6,
        fields: [
          { name: 'x' },
          { name: 'y' },
          { name: 'angle' },
          { name: 'z', role: 'z' },
          { name: 'level', role: 'level' },
          { name: 'state', role: 'state' },
          { name: 'vx' },
          { name: 'vy' },
          { name: 'angvel' },
        ],
      },
    });
    const hot = new Float32Array([
      HOT_FLAGS.GAME,
      0,
      0,
      0,
      // покоящееся тело (хвост дочитан ядром нулями) и движущееся
      2,
      5,
      0,
      ...[1, 2, 0, 0, 1, 2, 0, 0, 0],
      5,
      1,
      ...[3, 4, 0, 0, 0, 1, 5, 6, 0.5],
    ]);

    expect(parseHot(hot, keys)).toEqual({
      game: {
        c1: {
          d0: [1, 2, 0, 0, 1, 2, 0, 0, 0],
          d1: [3, 4, 0, 0, 0, 1, 5, 6, 0.5],
        },
      },
      consumed: hot.length,
    });
  });

  it('пустые группы дают пустую сцену', () => {
    const hot = new Float32Array([HOT_FLAGS.GAME, 0, 0, 0, 0]);

    expect(reconstructHot(hot, keysById)).toEqual({});
  });

  it('predicted-запись перекрывает интерполированную того же id', () => {
    const hot = new Float32Array([
      HOT_FLAGS.GAME | HOT_FLAGS.PREDICTED,
      0,
      0,
      1,
      1,
      10,
      1,
      1,
      0,
      // predicted: тот же ключ и id, другие поля
      1,
      10,
      99,
      99,
    ]);

    expect(reconstructHot(hot, keysById).a1).toEqual({ 10: [99, 99] });
  });

  it('строки предсказанных телом игры сущностей идут после хвоста', () => {
    const hot = new Float32Array([
      HOT_FLAGS.GAME | HOT_FLAGS.PREDICTED,
      0,
      0,
      // группа Indexed8: свой актор (10) и чужой (11)
      2,
      1,
      10,
      1,
      1,
      1,
      11,
      2,
      2,
      // группа IndexedNoNull8: ящик динамики
      1,
      7,
      4,
      5,
      // predicted-хвост своего актора
      1,
      10,
      99,
      99,
      // строки игры: чужой актор и ящик — обе перекрывают интерполяцию
      1,
      11,
      77,
      77,
      7,
      4,
      55,
    ]);

    expect(reconstructHot(hot, keysById)).toEqual({
      a1: { 10: [99, 99], 11: [77, 77] },
      d1: { d4: [55] },
    });
  });

  it('усечённая хвостовая запись — ошибка, а не строка с дырами', () => {
    const hot = new Float32Array([
      HOT_FLAGS.GAME | HOT_FLAGS.PREDICTED,
      0,
      0,
      0,
      0,
      // хвост обрезан посреди записи: ключу a1 нужно 4 float'а, есть 3
      1,
      10,
      99,
    ]);

    expect(() => reconstructHot(hot, keysById)).toThrow(/needs \d+ floats/);
  });
});
