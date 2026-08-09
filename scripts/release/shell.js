import { spawn } from 'node:child_process';

// Запуск внешних команд для релиз-скрипта. Два режима вывода:
//   - захват (capture) — обычный случай: в консоли одна строка со статусом,
//     полный вывод показывается только при падении;
//   - наследование (interactive) — только для `npm login`/`cargo login`,
//     где человеку нужен живой ввод.

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

export function capture(command, args = [], options = {}) {
  const cwd = options.cwd ?? process.cwd();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...options.env },
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
    const child = spawn(command, args, { cwd, stdio: 'inherit' });

    child.on('error', reject);
    child.on('close', code => resolve({ code, output: '' }));
  });
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

// dryRun гасит только изменяющие команды (write); чтение и проверки идут
// всегда — иначе прогон не докажет, что релиз пройдёт
export function createShell({ dryRun = false, log = () => {} } = {}) {
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

  return { dryRun, read, write, check, interactive };
}
