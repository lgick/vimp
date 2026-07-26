/* eslint-disable camelcase -- фейк ядра повторяет snake_case ABI GameCore */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import GameCoreAdapter from '../../packages/engine/src/host/GameCoreAdapter.js';

// Юнит-тесты адаптера ядра: маппинг команд на ABI, различение бот/человек,
// генерик-роутинг стандартного словаря событий ядра (panelSet/panelActive/
// death/shake) в мету + 'custom' в HostPlugin.onCoreEvent, флаги камеры в
// packFrame. Ядро — фейк (реальный core покрыт интеграционными
// HostGame.test.js и tests/core).

// Фейк ядра: записывает вызовы, отдаёт заранее заданные события/кадр.
const makeFakeCore = (events = []) => ({
  calls: [],
  events,
  load_map(json) {
    this.calls.push(['load_map', json]);
  },
  clear() {
    this.calls.push(['clear']);
  },
  spawn_actor(...a) {
    this.calls.push(['spawn_actor', ...a]);
  },
  spawn_scripted_actor(...a) {
    this.calls.push(['spawn_scripted_actor', ...a]);
  },
  remove_actor(id) {
    this.calls.push(['remove_actor', id]);
  },
  remove_scripted_actor(id) {
    this.calls.push(['remove_scripted_actor', id]);
  },
  reset_actor(...a) {
    this.calls.push(['reset_actor', ...a]);
  },
  apply_input(...a) {
    this.calls.push(['apply_input', ...a]);
  },
  remove_players_and_shots() {
    return JSON.stringify(['m1', 'w1']);
  },
  players_data() {
    return JSON.stringify({ m1: { 1: [1, 2, 0, 0, 0, 0, 0, 3, 2, 1] } });
  },
  position_of(id) {
    return id === 99 ? [] : [10, 20];
  },
  is_alive() {
    return true;
  },
  step(dt) {
    this.calls.push(['step', dt]);
  },
  take_events() {
    return JSON.stringify(this.events);
  },
  pack_body() {
    this.calls.push(['pack_body']);
  },
  pack_frame(...a) {
    this.calls.push(['pack_frame', ...a]);
  },
  frame_bytes() {
    return new Uint8Array([5, 3, 0, 0]);
  },
});

const makeParticipants = (bots = new Set()) => ({
  get: id => ({ isScripted: bots.has(id) }),
});

