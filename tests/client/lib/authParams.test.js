import { describe, it, expect } from 'vitest';
import { normalizeAuthParams } from '../../../packages/engine/src/client/lib/authParams.js';

const param = (name, value, options) => ({ name, value, options });

describe('authParams.normalizeAuthParams', () => {
  it('сеет значение из storage поверх схемы', () => {
    const params = [param('model', 'm1', { control: 'select', options: ['m1', 'm2'], storage: 'model' })];

    normalizeAuthParams(params, { model: 'm2' });

    expect(params[0].value).toBe('m2');
  });

  it('пустой storage оставляет значение схемы', () => {
    const params = [param('model', 'm1', { control: 'select', options: ['m1', 'm2'], storage: 'model' })];

    normalizeAuthParams(params, {});

    expect(params[0].value).toBe('m1');
  });

  it('единственный вариант перекрывает устаревший storage', () => {
    // поле с одним вариантом форма не показывает и править не даёт: без
    // этого перекрытия значение от версии игры, где вариантов было больше,
    // уехало бы на хост и получило отказ от validators
    const params = [param('model', 'm1', { control: 'select', options: ['s1'], storage: 'model' })];

    normalizeAuthParams(params, { model: 's0-no-longer-exists' });

    expect(params[0].value).toBe('s1');
  });

  it('несколько вариантов не перекрываются', () => {
    const params = [param('model', 'm1', { control: 'select', options: ['m1', 'm2'] })];

    normalizeAuthParams(params, {});

    expect(params[0].value).toBe('m1');
  });

  it('нестроковый единственный вариант приводится к строке', () => {
    // validateAuth отбивает нестроковое значение «Property must be a
    // string», а поправить его в скрытом поле нечем
    const params = [param('team', 0, { control: 'radio', options: [{ value: 1, label: 'Solo' }] })];

    normalizeAuthParams(params, {});

    expect(params[0].value).toBe('1');
  });

  it('поле без storage и без вариантов не трогается', () => {
    const params = [param('login', 'Bob', { control: 'text' })];

    normalizeAuthParams(params, {});

    expect(params[0].value).toBe('Bob');
  });

  it('param без options не роняет нормализацию', () => {
    const params = [{ name: 'login', value: 'Bob' }];

    expect(() => normalizeAuthParams(params, {})).not.toThrow();
    expect(params[0].value).toBe('Bob');
  });

  it('правит тот же массив — его main.js отдаёт следом в AuthCtrl.init', () => {
    const params = [param('model', 'm1', { control: 'select', options: ['s1'] })];

    expect(normalizeAuthParams(params, {})).toBe(params);
  });
});
