/* eslint-disable camelcase -- фейк ядра повторяет snake_case ABI ClientCore */
import { describe, it, expect } from 'vitest';
import { createLocalPlayer } from '../../../packages/engine/src/client/lib/localPlayer.js';

// Ядро отдаёт -1, пока player-блок не пришёл: сущности создаются раньше него
// (FIRST_SHOT_DATA), поэтому сервис обязан отвечать на каждый вызов заново.
const coreWith = id => ({ my_game_id: () => id });

describe('createLocalPlayer', () => {
  it('до первого player-блока свой id неизвестен', () => {
    const localPlayer = createLocalPlayer(() => null);

    expect(localPlayer.id).toBe(null);
    expect(localPlayer.is('01')).toBe(false);

    const pending = createLocalPlayer(() => coreWith(-1));

    expect(pending.id).toBe(null);
    expect(pending.is(0)).toBe(false);
  });

  it('читает id лениво: ядро появляется позже сервиса', () => {
    let core = null;
    const localPlayer = createLocalPlayer(() => core);

    expect(localPlayer.is('3')).toBe(false);

    core = coreWith(3);

    expect(localPlayer.id).toBe(3);
    expect(localPlayer.is('3')).toBe(true);
  });

  it('сравнивает id как строки — в кадре они ключи объекта', () => {
    const localPlayer = createLocalPlayer(() => coreWith(3));

    expect(localPlayer.is('3')).toBe(true);
    expect(localPlayer.is(3)).toBe(true);
    expect(localPlayer.is('4')).toBe(false);
    expect(localPlayer.is(null)).toBe(false);
    expect(localPlayer.is(undefined)).toBe(false);
  });

  it('переживает ядро без my_game_id (старая игра, фейковое ядро в тестах)', () => {
    const localPlayer = createLocalPlayer(() => ({}));

    expect(localPlayer.id).toBe(null);
    expect(localPlayer.is('01')).toBe(false);
  });
});
