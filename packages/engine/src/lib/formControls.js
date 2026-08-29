import { createRegistry } from './registry.js';

// Реестр значений `control` дескриптора формы (этап 3 плана
// plugin-forward-compat). Активных контролов четыре — все нативные элементы
// формы, их строит client/lib/formBuilder.js. Остальные четыре выведены из
// эксплуатации в v3, но продолжают работать вечно (И1): игра, собранная под
// v2, написала их в манифесте, и её dist больше никто не тронет.
//
// `patch` — то, чем алиас доливает дескриптор: без `numeric: true` бывшее
// числовое поле стало бы свободным текстом, и валидация пропустила бы в
// комнату строку вместо числа.
export const formControls = createRegistry('formControls', [
  { value: 'select', since: 1 },
  { value: 'text', since: 1 },
  { value: 'checkbox', since: 1 },
  { value: 'radio', since: 1 },
  {
    value: 'range',
    since: 1,
    alias: 'text',
    retiredIn: 3,
    patch: { numeric: true },
    note: 'нативного range нет; рисуется как numeric text',
  },
  {
    value: 'number',
    since: 1,
    alias: 'text',
    retiredIn: 3,
    patch: { numeric: true },
    note: 'нативного number нет; рисуется как numeric text',
  },
  {
    value: 'toggle',
    since: 1,
    alias: 'checkbox',
    retiredIn: 3,
    note: 'то же поведение, нативный checkbox',
  },
  {
    value: 'segmented',
    since: 1,
    alias: 'radio',
    retiredIn: 3,
    note: 'то же поведение, группа нативных radio',
  },
]);

/**
 * Разрешает `descriptor.control` в контрол, который умеет строить билдер.
 * @param {string} control - Значение `control` из дескриптора.
 * @returns {{control: string, patch: Object}|undefined} Активный контрол и
 *   накладка на дескриптор, либо undefined для неизвестного имени.
 */
export function resolveControl(control) {
  const chain = formControls.chain(control);

  if (chain.length === 0) {
    return undefined;
  }

  // накладки копятся по всей цепочке: алиас на алиас обязан донести обе
  return {
    control: chain.at(-1).value,
    patch: Object.assign({}, ...chain.map(entry => entry.patch ?? {})),
  };
}

/**
 * Приводит дескриптор поля к активному контролу (разрешает алиас).
 * @param {Object} descriptor - Дескриптор поля формы.
 * @returns {Object} Тот же объект, если контрол активен или неизвестен
 *   (последнее скажет билдер), иначе копия с активным `control` и накладкой
 *   алиаса под явными полями игры.
 */
export function resolveDescriptor(descriptor) {
  const resolved = resolveControl(descriptor?.control);

  if (!resolved || resolved.control === descriptor.control) {
    return descriptor;
  }

  // накладка идёт ПОД дескриптором: она уточняет контрол, а не переписывает
  // схему игры (явный numeric:false остаётся за игрой)
  return { ...resolved.patch, ...descriptor, control: resolved.control };
}

// имена, которые вправе написать новая игра (контракт-чекер, документация)
export const ACTIVE_FORM_CONTROLS = formControls.values();
