import { ERROR, skip, verdict } from '../result.js';

// Интерполируются только f32 и только в горячих блоках. interp на u8 или
// в event-блоке не ошибка сборки — он просто не исполняется, и поле
// дёргается вместо плавного движения.
export default {
  id: 'D3',
  name: 'snapshotInterp',
  level: ERROR,
  title: "interp only on f32 fields of class 'hot' blocks",

  check(ctx) {
    const snapshot = ctx.gameConfig?.snapshot;

    if (!snapshot) {
      return skip('no gameConfig.snapshot');
    }

    const violations = [];

    for (const [key, block] of Object.entries(snapshot)) {
      for (const field of block.fields ?? []) {
        if (field.interp === undefined) {
          continue;
        }

        if (block.class !== 'hot') {
          violations.push(
            `snapshot "${key}".${field.name}: interp on a class ` +
              `"${block.class}" block is never applied`,
          );
        }

        if (field.ty !== 'f32') {
          violations.push(
            `snapshot "${key}".${field.name}: interp on ty "${field.ty}" — ` +
              'only f32 interpolates',
          );
        }
      }
    }

    return verdict(violations);
  },
};
