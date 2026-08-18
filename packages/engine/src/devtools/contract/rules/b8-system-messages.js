import { ERROR, skip, verdict } from '../result.js';

// Регистрация игровых кодов — слепой Object.assign поверх движкового
// реестра: код в зарезервированном диапазоне затирает движковое сообщение
// без предупреждения, и вместо «Vote passed» игрок видит игровой текст.
// Диапазоны — длины движковых групп (client/config/chat messages).
const RESERVED = { s: 6, v: 5, m: 1, c: 1, n: 1 };

export default {
  id: 'B8',
  name: 'systemMessages',
  level: ERROR,
  title: 'system message codes stay out of the engine ranges',

  check(ctx) {
    const messages = ctx.hostPlugin?.systemMessages;

    if (!messages) {
      return skip('no HostPlugin.systemMessages');
    }

    const violations = [];

    for (const [name, code] of Object.entries(messages)) {
      const parsed = /^([a-z]):(\d+)$/.exec(String(code));

      if (!parsed) {
        violations.push(
          `systemMessages.${name} is "${code}" — expected "<group>:<index>"`,
        );
        continue;
      }

      const group = parsed[1];
      const index = Number(parsed[2]);
      const last = RESERVED[group];

      if (last !== undefined && index <= last) {
        violations.push(
          `systemMessages.${name} ("${code}") overwrites the engine message ` +
            `${group}:${index} (group "${group}" is reserved up to index ${last})`,
        );
      }
    }

    return verdict(violations);
  },
};
