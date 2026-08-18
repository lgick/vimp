import { ERROR, skip, verdict } from '../result.js';

// Класс парта регистрируется во Factory только через entitiesOnCanvas.
// Перечисления в parts и gameSets недостаточно: движок отвечает
// «Constructor for X not found.» на первом кадре, где ключ ожил.
export default {
  id: 'C2',
  name: 'partsRegistered',
  level: ERROR,
  title: 'every gameSets class is in entitiesOnCanvas and exported in parts',

  check(ctx) {
    const parts = ctx.clientConfig?.parts;

    if (!parts?.gameSets) {
      return skip('no client parts.gameSets');
    }

    const onCanvas = parts.entitiesOnCanvas ?? {};
    const exported = ctx.clientPlugin?.parts ?? null;
    const violations = [];

    for (const [key, names] of Object.entries(parts.gameSets)) {
      for (const name of names ?? []) {
        if (onCanvas[name] === undefined) {
          violations.push(
            `gameSets["${key}"] uses part "${name}", missing from ` +
              'entitiesOnCanvas — it is never registered',
          );
        }

        if (exported && exported[name] === undefined) {
          violations.push(
            `gameSets["${key}"] uses part "${name}", not exported in ` +
              'ClientPlugin.parts',
          );
        }
      }
    }

    return verdict(violations);
  },
};
