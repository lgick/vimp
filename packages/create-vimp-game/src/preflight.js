import { spawn } from 'node:child_process';

// Проверка окружения и git init. Отсутствие cargo/wasm-pack генерацию не
// блокирует: файлы игры создаются, ошибка всплывёт на npm run core:build —
// к тому моменту у автора уже есть проект и подсказка по установке.

const TOOLS = [
  {
    command: 'cargo',
    hint: 'install Rust: https://rustup.rs',
  },
  {
    command: 'wasm-pack',
    hint: 'install wasm-pack: cargo install wasm-pack',
  },
];

function run(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'ignore',
      shell: false,
    });

    child.on('error', () => resolve(null));
    child.on('close', code => resolve(code));
  });
}

export async function checkTools() {
  const missing = [];

  for (const tool of TOOLS) {
    const code = await run(tool.command, ['--version']);

    if (code !== 0) {
      missing.push(tool);
    }
  }

  return missing;
}

// первый коммит остаётся за автором игры: скаффолдер только заводит
// репозиторий, чтобы `git diff` работал с первой правки
export async function initGit(dir) {
  const code = await run('git', ['init', '--quiet'], { cwd: dir });

  return code === 0;
}
