import { describe, it, expect } from 'vitest';
import { RESERVED_GAME_IDS } from '../../packages/engine/src/master/gameRefs.js';
import authConfig from '../../packages/auth/src/config/auth.js';

// Списки зарезервированных id продублированы намеренно: общей зависимости
// между пакетами нет. Разъехавшись, они пропустили бы в реестр игру с id,
// который на мастере уже занят роутом (/games/lookup, /games/mine, …) —
// сторожит расхождение этот тест, а не человек
describe('RESERVED_GAME_IDS', () => {
  it('совпадает со списком auth-сервиса', () => {
    expect([...RESERVED_GAME_IDS].sort()).toEqual(
      [...authConfig.games.reservedIds].sort(),
    );
  });

  it('включает id роутов реестра на мастере', () => {
    ['lookup', 'mine', 'submit', 'manifest'].forEach(id => {
      expect(RESERVED_GAME_IDS.has(id)).toBe(true);
    });
  });
});
