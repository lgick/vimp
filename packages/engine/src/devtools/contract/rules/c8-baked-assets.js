import { ERROR, skip, verdict } from '../result.js';

// Неизвестное имя запекаемого ассета пропускается молча: part получает
// пустой assets и рисует ничего.
export default {
  id: 'C8',
  name: 'bakedAssets',
  level: ERROR,
  title: 'bakedAssets names exist in ClientPlugin.bakers',

  check(ctx) {
    const baked = ctx.clientConfig?.parts?.bakedAssets;
    const bakers = ctx.clientPlugin?.bakers;

    if (!baked || !bakers) {
      return skip('no bakedAssets or client plugin not loaded');
    }

    const violations = [];

    for (const [canvas, entries] of Object.entries(baked)) {
      for (const entry of entries ?? []) {
        if (bakers[entry.name] === undefined) {
          violations.push(
            `bakedAssets["${canvas}"]: baker "${entry.name}" is not in ` +
              'ClientPlugin.bakers — the entry is skipped silently',
          );
        }
      }
    }

    return verdict(violations);
  },
};
