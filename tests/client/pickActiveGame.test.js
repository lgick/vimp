import { describe, it, expect } from 'vitest';
import {
  pickActiveGame,
  isGameAvailable,
} from '../../packages/engine/src/client/lib/pickActiveGame.js';

// Выбор активной игры (этап 5 плана plugin-forward-compat). Недоступная игра
// остаётся в СПИСКЕ лобби с причиной, но активной быть не может: её плагин не
// загрузится. Раньше запасной путь `?? gamesManifest[0]` возвращал её
// обратно, а ветка сохранённого выбора (boot.gameId) совместимость не
// смотрела вовсе — вкладка вставала на исключении из loadClientPlugin.

const available = id => ({ id, title: id });
const unavailable = id => ({
  id,
  title: id,
  compat: { ok: false, missing: ['x'], text: `game "${id}" needs x` },
});

describe('isGameAvailable', () => {
  it('манифест без compat доступен — все опубликованные до этапа 5', () => {
    expect(isGameAvailable(available('tanks'))).toBe(true);
  });

  it('compat.ok === false — недоступна', () => {
    expect(isGameAvailable(unavailable('snakes'))).toBe(false);
  });
});

describe('pickActiveGame', () => {
  it('берёт первую доступную, пропуская недоступные', () => {
    const picked = pickActiveGame([unavailable('snakes'), available('tanks')]);

    expect(picked.id).toBe('tanks');
  });

  it('уважает сохранённый выбор, если игра доступна', () => {
    const picked = pickActiveGame(
      [available('snakes'), available('tanks')],
      'tanks',
    );

    expect(picked.id).toBe('tanks');
  });

  it('сохранённый выбор недоступной игры не берётся', () => {
    expect(() =>
      pickActiveGame([unavailable('snakes'), available('tanks')], 'snakes'),
    ).toThrow(/no playable game/);
  });

  it('каталог без единой доступной игры объясняет причину по каждой', () => {
    expect(() =>
      pickActiveGame([unavailable('snakes'), unavailable('tanks')]),
    ).toThrow(/needs x.*needs x/);
  });

  it('пустой каталог — undefined: это другой отказ, со своим текстом', () => {
    expect(pickActiveGame([])).toBeUndefined();
  });
});
