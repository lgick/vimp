import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  KNOWN_GAME_CONFIG_PATHS,
  REQUIRED_GAME_CONFIG_PATHS,
  createGameConfigView,
} from '../../packages/engine/src/lib/gameConfigView.js';
import hostDefaults from '../../packages/engine/src/config/hostDefaults.js';

// Единственная точка чтения gameConfig (этап 2 плана plugin-forward-compat).
// Смысл модуля — И2: игра, не знающая о поле, обязана грузиться. Тесты ниже
// фиксируют именно это, а не форму объекта.

const minimal = {
  parts: { models: { m1: {} } },
  playerKeys: { forward: { key: 1 } },
  snapshot: { a1: { id: 1 } },
  teams: { team1: 1, spectators: 2 },
};

describe('gameConfigView: обязательные поля', () => {
  it('минимального конфига достаточно — остальное умолчания', () => {
    expect(() => createGameConfigView(minimal, 'mini')).not.toThrow();
  });

  it('список обязательных — ровно четыре пути', () => {
    expect(REQUIRED_GAME_CONFIG_PATHS).toEqual([
      'parts.models',
      'playerKeys',
      'snapshot',
      'teams',
    ]);
  });

  it('бросает с именем игры и всеми недостающими полями сразу', () => {
    expect(() => createGameConfigView({ teams: { t: 1 } }, 'mini')).toThrow(
      /game "mini": gameConfig is missing required field\(s\): parts\.models, playerKeys, snapshot/,
    );
  });

  // null — не «поле есть»: движок разыменовывает его сразу
  it('считает null отсутствующим обязательным полем', () => {
    for (const field of ['teams', 'snapshot', 'playerKeys']) {
      expect(() =>
        createGameConfigView({ ...minimal, [field]: null }, 'mini'),
      ).toThrow(new RegExp(`missing required field\\(s\\): ${field}`));
    }
  });
});

describe('gameConfigView: умолчания (И2)', () => {
  it('поля, снятые с обязательных, получают безопасные значения', () => {
    const view = createGameConfigView(minimal, 'mini');

    expect(view.roomDefaults.maxPlayers).toBe(hostDefaults.maxPlayers);
    expect(view.parts.weapons).toEqual({});
    expect(view.parts.friendlyFire).toBe(false);
    expect(view.panel).toEqual({ fields: {}, activeKey: null });
    expect(view.spectatorTeam).toBe('spectators');
  });

  it('объявленное игрой не перетирается умолчанием', () => {
    const view = createGameConfigView(
      {
        ...minimal,
        roomDefaults: { maxPlayers: 4 },
        parts: { ...minimal.parts, weapons: { w1: {} }, friendlyFire: true },
        panel: { fields: { energy: { key: 'h', value: 100 } } },
        statMode: 'leaderboard',
      },
      'mini',
    );

    expect(view.roomDefaults.maxPlayers).toBe(4);
    expect(view.parts.weapons).toEqual({ w1: {} });
    expect(view.parts.friendlyFire).toBe(true);
    expect(view.panel.fields.energy.key).toBe('h');
    // соседнее поле того же блока всё равно доопределяется
    expect(view.panel.activeKey).toBe(null);
    expect(view.statMode).toBe('leaderboard');
  });

  // конфиг принадлежит плагину и переживает перезапуск матча: дописывать
  // в него умолчания значит менять игру под собой
  it('не мутирует переданный gameConfig', () => {
    const source = structuredClone(minimal);

    createGameConfigView(source, 'mini');

    expect(source).toEqual(minimal);
  });

  it('поля игры сверх контракта копируются как есть', () => {
    const view = createGameConfigView({ ...minimal, ownField: 42 }, 'mini');

    expect(view.ownField).toBe(42);
  });

  it('каждый известный путь перечислен в слепке поверхности', () => {
    for (const path of REQUIRED_GAME_CONFIG_PATHS) {
      expect(KNOWN_GAME_CONFIG_PATHS.includes(path)).toBe(false);
    }

    expect(KNOWN_GAME_CONFIG_PATHS).toContain('spectatorTeam');
  });
});

describe('gameConfigView: spectatorTeam', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('выводится из команды с именем spectators', () => {
    expect(createGameConfigView(minimal, 'mini').spectatorTeam).toBe(
      'spectators',
    );
  });

  it('под noSpectators равен null и не требует ключа', () => {
    const view = createGameConfigView(
      { ...minimal, teams: { players: 1 }, noSpectators: true },
      'snakes',
    );

    expect(view.spectatorTeam).toBe(null);
  });

  // null рабочий (вход в первую команду), но почти наверняка не то, чего
  // хотела игра — молчать здесь значит прятать опечатку
  it('предупреждает, если вывести не из чего', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = createGameConfigView(
      { ...minimal, teams: { red: 1, blue: 2 } },
      'mini',
    );

    expect(view.spectatorTeam).toBe(null);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('gameConfig.spectatorTeam is not set'),
    );
  });
});

describe('gameConfigView: согласованность объявленного', () => {
  // присутствия мало: при опечатке участник заходит в несуществующую
  // команду и падает уже в ParticipantManager, без упоминания причины
  it('требует, чтобы объявленный spectatorTeam был ключом teams', () => {
    expect(() =>
      createGameConfigView({ ...minimal, spectatorTeam: 'spectator' }, 'tanks'),
    ).toThrow(/'spectator' is not a key of teams \(team1, spectators\)/);
  });

  // вход без наблюдателей ведёт в единственную команду: вторая означала бы
  // «куда-нибудь», а ParticipantManager выбирает её однозначно
  it('под noSpectators требует ровно одну команду', () => {
    expect(() =>
      createGameConfigView(
        { ...minimal, teams: { red: 1, blue: 2 }, noSpectators: true },
        'snakes',
      ),
    ).toThrow(/noSpectators requires exactly one team, got 2 \(red, blue\)/);
  });
});
