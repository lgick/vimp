import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createFixtureHost,
  connectPlayer,
  joinTeam,
  tick,
  pressKey,
} from './fixtureHarness.js';

// Движковые тесты HostGame поверх фикстурной миниигры (Этап 7 плана
// отделения движка): доказывают, что HostGame и мета движка работают без
// единого импорта из @vimp/tanks и без собранного Rust-ядра — только
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
});
