// Общий билдер полей форм (room-форма и auth-форма используют один
// контракт дескрипторов — docs/en/plugin-api.md, раздел "Form schema").
// control: 'select'|'range'|'number'|'toggle'|'segmented'|'text'

function normalizeOptions(list) {
  return (list || []).map(opt =>
    opt !== null && typeof opt === 'object' ? opt : { value: opt, label: String(opt) },
  );
}

// 'source' — спец-источник вариантов из каталога движка (например карты),
// прокидывается вызывающей стороной через ctx.sources
function resolveOptions(descriptor, ctx) {
  if (descriptor.source) {
    return normalizeOptions(ctx?.sources?.[descriptor.source]);
  }

  return normalizeOptions(descriptor.options);
}

// unit:'s' — значение хранится в мс, показывается/редактируется в секундах
function toDisplay(descriptor, value) {
  return descriptor.unit === 's' ? value / 1000 : value;
}

function toStored(descriptor, value) {
  return descriptor.unit === 's' ? value * 1000 : value;
}

function buildSelect(descriptor, ctx) {
  const el = document.createElement('select');

  el.className = 'field-select';
  el.name = descriptor.name;

  resolveOptions(descriptor, ctx).forEach(({ value, label }) => {
    const option = document.createElement('option');

    option.value = value;
    option.textContent = label;
    el.appendChild(option);
  });

  return {
    el,
    getValue: () => el.value,
    setValue(value) {
      el.value = value;
    },
    onChange(cb) {
      el.addEventListener('change', () => cb({ name: descriptor.name, value: el.value }));
    },
  };
}

function buildRangeOrNumber(descriptor, type) {
  const el = document.createElement('input');

  el.type = type;
  el.name = descriptor.name;
  el.className = type === 'range' ? 'field-range' : 'field-number';

  // границы схемы — в единицах хранения (мс для unit:'s'), как и default;
  // конвертируем в единицы дисплея, иначе для unit:'s' min/max/step
  // пришлось бы писать в секундах, а default — в мс (несогласованный контракт)
  if (descriptor.min !== undefined) {
    el.min = toDisplay(descriptor, descriptor.min);
  }

  if (descriptor.max !== undefined) {
    el.max = toDisplay(descriptor, descriptor.max);
  }

  if (descriptor.step !== undefined) {
    el.step = toDisplay(descriptor, descriptor.step);
  }

  // пустой/невалидный ввод (очищенное числовое поле) не должен превращаться
  // в 0 на сабмите — откатываемся к дефолту схемы
  const fallback = () => toDisplay(descriptor, descriptor.default ?? 0);

  const getValue = () => {
    const n = Number(el.value);
    const value = el.value !== '' && Number.isFinite(n) ? n : fallback();

    return toStored(descriptor, value);
  };

  if (type === 'number') {
    return {
      el,
      getValue,
      setValue(value) {
        el.value = toDisplay(descriptor, value);
      },
      onChange(cb) {
        el.addEventListener('change', () => cb({ name: descriptor.name, value: getValue() }));
      },
    };
  }

  // range — трек + числовой readout рядом (tabular-nums в CSS)
  const wrap = document.createElement('span');

  wrap.className = 'field-range-wrap';

  const readout = document.createElement('output');

  readout.className = 'field-range-value';
  wrap.append(el, readout);

  const setValue = value => {
    el.value = toDisplay(descriptor, value);
    readout.textContent = el.value;
  };

  el.addEventListener('input', () => {
    readout.textContent = el.value;
  });

  return {
    el: wrap,
    getValue,
    setValue,
    onChange(cb) {
      el.addEventListener('change', () => cb({ name: descriptor.name, value: getValue() }));
    },
  };
}

