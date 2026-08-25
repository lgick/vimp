import { describe, it, expect, vi } from 'vitest';
import {
  buildField,
  buildForm,
  mergeRoomDefaults,
  collectFormErrors,
  renderFormErrors,
} from '../../../packages/engine/src/client/lib/formBuilder.js';

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

describe('formBuilder.buildField: text (нечисловой)', () => {
  it('regExp прокидывается атрибутом pattern', () => {
    const field = buildField({
      name: 'color',
      control: 'text',
      regExp: '^#[0-9a-f]{6}$',
      default: '#ffffff',
    });

    expect(field.el.tagName).toBe('INPUT');
    expect(field.el.type).toBe('text');
    expect(field.el.pattern).toBe('^#[0-9a-f]{6}$');
    expect(field.getValue()).toBe('#ffffff');
  });

  it('required и maxlength прокидываются нативными атрибутами', () => {
    const field = buildField({
      name: 'login',
      control: 'text',
      required: true,
      maxlength: 16,
      default: '',
    });

    expect(field.el.required).toBe(true);
    expect(field.el.maxLength).toBe(16);
  });
});

describe('formBuilder.buildField: text (числовой, unit/numeric)', () => {
  it('numeric:true хранит значение как число', () => {
    const field = buildField({
      name: 'maxPlayers',
      control: 'text',
      numeric: true,
      default: 8,
    });

    expect(field.getValue()).toBe(8);
  });

  it('unit:"s" хранит мс, отображает секунды', () => {
    const field = buildField({
      name: 'roundTime',
      control: 'text',
      unit: 's',
      default: 120000,
    });

    expect(field.el.value).toBe('120');
    expect(field.getValue()).toBe(120000);

    field.setValue(60000);
    expect(field.el.value).toBe('60');
    expect(field.getValue()).toBe(60000);
  });

  it('пустое числовое поле не превращается в 0 на сабмите', () => {
    const field = buildField({
      name: 'maxPlayers',
      control: 'text',
      numeric: true,
      default: 8,
    });

    field.el.value = '';
    expect(field.getValue()).toBe(8);
  });

  it('невалидный ввод откатывается к default', () => {
    const field = buildField({
      name: 'maxPlayers',
      control: 'text',
      numeric: true,
      default: 8,
    });

    field.el.value = 'abc';
    expect(field.getValue()).toBe(8);
  });
});

describe('formBuilder.buildField: checkbox', () => {
  it('чекбокс отражает boolean-значение', () => {
    const field = buildField({
      name: 'friendlyFire',
      control: 'checkbox',
      default: true,
    });

    expect(field.el.tagName).toBe('INPUT');
    expect(field.el.type).toBe('checkbox');
    expect(field.el.checked).toBe(true);
    expect(field.getValue()).toBe(true);

    field.setValue(false);
    expect(field.el.checked).toBe(false);
    expect(field.getValue()).toBe(false);
  });

  it('field.labelFor указывает на id инпута (для <label for>)', () => {
    const field = buildField({ name: 'friendlyFire', control: 'checkbox', default: false });

    expect(field.labelFor).toBe(field.el.id);
  });
});

describe('formBuilder.buildField: radio', () => {
  it('группа radio с общим name, getValue/setValue по value', () => {
    const field = buildField({
      name: 'team',
      control: 'radio',
      options: [
        { value: '1', label: 'Red' },
        { value: '2', label: 'Blue' },
      ],
      default: '1',
    });

    const inputs = field.el.querySelectorAll('input[type=radio]');
    expect(inputs).toHaveLength(2);
    expect(inputs[0].name).toBe(inputs[1].name);
    expect(inputs[0].checked).toBe(true);
    expect(field.getValue()).toBe('1');

    field.setValue('2');
    expect(inputs[1].checked).toBe(true);
    expect(field.getValue()).toBe('2');
  });

  it('изменение radio эмитит onChange', () => {
    const field = buildField({
      name: 'team',
      control: 'radio',
      options: [
        { value: '1', label: 'Red' },
        { value: '2', label: 'Blue' },
      ],
      default: '1',
    });

    const events = [];
    field.onChange(e => events.push(e));

    const inputs = field.el.querySelectorAll('input[type=radio]');
    inputs[1].checked = true;
    inputs[1].dispatchEvent(new Event('change', { bubbles: true }));

    expect(events).toEqual([{ name: 'team', value: '2' }]);
  });

  it('каждый вариант подписан <label for>', () => {
    const field = buildField({
      name: 'team',
      control: 'radio',
      options: [{ value: '1', label: 'Red' }],
    });

    const input = field.el.querySelector('input[type=radio]');
    const label = field.el.querySelector('label');
    expect(label.htmlFor).toBe(input.id);
    expect(label.textContent).toBe('Red');
  });
});

