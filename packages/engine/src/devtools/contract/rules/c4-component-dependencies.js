import { ERROR, WARN, skip, verdict } from '../result.js';
import { SERVICES } from '../../../config/clientServices.js';

// Движковый пул сервисов держит реестр (config/clientServices.js), но пул
// ими не исчерпывается: игра доливает туда свои через
// ClientPlugin.hooks.services(core) — например геометрию предсказанной
// динамики карты (docs/en/plugin-api.md «hooks.services»). Незнакомое имя не
// ошибка для движка: part получает undefined и рисует пустоту — карта без
// assetsBase выглядит как чистый холст без единой строки в консоли, ради
// этого правило и существует. Правило остаётся ERROR: оно работает на этапе
// разработки игры, а не в рантайме.
//
// Что именно возвращает `hooks.services(core)`, статически не видно — хук
// требует живого ядра. Поэтому у плагина есть необязательное поле
// `serviceNames`: объявленный список имён снимает догадку, и правило снова
// умеет краснеть (без него оно опускается до WARN и пропускает опечатку).
export { SERVICES };

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

    const declared = ctx.clientPlugin?.serviceNames;
    const listed = Array.isArray(declared) ? declared : [];

    if (declared !== undefined && !Array.isArray(declared)) {
      return verdict([
        `ClientPlugin.serviceNames is ${typeof declared}, expected an array ` +
          'of service names returned by hooks.services(core)',
      ]);
    }

    // раскладка «сервис → парты, которым он нужен» (client.js игры)
    const unknown = Object.keys(deps).filter(
      service => !SERVICES.includes(service) && !listed.includes(service),
    );

    if (unknown.length === 0) {
      return verdict([]);
    }

    const pool = [...SERVICES, ...listed].join(', ');

    // список игровых сервисов объявлен — гадать больше не о чем: имя вне
    // объединённого пула не даст парту ничего, кроме undefined
    if (listed.length) {
      return verdict(
        unknown.map(
          service =>
            `componentDependencies declares service "${service}" — neither ` +
            `the engine nor ClientPlugin.serviceNames provides it (${pool}), ` +
            'so it is silently undefined in the part',
        ),
      );
    }
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
