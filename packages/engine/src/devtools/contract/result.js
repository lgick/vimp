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
 * `level` перекрывает уровень правила на этом прогоне: у правила он один на
 * все случаи, а бывает, что нарушение доказуемо только частично (C4 не может
 * перечислить игровые сервисы, не запустив игровой код) — такое обязано
 * попасть в отчёт, но не обязано валить прогон.
 * @param {Array<string>} violations
 * @param {string} [note]
 * @param {string} [level] - ERROR или WARN; по умолчанию — уровень правила.
 * @returns {Object} { status, violations, note, level }.
 */
export function verdict(violations, note, level) {
  return {
    status: violations.length ? FAIL : PASS,
    violations,
    note,
    level,
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
