import { describe, it, expect } from 'vitest';
import { applyRoomOverrides } from '../../packages/engine/src/lib/applyRoomOverrides.js';
import hostDefaults from '../../packages/engine/src/config/hostDefaults.js';

// Д4.2: пользовательские roundTime/mapTime комнаты клампятся на сервере —
// форма лобби (min/max в lobby.pug) не является границей доверия.

const { roomTimeMin, roomTimeMax } = hostDefaults.timers;

const plugin = {
  gameConfig: {
    maps: { arena: {} },
    currentMap: 'arena',
    roomDefaults: { maxPlayers: 8 },
  },
};

describe('applyRoomOverrides: клампы времён комнаты', () => {
  it('без переопределений — дефолты движка', () => {
    const game = applyRoomOverrides({}, plugin);

    expect(game.timers.roundTime).toBe(hostDefaults.timers.roundTime);
    expect(game.timers.mapTime).toBe(hostDefaults.timers.mapTime);
  });

  it('отрицательные и нулевые значения поднимаются до минимума', () => {
    const game = applyRoomOverrides({ roundTime: -5000, mapTime: 0 }, plugin);

    expect(game.timers.roundTime).toBe(roomTimeMin);
    expect(game.timers.mapTime).toBe(roomTimeMin);
  });

  it('слишком большие значения срезаются до максимума', () => {
    const game = applyRoomOverrides(
      { roundTime: Number.MAX_SAFE_INTEGER, mapTime: roomTimeMax + 1 },
      plugin,
    );

    expect(game.timers.roundTime).toBe(roomTimeMax);
    expect(game.timers.mapTime).toBe(roomTimeMax);
  });

  it('дробные значения округляются вниз', () => {
    const game = applyRoomOverrides({ roundTime: 60000.9 }, plugin);

    expect(game.timers.roundTime).toBe(60000);
  });

  it('нечисловые значения игнорируются', () => {
    const game = applyRoomOverrides(
      { roundTime: NaN, mapTime: Infinity },
      plugin,
    );

    expect(game.timers.roundTime).toBe(hostDefaults.timers.roundTime);
    expect(game.timers.mapTime).toBe(hostDefaults.timers.mapTime);
  });
});