function buildToggle(descriptor) {
  // <label> целиком (переключатель + подпись, добавляемая в buildForm) —
  // клик по тексту переключает чекбокс "бесплатно", без for/id (a11y)
  const wrapper = document.createElement('label');

  wrapper.className = 'field-toggle';

  const switchEl = document.createElement('span');

  switchEl.className = 'field-toggle-switch';

  const el = document.createElement('input');

  el.type = 'checkbox';
  el.name = descriptor.name;

  const track = document.createElement('span');

  track.className = 'field-toggle-track';
  switchEl.append(el, track);
  wrapper.append(switchEl);

  return {
    el: wrapper,
    getValue: () => el.checked,
    setValue(value) {
      el.checked = Boolean(value);
    },
    onChange(cb) {
      el.addEventListener('change', () => cb({ name: descriptor.name, value: el.checked }));
    },
  };
}

function buildSegmented(descriptor, ctx) {
  const el = document.createElement('div');

  el.className = 'field-segmented';
  el.setAttribute('role', 'group');

  if (descriptor.label) {
    el.setAttribute('aria-label', descriptor.label);
  }

  const buttons = [];
  let current;
  let changeCb = null;

  const setActive = value => {
    current = value;
    buttons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === String(value));
    });
  };

  resolveOptions(descriptor, ctx).forEach(({ value, label }) => {
    const btn = document.createElement('button');

    btn.type = 'button';
    btn.className = 'field-segmented-btn';
    btn.dataset.value = value;
    btn.textContent = label;

    btn.addEventListener('click', () => {
      setActive(value);
      changeCb?.({ name: descriptor.name, value: current });
    });

    buttons.push(btn);
    el.appendChild(btn);
  });

  return {
    el,
    getValue: () => current,
    setValue(value) {
      setActive(value);
    },
    onChange(cb) {
      changeCb = cb;
    },
  };
}

function buildText(descriptor) {
  const el = document.createElement('input');

  el.type = 'text';
  el.name = descriptor.name;
  el.className = 'field-text';

  if (descriptor.regExp) {
    el.pattern = descriptor.regExp;
  }

  return {
    el,
    getValue: () => el.value,
    setValue(value) {
      el.value = value ?? '';
    },
    onChange(cb) {
      el.addEventListener('change', () => cb({ name: descriptor.name, value: el.value }));
    },
  };
}

const builders = {
  select: buildSelect,
  range: descriptor => buildRangeOrNumber(descriptor, 'range'),
  number: descriptor => buildRangeOrNumber(descriptor, 'number'),
  toggle: buildToggle,
  segmented: buildSegmented,
  text: buildText,
};

// строит одно поле формы по дескриптору (docs/en/plugin-api.md, "Form schema")
export function buildField(descriptor, ctx = {}) {
  const build = builders[descriptor.control];

  if (!build) {
    throw new Error(`formBuilder: unknown control "${descriptor.control}"`);
  }

  const field = build(descriptor, ctx);

  if (descriptor.default !== undefined) {
    field.setValue(descriptor.default);
  }

  return field;
}

// собирает форму (упорядоченный массив дескрипторов = порядок полей) в
// контейнер: одна .form-row на дескриптор (.form-label + контрол); onChange,
// если передан, подписывается на все поля разом
export function buildForm(descriptors, container, ctx = {}, onChange) {
  const fields = new Map();

  container.textContent = '';

  descriptors.forEach(descriptor => {
    let field;

    try {
      field = buildField(descriptor, ctx);
    } catch (e) {
      // одно поле с кривой/неизвестной схемой не должно ронять всю форму
      // (room-форма и особенно auth-форма — единственный путь к кнопке Start)
      console.error(`formBuilder: skipping field "${descriptor.name}" — ${e.message}`);
      return;
    }

    const row = document.createElement('div');

    row.className = 'form-row';

    const label = document.createElement('span');

    label.className = 'form-label';
    label.textContent = (descriptor.label || descriptor.name) + (descriptor.unit === 's' ? ' (s)' : '');

    // toggle: field.el уже <label> — кладём подпись внутрь него, а не рядом,
    // иначе клик по тексту не переключает чекбокс (a11y)
    if (descriptor.control === 'toggle') {
      field.el.appendChild(label);
      row.append(field.el);
    } else {
      row.append(label, field.el);
    }

    if (onChange) {
      field.onChange(onChange);
    }

    container.appendChild(row);
    fields.set(descriptor.name, field);
  });

  return fields;
}
