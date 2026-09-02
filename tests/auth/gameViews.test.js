import { describe, it, expect } from 'vitest';
import { forAuthor } from '../../packages/auth/src/lib/gameViews.js';

// Кодревью master-game-registry, находка 4: правка §6 dev-fixes расширила
// общий список колонок (GAME_FIELDS) ником модератора ради очереди
// модерации — и он поехал автору игры через GET /games/mine. Это не утечка
// секрета (ники публичны в лобби), а НОВАЯ СВЯЗКА: «эту заявку зарубил вот
// этот человек». До правки модерация со стороны автора была анонимной.

const game = {
  id: 'tanks',
  packageName: '@vimp-games/tanks',
  status: 'rejected',
  version: null,
  pendingVersion: '0.16.1',
  moderatorNote: 'нет dist/manifest.json в тарболе',
  moderatorNick: 'lgick',
  authorNick: 'Player1',
};

describe('forAuthor', () => {
  it('снимает ник модератора и оставляет его замечание', () => {
    const view = forAuthor(game);

    expect(view).not.toHaveProperty('moderatorNick');
    // замечание — это то, ради чего автор и открывает «My games»
    expect(view.moderatorNote).toBe('нет dist/manifest.json в тарболе');
  });

  it('остальную строку не трогает', () => {
    const { moderatorNick, ...rest } = game;

    expect(moderatorNick).toBe('lgick');
    expect(forAuthor(game)).toEqual(rest);
  });

  it('исходную строку не мутирует: очередь модерации читает ту же', () => {
    forAuthor(game);

    expect(game.moderatorNick).toBe('lgick');
  });
});
