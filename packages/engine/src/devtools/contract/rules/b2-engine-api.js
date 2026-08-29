import { ERROR, WARN, skip, verdict } from '../result.js';
import {
  ENGINE_CAPABILITIES,
  CAPABILITIES,
} from '../../../lib/capabilities.js';

// `engineApi` живёт в трёх местах (манифест, HostPlugin, ClientPlugin).
// Расхождение между ними — рассинхрон сборки внутри пакета, и это ошибка.
// Расхождение с установленным движком ошибкой БОЛЬШЕ НЕ является (этап 5
// плана plugin-forward-compat): `ENGINE_API_VERSION` заморожен на 4 и не
// гейт, а игра, собранная год назад против движка не последней версии, —
// нормальное состояние, ради которого весь план и делался.
//
// Импортом, а не литералом, значение остаётся по-прежнему: литерал не
// расходится со сборкой движка в момент написания и молча расходится через
// релиз, после чего манифест игры врёт о своём поколении.
//
// Возможности из `manifest.requires` проверяются по реестру установленного
// движка: имени, которого нет, движок дать не может — игра просит будущее.
export default {
  id: 'B2',
  name: 'engineApiVersion',
  level: ERROR,
  title: 'engineApi is consistent and requires name existing capabilities',

  check(ctx) {
    // манифест первый: он — то, что о поколении пакета читает движок,
    // и с ним сверяются половины плагина
    const declared = [
      ['manifest', ctx.manifest?.engineApi],
      ['host plugin', ctx.hostPlugin?.engineApi],
      ['client plugin', ctx.clientPlugin?.engineApi],
    ].filter(([, value]) => value !== undefined);

    if (!declared.length) {
      return skip('neither plugin half nor manifest is available');
    }

    const violations = [];
    const retired = [];
    const [source, reference] = declared[0];

    for (const [where, value] of declared) {
      if (value !== reference) {
        violations.push(
          `${where} declares engineApi v${value}, but ${source} declares ` +
            `v${reference} — rebuild the package`,
        );
      }
    }

    for (const [where, text] of [
      ['src/host/index.js', ctx.hostText],
      ['src/client/index.js', ctx.clientText],
    ]) {
      if (text && !text.includes('ENGINE_API_VERSION')) {
        violations.push(
          `${where} hardcodes engineApi — import ENGINE_API_VERSION instead`,
        );
      }
    }

    // форма `requires` — то же недоверие, что в checkPluginCompatibility:
    // строка проитерировалась бы здесь посимвольно, объект уронил бы чекер
    // «not iterable»
    const requires = ctx.manifest?.requires;

    if (requires === undefined || requires === null) {
      return finish(violations, retired);
    }

    if (
      !Array.isArray(requires) ||
      requires.some(name => typeof name !== 'string')
    ) {
      violations.push(
        'manifest.requires must be an array of capability names, got ' +
          `${JSON.stringify(requires)} — the engine reads it before it ` +
          'loads the plugin',
      );

      return finish(violations, retired);
    }

    for (const name of requires) {
      // has, а не CAPABILITIES.includes: реестр возможностей append-only,
      // и выведенное алиасом имя движок принимает вечно (ENGINE_CAPABILITIES.
      // has в checkPluginCompatibility). Сверка с одними активными именами
      // отвергала бы игру за то, что движок переименовал возможность — тот
      // самый отказ по возрасту, который план и снимал
      if (!ENGINE_CAPABILITIES.has(name)) {
        violations.push(
          `manifest.requires names '${name}', which this engine does not ` +
            `provide — known capabilities: ${CAPABILITIES.join(', ')}`,
        );
      } else if (ENGINE_CAPABILITIES.isRetired(name)) {
        retired.push(
          `manifest.requires names '${name}', which was retired — it still ` +
            `works (the engine resolves it to ` +
            `'${ENGINE_CAPABILITIES.resolve(name)}' forever), but a new game ` +
            `should declare '${ENGINE_CAPABILITIES.resolve(name)}' itself`,
        );
      }
    }

    return finish(violations, retired);
  },
};

// то же, что делают B5 и C10: выведенное имя — не отказ, а предупреждение.
// Отвергать за него значило бы отвергать игру за возраст (И1)
function finish(violations, retired) {
  if (violations.length === 0 && retired.length > 0) {
    return verdict(retired, 'retired capability names still resolve', WARN);
  }

  return verdict(violations);
}
