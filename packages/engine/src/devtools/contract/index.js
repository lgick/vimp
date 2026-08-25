import { loadContext } from './loadContext.js';
import { rules } from './rules/index.js';
import { ERROR, FAIL, WARN, summarize } from './result.js';

// Статическая проверка контракта «движок ↔ игра»: то же намерение, что у
// headless-раннера (молчаливое нарушение обязано становиться строкой),
// только без прогона матча — по конфигам, манифесту и живым объектам
// плагина. Живёт в движке, а не копируется в каждую игру: правила
// эволюционируют вместе с ENGINE_API_VERSION и применимы к любой игре.

export { loadContext } from './loadContext.js';
export { rules } from './rules/index.js';
export * from './result.js';

/**
 * @param {string} gameDir - Каталог пакета игры.
 * @returns {Promise<Object>} { game, results, summary, notes }.
 */
export async function checkContract(gameDir) {
  const ctx = await loadContext(gameDir);
  const results = runRules(ctx);

  return {
    game: {
      id: ctx.hostPlugin?.id ?? ctx.manifest?.id ?? null,
      dir: ctx.dir,
      hostSource: ctx.hostSource ?? null,
      clientSource: ctx.clientSource ?? null,
      built: Boolean(ctx.manifest),
      engineApi: ctx.engineApi,
    },
    results,
    summary: summarize(results),
    notes: ctx.notes,
  };
}

// Вердикт может нести собственный уровень (см. verdict) — но только один из
// двух известных: неизвестное значение молча перестало бы блокировать прогон
// (hasBlockingFailure сравнивает с ERROR), то есть опечатка в правиле
// отключала бы его без единой строки. Поэтому она громкая, а уровень берётся
// объявленный правилом.
function resolveLevel(level, rule) {
  if (level === undefined) {
    return rule.level;
  }

  if (level !== ERROR && level !== WARN) {
    console.error(
      `contract: rule ${rule.id} returned unknown level "${level}" — ` +
        `falling back to "${rule.level}"`,
    );

    return rule.level;
  }

  return level;
}

/**
 * Прогон правил по готовому контексту (тесты собирают его вручную).
 * @param {Object} ctx
 * @param {Array<Object>} [ruleList] - Набор правил; по умолчанию все.
 * @returns {Array<Object>} Результаты правил.
 */
export function runRules(ctx, ruleList = rules) {
  return ruleList.map(rule => {
    const { status, violations, note, level } = rule.check(ctx);

    return {
      id: rule.id,
      name: rule.name,
      title: rule.title,
      level: resolveLevel(level, rule),
      status,
      violations,
      note,
    };
  });
}

/**
 * @param {Object} report - Результат checkContract.
 * @param {boolean} [strict] - Считать предупреждения ошибками.
 * @returns {boolean} Есть ли отказ, который обязан валить прогон.
 */
export function hasBlockingFailure(report, strict = false) {
  return report.results.some(
    result =>
      result.status === FAIL && (strict || result.level === ERROR),
  );
}
