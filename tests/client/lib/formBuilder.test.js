import { describe, it, expect, vi } from 'vitest';
import {
  buildField,
  buildForm,
  mergeRoomDefaults,
  collectFormErrors,
  renderFormErrors,
  resolveForcedValue,
  bindLiveErrors,
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

  it('единственный вариант — принудительное значение, default/setValue его не переопределяют', () => {
    const field = buildField({
      name: 'model',
      control: 'select',
      options: ['s1'],
      // сервер (устаревший localStorage, например) прислал значение,
      // которого больше нет в списке — было бы default, если бы не forced
      default: 's0',
    });

    expect(field.getValue()).toBe('s1');

    field.setValue('s0');
    expect(field.getValue()).toBe('s1');
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

  it('единственный вариант — принудительное значение, default/setValue его не переопределяют', () => {
    const field = buildField({
      name: 'team',
      control: 'radio',
      options: [{ value: '1', label: 'Red' }],
      default: '9',
    });

    expect(field.getValue()).toBe('1');

    field.setValue('9');
    expect(field.getValue()).toBe('1');
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

    expect(collectFormErrors(descriptors, fields)).toEqual([{ name: 'login', label: 'Login', error: 'required' }]);
  });

  it('значение не матчится под regExp — ошибка формата', () => {
    const container = document.createElement('div');
    const descriptors = [
      { name: 'color', control: 'text', label: 'Color', regExp: '^#[0-9a-f]{6}$', default: '#ffffff' },
    ];
    const fields = buildForm(descriptors, container);

    fields.get('color').el.value = 'not-a-color';

    expect(collectFormErrors(descriptors, fields)).toEqual([{ name: 'color', label: 'Color', error: 'invalid format' }]);
  });

  it('строка длиннее maxlength — ошибка длины', () => {
    const container = document.createElement('div');
    const descriptors = [{ name: 'login', control: 'text', label: 'Login', maxlength: 4, default: '' }];
    const fields = buildForm(descriptors, container);

    fields.get('login').el.value = 'toolong';

    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'login', label: 'Login', error: 'must be at most 4 characters' },
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
      { name: 'maxPlayers', label: 'Max players', error: 'must be ≤ 30' },
    ]);

    fields.get('maxPlayers').el.value = '0';
    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'maxPlayers', label: 'Max players', error: 'must be ≥ 1' },
    ]);
  });

  it('regExp у numeric-поля проверяется тоже — единственная граница у манифестов без min/max (vimp-snakes/maxPlayers)', () => {
    const container = document.createElement('div');
    const descriptors = [
      {
        name: 'maxPlayers',
        control: 'text',
        numeric: true,
        label: 'Max players',
        regExp: '^([1-8])$',
        default: 8,
      },
    ];
    const fields = buildForm(descriptors, container);

    fields.get('maxPlayers').el.value = '40';

    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'maxPlayers', label: 'Max players', error: 'invalid format' },
    ]);

    fields.get('maxPlayers').el.value = '8';
    expect(collectFormErrors(descriptors, fields)).toEqual([]);
  });

  it('regExp неявно закреплён по всей строке — как нативный pattern (rangeToPattern не даёт своих ^…$)', () => {
    const container = document.createElement('div');
    // ровно то, что build-game-manifest.js/rangeToPattern генерирует для
    // maxPlayers 1..32 — без собственных ^/$: правило рассчитано на
    // атрибут pattern, который браузер сам оборачивает в ^(?:…)$
    const descriptors = [
      {
        name: 'maxPlayers',
        control: 'text',
        numeric: true,
        label: 'Max players',
        regExp: '(?:[1-9]|1[0-9]|2[0-9]|3[0-2])',
        default: 8,
      },
    ];
    const fields = buildForm(descriptors, container);

    // без якорей "99" матчится частично (первая "9" — валидная цифра) —
    // именно так значение вне диапазона молча проходило на lobby
    fields.get('maxPlayers').el.value = '99';
    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'maxPlayers', label: 'Max players', error: 'invalid format' },
    ]);

    fields.get('maxPlayers').el.value = '32';
    expect(collectFormErrors(descriptors, fields)).toEqual([]);
  });

  it('min/max сравниваются в отображаемой единице (unit:"s")', () => {
    const container = document.createElement('div');
    const descriptors = [
      { name: 'roundTime', control: 'text', unit: 's', label: 'Round time', min: 10, max: 3600, default: 60000 },
    ];
    const fields = buildForm(descriptors, container);

    fields.get('roundTime').el.value = '5';

    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'roundTime', label: 'Round time', error: 'must be ≥ 10' },
    ]);
  });

  it('поле без строки в DOM не валидируется — иначе форма заперта навсегда', () => {
    const container = document.createElement('div');
    // hidden и единственный вариант select/radio: игрок такого поля не
    // видит и исправить ошибку на нём не может
    const descriptors = [
      { name: 'secret', control: 'text', label: 'Secret', hidden: true, required: true, default: '' },
      { name: 'map', control: 'select', label: 'Map', options: ['only'], required: true },
    ];
    const fields = buildForm(descriptors, container);

    expect(container.querySelectorAll('.form-row')).toHaveLength(0);
    expect(collectFormErrors(descriptors, fields)).toEqual([]);
  });

  it('select без вариантов остаётся видимым и валидируется', () => {
    const container = document.createElement('div');
    const descriptors = [
      { name: 'map', control: 'select', label: 'Map', source: 'maps', required: true },
    ];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fields = buildForm(descriptors, container, { sources: { maps: [] } });

    // пустой список — дефект каталога, а не «нечего выбирать»: спрятать
    // такое поле значит отправить на хост пустую строку без единой ошибки
    expect(container.querySelectorAll('.form-row')).toHaveLength(1);
    expect(fields.get('map').singleOption).toBe(false);
    expect(error).toHaveBeenCalled();
    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'map', label: 'Map', error: 'no options available' },
    ]);

    error.mockRestore();
  });

  it('select без вариантов — ошибка и без required (vimp-tanks/map)', () => {
    const container = document.createElement('div');
    // ни одна игра не ставит required на `map`: без собственной ошибки
    // пустого резолва комната создавалась бы с map: ''
    const descriptors = [{ name: 'map', control: 'select', label: 'Map', source: 'maps' }];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fields = buildForm(descriptors, container, { sources: { maps: [] } });

    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'map', label: 'Map', error: 'no options available' },
    ]);

    error.mockRestore();
  });

  it('пустое обязательное числовое поле — "required", а не молчаливый default', () => {
    const container = document.createElement('div');
    const descriptors = [
      { name: 'maxPlayers', control: 'text', numeric: true, label: 'Max players', required: true, default: 8 },
    ];
    const fields = buildForm(descriptors, container);

    fields.get('maxPlayers').el.value = '';

    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'maxPlayers', label: 'Max players', error: 'required' },
    ]);
  });

  it('пустое числовое поле — ошибка даже без required (vimp-snakes/maxPlayers)', () => {
    const container = document.createElement('div');
    // ни одна игра не ставит required на maxPlayers: значение поля всё
    // равно обязательно — getValue() подменил бы пустоту дефолтом и
    // комната создалась бы молча
    const descriptors = [
      { name: 'maxPlayers', control: 'text', numeric: true, label: 'Max players', min: 1, max: 32, default: 8 },
    ];
    const fields = buildForm(descriptors, container);

    fields.get('maxPlayers').el.value = '';

    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'maxPlayers', label: 'Max players', error: 'required' },
    ]);
  });

  it('пустое необязательное текстовое поле ошибкой не считается', () => {
    const container = document.createElement('div');
    const descriptors = [{ name: 'motd', control: 'text', label: 'MOTD', maxlength: 32, default: '' }];
    const fields = buildForm(descriptors, container);

    expect(collectFormErrors(descriptors, fields)).toEqual([]);
  });

  it('нечисловой ввод в числовое поле без regExp — ошибка, а не откат к default', () => {
    const container = document.createElement('div');
    const descriptors = [
      { name: 'maxPlayers', control: 'text', numeric: true, label: 'Max players', min: 1, max: 30, default: 8 },
    ];
    const fields = buildForm(descriptors, container);

    fields.get('maxPlayers').el.value = 'много';

    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'maxPlayers', label: 'Max players', error: 'must be a number' },
    ]);
  });

  it('пробелы вокруг значения не мешают, но одни пробелы — пустое поле', () => {
    const container = document.createElement('div');
    // Number(' ') === 0: без trim пробел уехал бы нулём в игру, объявившую
    // numeric без min/max и без regExp
    const descriptors = [
      { name: 'maxPlayers', control: 'text', numeric: true, label: 'Max players', default: 8 },
    ];
    const fields = buildForm(descriptors, container);

    fields.get('maxPlayers').el.value = ' 6 ';
    expect(collectFormErrors(descriptors, fields)).toEqual([]);

    fields.get('maxPlayers').el.value = '   ';
    expect(collectFormErrors(descriptors, fields)).toEqual([
      { name: 'maxPlayers', label: 'Max players', error: 'required' },
    ]);
  });

  it('некомпилируемый regExp не роняет сабмит — поле проходит, дефект в консоли', () => {
    const container = document.createElement('div');
    // regExp приезжает из манифеста строкой: SyntaxError из new RegExp ушёл
    // бы из collectFormErrors в обработчик клика, и кнопка перестала бы
    // работать вовсе, не показав игроку ни строки
    const descriptors = [
      { name: 'color', control: 'text', label: 'Color', regExp: '^#[0-9a-f{6}$', default: '' },
    ];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fields = buildForm(descriptors, container);

    fields.get('color').el.value = 'zzz';

    expect(() => collectFormErrors(descriptors, fields)).not.toThrow();
    expect(collectFormErrors(descriptors, fields)).toEqual([]);
    // паттерн компилируется один раз на строку, а не на каждую проверку
    expect(error).toHaveBeenCalledTimes(1);

    error.mockRestore();
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

  it('подпись поля из формы важнее имени — серверные ошибки без label остаются на имени', () => {
    const container = document.createElement('div');

    renderFormErrors(container, [
      { name: 'maxPlayers', label: 'Max players', error: 'must be ≤ 8' },
      { name: 'model', error: 'unknown model' },
    ]);

    expect(container.children[0].textContent).toBe('MAX PLAYERS: must be ≤ 8');
    expect(container.children[1].textContent).toBe('MODEL: unknown model');
  });

  it('пустой список ошибок очищает контейнер', () => {
    const container = document.createElement('div');
    container.textContent = 'старая ошибка';

    renderFormErrors(container, []);

    expect(container.textContent).toBe('');
  });
});

