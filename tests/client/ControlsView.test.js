import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ControlsView — синглтон, перезагружаем модуль для изоляции
let ControlsView;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  document.body.className = '';
  ControlsView = (
    await import('../../packages/engine/src/client/components/view/Controls.js')
  ).default;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ControlsView.resetCursorHideTimer', () => {
  it('сразу показывает курсор и скрывает его через 3 секунды', () => {
    const view = new ControlsView({});
    document.body.classList.add('hide-cursor');

    view.resetCursorHideTimer();
    expect(document.body.classList.contains('hide-cursor')).toBe(false);

    vi.advanceTimersByTime(3000);
    expect(document.body.classList.contains('hide-cursor')).toBe(true);
  });

  it('повторный вызов сбрасывает предыдущий таймер скрытия', () => {
    const view = new ControlsView({});

    view.resetCursorHideTimer();
    vi.advanceTimersByTime(2000); // ещё не скрыт
    view.resetCursorHideTimer(); // таймер перезапущен
    vi.advanceTimersByTime(2000); // суммарно 4с, но с перезапуска лишь 2с

    expect(document.body.classList.contains('hide-cursor')).toBe(false);

    vi.advanceTimersByTime(1000); // добиваем до 3с после перезапуска
    expect(document.body.classList.contains('hide-cursor')).toBe(true);
  });
});
