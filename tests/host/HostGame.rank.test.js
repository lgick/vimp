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
    isRankLoaded: vi.fn(() => true),
  };
  host._roundManager = {
    reportKill: vi.fn(),
    checkTeamWipe: vi.fn(),
    overrideMapData: vi.fn(),
    initiateNewRound: vi.fn(),
    forceChangeMap: vi.fn(),
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

describe('HostGame.isPlayerRankLoaded', () => {
  it('прокидывает gameId в playerDataSync.isRankLoaded', () => {
    const host = makeFacade();

    expect(host.isPlayerRankLoaded('42')).toBe(true);
    expect(host._playerDataSync.isRankLoaded).toHaveBeenCalledWith('42');
  });

  // ради чего метод и заведён: getPlayerRank отвечает нулём и до ответа
  // мастера, а игра пишет ранг в stat колонкой '=' — ей нужно молчать,
  // пока ранга нет
  it('отвечает ложью, пока ранг не приехал', () => {
    const host = makeFacade();

    host._playerDataSync.isRankLoaded = vi.fn(() => false);

    expect(host.isPlayerRankLoaded('42')).toBe(false);
    expect(host.getPlayerRank('42')).toBe(7);
  });
});

// Тот же класс прокладок: игра пересобрала карту сама и говорит об этом
// движку, не начиная раунд и не меняя карту комнаты
describe('HostGame.overrideMapData', () => {
  it('прокидывает карту в RoundManager.overrideMapData', () => {
    const host = makeFacade();
    const mapData = { respawns: { players: [[1, 2, 3]] } };

    host.overrideMapData(mapData);

    expect(host._roundManager.overrideMapData).toHaveBeenCalledWith(mapData);
  });

  it('не начинает раунд и не меняет карту комнаты', () => {
    const host = makeFacade();

    host.overrideMapData({});

    expect(host._roundManager.initiateNewRound).not.toHaveBeenCalled();
    expect(host._roundManager.forceChangeMap).not.toHaveBeenCalled();
  });
});
