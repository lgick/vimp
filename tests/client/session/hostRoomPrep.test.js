import { describe, it, expect, vi } from 'vitest';
import { createHostRoomPrep } from '../../../packages/engine/src/client/session/hostRoomPrep.js';
import { makeConfig, makeFetch } from './sessionFakes.js';

// Подготовка комнаты к Worker'у хоста: игра, карты мастера, worker-бандл.

const ACTIVE = {
  id: 'tanks',
  version: '1.0.0',
  entries: { host: '/h.js', wasm: '/w.wasm' },
};

const create = (routes, gamePlugin = vi.fn()) =>
  createHostRoomPrep({
    getActiveGame: () => ACTIVE,
    config: makeConfig(),
    isDevBuild: false,
    fetchGamePluginManifest: gamePlugin,
    fetch: makeFetch(routes),
  });

const FULL = {
  '/maps/tanks/manifest.json': { version: 'm2', maps: ['a'] },
  '/maps/tanks/a': { name: 'a' },
  '/worker/manifest.json': { version: 'e5', url: '/worker-e5.js' },
};

describe('hostRoomPrep.prepareHostRoom', () => {
  it('активная игра, карты мастера и составной codeVersion', async () => {
    const room = {};
    const prepared = await create(FULL).prepareHostRoom(room);

    expect(room.game).toEqual({
      id: 'tanks',
      version: '1.0.0',
      hostEntryUrl: '/h.js',
      wasmUrl: '/w.wasm',
    });
    expect(room.maps).toEqual({ a: { name: 'a' } });
    expect(room.isDevMode).toBe(false);
    expect(prepared).toEqual({
      room,
      workerUrl: '/worker-e5.js',
      mapsVersion: 'm2',
      codeVersion: {
        engine: 'e5',
        game: { id: 'tanks', version: '1.0.0' },
      },
    });
  });

  it('мастер недоступен: карты из бандла, обновления кода выключены', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const room = {};
    const prepared = await create({}).prepareHostRoom(room);

    expect(room.maps).toBeUndefined();
    expect(prepared.workerUrl).toBeNull();
    expect(prepared.mapsVersion).toBeNull();
    expect(prepared.codeVersion).toBeNull();
  });

  it('другая версия игры из точки — версионный манифест мастера', async () => {
    const other = {
      id: 'tanks',
      version: '0.9.0',
      entries: { host: '/h9.js', wasm: '/w9.wasm' },
    };
    const gamePlugin = vi.fn(async () => other);
    const room = {};

    await create(FULL, gamePlugin).prepareHostRoom(room, {
      id: 'tanks',
      version: '0.9.0',
    });

    expect(gamePlugin).toHaveBeenCalledWith('/games/tanks/0.9.0.json');
    expect(room.game.hostEntryUrl).toBe('/h9.js');
  });

  it('та же версия, что активная, — без запроса манифеста', async () => {
    const gamePlugin = vi.fn();

    await create(FULL, gamePlugin).prepareHostRoom(
      {},
      {
        id: 'tanks',
        version: '1.0.0',
      },
    );

    expect(gamePlugin).not.toHaveBeenCalled();
  });
});

describe('hostRoomPrep: манифесты', () => {
  it('ошибка HTTP worker-манифеста — исключение', async () => {
    const prep = create({ '/worker/manifest.json': null });

    await expect(prep.fetchWorkerManifest()).rejects.toThrow('HTTP 404');
  });

  it('манифест игры — по manifestUrl', async () => {
    const gamePlugin = vi.fn(async () => ACTIVE);

    await create({}, gamePlugin).fetchGameManifest('tanks');

    expect(gamePlugin).toHaveBeenCalledWith('/games/tanks/manifest.json');
  });
});
