import { ERROR, skip, verdict } from '../result.js';

// Поля HostPlugin, которые движок разыменовывает без проверок: отсутствие
// любого даёт TypeError глубоко в onInit, за десяток кадров от причины.
// chatCommands проверяется отдельно на «массив»: движок его итерирует.
const REQUIRED = [
  ['id', 'string'],
  ['engineApi', 'number'],
  ['createCore', 'function'],
  ['gameConfig', 'object'],
  ['authSchema', 'object'],
  ['createModules', 'function'],
  ['buildClientGameConfig', 'function'],
];

export default {
  id: 'B1',
  name: 'hostPluginShape',
  level: ERROR,
  title: 'HostPlugin exports every field the engine dereferences',

  check(ctx) {
    if (!ctx.hostPlugin) {
      return skip('host plugin not loaded');
    }

    const violations = [];

    for (const [field, type] of REQUIRED) {
      const value = ctx.hostPlugin[field];

      if (value === undefined || value === null) {
        violations.push(`HostPlugin.${field} is missing`);
      } else if (typeof value !== type) {
        violations.push(
          `HostPlugin.${field} is ${typeof value}, expected ${type}`,
        );
      }
    }

    if (!Array.isArray(ctx.hostPlugin.chatCommands)) {
      violations.push(
        'HostPlugin.chatCommands must be an array (use [] for none) — the ' +
          'engine iterates it unguarded',
      );
    }

    return verdict(violations);
  },
};
