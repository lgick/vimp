import { describe, it, expect, beforeEach } from 'vitest';
import Factory from '../../packages/engine/src/lib/factory.js';

describe('Factory', () => {
  beforeEach(() => {
    // изоляция: чистим реестр между тестами
    Factory.constructors = {};
  });

  it('создаёт экземпляр зарегистрированного конструктора', () => {
    class Tank {
      constructor(hp) {
        this.hp = hp;
      }
    }

    Factory.add({ tank: Tank });
    const instance = Factory('tank', 100);

    expect(instance).toBeInstanceOf(Tank);
    expect(instance.hp).toBe(100);
  });

  it('передаёт несколько аргументов в конструктор', () => {
    class Bullet {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    }

    Factory.add({ bullet: Bullet });
    const b = Factory('bullet', 1, 2);

    expect(b).toMatchObject({ x: 1, y: 2 });
  });

  it('бросает ошибку для незарегистрированного имени', () => {
    expect(() => Factory('unknown')).toThrow(/not found/);
  });

  it('add объединяет конструкторы, не затирая существующие', () => {
    class A {}
    class B {}
    Factory.add({ a: A });
    Factory.add({ b: B });

    expect(Factory('a')).toBeInstanceOf(A);
    expect(Factory('b')).toBeInstanceOf(B);
  });
});