describe('GameCoreAdapter', () => {
  let core;
  let panel;
  let vimp;

  beforeEach(() => {
    core = makeFakeCore();
    panel = { updateUser: vi.fn(), setActiveWeapon: vi.fn() };
    vimp = { reportKill: vi.fn(), triggerCameraShake: vi.fn() };
  });

  it('createMap грузит масштабированную карту со scale:1', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
    });

    adapter.createMap({ step: 19.2, map: [[0]], scale: 0.6, setId: 'c1' });

    const [, json] = core.calls.find(c => c[0] === 'load_map');
    const parsed = JSON.parse(json);

    expect(parsed.scale).toBe(1); // ядро не масштабирует повторно
    expect(parsed.step).toBe(19.2);
    expect(parsed.setId).toBe('c1');
  });

  it('createPlayer различает человека (spawn_actor) и бота (spawn_scripted_actor)', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(new Set([2])),
    });

    adapter.createPlayer(1, 'm1', 'Human', 1, [10, 20, 0]);
    adapter.createPlayer(2, 'm1', 'Bot', 2, [30, 40, 90]);

    expect(core.calls).toContainEqual(['spawn_actor', 1, 'm1', 1, 10, 20, 0]);
    expect(core.calls).toContainEqual([
      'spawn_scripted_actor',
      2,
      'm1',
      2,
      30,
      40,
      90,
    ]);
  });

  it('removePlayer различает человека (remove_actor) и бота (remove_scripted_actor)', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(new Set([2])),
    });

    adapter.removePlayer(1);
    adapter.removePlayer(2);

    expect(core.calls).toContainEqual(['remove_actor', 1]);
    expect(core.calls).toContainEqual(['remove_scripted_actor', 2]);
  });

  it('changePlayerData → reset_actor с координатами респауна', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
    });

    adapter.changePlayerData(1, { respawnData: [5, 6, 180], teamId: 2 });

    expect(core.calls).toContainEqual(['reset_actor', 1, 2, 5, 6, 180]);
  });

  it('applyInput → apply_input с seq', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
    });

    adapter.applyInput(1, 42, 'down', 'forward');

    expect(core.calls).toContainEqual(['apply_input', 1, 42, 'down', 'forward']);
  });

  it('getPosition: [] от ядра → [0, 0]', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
    });

    expect(adapter.getPosition(1)).toEqual([10, 20]);
    expect(adapter.getPosition(99)).toEqual([0, 0]);
  });

  it('getPlayersData парсит players_data ядра', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
    });

    expect(adapter.getPlayersData()).toEqual({
      m1: { 1: [1, 2, 0, 0, 0, 0, 0, 3, 2, 1] },
    });
  });

  // стандартный словарь событий ядра (Wasm Host ABI) роутится адаптером
  // напрямую в мету — игре не нужен свой eventRouter
  it('updateData роутит стандартные события ядра в панель/vimp', () => {
    const events = [
      { type: 'panelSet', id: 1, field: 'health', value: 80 },
      { type: 'panelActive', id: 1, field: 'w2' },
      { type: 'death', victim: 2, killer: 1 },
      { type: 'shake', id: 1, intensity: 20, duration: 200 },
    ];

    core = makeFakeCore(events);

    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
    });

    adapter.injectServices({ vimp, panel });
    adapter.updateData(1 / 120);

    expect(core.calls).toContainEqual(['step', 1 / 120]);
    expect(panel.updateUser).toHaveBeenCalledWith('1', 'health', 80, 'set');
    expect(panel.setActiveWeapon).toHaveBeenCalledWith('1', 'w2');
    expect(vimp.reportKill).toHaveBeenCalledWith('2', '1');
    expect(vimp.triggerCameraShake).toHaveBeenCalledWith('1', {
      intensity: 20,
      duration: 200,
    });
  });

  // 'custom' — единственный тип вне стандартного словаря, у него игровой
  // смысл: адаптер отдаёт его опциональному HostPlugin.onCoreEvent как есть
  it("updateData роутит 'custom' события в onCoreEvent, остальные не трогает его", () => {
    const events = [
      { type: 'custom', data: { foo: 'bar' } },
      { type: 'panelSet', id: 1, field: 'health', value: 80 },
    ];

    core = makeFakeCore(events);

    const onCoreEvent = vi.fn();
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
      onCoreEvent,
    });

    adapter.injectServices({ vimp, panel });
    adapter.updateData(1 / 120);

    expect(onCoreEvent).toHaveBeenCalledTimes(1);
    expect(onCoreEvent).toHaveBeenCalledWith({ foo: 'bar' }, { vimp, panel });
  });

  it('updateData не падает без onCoreEvent при отсутствии custom-событий', () => {
    core = makeFakeCore([{ type: 'panelSet', id: 1, field: 'health', value: 80 }]);

    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
    });

    adapter.injectServices({ vimp, panel });

    expect(() => adapter.updateData(1 / 120)).not.toThrow();
  });

  it('packFrame прокидывает флаги камеры и playerId, возвращает ArrayBuffer', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
    });

    const buf = adapter.packFrame([10, 20, true, '20:200'], 1234.5, 7, 1);

    expect(core.calls).toContainEqual([
      'pack_frame',
      1234.5,
      7,
      true,
      10,
      20,
      true,
      '20:200',
      1,
    ]);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBe(4);
  });

  it('packFrame наблюдателя: playerId null → -1, без камеры', () => {
    const adapter = new GameCoreAdapter(core, {
      participants: makeParticipants(),
    });

    adapter.packFrame(0, 1000, 3, null);

    expect(core.calls).toContainEqual([
      'pack_frame',
      1000,
      3,
      false,
      0,
      0,
      false,
      undefined,
      -1,
    ]);
  });
});
