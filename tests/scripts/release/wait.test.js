import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../scripts/release/ui.js', () => ({
  log: vi.fn(),
  raw: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn(),
}));

import * as ui from '../../../scripts/release/ui.js';
import { startWait, cancelWaits } from '../../../scripts/release/registry.js';
import { awaitPublished } from '../../../scripts/release/steps.js';

// Публикацию делает CI по тегу: опрос реестра стартует сразу, а ждут его там,
// где версия нужна. Молчаливое ожидание читалось как зависание
describe('startWait', () => {
  it('отказ опроса — это false, а не исключение: решает тот, кто ждёт', async () => {
    const pending = startWait('x@1.0.0', async () => {
      throw new Error('сеть');
    });

    await expect(pending.promise).resolves.toBe(false);
  });

  // упавший прогон обрывает фоновые опросы: иначе их таймеры держали бы
  // процесс до 10 минут после сообщения об ошибке
  it('cancelWaits обрывает опрос через AbortSignal', async () => {
    const pending = startWait(
      'x@1.0.0',
      signal =>
        new Promise(resolve =>
          signal.addEventListener('abort', () => resolve(false)),
        ),
    );

    await Promise.resolve();
    cancelWaits();

    await expect(pending.promise).resolves.toBe(false);
  });

  it('опрос стартует сразу, не дожидаясь awaitPublished', () => {
    const wait = vi.fn(async () => true);

    startWait('x@1.0.0', wait);

    return Promise.resolve().then(() => expect(wait).toHaveBeenCalledOnce());
  });
});

describe('awaitPublished', () => {
  beforeEach(() => {
    vi.mocked(ui.log).mockClear();
    vi.mocked(ui.confirm).mockReset();
  });

  it('null (dry-run, артефакт не публиковался) — ничего не ждёт', async () => {
    await expect(awaitPublished(null)).resolves.toBeUndefined();
    expect(ui.log).not.toHaveBeenCalled();
  });

  it('говорит, чего ждёт и где смотреть CI, и отмечает дождавшееся', async () => {
    const pending = startWait('x@1.0.0', async () => true, 'https://ci');

    await awaitPublished(pending);
    await awaitPublished(pending);

    const lines = vi.mocked(ui.log).mock.calls.map(([line]) => line);

    expect(lines[0]).toBe('  … ждём публикацию x@1.0.0 (CI: https://ci)');
    expect(lines[1]).toMatch(/^ {2}· x@1\.0\.0 в реестре/);
    // второй вызов — no-op: итоговый обход не повторяет ожидание
    expect(lines).toHaveLength(2);
  });

  it('печатает прогресс, пока CI публикует', async () => {
    vi.useFakeTimers();

    let finish;
    const pending = startWait(
      'x@1.0.0',
      () => new Promise(resolve => (finish = resolve)),
    );
    const waiting = awaitPublished(pending, { progressMs: 30000 });

    await vi.advanceTimersByTimeAsync(65000);
    finish(true);
    await waiting;
    vi.useRealTimers();

    const lines = vi.mocked(ui.log).mock.calls.map(([line]) => line);

    expect(lines).toContain('  … ждём публикацию x@1.0.0 — 30s');
    expect(lines).toContain('  … ждём публикацию x@1.0.0 — 1m00s');
  });

  it('версия не появилась — спрашивает, отказ останавливает релиз', async () => {
    vi.mocked(ui.confirm).mockResolvedValue(false);

    await expect(
      awaitPublished(startWait('x@1.0.0', async () => false)),
    ).rejects.toThrow(/x@1\.0\.0 не появился в реестре/);
    expect(vi.mocked(ui.confirm).mock.calls[0][1]).toBe(false);
  });

  it('версия не появилась, но разработчик решил продолжать', async () => {
    vi.mocked(ui.confirm).mockResolvedValue(true);

    const pending = startWait('x@1.0.0', async () => false);

    await expect(awaitPublished(pending)).resolves.toBeUndefined();
    // шаг прода увидит это и не станет деплоить
    expect(pending.published).toBe(false);
  });

  it('дождавшаяся публикация помечается published', async () => {
    const pending = startWait('x@1.0.0', async () => true);

    await awaitPublished(pending);

    expect(pending.published).toBe(true);
  });
});
