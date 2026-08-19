import { ERROR, skip, verdict } from '../result.js';

// Своих команд у движка нет: реестр CommandProcessor наполняет только игра,
// поэтому зарезервированных имён не существует. Проверяем форму: ведущий слэш
// и отсутствие дублей — вторая регистрация одного имени молча затирает первую.
export default {
  id: 'B7',
  name: 'chatCommands',
  level: ERROR,
  title: 'chat commands are well-formed and unique',

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

      if (typeof command.handler !== 'function') {
        violations.push(`chat command "${name}" has no handler function`);
      }

      if (seen.has(name)) {
        violations.push(`chat command "${name}" is registered twice`);
      }

      seen.add(name);
    }

    return verdict(violations);
  },
};
