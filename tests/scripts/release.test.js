import { describe, it, expect, vi, beforeEach } from 'vitest';

// ask() читает readline напрямую — мокаем модуль целиком, чтобы тест не
// зависел от stdin и не печатал в консоль
const ask = vi.fn();

vi.mock('../../scripts/release/ui.js', () => ({
  log: vi.fn(),
  ask: (...args) => ask(...args),
}));

beforeEach(() => {
  ask.mockReset();
});

const { askGameVersionAsIs, askVersion, resolveVersionAnswer } = await import(
  '../../scripts/release/versionPrompt.js'
);
const { UsageError } = await import('../../scripts/release/errors.js');

describe('askGameVersionAsIs', () => {
  it('Enter (текущая версия) публикует как есть, без вопроса о новом теге', async () => {
    ask.mockResolvedValueOnce('0.22.0');

    const target = await askGameVersionAsIs(
      '@vimp-games/tanks',
      { current: '0.22.0', published: '0.21.0' },
      { yes: false },
    );

    expect(target).toBe('0.22.0');
  });

  // сценарий, из-за которого функция появилась: тег текущей версии уже
  // существует на remote (от неудавшегося прогона) — повторный пуш того же
  // тега не запустит release.yml, нужна версия строго выше
  it('явный patch поднимает версию выше текущей — тег будет новым', async () => {
    ask.mockResolvedValueOnce('patch');

    const target = await askGameVersionAsIs(
      '@vimp-games/tanks',
      { current: '0.22.0', published: '0.21.0' },
      { yes: false },
    );

    expect(target).toBe('0.22.1');
  });

  it('своя версия строго выше текущей тоже принимается', async () => {
    ask.mockResolvedValueOnce('0.23.0');

    const target = await askGameVersionAsIs(
      '@vimp-games/tanks',
      { current: '0.22.0', published: '0.21.0' },
      { yes: false },
    );

    expect(target).toBe('0.23.0');
  });

  it('--yes публикует как есть без вопроса', async () => {
    const target = await askGameVersionAsIs(
      '@vimp-games/tanks',
      { current: '0.22.0', published: '0.21.0' },
      { yes: true },
    );

    expect(target).toBe('0.22.0');
    expect(ask).not.toHaveBeenCalled();
  });

  it('версия не выше текущей отклоняется', async () => {
    ask.mockResolvedValueOnce('0.22.0-nope');

    await expect(
      askGameVersionAsIs(
        '@vimp-games/tanks',
        { current: '0.22.0', published: '0.21.0' },
        { yes: false },
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('askVersion', () => {
  it('Enter принимает предложенный инкремент', async () => {
    ask.mockResolvedValueOnce('0.35.0');

    const target = await askVersion(
      'vimp-engine',
      { current: '0.34.4', level: 'minor', reason: 'test', published: '0.34.4' },
      { yes: false },
    );

    expect(target).toBe('0.35.0');
  });

  it('--yes принимает предложенный инкремент без вопроса', async () => {
    const target = await askVersion(
      'vimp-engine',
      { current: '0.34.4', level: 'patch', reason: 'test', published: '0.34.4' },
      { yes: true },
    );

    expect(target).toBe('0.34.5');
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('resolveVersionAnswer', () => {
  it('не даёт версию не больше опубликованной', () => {
    expect(() =>
      resolveVersionAnswer('0.21.0', { current: '0.22.0', published: '0.21.0' }),
    ).toThrow(UsageError);
  });
});
