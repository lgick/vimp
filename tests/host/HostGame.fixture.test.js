import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createFixtureHost,
  connectPlayer,
  joinTeam,
  tick,
  pressKey,
  sendAim,
} from './fixtureHarness.js';

// Движковые тесты HostGame поверх фикстурной миниигры (Этап 7 плана
// отделения движка): доказывают, что HostGame и мета движка работают без
// единого импорта из @vimp-games/tanks и без собранного Rust-ядра — только
// HostPlugin с fake-core (JS-объект, реализующий Wasm Host ABI). Схема
// фикстуры нарочно отличается от танков: одна играющая команда (team1),
// одна колонка статистики сверх имени, один флаг панели. Интеграционные
// тесты на реальном ядре — tests/host/HostGame.test.js (integration).
describe('HostGame (фикстура — без Rust-артефактов игры)', () => {
  let host;
  let socket;
  let core;

  beforeEach(async () => {
    ({ host, socket, core } = await createFixtureHost());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('конструктор грузит карту фикстуры в fake-core', () => {
    expect(core.map_info()).not.toBe('null');
    expect(JSON.parse(core.map_info()).setId).toBe('m1');
  });

  it('игрок онбордится спектатором и получает первый кадр', async () => {
    const gameId = await connectPlayer(host);

    expect(gameId).toBeDefined();
    expect(socket.framesOf('sendFirstShot')).toHaveLength(1);
    expect(socket.framesOf('sendTechInform').length).toBeGreaterThan(0);
  });

  it('вход в единственную играющую команду создаёт актёра в fake-core', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    joinTeam(host, gameId, 'team1');
    tick(host, 1);

    expect(core.is_alive(gameId)).toBe(true);
  });

  it('движение вперёд смещает актёра в fake-core', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    joinTeam(host, gameId, 'team1');
    tick(host, 1);

    const before = core.position_of(gameId);

    pressKey(host, gameId, 'forward');
    tick(host, 30);

    const after = core.position_of(gameId);

    expect(after[1]).not.toBe(before[1]);
  });

  it('ввод указателем доходит до ядра мировой точкой и битами', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    joinTeam(host, gameId, 'team1');
    tick(host, 1);

    sendAim(host, gameId, 12.5, -3.25, 3);

    expect(core.aim_of(gameId)).toEqual({ x: 12.5, y: -3.25, flags: 3 });
  });

  it('наблюдателю указатель ядром не применяется', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    joinTeam(host, gameId, 'team1');
    tick(host, 1);

    host._participants.get(gameId).isWatching = true;
    sendAim(host, gameId, 5, 5, 1);

    expect(core.aim_of(gameId)).toBeNull();
  });

  it('/spawn создаёт scripted-участника в единственной играющей команде', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    joinTeam(host, gameId, 'team1');
    tick(host, 1);

    host.pushMessage(gameId, '/spawn 1');
    tick(host, 1);

    const bots = host._scripted.getScripted();

    expect(bots).toHaveLength(1);
    expect(bots[0].team).toBe('team1');
    expect(core.is_alive(bots[0].gameId)).toBe(true);
  });

  it('статистика с одной играющей командой рассылается без ошибок', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    joinTeam(host, gameId, 'team1');
    tick(host, 1);

    expect(socket.framesOf('sendStat').length).toBeGreaterThan(0);
  });

  it('removeUser удаляет актёра из fake-core', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    joinTeam(host, gameId, 'team1');
    tick(host, 1);

    host.removeUser(gameId);

    expect(core.is_alive(gameId)).toBe(false);
  });

  it('эстафета: handoff-мета восстанавливает участника в новом HostGame', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    joinTeam(host, gameId, 'team1');
    tick(host, 1);

    let handoffMeta;

    host.requestHandoff(meta => {
      handoffMeta = meta;
    });
    host._roundManager.initiateNewRound();

    expect(handoffMeta.gameId).toBe('miniGame');
    expect(handoffMeta.humans).toHaveLength(1);

    const { createFixtureHost: createNext } = await import('./fixtureHarness.js');
    const { host: nextHost } = await createNext({
      opts: { handoff: handoffMeta },
    });

    expect(nextHost.currentMap).toBe(host.currentMap);
  });

  it('destroy останавливает таймеры и снимает всех участников', async () => {
    const gameId = await connectPlayer(host, { socketId: 's1' });

    joinTeam(host, gameId, 'team1');
    tick(host, 1);

    const pending = vi.getTimerCount();

    expect(pending).toBeGreaterThan(0);

    await host.destroy();

    expect(host._participants.getAll()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('destroy синхронизирует профиль ровно один раз и дожидается запросов', async () => {
    const puts = [];
    let pending = 0;

    // считающий playerDataFetch: PUT rank и PUT state должны уйти по одному
    // разу на участника — параллельный второй flush повёз бы ту же дельту
    // рейтинга (двойной зачёт)
    const playerDataFetch = async (url, { method } = {}) => {
      if (method === 'PUT') {
        puts.push(url);
      }

      pending += 1;

      // ответ приходит микрозадачей позже: разрешись destroy раньше —
      // dedicated.close() успел бы сделать process.exit(0)
      await Promise.resolve();

      pending -= 1;

      return { ok: true, status: 200, json: async () => ({ rank: 0, state: null }) };
    };

    const { host: counted } = await createFixtureHost({
      opts: { playerDataFetch },
    });

    const gameId = await connectPlayer(counted, { socketId: 's1' });

    joinTeam(counted, gameId, 'team1');
    tick(counted, 1);

    puts.length = 0;

    await counted.destroy();

    expect(pending).toBe(0);
    expect(puts.filter(url => url.includes('rank'))).toHaveLength(1);
    expect(puts.filter(url => url.includes('state'))).toHaveLength(1);
  });
});

// noSpectators + endlessRound (opt-in флаги gameConfig): игра из одной
// команды, где наблюдателей нет как концепции, а раунд не кончается.
// Проверяется тот самый путь входа, который заменяет голосование.
describe('HostGame: noSpectators', () => {
  const NO_SPECTATORS = {
    teams: { team1: 1 },
    spectatorTeam: undefined,
    noSpectators: true,
    endlessRound: true,
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('вход кладёт человека сразу в играющую команду, с актором', async () => {
    const { host, core } = await createFixtureHost({ game: NO_SPECTATORS });
    const gameId = await connectPlayer(host, { socketId: 's1' });
    const user = host._participants.get(gameId);

    expect(user.team).toBe('team1');
    expect(user.teamId).toBe(1);
    expect(user.status).toBe('active');

    tick(host, 1);

    expect(core.is_alive(gameId)).toBe(true);
  });

  it('строка stat заводится в играющей команде, а не у наблюдателей', async () => {
    const { host } = await createFixtureHost({ game: NO_SPECTATORS });
    const gameId = await connectPlayer(host, { socketId: 's1' });
    // getFull() отдаёт плоский провод — команда участника видна только в
    // разбивке по teamId, которую держит сам модуль
    expect(Object.keys(host._stat._body[1])).toContain(gameId);
    expect(host._stat._body[2]).toBeUndefined();
  });

  it('одинокий игрок не обнуляет stat (endlessRound)', async () => {
    const { host } = await createFixtureHost({ game: NO_SPECTATORS });
    const reset = vi.spyOn(host._stat, 'reset');

    await connectPlayer(host, { socketId: 's1' });

    expect(reset).not.toHaveBeenCalled();
  });
});
