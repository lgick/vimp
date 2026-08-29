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
// `requires` при этом живёт в трёх местах пакета (манифест + обе половины
// плагина), и их расхождение — такой же рассинхрон сборки, как расхождение
// `engineApi`.
export default {
  id: 'B2',
  name: 'engineApiVersion',
  level: ERROR,
  title:
    'engineApi is consistent, requires names existing capabilities and ' +
    'agrees between the manifest and both plugin halves',

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
      violations.push(...halfViolations(ctx, []));

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

    violations.push(...halfViolations(ctx, requires));

    return finish(violations, retired);
  },
};

// `requires` пишут три места одного пакета: скрипт сборки манифеста и обе
// половины плагина (последние — ради standalone SDK, у которого манифеста
// нет). Разъехавшись, они дают игру, которую лобби честно отвергает, а
// solo-режим принимает и тихо недоигрывает. Половина без поля из сверки
// исключена: пакет, собранный до появления поля, обязан оставаться
// валидным (И1/И2)
function halfViolations(ctx, manifestRequires) {
  const wanted = new Set(manifestRequires);
  const violations = [];
  const halves = [
    ['HostPlugin', ctx.hostPlugin?.requires],
    ['ClientPlugin', ctx.clientPlugin?.requires],
  ].filter(([, value]) => value !== undefined && value !== null);

  for (const [where, value] of halves) {
    if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) {
      violations.push(
        `${where}.requires must be an array of capability names, got ` +
          `${JSON.stringify(value)} — the standalone SDK reads it`,
      );
      continue;
    }

    const extra = value.filter(name => !wanted.has(name));

    if (extra.length) {
      violations.push(
        `${where}.requires names ${extra.join(', ')}, which ` +
          'manifest.requires does not list — the lobby master reads the ' +
          'manifest, so the two must agree',
      );
    }
  }

  // «поле объявлено» — это наличие ключа, а не непустой список: половина с
  // `requires: []` утверждает, что игре ничего не нужно, и расходится с
  // манифестом, который просит возможность. Половина БЕЗ поля не утверждает
  // ничего — пакет, собранный до его появления
  if (halves.length === 0) {
    return violations;
  }

  const declared = halves
    .map(([, value]) => value)
    .filter(Array.isArray)
    .flat();

  const missing = [...wanted].filter(name => !declared.includes(name));

  if (missing.length) {
    violations.push(
      `manifest.requires names ${missing.join(', ')}, which neither plugin ` +
        'half declares — the standalone SDK has no manifest and would run ' +
        'the game on an engine that cannot support it',
    );
  }

  return violations;
}

// то же, что делают B5 и C10: выведенное имя — не отказ, а предупреждение.
// Отвергать за него значило бы отвергать игру за возраст (И1)
function finish(violations, retired) {
  if (violations.length === 0 && retired.length > 0) {
    return verdict(retired, 'retired capability names still resolve', WARN);
  }

  return verdict(violations);
}
