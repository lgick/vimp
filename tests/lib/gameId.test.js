import { describe, it, expect } from 'vitest';
import {
  GAME_ID_PATTERN,
  isValidGameId,
} from '../../packages/engine/src/lib/gameId.js';
import { GAME_ID_PATTERN as MASTER_PATTERN } from '../../packages/engine/src/master/gameRefs.js';
import authConfig from '../../packages/auth/src/config/auth.js';

describe('gameId', () => {
  it('мастер реэкспортирует тот же паттерн', () => {
    expect(MASTER_PATTERN).toBe(GAME_ID_PATTERN);
  });

  it.each(['tanks', 'snakes', 'my-game-2'])('%s — валиден', id => {
    expect(isValidGameId(id)).toBe(true);
  });

  it.each(['', 't', '1tanks', 'Tanks', 'a'.repeat(32), 'tank_s', null, 1])(
    '%j — невалиден',
    id => {
      expect(isValidGameId(id)).toBe(false);
    },
  );

  it('совпадает с форматом auth-сервиса', () => {
    expect(String(authConfig.games.idPattern)).toBe(String(GAME_ID_PATTERN));
  });
});
