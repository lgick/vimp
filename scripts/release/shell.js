import { spawn } from 'node:child_process';

// Запуск внешних команд для релиз-скрипта. Два режима вывода:
//   - захват (capture) — обычный случай: в консоли одна строка со статусом,
//     полный вывод показывается только при падении;
//   - наследование (interactive) — для `npm login`/`cargo login` и для самой
//     публикации, где человеку нужен живой ввод.

export class CommandError extends Error {
  constructor({ command, cwd, code, output }) {
    super(`command failed (exit ${code}): ${command}`);
    this.name = 'CommandError';
    this.command = command;
    this.cwd = cwd;
    this.code = code;
    this.output = output;
  }

  // единый формат разбора падения: команда, где запускалась, код и весь
  // захваченный вывод — иначе тихий режим прячет причину
  format() {
    return [
      `command: ${this.command}`,
      `cwd:     ${this.cwd}`,
      `exit:    ${this.code}`,
      '--- output ---',
      this.output.trim() || '(empty)',
      '--------------',
    ].join('\n');
  }
}

// аргумент с пробелами берётся в кавычки: строка идёт в отчёт о падении и
// должна читаться как команда, которую можно повторить руками
export function formatCommand(command, args = []) {
  return [command, ...args]
    .map(part => (/\s/.test(part) ? `"${part}"` : part))
    .join(' ');
}

// `npm run release --dry-run` (без `--`) флаг до скрипта не доносит: npm
// съедает его как СВОЙ конфиг и экспортирует npm_config_dry_run в окружение.
// Скрипт при этом идёт боевым ходом, а каждый дочерний `npm publish`
// становится холостым — релиз «проходит», ставит теги и коммиты, а в реестре
// пусто. Переменную вырезаем из окружения любой дочерней команды (preflight
// от неё отказывается ещё раньше).
const DRY_RUN_ENV = /^npm_config_dry[_-]?run$/i;

export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };

  for (const key of Object.keys(env)) {
    if (DRY_RUN_ENV.test(key)) {
      delete env[key];
    }
  }

  return env;
}

// Выставлен ли флаг холостого npm в окружении: значение «false»/пустая строка
// у npm означает выключено.
export function npmDryRunEnv(env = process.env) {
  return Object.entries(env).some(
    ([key, value]) =>
      DRY_RUN_ENV.test(key) && value !== '' && value !== 'false',
  );
}

export function capture(command, args = [], options = {}) {
  const cwd = options.cwd ?? process.cwd();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // потоки копятся раздельно: `npm --json` пишет ответ в stdout, а любое
    // предупреждение — в stderr, и склейка ломала бы JSON.parse. Слитый
    // `output` остаётся только для отчёта о падении
    let stdout = '';
    let stderr = '';
    let output = '';

    child.stdout.on('data', chunk => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      output += chunk;
    });

    child.on('error', error => {
      reject(
        new CommandError({
          command: formatCommand(command, args),
          cwd,
          code: null,
          output: error.message,
        }),
      );
    });

    child.on('close', code => {
      if (code === 0 || options.allowFailure) {
        resolve({ code, stdout, stderr, output });
        return;
      }

      reject(
        new CommandError({
          command: formatCommand(command, args),
          cwd,
          code,
          output,
        }),
      );
    });
  });
}

export function interactive(command, args = [], options = {}) {
  const cwd = options.cwd ?? process.cwd();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnv(options.env),
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', code => resolve({ code, output: '' }));
  });
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

// dryRun гасит только изменяющие команды (write); чтение и проверки идут
// всегда — иначе прогон не докажет, что релиз пройдёт.
// releaseStdin вызывается перед каждой командой с живым вводом: родительский
// readline читает тот же stdin и съел бы то, что человек печатает ребёнку.
export function createShell({ dryRun = false, log = () => {}, releaseStdin } = {}) {
  // read — только чтение состояния (git rev-parse, git diff --cached):
  // выполняется всегда, включая dry-run
  async function read(command, args, options = {}) {
    return capture(command, args, options);
  }

  async function write(command, args, options = {}) {
    const line = formatCommand(command, args);

    if (dryRun) {
      log(`  · dry-run, skipped: ${line}${options.cwd ? ` (${options.cwd})` : ''}`);
      return { code: 0, stdout: '', stderr: '', output: '', skipped: true };
    }

    log(`  · ${line}`);
    return capture(command, args, options);
  }

  // проверка (тесты/линт/сборка) — выполняется и в dry-run. Строка статуса
  // печатается до запуска: иначе консоль молчит всё время долгой команды
  async function check(label, command, args, options = {}) {
    const started = Date.now();

    log(`  ▸ ${label} …`);

    try {
      const result = await capture(command, args, options);
      log(`    ok (${formatDuration(Date.now() - started)})`);
      return result;
    } catch (error) {
      log(`    FAILED (${formatDuration(Date.now() - started)})`);
      throw error;
    }
  }

  async function runInteractive(command, args, options = {}) {
    releaseStdin?.();
    return interactive(command, args, options);
  }

  // Публикация в реестр: изменяющая команда, но с живым терминалом. При 2FA
  // npm и cargo спрашивают одноразовый код или открывают браузер, а с
  // захваченными потоками у команды нет ни stdin, ни TTY — она падает с
  // EOTP вместо запроса. Вывод идёт прямо в консоль, поэтому в отчёте о
  // падении остаётся только команда.
  async function publish(command, args, options = {}) {
    const line = formatCommand(command, args);

    if (dryRun) {
      log(`  · dry-run, skipped: ${line}${options.cwd ? ` (${options.cwd})` : ''}`);
      return { code: 0, stdout: '', stderr: '', output: '', skipped: true };
    }

    log(`  · ${line}`);

    const { code } = await runInteractive(command, args, options);

    if (code !== 0) {
      throw new CommandError({
        command: line,
        cwd: options.cwd ?? process.cwd(),
        code,
        output: '(вывод команды выше — она печаталась прямо в этот терминал)',
      });
    }

    return { code, stdout: '', stderr: '', output: '' };
  }

  return { dryRun, read, write, check, publish, interactive: runInteractive };
}
