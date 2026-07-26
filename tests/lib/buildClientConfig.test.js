import { describe, it, expect } from 'vitest';
import { buildClientConfig } from '../../packages/engine/src/lib/buildClientConfig.js';

// минимальные конфиги: движковые дефолты + игровая половина + game-конфиг
const makeDefaults = () => ({
  interpolation: { delay: 100 },
  modules: {
    chat: { elems: { cmd: 'cmd' }, params: { listLimit: 5 } },
    vote: { elems: { voteId: 'vote' } },
  },
  techInformList: ['Loading...'],
});

const makeGameClient = () => ({
  parts: { gameSets: { m1: ['Tank'] } },
  initIdList: ['vimp'],
  modules: {
    chat: { params: { messages: { b: ['bots'] } } },
    vote: { params: { templates: { teamChange: ['Choose a team'] } } },
  },
});

const makeGame = () => ({
  timers: { voteTime: 10000, timeStep: 1000 / 120 },
  playerKeys: { fire: { key: 1 } },
  parts: { models: { m1: {} }, weapons: { w1: {} } },
  snapshot: { a1: { id: 1, kind: 'indexed8', class: 'hot', fields: [] } },
});

describe('buildClientConfig', () => {
  it('deep-merge: движковые и игровые ветки одного модуля сливаются', () => {
    const config = buildClientConfig(makeGame(), makeDefaults(), makeGameClient());

    // движковая ветка chat сохранена, игровая добавлена
    expect(config.modules.chat.elems.cmd).toBe('cmd');
    expect(config.modules.chat.params.listLimit).toBe(5);
    expect(config.modules.chat.params.messages.b).toEqual(['bots']);

    // непересекающиеся ветки обеих половин на месте
    expect(config.interpolation.delay).toBe(100);
    expect(config.techInformList).toEqual(['Loading...']);
    expect(config.parts.gameSets.m1).toEqual(['Tank']);
    expect(config.initIdList).toEqual(['vimp']);
  });

  it('дописывает время голосования и prediction из game-конфига', () => {
    const game = makeGame();
    const config = buildClientConfig(game, makeDefaults(), makeGameClient());

    expect(config.modules.vote.params.time).toBe(10000);
    expect(config.modules.vote.params.templates.teamChange).toEqual([
      'Choose a team',
    ]);
    expect(config.prediction).toEqual({
      timeStep: game.timers.timeStep,
      playerKeys: game.playerKeys,
      models: game.parts.models,
      weapons: game.parts.weapons,
    });
    // снапшот-схема игры едет клиенту в CONFIG_DATA (Д1)
    expect(config.snapshot).toBe(game.snapshot);
  });

  it('не мутирует переданные конфиги', () => {
    const defaults = makeDefaults();
    const gameClient = makeGameClient();

    buildClientConfig(makeGame(), defaults, gameClient);

    expect(defaults.modules.vote.params).toBeUndefined();
    expect(defaults.modules.chat.params.messages).toBeUndefined();
    expect(gameClient.modules.vote.params.time).toBeUndefined();
  });
});
