import { describe, it, expect, beforeEach, vi } from 'vitest';
import hostPlugin from '../../src/host/index.js';
import ScriptedManager from '../../src/host/ScriptedManager.js';
import spawnCommand from '../../src/host/spawnCommand.js';
import mapData from '../../src/data/maps/arena.js';

// The engine dereferences the fields below without a guard and calls the five
// scripted methods by name — both are contracts no browser run announces
// before it crashes.
describe('HostPlugin surface', () => {
  it('exports every field the engine reads', () => {
    expect(typeof hostPlugin.id).toBe('string');
    expect(typeof hostPlugin.engineApi).toBe('number');
    expect(typeof hostPlugin.createCore).toBe('function');
    expect(typeof hostPlugin.gameConfig).toBe('object');
    expect(typeof hostPlugin.authSchema).toBe('object');
    expect(typeof hostPlugin.createModules).toBe('function');
    expect(typeof hostPlugin.buildClientGameConfig).toBe('function');
    expect(Array.isArray(hostPlugin.chatCommands)).toBe(true);
  });

  it('does not shadow an engine chat command', () => {
    const reserved = ['/name', '/nr', '/timeleft', '/mapname', '/rank'];

    for (const command of hostPlugin.chatCommands) {
      expect(command.name.startsWith('/')).toBe(true);
      expect(reserved).not.toContain(command.name);
    }
  });

  it('keeps its system message codes out of the engine groups', () => {
    // engine groups and their last index
    const reserved = { s: 6, v: 5, m: 1, c: 1, n: 1 };

    for (const code of Object.values(hostPlugin.systemMessages)) {
      const [group, index] = code.split(':');

      expect(Number(index) > (reserved[group] ?? -1)).toBe(true);
    }
  });
});

// Minimal doubles of the engine modules: the manager only ever talks to these
// five, and a real one would drag the whole host runtime into a unit test.
function createContext({ teamSizes = { team1: 0, team2: 0 }, isFull = false }) {
  const created = [];
  const sizes = { ...teamSizes };
  let nextId = 10;

  const participants = {
    isFull,
    getPlayableTeams: () => Object.keys(sizes),
    getTeamSize: team => sizes[team] ?? 0,
    createScripted: ({ team, model }) => {
      const gameId = (nextId += 1);

      created.push({ gameId, team, model, isScripted: true, teamId: 1 });
      sizes[team] += 1;

      return gameId;
    },
    get: gameId => created.find(item => item.gameId === gameId),
    getScripted: () => created,
    remove: gameId => {
      const index = created.findIndex(item => item.gameId === gameId);

      if (index !== -1) {
        sizes[created[index].team] -= 1;
        created.splice(index, 1);
      }
    },
  };

  return {
    participants,
    coreAdapter: { removePlayer: vi.fn() },
    panel: { addUser: vi.fn(), removeUser: vi.fn() },
    stat: { addUser: vi.fn(), removeUser: vi.fn() },
    scripted: hostPlugin.gameConfig.scripted,
  };
}

describe('ScriptedManager', () => {
  let ctx;
  let manager;

  beforeEach(() => {
    ctx = createContext({});
    manager = new ScriptedManager(ctx);
    manager.createMap(mapData);
  });

  it('creates nothing before a map is known', () => {
    const fresh = new ScriptedManager(createContext({}));

    expect(fresh.createScripted(2)).toBe(0);
  });

  it('spreads bots over the emptiest team', () => {
    expect(manager.createScripted(4)).toBe(4);
    expect(manager.getCountsPerTeam()).toEqual({ team1: 2, team2: 2 });
  });

  it('stops at the respawn capacity of a team', () => {
    const capacity = mapData.respawns.team1.length;

    expect(manager.createScripted(capacity + 3, 'team1')).toBe(capacity);
  });

  it('creates nothing once the room is full', () => {
    const full = new ScriptedManager(createContext({ isFull: true }));

    full.createMap(mapData);

    expect(full.createScripted(3)).toBe(0);
  });

  it('frees exactly one slot for a human', () => {
    manager.createScripted(2, 'team1');

    expect(manager.removeOneForHuman('team1')).toBe(true);
    expect(manager.getCountsPerTeam()).toEqual({ team1: 1 });
    expect(manager.removeOneForHuman('team2')).toBe(false);
  });

  it('removes bots of one team or of all of them', () => {
    manager.createScripted(2, 'team1');
    manager.createScripted(1, 'team2');

    manager.removeScripted('team1');
    expect(manager.getCountsPerTeam()).toEqual({ team2: 1 });

    manager.removeScripted();
    expect(manager.getCountsPerTeam()).toEqual({});
  });
});

describe('/spawn', () => {
  it('reports the number actually created and restarts the round', () => {
    const chat = { pushSystem: vi.fn() };
    const roundManager = { initiateNewRound: vi.fn() };
    const scripted = { createScripted: vi.fn(() => 2) };

    spawnCommand.handler({ chat, roundManager, scripted }, 1, ['3']);

    expect(scripted.createScripted).toHaveBeenCalledWith(3);
    expect(chat.pushSystem).toHaveBeenCalledWith('BOTS_SPAWNED', [2]);
    expect(roundManager.initiateNewRound).toHaveBeenCalled();
  });

  it('defaults to a single bot', () => {
    const scripted = { createScripted: vi.fn(() => 1) };

    spawnCommand.handler(
      {
        chat: { pushSystem: vi.fn() },
        roundManager: { initiateNewRound: vi.fn() },
        scripted,
      },
      1,
      [],
    );

    expect(scripted.createScripted).toHaveBeenCalledWith(1);
  });
});