describe('formBuilder.resolveForcedValue', () => {
  // solo-путь (boot.autoAuth) отвечает хосту без формы и обязан прийти к
  // тому же значению, что и она
  it('единственный вариант select — его значение', () => {
    expect(resolveForcedValue({ control: 'select', options: ['s1'] })).toBe('s1');
    expect(
      resolveForcedValue({ control: 'radio', options: [{ value: '1', label: 'Red' }] }),
    ).toBe('1');
  });

  it('несколько вариантов, пустой список и не-select — undefined', () => {
    expect(resolveForcedValue({ control: 'select', options: ['a', 'b'] })).toBeUndefined();
    expect(resolveForcedValue({ control: 'select', options: [] })).toBeUndefined();
    expect(resolveForcedValue({ control: 'text' })).toBeUndefined();
  });

  it('source резолвится через ctx.sources — как в форме', () => {
    expect(
      resolveForcedValue({ control: 'select', source: 'maps' }, { sources: { maps: ['pool'] } }),
    ).toBe('pool');
  });

  it('нестроковый вариант приводится к строке — как отдал бы DOM', () => {
    // <option>.value и <input type=radio>.value — DOM-свойства, всегда
    // строки. Нестроковое значение validateAuth отбивает «Property must be
    // a string», а строки поля в DOM нет — поправить нечем
    expect(resolveForcedValue({ control: 'select', options: [{ value: 1, label: 'Solo' }] })).toBe(
      '1',
    );
    expect(resolveForcedValue({ control: 'radio', options: [7] })).toBe('7');
  });
});

