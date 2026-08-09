import { createInterface } from 'node:readline/promises';

// Вывод и вопросы. Весь текст — русский: сценарий интерактивный, его читает
// разработчик, а не CI.

const PREFIX = '[release]';

export function log(message = '') {
  console.log(message === '' ? '' : `${PREFIX} ${message}`);
}

export function raw(message) {
  console.log(message);
}

export function error(message) {
  console.error(`${PREFIX} ${message}`);
}

let rl = null;

function reader() {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  return rl;
}

export function closePrompts() {
  rl?.close();
  rl = null;
}

export async function ask(question, fallback = '') {
  const suffix = fallback === '' ? '' : ` [${fallback}]`;
  const answer = await reader().question(`${PREFIX} ${question}${suffix}: `);

  return answer.trim() === '' ? fallback : answer.trim();
}

const YES = ['y', 'yes'];
const NO = ['n', 'no'];

// неизвестный ввод переспрашивается, а не толкуется как «нет»: на вопросе
// про пуш в прод угадывание обходится дорого
export async function confirm(question, fallback = true) {
  const hint = fallback ? 'Y/n' : 'y/N';

  for (;;) {
    const answer = (await reader().question(`${PREFIX} ${question} (${hint}): `))
      .trim()
      .toLowerCase();

    if (answer === '') {
      return fallback;
    }

    if (YES.includes(answer)) {
      return true;
    }

    if (NO.includes(answer)) {
      return false;
    }

    error('ответьте «y» или «n»');
  }
}

// Простая таблица: выравнивание по самой широкой ячейке столбца.
export function table(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) =>
    Math.max(...all.map(row => String(row[column] ?? '').length)),
  );

  const line = row =>
    row
      .map((cell, column) => String(cell ?? '').padEnd(widths[column]))
      .join('  ')
      .trimEnd();

  raw('');
  raw(`  ${line(headers)}`);
  raw(`  ${widths.map(width => '-'.repeat(width)).join('  ')}`);

  for (const row of rows) {
    raw(`  ${line(row)}`);
  }

  raw('');
}
