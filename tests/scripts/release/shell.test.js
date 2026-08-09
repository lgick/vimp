import { describe, it, expect } from 'vitest';

import { capture, createShell, CommandError } from '../../../scripts/release/shell.js';

describe('shell', () => {
  it('возвращает захваченный stdout при успехе', async () => {
    const { code, output } = await capture('node', ['-e', 'console.log("hi")']);

    expect(code).toBe(0);
    expect(output.trim()).toBe('hi');
  });

  it('при ненулевом коде ошибка несёт команду, каталог, код и вывод', async () => {
    const failing = capture(
      'node',
      ['-e', 'console.error("boom"); process.exit(3)'],
      { cwd: process.cwd() },
    );

    await expect(failing).rejects.toBeInstanceOf(CommandError);

    const error = await failing.catch(caught => caught);

    expect(error.command).toContain('node');
    expect(error.cwd).toBe(process.cwd());
    expect(error.code).toBe(3);
    expect(error.output).toContain('boom');
    expect(error.format()).toContain('exit:    3');
  });

  it('не смешивает stdout и stderr', async () => {
    const { stdout, stderr, output } = await capture('node', [
      '-e',
      'console.log("{\\"v\\":1}"); console.error("warn")',
    ]);

    expect(stdout.trim()).toBe('{"v":1}');
    expect(stderr.trim()).toBe('warn');
    expect(JSON.parse(stdout)).toEqual({ v: 1 });
    // слитый вывод остаётся для отчёта о падении
    expect(output).toContain('warn');
  });

  it('allowFailure отдаёт код вместо исключения', async () => {
    const { code } = await capture('node', ['-e', 'process.exit(7)'], {
      allowFailure: true,
    });

    expect(code).toBe(7);
  });

  it('--dry-run гасит изменяющие команды, но не проверки', async () => {
    const lines = [];
    const shell = createShell({ dryRun: true, log: line => lines.push(line) });

    const written = await shell.write('node', ['-e', 'process.exit(1)']);

    expect(written.skipped).toBe(true);
    expect(lines.at(-1)).toContain('dry-run');

    const checked = await shell.check('echo', 'node', ['-e', 'console.log("ok")']);

    expect(checked.stdout.trim()).toBe('ok');
    expect(lines.at(-2)).toContain('▸ echo');
    expect(lines.at(-1)).toContain('ok (');
  });

  it('падение проверки пробрасывается и в dry-run', async () => {
    const shell = createShell({ dryRun: true });

    await expect(
      shell.check('fail', 'node', ['-e', 'process.exit(2)']),
    ).rejects.toBeInstanceOf(CommandError);
  });

  // публикация идёт с живым терминалом: при 2FA npm сам спрашивает
  // одноразовый код, а с захваченными потоками падал бы с EOTP
  it('publish отдаёт stdin команде и логирует её', async () => {
    const lines = [];
    const released = [];
    const shell = createShell({
      log: line => lines.push(line),
      releaseStdin: () => released.push('closed'),
    });

    const result = await shell.publish('node', ['-e', 'process.exit(0)']);

    expect(result.code).toBe(0);
    expect(released).toEqual(['closed']);
    expect(lines.at(-1)).toContain('node');
  });

  // без исключения релиз поехал бы дальше — ставить тег и пушить прод по
  // неопубликованному пакету
  it('publish падает CommandError на ненулевом коде', async () => {
    const shell = createShell({ releaseStdin: () => {} });
    const failing = shell.publish('node', ['-e', 'process.exit(5)'], {
      cwd: process.cwd(),
    });

    await expect(failing).rejects.toBeInstanceOf(CommandError);

    const error = await failing.catch(caught => caught);

    expect(error.code).toBe(5);
    expect(error.cwd).toBe(process.cwd());
    // вывод шёл в терминал, в отчёте остаётся команда
    expect(error.format()).toContain('exit:    5');
  });

  it('publish в dry-run ничего не запускает', async () => {
    const released = [];
    const shell = createShell({
      dryRun: true,
      releaseStdin: () => released.push('closed'),
    });

    const result = await shell.publish('node', ['-e', 'process.exit(1)']);

    expect(result.skipped).toBe(true);
    expect(released).toEqual([]);
  });
});
