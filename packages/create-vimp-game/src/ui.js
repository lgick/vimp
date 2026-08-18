// Вывод CLI. Текст интерфейса английский (как у bin/vimp-sim.js): его
// читает автор игры, в том числе вне этого репозитория.

// цвета гасятся, когда вывод уходит не в терминал (пайп, CI) или задан
// NO_COLOR — иначе escape-последовательности попадают в лог
const enabled =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const CODES = {
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  cyan: '36',
};

// ESC собирается из кода: буквальный управляющий символ в исходнике
// невидим при чтении и теряется при копировании
const ESC = String.fromCharCode(27);

function paint(name, text) {
  return enabled ? `${ESC}[${CODES[name]}m${text}${ESC}[0m` : String(text);
}

export const color = {
  bold: text => paint('bold', text),
  dim: text => paint('dim', text),
  red: text => paint('red', text),
  green: text => paint('green', text),
  yellow: text => paint('yellow', text),
  cyan: text => paint('cyan', text),
};

export function log(message = '') {
  process.stdout.write(`${message}\n`);
}

export function warn(message) {
  process.stderr.write(`${color.yellow('warning:')} ${message}\n`);
}

// финальный экран: команды, которые автор игры выполняет следующими.
// Порядок повторяет docs/ai/11-authoring-workflow.md: зависимости → ядро →
// проверка контракта → headless-прогон → браузер
export function nextSteps({ directory, tokens }) {
  const lines = [
    '',
    `${color.green('Done.')} ${color.bold(tokens.GAME_TITLE)} scaffolded in ${color.cyan(directory)}`,
    '',
    'Next steps:',
    `  cd ${directory}`,
    '  npm install',
    '  npm run core:build     # cargo + wasm-pack',
    '  npm run check:contract # static plugin contract check',
    '  npm run build',
    '  npm run sim            # headless match',
    '',
    color.dim(
      'Read CLAUDE.md in the generated project before writing gameplay.',
    ),
    '',
  ];

  return lines.join('\n');
}
