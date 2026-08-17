import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setBootConfig,
  getBootConfig,
  resetBootConfig,
  resolveBootConfig,
} from '../../packages/engine/src/client/boot.js';

// Режим загрузки клиента (Этап 2 плана standalone-sdk): инъекция SDK,
// ответ dedicated-сервера по /config и откат в лобби при любом сбое.

const ok = body => ({ ok: true, json: async () => body });

describe('boot', () => {
  beforeEach(() => {
    resetBootConfig();
  });

  it('отдаёт инъекцию SDK, не касаясь сети', async () => {
    const fetchImpl = vi.fn();
    const injected = { mode: 'solo', autoAuth: { name: 'Bot' } };

    setBootConfig(injected);

    expect(await resolveBootConfig(fetchImpl)).toBe(injected);
    expect(getBootConfig()).toBe(injected);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('читает dedicated-режим из /config и доклеивает wsUrl по умолчанию', async () => {
    const fetchImpl = vi.fn(async () => ok({ mode: 'dedicated', gameId: 'mini' }));
    const cfg = await resolveBootConfig(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith('/config');
    expect(cfg.mode).toBe('dedicated');
    expect(cfg.gameId).toBe('mini');
    expect(cfg.wsUrl).toBe(`ws://${location.host}/game`);
  });

  it('не затирает явный wsUrl сервера', async () => {
    const cfg = await resolveBootConfig(async () =>
      ok({ mode: 'dedicated', wsUrl: 'wss://game.example/ws' }),
    );

    expect(cfg.wsUrl).toBe('wss://game.example/ws');
  });

  it('сбой сети — это lobby-режим', async () => {
    const cfg = await resolveBootConfig(async () => {
      throw new Error('offline');
    });

    expect(cfg).toEqual({ mode: 'lobby' });
  });

  it('404 и невалидный ответ — тоже lobby-режим', async () => {
    const cfg = await resolveBootConfig(async () => ({ ok: false, status: 404 }));

    expect(cfg).toEqual({ mode: 'lobby' });

    resetBootConfig();

    const garbage = await resolveBootConfig(async () => ok({ mode: 'nonsense' }));

    expect(garbage).toEqual({ mode: 'lobby' });
  });

  it('разрешённый конфиг кэшируется в модуле', async () => {
    const fetchImpl = vi.fn(async () => ok({ mode: 'dedicated' }));

    const first = await resolveBootConfig(fetchImpl);
    const second = await resolveBootConfig(fetchImpl);

    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
