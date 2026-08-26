import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchGamesManifest,
  fetchGameManifest,
  assertEngineApiCompatible,
  assertGameConfigShape,
  loadClientPlugin,
} from '../../packages/engine/src/lib/gamePlugin.js';
import { ENGINE_API_VERSION } from '../../packages/engine/src/config/opcodes.js';

// Динамическая загрузка игры по GameManifest мастера (Этап 6.3)

describe('gamePlugin: fetchGamesManifest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('возвращает распарсенный JSON при успешном ответе', async () => {
    const manifests = [{ id: 'tanks' }];

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => manifests }),
    );

    await expect(fetchGamesManifest('/games/manifest.json')).resolves.toBe(
      manifests,
    );
    expect(fetch).toHaveBeenCalledWith('/games/manifest.json');
  });

  it('бросает при неуспешном HTTP-ответе', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    await expect(fetchGamesManifest()).rejects.toThrow(/HTTP 500/);
  });
});

describe('gamePlugin: fetchGameManifest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('возвращает распарсенный JSON-объект (не массив) при успешном ответе', async () => {
    const manifest = { id: 'tanks' };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => manifest }),
    );

    await expect(
      fetchGameManifest('/games/tanks/manifest.json'),
    ).resolves.toBe(manifest);
    expect(fetch).toHaveBeenCalledWith('/games/tanks/manifest.json');
  });

  it('бросает при неуспешном HTTP-ответе', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );

    await expect(
      fetchGameManifest('/games/tanks/manifest.json'),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe('gamePlugin: assertGameConfigShape', () => {
  const validGameConfig = {
    roomDefaults: { maxPlayers: 8 },
    snapshot: {},
    parts: { models: {}, weapons: {}, friendlyFire: false },
    panel: { fields: {} },
    playerKeys: {},
    teams: { team1: 1, spectators: 2 },
    spectatorTeam: 'spectators',
  };

  it('пропускает gameConfig со всеми обязательными полями', () => {
    expect(() =>
      assertGameConfigShape({ id: 'tanks', gameConfig: validGameConfig }),
    ).not.toThrow();
  });

  it('бросает при отсутствии обязательного поля', () => {
    const { roomDefaults, ...rest } = validGameConfig;

    expect(() =>
      assertGameConfigShape({ id: 'tanks', gameConfig: rest }),
    ).toThrow(/roomDefaults\.maxPlayers/);
  });

  // HostGame разыменовывает их безусловно (this._teams[spectatorTeam]):
  // отсутствие обязано называться контрактом, а не тремя TypeError подряд
  it('требует teams и spectatorTeam', () => {
    const { teams, spectatorTeam, ...rest } = validGameConfig;

    expect(() =>
      assertGameConfigShape({ id: 'tanks', gameConfig: rest }),
    ).toThrow(/teams, spectatorTeam/);
  });

  // null — не «поле есть»: движок разыменовывает эти поля сразу, и до
  // правки гейт молча пропускал такой конфиг (а на teams падал сам)
  it('считает null отсутствующим полем, а не значением', () => {
    for (const field of ['teams', 'snapshot', 'playerKeys']) {
      expect(() =>
        assertGameConfigShape({
          id: 'tanks',
          gameConfig: { ...validGameConfig, [field]: null },
        }),
      ).toThrow(new RegExp(`missing required field\\(s\\): ${field}`));
    }
  });

  // присутствия мало: при опечатке участник заходит в несуществующую
  // команду и падает уже в ParticipantManager, без упоминания причины
  it('требует, чтобы spectatorTeam был ключом teams', () => {
    const typo = { ...validGameConfig, spectatorTeam: 'spectator' };

    expect(() =>
      assertGameConfigShape({ id: 'tanks', gameConfig: typo }),
    ).toThrow(/'spectator' is not a key of teams \(team1, spectators\)/);
  });

  // noSpectators (opt-in): наблюдателей нет как концепции — ключа
  // spectatorTeam в конфиге тоже нет, и требовать его нечего
  it('под noSpectators не требует spectatorTeam', () => {
    const { spectatorTeam, ...rest } = validGameConfig;

    expect(() =>
      assertGameConfigShape({
        id: 'snakes',
        gameConfig: { ...rest, teams: { players: 1 }, noSpectators: true },
      }),
    ).not.toThrow();
  });

  // вход без наблюдателей ведёт в единственную команду: вторая означала бы
  // «куда-нибудь», а ParticipantManager выбирает её однозначно
  it('под noSpectators требует ровно одну команду', () => {
    const { spectatorTeam, ...rest } = validGameConfig;

    expect(() =>
      assertGameConfigShape({
        id: 'snakes',
        gameConfig: { ...rest, teams: { red: 1, blue: 2 }, noSpectators: true },
      }),
    ).toThrow(/noSpectators requires exactly one team, got 2 \(red, blue\)/);
  });
});

describe('gamePlugin: assertEngineApiCompatible', () => {
  it('пропускает манифест с совпадающей версией engineApi', () => {
    expect(() =>
      assertEngineApiCompatible({ id: 'tanks', engineApi: ENGINE_API_VERSION }),
    ).not.toThrow();
  });

  it('бросает при несовпадении engineApi', () => {
    expect(() =>
      assertEngineApiCompatible({ id: 'tanks', engineApi: ENGINE_API_VERSION + 1 }),
    ).toThrow(/tanks/);
  });
});

describe('gamePlugin: loadClientPlugin', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('отказывается грузить плагин с несовместимым engineApi (import не вызывается)', async () => {
    await expect(
      loadClientPlugin({
        id: 'tanks',
        engineApi: ENGINE_API_VERSION + 1,
        entries: { client: '/unreachable.js' },
      }),
    ).rejects.toThrow(/engine API/);
  });
});
