import { describe, it, expect, vi } from 'vitest';
import CommandProcessor from '../../packages/engine/src/host/meta/core/CommandProcessor.js';

// Своих команд у движка нет: реестр наполняет игра через
// HostPlugin.chatCommands. Здесь проверяется только сам реестр — разбор
// строки, передача контекста и ответ на незнакомое имя.

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

describe('CommandProcessor.registerCommand: игровые команды', () => {
  it('зарегистрированная команда получает (ctx, gameId, args)', () => {
    const cp = makeCp();
    const handler = vi.fn();

    cp.registerCommand('/custom', handler);
    cp.parseCommand('u', '/custom 3 team1');

    expect(handler).toHaveBeenCalledWith(cp._ctx, 'u', ['3', 'team1']);
    expect(cp._chat.pushSystemByUser).not.toHaveBeenCalled();
  });

  it('лишние пробелы схлопываются перед разбором', () => {
    const cp = makeCp();
    const handler = vi.fn();

    cp.registerCommand('/custom', handler);
    cp.parseCommand('u', '/custom   3    team1');

    expect(handler).toHaveBeenCalledWith(cp._ctx, 'u', ['3', 'team1']);
  });

  it('ctx — deps конструктора: игре доступна вся мета движка', () => {
    const cp = makeCp();
    const handler = vi.fn();

    cp.registerCommand('/custom', handler);
    cp.parseCommand('u', '/custom');

    const [ctx] = handler.mock.calls[0];

    expect(ctx.chat).toBe(cp._chat);
    expect(typeof ctx.roundManager.changeName).toBe('function');
    expect(typeof ctx.timerManager.getMapTimeLeft).toBe('function');
    expect(typeof ctx.playerDataSync.getRank).toBe('function');
    expect(ctx.isDevMode).toBe(false);
  });

  it('бывшие движковые имена свободны для игры', () => {
    // /name, /nr, /timeleft, /mapname, /rank больше не разбираются движком:
    // одна и та же команда в разных играх делает разное или отсутствует
    const cp = makeCp();
    const handler = vi.fn();

    cp.registerCommand('/mapname', handler);
    cp.parseCommand('u', '/mapname');

    expect(handler).toHaveBeenCalledWith(cp._ctx, 'u', []);
    expect(cp._chat.pushSystemByUser).not.toHaveBeenCalled();
  });

  it('незарегистрированная команда → COMMANDS_NOT_FOUND', () => {
    const cp = makeCp();

    cp.parseCommand('u', '/timeleft');

    expect(cp._chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'COMMANDS_NOT_FOUND',
    );
  });

  it('повторная регистрация имени заменяет обработчик', () => {
    const cp = makeCp();
    const first = vi.fn();
    const second = vi.fn();

    cp.registerCommand('/custom', first);
    cp.registerCommand('/custom', second);
    cp.parseCommand('u', '/custom');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });
});
