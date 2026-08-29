import { describe, it, expect } from 'vitest';
import {
  formControls,
  resolveControl,
  resolveDescriptor,
  ACTIVE_FORM_CONTROLS,
} from '../../packages/engine/src/lib/formControls.js';
import {
  buildField,
  collectFormErrors,
  resolveForcedValue,
  FORM_CONTROLS,
} from '../../packages/engine/src/client/lib/formBuilder.js';

// Контролы, выведенные из эксплуатации в v3 (этап 3 плана
// plugin-forward-compat): игра под v2 написала их в манифесте, её dist
// больше никто не тронет — форма обязана строиться и валидироваться.

describe('реестр контролов', () => {
  it('активные имена реестра совпадают с тем, что умеет билдер', () => {
    expect([...ACTIVE_FORM_CONTROLS].sort()).toEqual([...FORM_CONTROLS].sort());
  });

  it('выведенные имена остались в реестре и разрешаются в нативные', () => {
    expect(resolveControl('range')).toEqual({
      control: 'text',
      patch: { numeric: true },
    });
    expect(formControls.resolve('number')).toBe('text');
    expect(formControls.resolve('toggle')).toBe('checkbox');
    expect(formControls.resolve('segmented')).toBe('radio');
    expect(formControls.get('segmented').retiredIn).toBe(3);
  });

  it('неизвестный контрол не разрешается', () => {
    expect(resolveControl('slider')).toBeUndefined();
    expect(resolveDescriptor({ control: 'slider' }).control).toBe('slider');
  });
});

describe('формы под выведенные контролы', () => {
  it('range строится числовым text-инпутом с работающей валидацией', () => {
    const descriptor = {
      name: 'maxPlayers',
      control: 'range',
      min: 1,
      max: 8,
      default: 4,
    };
    const field = buildField(descriptor);

    expect(field.el.tagName).toBe('INPUT');
    expect(field.el.type).toBe('text');
    expect(field.getValue()).toBe(4);

    field.el.value = '9';
    expect(
      collectFormErrors([descriptor], new Map([['maxPlayers', field]])),
    ).toEqual([
      { name: 'maxPlayers', label: 'maxPlayers', error: 'must be ≤ 8' },
    ]);

    field.el.value = '6';
    expect(
      collectFormErrors([descriptor], new Map([['maxPlayers', field]])),
    ).toEqual([]);
    // числовое поле отдаёт число, а не строку: хост получает то же, что и от
    // нативного text с numeric:true
    expect(field.getValue()).toBe(6);
  });

  it('number ведёт себя как range: пустой ввод — ошибка, а не молчаливый ноль', () => {
    const descriptor = { name: 'roundTime', control: 'number', default: 60 };
    const field = buildField(descriptor);

    field.el.value = '';
    expect(
      collectFormErrors([descriptor], new Map([['roundTime', field]])),
    ).toEqual([{ name: 'roundTime', label: 'roundTime', error: 'required' }]);
  });

  it('toggle строится нативным checkbox', () => {
    const field = buildField({
      name: 'friendlyFire',
      control: 'toggle',
      default: true,
    });

    expect(field.el.type).toBe('checkbox');
    expect(field.getValue()).toBe(true);
  });

  it('segmented строится группой radio и участвует в forcedValue', () => {
    const descriptor = {
      name: 'mode',
      control: 'segmented',
      options: ['ffa', 'team'],
    };
    const field = buildField(descriptor);

    expect([...field.el.querySelectorAll('input')].map(i => i.type)).toEqual([
      'radio',
      'radio',
    ]);

    field.setValue('team');
    expect(field.getValue()).toBe('team');

    // единственный вариант — принудительное значение, как и у radio
    expect(resolveForcedValue({ ...descriptor, options: ['ffa'] })).toBe('ffa');
  });
});
