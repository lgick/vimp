import { ERROR, skip, verdict } from '../result.js';
import { CAPABILITIES } from '../../../lib/capabilities.js';

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

    for (const name of ctx.manifest?.requires ?? []) {
      if (!CAPABILITIES.includes(name)) {
        violations.push(
          `manifest.requires names '${name}', which this engine does not ` +
            `provide — known capabilities: ${CAPABILITIES.join(', ')}`,
        );
      }
    }

    return verdict(violations);
  },
};
