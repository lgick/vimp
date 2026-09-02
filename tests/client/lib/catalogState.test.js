import { describe, it, expect, vi } from 'vitest';
import { applyCatalogState } from '../../../packages/engine/src/client/lib/catalogState.js';

// Пустой каталог игр — законное состояние лобби (кодревью
// master-game-registry, находка 1): модератор вправе снять с раздачи
// последнюю игру, и вернуть её он обязан из той же панели, а не запросом мимо
// интерфейса. До этой правки бутстрап бросал и стирал разметку страницы.

const deps = (over = {}) => ({
  hostBtn: { disabled: false },
  emptyText: 'No games are published yet',
  bindGame: vi.fn(),
  showError: vi.fn(),
  clearError: vi.fn(),
  ...over,
});

describe('applyCatalogState', () => {
  it('с активной игрой: форма комнаты, чистая строка отказа, кнопка включена', () => {
    const manifest = { id: 'tanks', title: 'Tanks' };
    const d = deps({ hostBtn: { disabled: true } });

    applyCatalogState(manifest, d);

    expect(d.bindGame).toHaveBeenCalledWith(manifest);
    expect(d.clearError).toHaveBeenCalled();
    expect(d.showError).not.toHaveBeenCalled();
    expect(d.hostBtn.disabled).toBe(false);
  });

  it('пустой каталог: кнопка выключена, причина названа, игру не привязываем', () => {
    const d = deps();

    applyCatalogState(undefined, d);

    // bindGame не зовётся вовсе: без манифеста у формы комнаты нет схемы
    // полей, а у Leaderboard — игры, за рейтингом которой идти
    expect(d.bindGame).not.toHaveBeenCalled();
    expect(d.showError).toHaveBeenCalledWith('No games are published yet');
    expect(d.clearError).not.toHaveBeenCalled();
    expect(d.hostBtn.disabled).toBe(true);
  });

  it('текст отказа берётся у вызывающего: причина бывает конкретнее', () => {
    // каталог непустой, но играбельного в нём нет (движок обновили, игры
    // просят возможность, которой в нём уже нет) — для лобби это то же
    // состояние, но сказать надо не «игр пока не опубликовано», а причину
    const d = deps({ emptyText: 'no playable game in the lobby catalog: "tanks"' });

    applyCatalogState(undefined, d);

    expect(d.showError).toHaveBeenCalledWith(
      'no playable game in the lobby catalog: "tanks"',
    );
  });

  it('без кнопки в разметке не падает', () => {
    const d = deps({ hostBtn: null });

    expect(() => applyCatalogState(undefined, d)).not.toThrow();
    expect(d.showError).toHaveBeenCalled();
  });

  it('возврат игры снимает состояние пустого каталога', () => {
    const d = deps({ hostBtn: { disabled: true } });

    // «Test» застейдженной версии — единственный путь наружу из пустого
    // каталога, и он обязан вернуть лобби в рабочее состояние целиком
    applyCatalogState({ id: 'snakes', title: 'Snakes' }, d);

    expect(d.hostBtn.disabled).toBe(false);
    expect(d.clearError).toHaveBeenCalled();
  });
});
