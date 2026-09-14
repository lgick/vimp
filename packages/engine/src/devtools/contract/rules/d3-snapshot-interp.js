import { ERROR, skip, verdict } from '../result.js';

// Интерполируются только f32 и только в горячих блоках. interp на u8 или
// в event-блоке не ошибка сборки — он просто не исполняется, и поле
// дёргается вместо плавного движения.
//
// Там же — роль `state` (байт состояния тела карты): u8 сразу за головой
// строки динамики (позиция 5 у слоёной строки, 3 — у плоской) и до
// опционального хвоста. Ядро отвергает иное при загрузке карты, то есть
// уже в запущенном матче (зеркало `BlockSchema::validate_roles`).
export default {
  id: 'D3',
  name: 'snapshotInterp',
  level: ERROR,
  title: "interp only on f32 fields of class 'hot' blocks; role 'state' is a u8 right after the row head",

  check(ctx) {
    const snapshot = ctx.gameConfig?.snapshot;

    if (!snapshot) {
      return skip('no gameConfig.snapshot');
    }

    const violations = [];

    for (const [key, block] of Object.entries(snapshot)) {
      checkStateRole(key, block, violations);

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

// позиции зафиксированы движком (`GameMap::dynamic_map_data_with_state`)
const STATE_INDEX_FLAT = 3;
const STATE_INDEX_LAYERED = 5;

function checkStateRole(key, block, violations) {
  const fields = block.fields ?? [];
  const layered = fields[3]?.role === 'z' && fields[4]?.role === 'level';
  const expected = layered ? STATE_INDEX_LAYERED : STATE_INDEX_FLAT;

  fields.forEach((field, index) => {
    if (field.role !== 'state') {
      return;
    }

    const at = `snapshot "${key}".${field.name}`;

    if (index !== expected) {
      violations.push(
        `${at}: role 'state' at index ${index}, the engine writes it at ` +
          `${expected} (right after the ${layered ? 'layered' : 'flat'} row head)`,
      );
    }

    if (field.ty !== 'u8') {
      violations.push(`${at}: role 'state' must be ty "u8", got "${field.ty}"`);
    }

    if (block.optionalFrom !== undefined && block.optionalFrom <= index) {
      violations.push(
        `${at}: role 'state' at index ${index} lies inside the optional tail ` +
          `(optionalFrom ${block.optionalFrom}) — a resting body would lose it`,
      );
    }
  });
}
