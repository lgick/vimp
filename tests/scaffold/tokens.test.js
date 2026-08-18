import { describe, it, expect } from 'vitest';

import {
  buildTokens,
  defaultPackageName,
  defaultTitle,
  isValidGameId,
  isValidPackageName,
  toCrateName,
  toCrateSnake,
  toGameId,
  TokenError,
} from '../../packages/create-vimp-game/src/tokens.js';

const versions = { engineVersion: '^0.9.0', coreVersion: '0.3.2' };

describe('валидация id и имени пакета', () => {
  it('принимает kebab-case', () => {
    expect(isValidGameId('space-arena')).toBe(true);
    expect(isValidGameId('arena')).toBe(true);
  });

  it('отвергает всё остальное', () => {
    for (const id of [
      'Space-Arena',
      '2fast',
      'space arena',
      'space_arena',
      'arena-',
      '',
    ]) {
      expect(isValidGameId(id), id).toBe(false);
    }
  });

  it('принимает имена npm со scope и без', () => {
    expect(isValidPackageName('@vimp-games/space-arena')).toBe(true);
    expect(isValidPackageName('space-arena')).toBe(true);
  });

  it('отвергает недопустимые имена npm', () => {
    for (const name of [
      '@vimp-games/Space',
      'space arena',
      '@vimp-games',
      '',
    ]) {
      expect(isValidPackageName(name), name).toBe(false);
    }
  });
});

describe('дефолты из имени каталога', () => {
  it('приводит произвольное имя к id', () => {
    expect(toGameId('My Game 2')).toBe('my-game-2');
    expect(toGameId('space_arena')).toBe('space-arena');
    expect(toGameId('2fast')).toBe('game-2fast');
  });

  it('выводит заголовок и имя пакета', () => {
    expect(defaultTitle('space-arena')).toBe('Space Arena');
    expect(defaultPackageName('space-arena')).toBe('@vimp-games/space-arena');
  });
});

describe('имя крейта', () => {
  it('выводится из id, snake-вариант — для артефактов wasm-bindgen', () => {
    expect(toCrateName('space-arena')).toBe('space-arena-core');
    expect(toCrateSnake('space-arena-core')).toBe('space_arena_core');
  });
});

describe('buildTokens', () => {
  it('собирает полный набор подстановок', () => {
    const tokens = buildTokens({
      id: 'space-arena',
      author: 'lgick',
      year: 2026,
      ...versions,
    });

    expect(tokens).toEqual({
      GAME_ID: 'space-arena',
      GAME_TITLE: 'Space Arena',
      PACKAGE_NAME: '@vimp-games/space-arena',
      CRATE_NAME: 'space-arena-core',
      CRATE_SNAKE: 'space_arena_core',
      ENGINE_VERSION: '^0.9.0',
      CORE_VERSION: '0.3.2',
      AUTHOR: 'lgick',
      YEAR: '2026',
    });
  });

  it('падает на недопустимом id', () => {
    expect(() => buildTokens({ id: 'Space Arena', ...versions })).toThrow(
      TokenError,
    );
  });

  it('падает на недопустимом имени пакета', () => {
    expect(() =>
      buildTokens({
        id: 'arena',
        packageName: '@vimp-games/Arena',
        ...versions,
      }),
    ).toThrow(TokenError);
  });
});
