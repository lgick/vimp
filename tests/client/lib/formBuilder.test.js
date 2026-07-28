import { describe, it, expect, vi } from 'vitest';
import { buildField, buildForm } from '../../../packages/engine/src/client/lib/formBuilder.js';

describe('formBuilder.buildField: select', () => {
  it('строит select из options и возвращает выбранное значение', () => {
    const field = buildField({
      name: 'map',
      control: 'select',
      options: ['arena', 'canyon'],
      default: 'canyon',
    });

    expect(field.el.tagName).toBe('SELECT');
    expect(field.getValue()).toBe('canyon');

    field.setValue('arena');
    expect(field.getValue()).toBe('arena');
  });

  it('source достаёт варианты из ctx.sources', () => {
    const field = buildField(
      { name: 'map', control: 'select', source: 'maps', default: 'b' },
      { sources: { maps: ['a', 'b', 'c'] } },
    );

    const values = [...field.el.options].map(o => o.value);
    expect(values).toEqual(['a', 'b', 'c']);
    expect(field.getValue()).toBe('b');
  });
});

describe('formBuilder.buildField: number/range + unit', () => {
  it('number хранит значение как есть', () => {
    const field = buildField({
      name: 'maxPlayers',
      control: 'number',
      min: 1,
      max: 32,
      default: 8,
    });

    expect(field.el.type).toBe('number');
    expect(field.getValue()).toBe(8);
  });

  it('range с unit:"s" хранит мс, отображает секунды', () => {
    const field = buildField({
      name: 'roundTime',
      control: 'range',
      unit: 's',
      min: 10000,
      max: 3600000,
      default: 120000,
    });

    const input = field.el.querySelector('input[type=range]');
    expect(input.value).toBe('120');
    expect(field.getValue()).toBe(120000);

    field.setValue(60000);
    expect(input.value).toBe('60');
    expect(field.getValue()).toBe(60000);
  });

  it('min/max/step тоже конвертируются в единицы дисплея (unit:"s")', () => {
    const field = buildField({
      name: 'roundTime',
      control: 'range',
      unit: 's',
      min: 10000,
      max: 3600000,
      step: 5000,
      default: 120000,
    });

    const input = field.el.querySelector('input[type=range]');
    expect(input.min).toBe('10');
    expect(input.max).toBe('3600');
    expect(input.step).toBe('5');
  });

  it('пустое числовое поле не превращается в 0 на сабмите', () => {
    const field = buildField({
      name: 'maxPlayers',
      control: 'number',
      min: 1,
      max: 32,
      default: 8,
    });

    field.el.value = '';
    expect(field.getValue()).toBe(8);
  });
});

describe('formBuilder.buildField: toggle', () => {
  it('чекбокс отражает boolean-значение', () => {
    const field = buildField({
      name: 'friendlyFire',
      control: 'toggle',
      default: true,
    });

    const input = field.el.querySelector('input[type=checkbox]');
    expect(input.checked).toBe(true);
    expect(field.getValue()).toBe(true);

    field.setValue(false);
    expect(input.checked).toBe(false);
    expect(field.getValue()).toBe(false);
  });
});

describe('formBuilder.buildField: segmented', () => {
  it('клик по кнопке меняет значение и эмитит onChange', () => {
    const field = buildField({
      name: 'team',
      control: 'segmented',
      options: [
        { value: '1', label: 'Red' },
        { value: '2', label: 'Blue' },
      ],
      default: '1',
    });

    const events = [];
    field.onChange(e => events.push(e));

    const buttons = field.el.querySelectorAll('.field-segmented-btn');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].classList.contains('active')).toBe(true);

    buttons[1].click();

    expect(field.getValue()).toBe('2');
    expect(events).toEqual([{ name: 'team', value: '2' }]);
    expect(buttons[1].classList.contains('active')).toBe(true);
  });
});

describe('formBuilder.buildField: text', () => {
  it('regExp прокидывается атрибутом pattern', () => {
    const field = buildField({
      name: 'color',
      control: 'text',
      regExp: '^#[0-9a-f]{6}$',
      default: '#ffffff',
    });

    expect(field.el.pattern).toBe('^#[0-9a-f]{6}$');
    expect(field.getValue()).toBe('#ffffff');
  });
});

describe('formBuilder.buildForm', () => {
  it('строит .form-row на каждый дескриптор, в порядке массива', () => {
    const container = document.createElement('div');

    const fields = buildForm(
      [
        { name: 'maxPlayers', control: 'number', label: 'Max players', default: 8 },
        { name: 'friendlyFire', control: 'toggle', label: 'Friendly fire', default: false },
      ],
      container,
    );

    const rows = container.querySelectorAll('.form-row');
    expect(rows).toHaveLength(2);
    expect(fields.get('maxPlayers').getValue()).toBe(8);
    expect(fields.get('friendlyFire').getValue()).toBe(false);
    expect(rows[0].querySelector('.form-label').textContent).toBe('Max players');
  });

  it('добавляет суффикс "(s)" к подписи для unit:"s"', () => {
    const container = document.createElement('div');

    buildForm(
      [{ name: 'roundTime', control: 'range', label: 'Round time', unit: 's', default: 60000 }],
      container,
    );

    expect(container.querySelector('.form-label').textContent).toBe('Round time (s)');
  });

  it('подписывает onChange на все поля разом', () => {
    const container = document.createElement('div');
    const events = [];

    const fields = buildForm(
      [{ name: 'nick', control: 'text', label: 'Nick', default: '' }],
      container,
      {},
      e => events.push(e),
    );

    const input = fields.get('nick').el;
    input.value = 'Neo';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(events).toEqual([{ name: 'nick', value: 'Neo' }]);
  });

  it('битый дескриптор логируется и пропускается, остальные поля рендерятся', () => {
    const container = document.createElement('div');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const fields = buildForm(
      [
        { name: 'unknown', control: 'not-a-control', default: 1 },
        { name: 'maxPlayers', control: 'number', label: 'Max players', default: 8 },
      ],
      container,
    );

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unknown'));
    expect(fields.has('unknown')).toBe(false);
    expect(fields.get('maxPlayers').getValue()).toBe(8);
    expect(container.querySelectorAll('.form-row')).toHaveLength(1);

    errorSpy.mockRestore();
  });

  it('засев дефолтов room-формы: roomForm.default побеждает roomDefaults, иначе — из roomDefaults', () => {
    // main.js/populateRoomForm мёржит схему с roomDefaults именно так —
    // тест фиксирует контракт (Часть 6 плана: roomDefaults остаётся
    // единственным источником значений по умолчанию)
    const roomDefaults = { maxPlayers: 8, map: 'pool mini', friendlyFire: true };
    const roomForm = [
      { name: 'maxPlayers', control: 'number', label: 'Max players', min: 1, max: 32 },
      { name: 'map', control: 'select', label: 'Map', source: 'maps' },
      { name: 'friendlyFire', control: 'toggle', label: 'Friendly fire', default: false },
    ];

    const container = document.createElement('div');
    const descriptors = roomForm.map(descriptor => ({
      default: roomDefaults[descriptor.name],
      ...descriptor,
    }));

    const fields = buildForm(descriptors, container, {
      sources: { maps: ['pool mini', 'canopy'] },
    });

    expect(fields.get('maxPlayers').getValue()).toBe(8);
    expect(fields.get('map').getValue()).toBe('pool mini');
    // явный default в схеме побеждает roomDefaults
    expect(fields.get('friendlyFire').getValue()).toBe(false);
  });
});
