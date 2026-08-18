import { ERROR, skip, verdict } from '../result.js';

// Пул сервисов клиента ровно из трёх имён (client/main.js). Незнакомое имя
// не ошибка для движка: part получает undefined и рисует пустоту — карта
// без assetsBase выглядит как чистый холст без единой строки в консоли.
const SERVICES = ['renderer', 'soundManager', 'assetsBase'];

export default {
  id: 'C4',
  name: 'componentDependencies',
  level: ERROR,
  title: 'componentDependencies name only existing services',

  check(ctx) {
    const deps = ctx.clientConfig?.parts?.componentDependencies;

    if (!deps) {
      return skip('no client parts.componentDependencies');
    }

    // раскладка «сервис → парты, которым он нужен» (client.js игры)
    const violations = Object.keys(deps)
      .filter(service => !SERVICES.includes(service))
      .map(
        service =>
          `componentDependencies declares service "${service}" — the engine ` +
          `provides only ${SERVICES.join(', ')} (an unknown one is silently ` +
          'undefined in the part)',
      );

    return verdict(violations);
  },
};
