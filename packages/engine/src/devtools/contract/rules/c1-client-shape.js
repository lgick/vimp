import { ERROR, skip, verdict } from '../result.js';

// Поля ClientPlugin и все три хука. Хук с пустым телом — норма,
// отсутствующий — краш на первом же вызове (движок зовёт их безусловно).
const REQUIRED = [
  ['id', 'string'],
  ['engineApi', 'number'],
  ['createClientCore', 'function'],
  ['parts', 'object'],
  ['bakers', 'object'],
  ['styles', 'string'],
];

const HOOKS = ['onAuth', 'onPanel', 'onLocalAction'];

export default {
  id: 'C1',
  name: 'clientPluginShape',
  level: ERROR,
  title: 'ClientPlugin exports parts, bakers, styles and all three hooks',

  check(ctx) {
    if (!ctx.clientPlugin) {
      return skip('client plugin not loaded');
    }

    const violations = [];

    for (const [field, type] of REQUIRED) {
      const value = ctx.clientPlugin[field];

      if (value === undefined || value === null) {
        violations.push(`ClientPlugin.${field} is missing`);
      } else if (typeof value !== type) {
        violations.push(
          `ClientPlugin.${field} is ${typeof value}, expected ${type}`,
        );
      }
    }

    for (const hook of HOOKS) {
      if (typeof ctx.clientPlugin.hooks?.[hook] !== 'function') {
        violations.push(
          `ClientPlugin.hooks.${hook} is missing — an empty body is fine, ` +
            'a missing hook crashes',
        );
      }
    }

    return verdict(violations);
  },
};
