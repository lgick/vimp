// Общий билдер полей форм (room-форма и auth-форма используют один
// контракт дескрипторов — docs/en/plugin-api.md, раздел "Form schema").
// control: 'select'|'text'|'checkbox'|'radio'; все контролы — нативные
// элементы формы, без визуальной кастомизации. Валидация — не нативная
// (никаких браузерных попапов): collectFormErrors/renderFormErrors ниже
// собирают и рисуют ошибки в разметку (#lobby-error/#auth-error).
// Проверяются только поля, у которых есть строка в DOM: ошибка на скрытом
// поле игроку не видна и исправить её нечем — она просто запирает форму.

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

// ровно один резолвнутый вариант — единственно возможное значение поля:
// строка формы для него не рендерится (игроку нечего выбирать и нечем
// поправить рассинхрон), поэтому ничто извне (устаревший localStorage,
// default из схемы, серверное PS_AUTH_DATA) не должно иметь возможности
// его переопределить — native <select>.value на несуществующем option
// молча схлопывается в '' без единой ошибки (vimp-snakes/model)
function forcedValue(options) {
  return options.length === 1 ? options[0].value : undefined;
}

// то же правило вне формы: solo-путь (boot.autoAuth) отвечает хосту без
// всякой формы и должен прийти ровно к тому же значению, что и она
export function resolveForcedValue(descriptor, ctx = {}) {
  if (descriptor.control !== 'select' && descriptor.control !== 'radio') {
    return undefined;
  }

  return forcedValue(resolveOptions(descriptor, ctx));
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
  const options = resolveOptions(descriptor, ctx);
  const forced = forcedValue(options);

  el.name = descriptor.name;

  options.forEach(({ value, label }) => {
    const option = document.createElement('option');

    option.value = value;
    option.textContent = label;
    el.appendChild(option);
  });

  if (forced !== undefined) {
    el.value = forced;
  }

  return {
    el,
    singleOption: forced !== undefined,
    noOptions: options.length === 0,
    getValue: () => el.value,
    setValue(value) {
      if (forced !== undefined) {
        return;
      }

      el.value = value;
    },
    onChange(cb) {
      el.addEventListener('change', () => cb({ name: descriptor.name, value: el.value }));
    },
  };
}

// numeric text-поле (unit задан или numeric:true) — переиспользует
// toDisplay/toStored, откатывается к default при пустом/невалидном вводе,
// вместо превращения его в 0 на сабмите
function buildText(descriptor) {
  const el = document.createElement('input');
  const numeric = descriptor.numeric || descriptor.unit !== undefined;

  el.type = 'text';
  el.name = descriptor.name;

  // pattern/required — семантика контрола (a11y, автозаполнение), НЕ
  // валидация: обе формы — обычные div, не <form>, и reportValidity()
  // движок не зовёт (см. collectFormErrors). maxLength — единственный из
  // трёх с реальным эффектом: он ограничивает сам ввод
  if (descriptor.regExp) {
    el.pattern = descriptor.regExp;
  }

  if (descriptor.required) {
    el.required = true;
  }

  if (descriptor.maxlength !== undefined) {
    el.maxLength = descriptor.maxlength;
  }

  const fallback = () => toDisplay(descriptor, descriptor.default ?? 0);

  const getValue = () => {
    if (!numeric) {
      return el.value;
    }

    const n = Number(el.value);
    const value = el.value !== '' && Number.isFinite(n) ? n : fallback();

    return toStored(descriptor, value);
  };

  return {
    el,
    getValue,
    setValue(value) {
      el.value = numeric ? toDisplay(descriptor, value) : (value ?? '');
    },
    onChange(cb) {
      el.addEventListener('change', () => cb({ name: descriptor.name, value: getValue() }));
    },
  };
}

// уникальный id для <label for> подписи (несколько форм с одноимённым полем
// могут сосуществовать в DOM — room-форма и auth-форма рендерятся в разные
// моменты, но обе всегда присутствуют в разметке)
let idSeq = 0;

function buildCheckbox(descriptor) {
  const el = document.createElement('input');

  el.type = 'checkbox';
  el.name = descriptor.name;
  el.id = `field-checkbox-${++idSeq}`;

  return {
    el,
    labelFor: el.id,
    getValue: () => el.checked,
    setValue(value) {
      el.checked = Boolean(value);
    },
    onChange(cb) {
      el.addEventListener('change', () => cb({ name: descriptor.name, value: el.checked }));
    },
  };
}