describe('formBuilder.buildForm', () => {
  it('строит .form-row на каждый дескриптор, в порядке массива', () => {
    const container = document.createElement('div');

    const fields = buildForm(
      [
        { name: 'maxPlayers', control: 'text', numeric: true, label: 'Max players', default: 8 },
        { name: 'friendlyFire', control: 'checkbox', label: 'Friendly fire', default: false },
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
      [{ name: 'roundTime', control: 'text', label: 'Round time', unit: 's', default: 60000 }],
      container,
    );

    expect(container.querySelector('.form-label').textContent).toBe('Round time (s)');
  });

  it('добавляет суффикс с диапазоном к подписи для min/max', () => {
    const container = document.createElement('div');

    buildForm(
      [
        {
          name: 'maxPlayers',
          control: 'text',
          numeric: true,
          label: 'Max players',
          min: 1,
          max: 30,
          default: 8,
        },
      ],
      container,
    );

    expect(container.querySelector('.form-label').textContent).toBe('Max players (1–30)');
  });

  it('комбинирует unit:"s" и диапазон в одном суффиксе', () => {
    const container = document.createElement('div');

    buildForm(
      [
        {
          name: 'roundTime',
          control: 'text',
          label: 'Round time',
          unit: 's',
          min: 10,
          max: 3600,
          default: 60000,
        },
      ],
      container,
    );

    expect(container.querySelector('.form-label').textContent).toBe('Round time (s, 10–3600)');
  });

  it('select с единственным резолвнутым вариантом не рендерит .form-row, но попадает в fields', () => {
    const container = document.createElement('div');

    const fields = buildForm(
      [{ name: 'map', control: 'select', label: 'Map', options: ['pool mini'], default: 'pool mini' }],
      container,
    );

    expect(container.querySelectorAll('.form-row')).toHaveLength(0);
    expect(fields.get('map').getValue()).toBe('pool mini');
  });

  it('radio с единственным резолвнутым вариантом не рендерит .form-row', () => {
    const container = document.createElement('div');

    const fields = buildForm(
      [{ name: 'team', control: 'radio', label: 'Team', options: [{ value: '1', label: 'Red' }], default: '1' }],
      container,
    );

    expect(container.querySelectorAll('.form-row')).toHaveLength(0);
    expect(fields.get('team').getValue()).toBe('1');
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

  it('hidden:true — поле в fields Map, но без .form-row в DOM', () => {
    const container = document.createElement('div');

    const fields = buildForm(
      [
        { name: 'secret', control: 'text', label: 'Secret', default: 'x', hidden: true },
        { name: 'visible', control: 'text', label: 'Visible', default: 'y' },
      ],
      container,
    );

    expect(container.querySelectorAll('.form-row')).toHaveLength(1);
    expect(fields.has('secret')).toBe(true);
    expect(fields.get('secret').getValue()).toBe('x');
    expect(container.textContent).not.toContain('Secret');
  });

  it('битый дескриптор логируется и пропускается, остальные поля рендерятся', () => {
    const container = document.createElement('div');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const fields = buildForm(
      [
        { name: 'unknown', control: 'not-a-control', default: 1 },
        { name: 'maxPlayers', control: 'text', numeric: true, label: 'Max players', default: 8 },
      ],
      container,
    );

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unknown'));
    expect(fields.has('unknown')).toBe(false);
    expect(fields.get('maxPlayers').getValue()).toBe(8);
    expect(container.querySelectorAll('.form-row')).toHaveLength(1);

    errorSpy.mockRestore();
  });
});

describe('formBuilder.mergeRoomDefaults', () => {
  // main.js/populateRoomForm вызывает именно эту функцию — тест накрывает
  // продовый путь напрямую, а не повторяет мёрж своей копией (Часть 6 плана:
  // roomDefaults остаётся единственным источником значений по умолчанию)
  const roomDefaults = { maxPlayers: 8, map: 'pool mini', friendlyFire: true };
  const roomForm = [
    { name: 'maxPlayers', control: 'text', numeric: true, label: 'Max players' },
    { name: 'map', control: 'select', label: 'Map', source: 'maps' },
    { name: 'friendlyFire', control: 'checkbox', label: 'Friendly fire', default: false },
  ];

  it('засевает default полей значениями roomDefaults', () => {
    const container = document.createElement('div');
    const descriptors = mergeRoomDefaults(roomForm, roomDefaults);

    const fields = buildForm(descriptors, container, {
      sources: { maps: ['pool mini', 'canopy'] },
    });

    expect(fields.get('maxPlayers').getValue()).toBe(8);
    expect(fields.get('map').getValue()).toBe('pool mini');
    // явный default в схеме побеждает roomDefaults
    expect(fields.get('friendlyFire').getValue()).toBe(false);
  });

  it('не трогает дескрипторы с явным default', () => {
    const descriptors = mergeRoomDefaults(roomForm, roomDefaults);

    expect(descriptors.find(d => d.name === 'friendlyFire').default).toBe(false);
    expect(descriptors.find(d => d.name === 'maxPlayers').default).toBe(8);
  });
});

describe('formBuilder.collectFormErrors', () => {
  it('пустая обязательная строка — ошибка "required"', () => {
    const container = document.createElement('div');
    const descriptors = [{ name: 'login', control: 'text', label: 'Login', required: true, default: '' }];
    const fields = buildForm(descriptors, container);

    fields.get('login').el.value = '';

    expect(collectFormErrors(descriptors, fields)).toEqual([{ name: 'login', error: 'required' }]);
  });

  it('значение не матчится под regExp — ошибка формата', () => {
    const container = document.createElement('div');
    const descriptors = [
      { name: 'color', control: 'text', label: 'Color', regExp: '^#[0-9a-f]{6}$', default: '#ffffff' },
    ];
    const fields = buildForm(descriptors, container);

    fields.get('color').el.value = 'not-a-color';

    expect(collectFormErrors(descriptors, fields)).toEqual([{ name: 'color', error: 'invalid format' }]);
  });

  it('строка длиннее maxlength — ошибка длины', () => {
    const container = document.createElement('div');
    const descriptors = [{ name: 'login', control: 'text', label: 'Login', maxlength: 4, default: '' }];
    const fields = buildForm(descriptors, container);

    fields.get('login').el.value = 'toolong';

    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'login', error: 'must be at most 4 characters' },
    ]);
  });

  it('числовое значение вне min/max — ошибка диапазона', () => {
    const container = document.createElement('div');
    const descriptors = [
      { name: 'maxPlayers', control: 'text', numeric: true, label: 'Max players', min: 1, max: 30, default: 8 },
    ];
    const fields = buildForm(descriptors, container);

    fields.get('maxPlayers').el.value = '40';
    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'maxPlayers', error: 'must be ≤ 30' },
    ]);

    fields.get('maxPlayers').el.value = '0';
    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'maxPlayers', error: 'must be ≥ 1' },
    ]);
  });

  it('min/max сравниваются в отображаемой единице (unit:"s")', () => {
    const container = document.createElement('div');
    const descriptors = [
      { name: 'roundTime', control: 'text', unit: 's', label: 'Round time', min: 10, max: 3600, default: 60000 },
    ];
    const fields = buildForm(descriptors, container);

    fields.get('roundTime').el.value = '5';

    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'roundTime', error: 'must be ≥ 10' },
    ]);
  });

  it('валидная форма не даёт ошибок', () => {
    const container = document.createElement('div');
    const descriptors = [
      { name: 'maxPlayers', control: 'text', numeric: true, label: 'Max players', min: 1, max: 30, default: 8 },
      { name: 'friendlyFire', control: 'checkbox', label: 'Friendly fire', default: false },
    ];
    const fields = buildForm(descriptors, container);

    expect(collectFormErrors(descriptors, fields)).toEqual([]);
  });
});

describe('formBuilder.renderFormErrors', () => {
  it('рендерит по одной строке на ошибку', () => {
    const container = document.createElement('div');

    renderFormErrors(container, [
      { name: 'login', error: 'too short' },
      { name: 'team', error: '' },
    ]);

    const lines = [...container.children];
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toBe('LOGIN: too short');
    expect(lines[1].textContent).toBe('TEAM is not correctly!');
  });

  it('пустой список ошибок очищает контейнер', () => {
    const container = document.createElement('div');
    container.textContent = 'старая ошибка';

    renderFormErrors(container, []);

    expect(container.textContent).toBe('');
  });
});