describe('formBuilder.bindLiveErrors', () => {
  const makeForm = () => {
    const container = document.createElement('div');
    const errorContainer = document.createElement('div');
    const descriptors = [
      { name: 'login', control: 'text', label: 'Login', required: true, default: '' },
      { name: 'motd', control: 'text', label: 'MOTD', required: true, default: '' },
    ];
    const fields = buildForm(descriptors, container);
    const arm = bindLiveErrors(container, errorContainer, () => ({ descriptors, fields }));

    return { container, errorContainer, descriptors, fields, arm };
  };

  const type = (field, value) => {
    field.el.value = value;
    field.el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('до первого сабмита правка формы ничего не рисует', () => {
    const { errorContainer, fields } = makeForm();

    type(fields.get('login'), 'B');

    expect(errorContainer.textContent).toBe('');
  });

  it('после сабмита строка уходит по мере починки своего поля', () => {
    const { errorContainer, descriptors, fields, arm } = makeForm();

    arm();
    renderFormErrors(errorContainer, collectFormErrors(descriptors, fields));
    expect(errorContainer.children).toHaveLength(2);

    // правка одного поля не должна уносить ошибку второго — иначе игрок
    // теряет список того, что ещё не починено
    type(fields.get('login'), 'Bob');
    expect(errorContainer.children).toHaveLength(1);
    expect(errorContainer.textContent).toBe('MOTD: required');

    type(fields.get('motd'), 'hi');
    expect(errorContainer.children).toHaveLength(0);
  });

  it('пустой контейнер полей не роняет привязку', () => {
    expect(() => bindLiveErrors(null, document.createElement('div'), () => ({}))).not.toThrow();
  });
});