// группа нативных radio с общим name; подпись каждого варианта — соседний
// <label for>, как у checkbox
function buildRadio(descriptor, ctx) {
  const el = document.createElement('div');
  const groupName = `field-radio-${descriptor.name}-${++idSeq}`;
  const inputs = [];
  const options = resolveOptions(descriptor, ctx);
  // см. forcedValue: ровно один вариант — принудительное и неизменяемое
  // значение, строка скрыта и поправить рассинхрон нечем
  const forced = forcedValue(options);

  options.forEach(({ value, label }) => {
    const wrap = document.createElement('span');
    const input = document.createElement('input');

    input.type = 'radio';
    input.name = groupName;
    input.id = `${groupName}-${inputs.length}`;
    input.value = value;

    const optionLabel = document.createElement('label');

    optionLabel.htmlFor = input.id;
    optionLabel.textContent = label;

    wrap.append(input, optionLabel);
    el.appendChild(wrap);
    inputs.push(input);
  });

  if (forced !== undefined) {
    inputs[0].checked = true;
  }

  const getValue = () => inputs.find(input => input.checked)?.value;

  return {
    el,
    singleOption: forced !== undefined,
    noOptions: options.length === 0,
    getValue,
    setValue(value) {
      if (forced !== undefined) {
        return;
      }

      inputs.forEach(input => {
        input.checked = input.value === String(value);
      });
    },
    onChange(cb) {
      inputs.forEach(input => {
        input.addEventListener('change', () => cb({ name: descriptor.name, value: getValue() }));
      });
    },
  };
}

