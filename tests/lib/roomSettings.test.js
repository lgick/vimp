import { describe, it, expect } from 'vitest';
import {
  sanitizeRoomSettings,
  ROOM_SETTINGS_MAX_BYTES,
} from '../../packages/engine/src/lib/roomSettings.js';

describe('sanitizeRoomSettings', () => {
  it('известные ключи остаются, остальное отбрасывается', () => {
    expect(
      sanitizeRoomSettings({
        hostSocketId: 'local',
        game: { id: 'tanks' },
        maxPlayers: 6,
        map: 'dust',
        roundTime: 120000,
        mapTime: 600000,
        friendlyFire: false,
        isDevMode: true,
      }),
    ).toEqual({
      maxPlayers: 6,
      map: 'dust',
      roundTime: 120000,
      mapTime: 600000,
      friendlyFire: false,
    });
  });

  it('числа клампятся и обрезаются до целых, строки — по длине', () => {
    expect(
      sanitizeRoomSettings({
        maxPlayers: 1000.7,
        roundTime: -5,
        mapTime: Infinity,
        map: 'x'.repeat(100),
      }),
    ).toEqual({ maxPlayers: 64, roundTime: 0, map: 'x'.repeat(64) });
  });

  it('неверные типы — ключа нет', () => {
    expect(
      sanitizeRoomSettings({
        maxPlayers: '8',
        map: '',
        friendlyFire: 'true',
      }),
    ).toEqual({});
  });

  it('не объект — пустые настройки', () => {
    expect(sanitizeRoomSettings(null)).toEqual({});
    expect(sanitizeRoomSettings('x')).toEqual({});
    expect(ROOM_SETTINGS_MAX_BYTES).toBe(4096);
  });
});
