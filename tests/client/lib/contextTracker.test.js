import { describe, it, expect } from 'vitest';
import { createContextTracker } from '../../../packages/engine/src/client/lib/contextTracker.js';

describe('contextTracker', () => {
  it('останавливает рендер только на первой потере', () => {
    const tracker = createContextTracker();

    expect(tracker.markLost('vimp')).toBe(true);
    expect(tracker.markLost('radar')).toBe(false);
    expect(tracker.markLost('vimp')).toBe(false); // повторное событие
    expect(tracker.hasLost()).toBe(true);
  });

  it('пересобирает сцену один раз и только после восстановления всех полотен', () => {
    const tracker = createContextTracker();

    tracker.markLost('vimp');
    tracker.markLost('radar');

    // радар ещё мёртв — перепечка дала бы пустые текстуры
    expect(tracker.markRestored('vimp')).toBe(false);
    expect(tracker.isLost('radar')).toBe(true);

    expect(tracker.markRestored('radar')).toBe(true);
    expect(tracker.hasLost()).toBe(false);
  });

  it('игнорирует восстановление полотна, которое не теряли', () => {
    const tracker = createContextTracker();

    expect(tracker.markRestored('vimp')).toBe(false);

    tracker.markLost('vimp');
    tracker.markRestored('vimp');

    // второе событие по тому же полотну сцену не пересобирает
    expect(tracker.markRestored('vimp')).toBe(false);
  });

  it('reset снимает состояние потери', () => {
    const tracker = createContextTracker();

    tracker.markLost('vimp');
    tracker.reset();

    expect(tracker.hasLost()).toBe(false);
    expect(tracker.markLost('vimp')).toBe(true);
  });
});