const builders = {
  select: buildSelect,
  text: buildText,
  checkbox: buildCheckbox,
  radio: buildRadio,
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

// засеивает default каждого дескриптора room-формы значением из roomDefaults
// (docs/en/plugin-api.md "Form schema": roomDefaults остаётся единственным
// источником значений по умолчанию); явный descriptor.default, если он есть
// в схеме, побеждает. Вынесено из populateRoomForm (main.js), чтобы этот же
// код был накрыт тестом, а не продублирован в нём
export function mergeRoomDefaults(descriptors, roomDefaults) {
  return descriptors.map(descriptor => ({
    default: roomDefaults[descriptor.name],
    ...descriptor,
  }));
}

// суффикс подписи поля: диапазон (min/max, если задан хотя бы один из них),
// иначе просто единица (unit:'s') — та же строка, что и раньше, "(s)".
// Полноценные HTML5 min/max тут не годятся: числовые поля — type=text
// (unit-конвертация мс<->с сама по себе не native-совместима), поэтому
// диапазон — только подсказка + вход в collectFormErrors ниже
function buildLabelSuffix(descriptor) {
  const { min, max, unit } = descriptor;

  if (min === undefined && max === undefined) {
    return unit === 's' ? ' (s)' : '';
  }

  const range = `${min ?? '…'}–${max ?? '…'}`;

  return unit === 's' ? ` (s, ${range})` : ` (${range})`;
}

// ошибка одного поля, либо null — required/regExp/maxlength (не-numeric
// text)/min/max (numeric text); сообщения не зависят от локали браузера, в
// отличие от бывшего reportValidity(). regExp сверяется с "сырой" строкой
// поля (field.el.value) — тем же значением, которое раньше матчил нативный
// pattern: у числового text-поля getValue() отдаёт число в единице
// хранения (мс для unit:'s'), а не отображаемую строку, так что regExp
// (сгенерированный build-game-manifest.js диапазон вроде "^([1-8])$" для
// maxPlayers — единственная граница у манифестов без min/max) проверяется
// отдельно от min/max, а не вместо них
function validateField(descriptor, field) {
  const value = field.getValue();
  const isText = descriptor.control === 'text';
  // у числового поля getValue() уже откатился к default (чтобы пустая
  // строка не уехала нулём), поэтому пустоту видно только по сырой строке
  const raw = isText ? field.el.value : undefined;
  const isEmpty = isText
    ? raw === ''
    : value === undefined || value === null || value === '';
  const numeric = isText && (descriptor.numeric || descriptor.unit !== undefined);

  // числовое поле всегда несёт число и «необязательным» быть не может:
  // пустой ввод getValue() подменяет default'ом (чтобы не уехал нолём), и
  // без этой ветки пустой Max players молча создавал бы комнату с дефолтом
  if ((descriptor.required || numeric) && isEmpty) {
    return 'required';
  }

  if (isEmpty) {
    return null;
  }

  if (numeric) {
    // без этой проверки нечисловой ввод молча подменялся бы default'ом
    // из getValue() и уезжал на хост как «валидный»
    if (!Number.isFinite(Number(raw))) {
      return 'must be a number';
    }

    const displayValue = descriptor.unit === 's' ? value / 1000 : value;

    // min/max раньше regExp: тот же диапазон regExp кодирует точным
    // паттерном (rangeToPattern), но «must be ≤ 32» говорит игроку то же,
    // что подсказка в подписи поля, а «invalid format» — ничего
    if (descriptor.min !== undefined && displayValue < descriptor.min) {
      return `must be ≥ ${descriptor.min}`;
    }

    if (descriptor.max !== undefined && displayValue > descriptor.max) {
      return `must be ≤ ${descriptor.max}`;
    }
  } else if (
    isText &&
    descriptor.maxlength !== undefined &&
    String(value).length > descriptor.maxlength
  ) {
    return `must be at most ${descriptor.maxlength} characters`;
  }

  // HTML `pattern` matches the WHOLE value (browsers wrap it in `^(?:…)$`
  // themselves) — a bare `new RegExp(descriptor.regExp)` has no such anchor
  // and would accept "99" against a "single digit" pattern off a partial
  // match, so it must be anchored the same way here. Проверяется последним:
  // ловит то, что диапазон пропускает (дробное, ведущий ноль)
  if (isText && descriptor.regExp && !new RegExp(`^(?:${descriptor.regExp})$`).test(raw)) {
    return 'invalid format';
  }

  return null;
}

// валидирует всю форму перед сабмитом (замена бывшего reportFormValidity/
// native reportValidity): порядок ошибок — порядок дескрипторов.
// Поля без строки в DOM (hidden, единственный вариант) пропускаются: их
// ошибку игрок не видит и исправить не может — она бы заперла форму
// навсегда (нативный reportValidity обходил только контролы в DOM и до них
// тоже не добирался). label — подпись из формы, чтобы имя в ошибке
// совпадало с тем, что игрок видит рядом с полем
export function collectFormErrors(descriptors, fields) {
  const errors = [];

  descriptors.forEach(descriptor => {
    const field = fields.get(descriptor.name);

    if (!field || field.rendered === false) {
      return;
    }

    const error = validateField(descriptor, field);

    if (error) {
      errors.push({
        name: descriptor.name,
        label: descriptor.label || descriptor.name,
        error,
      });
    }
  });

  return errors;
}

// рисует ошибки формы в разметку — общий рендер для #lobby-error и
// #auth-error (и для клиентской collectFormErrors, и для серверных ошибок
// PS_AUTH_DATA/validators, чей формат уже {name, error})
export function renderFormErrors(container, errors) {
  if (!container) {
    return;
  }

  container.textContent = '';

  (errors || []).forEach(({ name, label, error }) => {
    const line = document.createElement('div');
    // серверные ошибки (PS_AUTH_DATA/validators) приезжают без label —
    // для них, как и раньше, остаётся имя поля
    const title = String(label || name).toUpperCase();

    line.textContent = error ? `${title}: ${error}` : `${title} is not correctly!`;

    container.appendChild(line);
  });
}

// собирает форму (упорядоченный массив дескрипторов = порядок полей) в
// контейнер: одна .form-row на дескриптор (.form-label + контрол); onChange,
// если передан, подписывается на все поля разом. hidden:true, а также
// select/radio с единственным резолвнутым вариантом (singleOption) — поле
// строится и участвует в сабмите (fields Map), но строка не попадает в DOM
// и помечается field.rendered = false (collectFormErrors такие пропускает)
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

    if (onChange) {
      field.onChange(onChange);
    }

    fields.set(descriptor.name, field);

    // пустой список вариантов — дефект схемы или каталога, а не «нечего
    // выбирать»: значения у поля нет вовсе. Такое поле остаётся видимым
    // (и валидируемым) — молча спрятать его значит отправить на хост
    // пустую строку и получить отказ уже от игровых validators
    if (field.noOptions) {
      console.error(
        `formBuilder: field "${descriptor.name}" resolved to no options`,
      );
    }

    if (descriptor.hidden || field.singleOption) {
      field.rendered = false;
      return;
    }

    field.rendered = true;

    const row = document.createElement('div');

    row.className = 'form-row';

    // checkbox подписывается через <label for>, чтобы клик по тексту
    // переключал его (a11y) и строка выглядела как у остальных полей
    // (подпись слева, контрол справа)
    const label = document.createElement(field.labelFor ? 'label' : 'span');

    label.className = 'form-label';
    label.textContent = (descriptor.label || descriptor.name) + buildLabelSuffix(descriptor);

    if (field.labelFor) {
      label.htmlFor = field.labelFor;
    }

    row.append(label, field.el);
    container.appendChild(row);
  });

  return fields;
}
