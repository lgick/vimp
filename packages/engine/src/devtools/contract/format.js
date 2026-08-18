import { ERROR, FAIL, PASS, SKIP } from './result.js';

// Человекочитаемый отчёт — та же разметка, что у секции инвариантов
// headless-раннера (devtools/report.js): один значок, id, имя правила,
// заголовок, ниже — нарушения.
const MARKS = { [PASS]: '✅', [FAIL]: '❌', [SKIP]: '⏭️' };

/**
 * @param {Object} report - Результат checkContract.
 * @param {Object} [options]
 * @param {boolean} [options.quiet] - Только нарушения и сводка.
 * @returns {string}
 */
export function formatContract(report, { quiet = false } = {}) {
  const { summary } = report;
  const lines = [`# Contract report — ${report.game.id ?? '(unknown game)'}`, ''];

  lines.push(`- game: \`${report.game.dir}\``);
  lines.push(`- engine API: v${report.game.engineApi}`);
  lines.push(
    `- host: \`${report.game.hostSource ?? '(not loaded)'}\`, ` +
      `client: \`${report.game.clientSource ?? '(not loaded)'}\``,
  );
  lines.push(`- built: ${report.game.built ? 'yes' : 'no (dist/ is missing)'}`);
  lines.push('');

  for (const note of report.notes) {
    lines.push(`> ${note}`);
  }

  if (report.notes.length) {
    lines.push('');
  }

  lines.push(
    `${summary.passed} passed, ${summary.failed} failed ` +
      `(${summary.errors} error, ${summary.warnings} warning), ` +
      `${summary.skipped} skipped`,
  );
  lines.push('');

  for (const result of report.results) {
    if (quiet && result.status !== FAIL) {
      continue;
    }

    const level = result.level === ERROR ? '' : ` (${result.level})`;
    const note = result.note ? ` — ${result.note}` : '';

    lines.push(
      `- ${MARKS[result.status]} ${result.id}. \`${result.name}\`${level}: ` +
        `${result.title}${note}`,
    );

    for (const violation of result.violations) {
      lines.push(`  - ${violation}`);
    }
  }

  lines.push('');

  return `${lines.join('\n')}\n`;
}

export default formatContract;
