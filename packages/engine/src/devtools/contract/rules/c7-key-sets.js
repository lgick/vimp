import { ERROR, skip, verdict } from '../result.js';

// keySetList: [0] — набор наблюдателя, [1] — игрока. Без nextPlayer/
// prevPlayer наблюдатель заперт на одной камере; занятый движковый код
// (чат, голосование, статистика, escape, enter) до игры не доходит;
// расхождение имён с playerKeys даёт клавишу, которая ничего не шлёт.
const ENGINE_CODES = { 9: 'stat', 13: 'enter', 27: 'escape', 67: 'chat', 77: 'vote' };
const SPECTATOR_ACTIONS = ['nextPlayer', 'prevPlayer'];

export default {
  id: 'C7',
  name: 'keySets',
  level: ERROR,
  title: 'keySetList: spectator actions, engine codes, playerKeys parity',

  check(ctx) {
    const keySetList = ctx.clientConfig?.modules?.controls?.keySetList;

    if (!Array.isArray(keySetList)) {
      return skip('no client controls.keySetList');
    }

    const violations = [];
    const spectator = Object.values(keySetList[0] ?? {});

    for (const action of SPECTATOR_ACTIONS) {
      if (!spectator.includes(action)) {
        violations.push(
          `keySetList[0] (spectator) has no "${action}" — the spectator ` +
            'cannot switch camera',
        );
      }
    }

    keySetList.forEach((set, index) => {
      for (const code of Object.keys(set ?? {})) {
        if (ENGINE_CODES[code]) {
          violations.push(
            `keySetList[${index}] binds code ${code} — the engine owns it ` +
              `(${ENGINE_CODES[code]})`,
          );
        }
      }
    });

    const playerKeys = ctx.gameConfig?.playerKeys;

    if (playerKeys) {
      const bound = new Set(Object.values(keySetList[1] ?? {}));
      const declared = new Set(Object.keys(playerKeys));

      for (const action of declared) {
        if (!bound.has(action)) {
          violations.push(
            `playerKeys."${action}" has no key in keySetList[1]`,
          );
        }
      }

      for (const action of bound) {
        if (!declared.has(action)) {
          violations.push(
            `keySetList[1] binds "${action}", missing from gameConfig.playerKeys`,
          );
        }
      }
    }

    return verdict(violations);
  },
};
