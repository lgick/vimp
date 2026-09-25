import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../scripts/release/ui.js', () => ({
  log: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn(),
}));

import * as ui from '../../../scripts/release/ui.js';
import {
  tagAction,
  parseLsRemote,
  releaseTag,
} from '../../../scripts/release/tags.js';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

describe('tagAction', () => {
  it.each([
    [{ head: HEAD, local: null, remote: null }, 'create'],
    // прерванный прогон: тег поставлен, пуш не дошёл
    [{ head: HEAD, local: HEAD, remote: null }, 'push'],
    // CI упал: тег в origin есть, повторный пуш — no-op
    [{ head: HEAD, local: HEAD, remote: HEAD }, 'retrigger'],
    [{ head: HEAD, local: null, remote: HEAD }, 'retrigger'],
    // фикс после упавшего CI: тег остался на старом коммите
    [{ head: HEAD, local: OLD, remote: OLD }, 'move'],
    [{ head: HEAD, local: OLD, remote: null }, 'move'],
    [{ head: HEAD, local: HEAD, remote: OLD }, 'move'],
  ])('%j → %s', (state, action) => {
    expect(tagAction(state)).toBe(action);
  });
});

describe('parseLsRemote', () => {
  it('лёгкий тег — одна строка', () => {
    expect(parseLsRemote(`${HEAD}\trefs/tags/v1.0.0\n`, 'v1.0.0')).toBe(HEAD);
  });

  it('аннотированный — берётся коммит из ^{}', () => {
    const stdout = `${OLD}\trefs/tags/v1.0.0\n${HEAD}\trefs/tags/v1.0.0^{}\n`;

    expect(parseLsRemote(stdout, 'v1.0.0')).toBe(HEAD);
  });

  it('пустой ответ — тега нет', () => {
    expect(parseLsRemote('', 'v1.0.0')).toBe(null);
  });

  it('чужой тег с тем же префиксом не засчитывается', () => {
    expect(parseLsRemote(`${HEAD}\trefs/tags/v1.0.10\n`, 'v1.0.1')).toBe(null);
  });
});

// Шелл с заданным состоянием тега: head/local/remote — sha или null
function stateShell({ head = HEAD, local = null, remote = null, dryRun = false }) {
  const calls = [];
  const ok = stdout => ({ code: 0, stdout, stderr: '', output: stdout });
  const missing = { code: 1, stdout: '', stderr: '', output: '' };

  return {
    dryRun,
    calls,
    read: async (command, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return head ? ok(`${head}\n`) : missing;
      }
      if (args[0] === 'rev-parse') {
        return local ? ok(`${local}\n`) : missing;
      }
      if (args[0] === 'ls-remote') {
        return ok(remote ? `${remote}\t${args[3]}\n` : '');
      }
      throw new Error(`неожиданный read: ${args.join(' ')}`);
    },
    write: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      return ok('');
    },
  };
}

describe('releaseTag', () => {
  beforeEach(() => {
    vi.mocked(ui.confirm).mockReset();
  });

  it('create: ставит и пушит тег', async () => {
    const shell = stateShell({});

    await releaseTag(shell, '/repo', 'v1.0.0');

    expect(shell.calls).toEqual(['git tag v1.0.0', 'git push origin v1.0.0']);
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it('push: локальный тег на HEAD только пушится', async () => {
    const shell = stateShell({ local: HEAD });

    await releaseTag(shell, '/repo', 'v1.0.0');

    expect(shell.calls).toEqual(['git push origin v1.0.0']);
  });

  it('retrigger: удаляет тег в origin и пушит снова — иначе CI не стартует', async () => {
    vi.mocked(ui.confirm).mockResolvedValue(true);
    const shell = stateShell({ local: HEAD, remote: HEAD });

    await releaseTag(shell, '/repo', 'v1.0.0');

    expect(shell.calls).toEqual([
      'git push origin :refs/tags/v1.0.0',
      'git push origin v1.0.0',
    ]);
  });

  // тег поставлен с другой машины: без локального тега пуш после удаления
  // в origin упал бы, и тег пропал бы из origin насовсем
  it('retrigger без локального тега сначала ставит его', async () => {
    vi.mocked(ui.confirm).mockResolvedValue(true);
    const shell = stateShell({ remote: HEAD });

    await releaseTag(shell, '/repo', 'v1.0.0');

    expect(shell.calls).toEqual([
      'git tag v1.0.0',
      'git push origin :refs/tags/v1.0.0',
      'git push origin v1.0.0',
    ]);
  });

  it('retrigger спрашивает с «нет» по умолчанию: прошлый запуск может ещё идти', async () => {
    vi.mocked(ui.confirm).mockResolvedValue(true);

    await releaseTag(stateShell({ local: HEAD, remote: HEAD }), '/repo', 'v1.0.0');

    expect(vi.mocked(ui.confirm).mock.calls[0][1]).toBe(false);
  });

  it('retrigger без согласия — отказ, в origin ничего не трогается', async () => {
    vi.mocked(ui.confirm).mockResolvedValue(false);
    const shell = stateShell({ local: HEAD, remote: HEAD });

    await expect(releaseTag(shell, '/repo', 'v1.0.0')).rejects.toThrow(
      /CI повторно не запустится/,
    );
    expect(shell.calls).toEqual([]);
  });

  it('move: перевыставляет тег на HEAD и в origin', async () => {
    vi.mocked(ui.confirm).mockResolvedValue(true);
    const shell = stateShell({ local: OLD, remote: OLD });

    await releaseTag(shell, '/repo', 'v1.0.0');

    expect(shell.calls).toEqual([
      'git tag --force v1.0.0',
      'git push origin :refs/tags/v1.0.0',
      'git push origin v1.0.0',
    ]);
    // по умолчанию «нет»: опубликуется другой коммит
    expect(vi.mocked(ui.confirm).mock.calls[0][1]).toBe(false);
  });

  it('move только локально: удалять в origin нечего', async () => {
    vi.mocked(ui.confirm).mockResolvedValue(true);
    const shell = stateShell({ local: OLD });

    await releaseTag(shell, '/repo', 'v1.0.0');

    expect(shell.calls).toEqual(['git tag --force v1.0.0', 'git push origin v1.0.0']);
  });

  it('move без согласия — отказ', async () => {
    vi.mocked(ui.confirm).mockResolvedValue(false);
    const shell = stateShell({ local: OLD, remote: OLD });

    await expect(releaseTag(shell, '/repo', 'v1.0.0')).rejects.toThrow(
      /стоит не на HEAD/,
    );
    expect(shell.calls).toEqual([]);
  });

  it('origin не ответил — боевой прогон падает до любого пуша', async () => {
    const shell = stateShell({});

    shell.read = async (command, args) =>
      args[0] === 'ls-remote'
        ? { code: 128, stdout: '', stderr: 'fatal', output: 'fatal' }
        : { code: 0, stdout: `${HEAD}\n`, stderr: '', output: '' };

    await expect(releaseTag(shell, '/repo', 'v1.0.0')).rejects.toThrow(
      /ls-remote/,
    );
    expect(shell.calls).toEqual([]);
  });
});
