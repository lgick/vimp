import { describe, it, expect } from 'vitest';
import { builtinScenario } from '../../packages/engine/src/devtools/builtinScenario.js';
import {
  loadGameForSim,
  FIXTURE_SOURCE,
} from '../../packages/engine/src/devtools/pluginLoader.js';

// Встроенный сценарий — единственный, который автор плагина получает
// бесплатно, и потому единственный, который обязан подстраиваться под чужую
// игру: фикстурные 'm1'/'team1'/'forward' на ней означают либо падение в
// ядре, либо красный вердикт исправному плагину.

const plugin = (gameConfig, source = '/tmp/other/dist/manifest.json') => ({
  id: 'other',
  source,
  hostPlugin: { gameConfig },
});

const otherGame = {
  parts: { models: { hover: {}, walker: {} } },
  playerKeys: { thrust: { key: 1 }, brake: { key: 2 } },
  teams: { blue: 1, red: 2, watchers: 3 },
  spectatorTeam: 'watchers',
};

describe('builtinScenario', () => {
  it('берёт модель, играющую команду и клавишу из gameConfig игры', () => {
    const scenario = builtinScenario(plugin(otherGame));

    expect(scenario.participants[0].model).toBe('hover');
    expect(scenario.timeline[0]).toMatchObject({ op: 'join', team: 'blue' });
    expect(scenario.timeline.filter(op => op.op === 'key')).toEqual([
      { tick: 40, op: 'key', who: 'p1', action: 'down', name: 'thrust' },
      { tick: 100, op: 'key', who: 'p1', action: 'up', name: 'thrust' },
    ]);
  });

  it('на чужой игре не судит ни покрытие ключей, ни дрейф', () => {
    const scenario = builtinScenario(plugin(otherGame));

    expect(scenario.unusedSnapshotKeys).toBe('*');
    expect(scenario.divergence).toBeNull();
  });

  // type: 1 — триггер, у которого 'up' игнорируется: смоук «нажал —
  // отпустил» на нём не даёт ни удержания, ни движения
  it('берёт удерживаемую клавишу, а не первый попавшийся триггер', () => {
    const triggerFirst = {
      ...otherGame,
      playerKeys: { fire: { key: 1, type: 1 }, thrust: { key: 2 } },
    };

    expect(builtinScenario(plugin(triggerFirst)).timeline[1].name).toBe(
      'thrust',
    );
  });

  it('если игра объявила одни триггеры — берёт первый, прогон не блокируется', () => {
    const triggersOnly = {
      ...otherGame,
      playerKeys: { fire: { key: 1, type: 1 }, swap: { key: 2, type: 1 } },
    };

    expect(builtinScenario(plugin(triggersOnly)).timeline[1].name).toBe('fire');
  });

  it('команда зрителей в качестве играющей не берётся', () => {
    const spectatorsFirst = {
      ...otherGame,
      teams: { watchers: 1, blue: 2 },
    };

    expect(builtinScenario(plugin(spectatorsFirst)).timeline[0].team).toBe(
      'blue',
    );
  });

  it('игре без модели или клавиши отвечает разбираемой ошибкой', () => {
    const empty = { ...otherGame, parts: { models: {} } };

    expect(() => builtinScenario(plugin(empty))).toThrow(
      /has nothing to drive/,
    );
    expect(() => builtinScenario(plugin(empty))).toThrow(/--scenario/);
  });

  it('на фикстуре — прежний аудит: свои ключи и живой детектор дрейфа', () => {
    const scenario = builtinScenario(plugin(otherGame, FIXTURE_SOURCE));

    expect(scenario.unusedSnapshotKeys).toEqual(['e1']);
    expect(scenario.divergence).toBeUndefined();
  });

  it('на настоящей фикстуре собирается её же идентификаторами', async () => {
    const scenario = builtinScenario(await loadGameForSim({}));

    expect(scenario.participants[0].model).toBe('m1');
    expect(scenario.timeline[0].team).toBe('team1');
    expect(scenario.timeline[1].name).toBe('forward');
  });
});
