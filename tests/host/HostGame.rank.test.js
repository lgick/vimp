import { describe, it, expect, vi } from 'vitest';
import HostGame from '../../packages/engine/src/host/HostGame.js';

// Фасад rank/state — тонкие прокладки к PlayerDataSync. Конструктор HostGame
// поднимает всю мету, поэтому здесь берётся голый прототип с подставленными
// сервисами: проверяется ровно маршрутизация вызова.
const makeFacade = () => {
  const host = Object.create(HostGame.prototype);

  host._playerDataSync = {
    addRank: vi.fn(),
    getRank: vi.fn(() => 7),
  };
  host._roundManager = {
    reportKill: vi.fn(),
    checkTeamWipe: vi.fn(),
  };

  return host;
};

describe('HostGame.addPlayerRank', () => {
  it('прокидывает gameId и дельту в playerDataSync.addRank', () => {
    const host = makeFacade();

    host.addPlayerRank('42', 1);

    expect(host._playerDataSync.addRank).toHaveBeenCalledTimes(1);
    expect(host._playerDataSync.addRank).toHaveBeenCalledWith('42', 1);
  });

  it('принимает отрицательную дельту без изменений', () => {
    const host = makeFacade();

    host.addPlayerRank('42', -2);

    expect(host._playerDataSync.addRank).toHaveBeenCalledWith('42', -2);
  });

  it('не трогает RoundManager (мимо reportKill и team-wipe)', () => {
    const host = makeFacade();

    host.addPlayerRank('42', 1);

    expect(host._roundManager.reportKill).not.toHaveBeenCalled();
    expect(host._roundManager.checkTeamWipe).not.toHaveBeenCalled();
  });
});
