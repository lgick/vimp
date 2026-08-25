import { ERROR, WARN, skip, verdict } from '../result.js';

// Движковых сервисов ровно четыре (client/main.js), но пул ими не
// исчерпывается: игра доливает туда свои через ClientPlugin.hooks.services(core)
// — например геометрию предсказанной динамики карты
// (docs/en/plugin-api.md «hooks.services»). Незнакомое имя не ошибка для
// движка: part получает undefined и рисует пустоту — карта без assetsBase
// выглядит как чистый холст без единой строки в консоли, ради этого правило
// и существует.
const SERVICES = ['renderer', 'soundManager', 'assetsBase', 'localPlayer'];

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
    const unknown = Object.keys(deps).filter(
      service => !SERVICES.includes(service),
    );

    if (unknown.length === 0) {
      return verdict([]);
    }

    const pool = SERVICES.join(', ');
    // hooks.services(core) требует живой инстанс ядра, а игровой код чекер не
    // запускает — статически перечислить игровые сервисы нечем. Поэтому при
    // объявленном хуке имя вне движкового пула остаётся строкой отчёта, но
    // прогон не валит: иначе правило краснеет на штатном механизме движка
    if (typeof ctx.clientPlugin?.hooks?.services === 'function') {
      return verdict(
        unknown.map(
          service =>
            `componentDependencies declares service "${service}" — not one of ` +
            `the engine's (${pool}), so ClientPlugin.hooks.services() has to ` +
            'return it; verifying that needs a live core, which this check ' +
            'has no way to build (a service nothing provides is silently ' +
            'undefined in the part)',
        ),
        'the plugin declares hooks.services(), so the pool is not statically known',
        WARN,
      );
    }

    return verdict(
      unknown.map(
        service =>
          `componentDependencies declares service "${service}" — the engine ` +
          `provides only ${pool}, and this plugin declares no ` +
          'hooks.services() to add its own (an unknown one is silently ' +
          'undefined in the part)',
      ),
    );
  },
};
