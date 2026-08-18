import { ERROR, skip, verdict } from '../result.js';

// Движковые команды разбираются switch'ем раньше реестра игровых
// (CommandProcessor.parseCommand): одноимённая команда плагина
// регистрируется, но не вызывается никогда.
const RESERVED = ['/name', '/nr', '/timeleft', '/mapname', '/rank'];

export default {
  id: 'B7',
  name: 'chatCommands',
  level: ERROR,
  title: 'chat commands do not shadow the engine commands',

  check(ctx) {
    const commands = ctx.hostPlugin?.chatCommands;

    if (!Array.isArray(commands)) {
      return skip('no chatCommands array');
    }

    const violations = [];
    const seen = new Set();

    for (const command of commands) {
      const { name } = command ?? {};

      if (typeof name !== 'string' || !name.startsWith('/')) {
        violations.push(
          `chat command ${JSON.stringify(name)} has no leading-slash name`,
        );
        continue;
      }

      if (RESERVED.includes(name)) {
        violations.push(
          `chat command "${name}" is an engine command — it will never fire`,
        );
      }

      if (seen.has(name)) {
        violations.push(`chat command "${name}" is registered twice`);
      }

      seen.add(name);
    }

    return verdict(violations);
  },
};
