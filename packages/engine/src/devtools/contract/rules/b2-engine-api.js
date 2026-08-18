import { ERROR, skip, verdict } from '../result.js';

// engineApi живёт в трёх местах (манифест, HostPlugin, ClientPlugin) и во
// всех трёх обязан быть импортом ENGINE_API_VERSION, а не числом: литерал
// не расходится со сборкой движка в момент написания и молча расходится
// через релиз, после чего плагин отклоняется гейтом совместимости.
export default {
  id: 'B2',
  name: 'engineApiVersion',
  level: ERROR,
  title: 'engineApi matches ENGINE_API_VERSION in all three places',

  check(ctx) {
    const declared = [
      ['host plugin', ctx.hostPlugin?.engineApi],
      ['client plugin', ctx.clientPlugin?.engineApi],
      ['manifest', ctx.manifest?.engineApi],
    ].filter(([, value]) => value !== undefined);

    if (!declared.length) {
      return skip('neither plugin half nor manifest is available');
    }

    const violations = [];

    for (const [where, value] of declared) {
      if (value !== ctx.engineApi) {
        violations.push(
          `${where} declares engineApi v${value}, this engine is v${ctx.engineApi}`,
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

    return verdict(violations);
  },
};
