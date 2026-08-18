import { spawn } from 'node:child_process';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

// bin/vimp-contract.js: код выхода — единственное, ради чего CLI и нужен
// в npm-скриптах игры, и проверить его можно только дочерним процессом.

const ROOT = path.resolve(import.meta.dirname, '../../..');
const BIN = path.join(ROOT, 'packages/engine/bin/vimp-contract.js');
const FIXTURE = path.join(ROOT, 'packages/engine/tests/fixtures/miniGame');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

describe('bin/vimp-contract.js', () => {
  it('печатает справку и выходит с нулём', async () => {
    const { code, stdout } = await run(['--help']);

    expect(code).toBe(0);
    expect(stdout).toContain('Usage: vimp-contract');
  });

  it('неизвестный флаг — код 1 и подсказка', async () => {
    const { code, stderr } = await run(['--nope']);

    expect(code).toBe(1);
    expect(stderr).toContain("unknown option '--nope'");
  });

  it('--game без значения не проверяет молча текущий каталог', async () => {
    const { code, stderr } = await run(['--game', '--json']);

    expect(code).toBe(1);
    expect(stderr).toContain("option '--game' needs a value");
  });

  it('--json печатает разбираемый отчёт', async () => {
    const { stdout } = await run(['--game', FIXTURE, '--json']);
    const report = JSON.parse(stdout);

    expect(report.game.dir).toBe(FIXTURE);
    expect(Array.isArray(report.results)).toBe(true);
    expect(report.summary.passed).toBeGreaterThan(0);
  });

  it('--quiet оставляет только провалы и сводку', async () => {
    const { stdout } = await run(['--game', FIXTURE, '--quiet']);

    expect(stdout).toContain('passed,');
    expect(stdout).not.toContain('✅');
  });

  // 32 skip подряд — не «проверено, всё хорошо»: опечатка в пути обязана
  // валить прогон, а не выдавать нулевой код выхода
  it('несуществующий каталог — отказ, а не зелёный прогон', async () => {
    const { code, stderr } = await run([
      '--game',
      path.join(ROOT, 'no-such-game'),
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain('nothing to check');
  });
});
