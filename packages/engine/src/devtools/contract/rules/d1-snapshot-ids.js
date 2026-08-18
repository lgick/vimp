import { ERROR, skip, verdict } from '../result.js';

// Уникальность id блоков — единственное, что вообще валидируется в
// снапшот-схеме. Дубликат означает, что один блок кадра разбирается
// схемой другого: мусор вместо ошибки.
export default {
  id: 'D1',
  name: 'snapshotIds',
  level: ERROR,
  title: 'snapshot block ids are unique',

  check(ctx) {
    const snapshot = ctx.gameConfig?.snapshot;

    if (!snapshot) {
      return skip('no gameConfig.snapshot');
    }

    const byId = new Map();
    const violations = [];

    for (const [key, block] of Object.entries(snapshot)) {
      const previous = byId.get(block.id);

      if (previous !== undefined) {
        violations.push(
          `snapshot id ${block.id} is used by both "${previous}" and "${key}"`,
        );
      } else {
        byId.set(block.id, key);
      }
    }

    return verdict(violations);
  },
};
