import { describe, it, expect } from 'vitest';
import { createRegistry } from '../../packages/engine/src/lib/registry.js';

// Append-only реестр (этап 3 плана plugin-forward-compat): имя, которое игра
// могла написать, живёт вечно — вывод из эксплуатации делается алиасом.

const registry = createRegistry('demo', [
  { value: 'text', since: 1 },
  { value: 'checkbox', since: 1 },
  {
    value: 'range',
    since: 1,
    alias: 'text',
    retiredIn: 3,
    patch: { numeric: true },
  },
  { value: 'legacy', since: 1, alias: 'range', retiredIn: 2 },
]);

describe('createRegistry', () => {
  it('активное имя разрешается в себя и не считается выведенным', () => {
    expect(registry.resolve('text')).toBe('text');
    expect(registry.isRetired('text')).toBe(false);
    expect(registry.has('text')).toBe(true);
  });

  it('выведенное имя разрешается в свою замену', () => {
    expect(registry.resolve('range')).toBe('text');
    expect(registry.isRetired('range')).toBe(true);
  });

  it('цепочка алиасов проходится до активного имени', () => {
    expect(registry.resolve('legacy')).toBe('text');
    expect(registry.chain('legacy').map(entry => entry.value)).toEqual([
      'legacy',
      'range',
      'text',
    ]);
  });

  it('неизвестное имя — undefined: плагин попросил будущее', () => {
    expect(registry.resolve('nope')).toBeUndefined();
    expect(registry.has('nope')).toBe(false);
    expect(registry.chain('nope')).toEqual([]);
  });

  it('list() отдаёт и выведенные записи, values() — только активные', () => {
    expect(registry.list().map(entry => entry.value)).toEqual([
      'text',
      'checkbox',
      'range',
      'legacy',
    ]);
    expect(registry.values()).toEqual(['text', 'checkbox']);
  });

  it('дубликат, висячий алиас и цикл — дефект движка, падают на создании', () => {
    expect(() =>
      createRegistry('dup', [{ value: 'a' }, { value: 'a' }]),
    ).toThrow(/duplicate/);

    expect(() =>
      createRegistry('dangling', [{ value: 'a', alias: 'b' }]),
    ).toThrow(/unknown/);

    expect(() =>
      createRegistry('cycle', [
        { value: 'a', alias: 'b' },
        { value: 'b', alias: 'a' },
      ]),
    ).toThrow(/cycle/);
  });

  it('записи заморожены: реестр нельзя доправить в рантайме', () => {
    expect(Object.isFrozen(registry.get('text'))).toBe(true);
  });
});
