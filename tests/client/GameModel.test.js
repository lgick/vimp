import { describe, it, expect, beforeEach, vi } from 'vitest';
import GameModel from '../../packages/engine/src/client/components/model/Game.js';
import Factory from '../../packages/engine/src/lib/factory.js';

// фейковая сущность с update/destroy
class FakeEntity {
  constructor(data) {
    this.data = data;
    this.updated = null;
    this.destroyed = false;
  }
  update(d) {
    this.updated = d;
  }
  destroy() {
    this.destroyed = true;
  }
}

const collect = model => {
  const events = [];
  ['create', 'createEffect', 'remove'].forEach(type =>
    model.publisher.on(type, data => events.push({ type, data })),
  );
  return events;
};

beforeEach(() => {
  Factory.constructors = {};
  Factory.add({ Tank: FakeEntity, ShotEffect: FakeEntity });
});

describe('GameModel.create / read', () => {
  it('создаёт экземпляр и кладёт в хранилище', () => {
    const model = new GameModel();
    const events = collect(model);

    model.create('Tank', '01', { hp: 100 });

    expect(model.read('Tank', '01')).toBeInstanceOf(FakeEntity);
    expect(model.read('Tank', '01').data).toEqual({ hp: 100 });
    expect(events.find(e => e.type === 'create')).toBeDefined();
  });

  it('read возвращает все экземпляры конструктора и все данные', () => {
    const model = new GameModel();
    model.create('Tank', '01', {});
    model.create('Tank', '02', {});

    expect(Object.keys(model.read('Tank'))).toEqual(['01', '02']);
    expect(model.read()).toHaveProperty('Tank');
  });

  it('read для отсутствующих данных возвращает undefined', () => {
    const model = new GameModel();
    expect(model.read('Missing')).toBeUndefined();
    model.create('Tank', '01', {});
    expect(model.read('Tank', '99')).toBeUndefined();
  });
});

describe('GameModel.update', () => {
  it('передаёт данные в update экземпляра', () => {
    const model = new GameModel();
    model.create('Tank', '01', {});

    model.update('Tank', '01', { x: 5 });
    expect(model.read('Tank', '01').updated).toEqual({ x: 5 });
  });

  it('update с null удаляет экземпляр', () => {
    const model = new GameModel();
    model.create('Tank', '01', {});
    const events = collect(model);

    model.update('Tank', '01', null);
    expect(model.read('Tank', '01')).toBeUndefined();
    expect(events.find(e => e.type === 'remove')).toBeDefined();
  });
});

describe('GameModel.remove', () => {
  it('удаляет конкретный экземпляр и эмитит remove', () => {
    const model = new GameModel();
    model.create('Tank', '01', {});
    const events = collect(model);

    model.remove('Tank', '01');
    expect(model.read('Tank', '01')).toBeUndefined();
    expect(events.filter(e => e.type === 'remove')).toHaveLength(1);
  });

  it('удаляет всех по конструктору', () => {
    const model = new GameModel();
    model.create('Tank', '01', {});
    model.create('Tank', '02', {});
    const events = collect(model);

    model.remove('Tank');
    expect(model.read('Tank')).toBeUndefined();
    expect(events.filter(e => e.type === 'remove')).toHaveLength(2);
  });

  it('без аргументов очищает всё полотно', () => {
    const model = new GameModel();
    model.create('Tank', '01', {});
    model.create('Tank', '02', {});
    const events = collect(model);

    model.remove();
    expect(model.read()).toEqual({});
    expect(events.filter(e => e.type === 'remove')).toHaveLength(2);
  });
});

describe('GameModel.createEffect', () => {
  it('добавляет эффект в managedEffects и эмитит createEffect', () => {
    const model = new GameModel();
    const events = collect(model);

    model.createEffect('ShotEffect', {});
    expect(model._managedEffects.ShotEffect.size).toBe(1);
    expect(events.find(e => e.type === 'createEffect')).toBeDefined();
  });

  it('destroy эффекта снимает его с учёта и вызывает оригинальный destroy', () => {
    const model = new GameModel();
    model.createEffect('ShotEffect', {});
    const effect = [...model._managedEffects.ShotEffect][0];

    effect.destroy();

    expect(effect.destroyed).toBe(true); // оригинальный destroy вызван
    // набор опустел и удалён
    expect(model._managedEffects.ShotEffect).toBeUndefined();
  });
});
