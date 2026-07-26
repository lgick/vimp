import { describe, it, expect, vi } from 'vitest';
import CommandProcessor from '../../packages/engine/src/host/meta/core/CommandProcessor.js';

// Движковое ядро чат-команд: /name, /nr, /timeleft, /mapname, /rank +
// регистрация игровых команд (registerCommand). Игровая /bot —
// botCommand.test.js.

const makeCp = (overrides = {}) =>
  new CommandProcessor({
    chat: overrides.chat || {
      pushSystem: vi.fn(),
      pushSystemByUser: vi.fn(),
    },
    roundManager: overrides.roundManager || {
      changeName: vi.fn(),
      initiateNewRound: vi.fn(),
      currentMap: 'm1',
    },
    timerManager: overrides.timerManager || { getMapTimeLeft: vi.fn(() => 0) },
    playerDataSync: overrides.playerDataSync || {
      getRank: vi.fn(() => 0),
    },
    isDevMode: overrides.isDevMode ?? false,
  });

describe('CommandProcessor.parseCommand: движковые команды', () => {
  it('/name делегирует смену ника RoundManager', () => {
    const cp = makeCp();
    cp.parseCommand('u', '/name NewName');
    expect(cp._roundManager.changeName).toHaveBeenCalledWith('u', 'NewName');
  });

  it('/nr в dev-режиме перезапускает раунд', () => {
    const cp = makeCp({ isDevMode: true });
    cp.parseCommand('u', '/nr');
    expect(cp._roundManager.initiateNewRound).toHaveBeenCalled();
  });

  it('/nr вне dev-режима не найдено', () => {
    const cp = makeCp({ isDevMode: false });
    cp.parseCommand('u', '/nr');
    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'COMMANDS_NOT_FOUND',
    );
    expect(cp._roundManager.initiateNewRound).not.toHaveBeenCalled();
  });

  it('/mapname отдаёт текущую карту', () => {
    const cp = makeCp();
    cp.parseCommand('u', '/mapname');
    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith('u', ['m1']);
  });

  it('/timeleft форматирует оставшееся время', () => {
    const cp = makeCp({ timerManager: { getMapTimeLeft: () => 65000 } });
    cp.parseCommand('u', '/timeleft');
    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith('u', ['01:05']);
  });

  it('/rank отдаёт ранг игрока из PlayerDataSync', () => {
    const playerDataSync = { getRank: vi.fn(() => 5) };
    const cp = makeCp({ playerDataSync });

    cp.parseCommand('u', '/rank');

    expect(playerDataSync.getRank).toHaveBeenCalledWith('u');
    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith('u', 'RANK', [5]);
  });

  it('неизвестная команда → COMMANDS_NOT_FOUND', () => {
    const cp = makeCp();
    cp.parseCommand('u', '/whatever');
    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'COMMANDS_NOT_FOUND',
    );
  });
});

describe('CommandProcessor.registerCommand: игровые команды', () => {
  it('зарегистрированная команда получает (ctx, gameId, args)', () => {
    const cp = makeCp();
    const handler = vi.fn();

    cp.registerCommand('/custom', handler);
    cp.parseCommand('u', '/custom 3 team1');

    expect(handler).toHaveBeenCalledWith(cp._ctx, 'u', ['3', 'team1']);
    expect(cp._chat.pushSystemByUser).not.toHaveBeenCalled();
  });

  it('ctx — deps конструктора (доступ к мете движка)', () => {
    const cp = makeCp();
    const handler = vi.fn();

    cp.registerCommand('/custom', handler);
    cp.parseCommand('u', '/custom');

    const [ctx] = handler.mock.calls[0];

    expect(ctx.chat).toBe(cp._chat);
    expect(ctx.roundManager).toBe(cp._roundManager);
  });

  it('движковая команда не перекрывается зарегистрированной', () => {
    const cp = makeCp();
    const handler = vi.fn();

    cp.registerCommand('/mapname', handler);
    cp.parseCommand('u', '/mapname');

    expect(handler).not.toHaveBeenCalled();
    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith('u', ['m1']);
  });
});
