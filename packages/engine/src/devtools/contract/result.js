// Словарь результатов статической проверки контракта. Он намеренно тот же,
// что у headless-раннера (devtools/invariants.js): pass / fail / skip —
// автор плагина читает оба отчёта подряд и не должен держать в голове две
// системы вердиктов. Отличие одно: у правила есть уровень (error / warn),
// потому что часть контракта — соглашения (пять колонок статистики), а не
// жёсткие отказы.

export const PASS = 'pass';
export const FAIL = 'fail';
export const SKIP = 'skip';

export const ERROR = 'error';
export const WARN = 'warn';

/**
 * «Проверять нечего»: входа нет (игра не собрана, нет package.json).
 * skip никогда не маскирует нарушение — он означает отсутствие данных.
 * @param {string} note - Чего именно не хватило.
 * @returns {Object} { status, violations, note }.
 */
export function skip(note) {
  return { status: SKIP, violations: [], note };
}

/**
 * Вердикт по списку нарушений: пустой список — pass.
 * @param {Array<string>} violations
 * @param {string} [note]
 * @returns {Object} { status, violations, note }.
 */
export function verdict(violations, note) {
  return {
    status: violations.length ? FAIL : PASS,
    violations,
    note,
  };
}

/**
 * Сводка по результатам правил.
 * @param {Array<Object>} results
 * @returns {Object} { passed, failed, skipped, errors, warnings, violations }.
 */
export function summarize(results) {
  const failed = results.filter(r => r.status === FAIL);

  return {
    passed: results.filter(r => r.status === PASS).length,
    failed: failed.length,
    skipped: results.filter(r => r.status === SKIP).length,
    errors: failed.filter(r => r.level === ERROR).length,
    warnings: failed.filter(r => r.level === WARN).length,
    violations: results.reduce((sum, r) => sum + r.violations.length, 0),
  };
}
