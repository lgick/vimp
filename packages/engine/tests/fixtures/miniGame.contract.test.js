import { describe, it, expect } from 'vitest';
import hostPlugin from './miniGame/host/index.js';
import clientPlugin from './miniGame/client/index.js';
import { assertGameConfigShape } from '../../src/lib/gamePlugin.js';
import { buildCoreConfig } from '../../src/lib/coreConfig.js';
import { ENGINE_API_VERSION } from '../../src/config/opcodes.js';

// Доказательство «второй игры» (Этап 7 плана отделения движка): миниигра-
// фикстура удовлетворяет тем же контрактам (§3.2/§3.3 PLAN.md), что и
// @vimp/tanks, — без единого общего файла с игрой.
describe('miniGame fixture: HostPlugin/ClientPlugin contract', () => {
  it('HostPlugin.engineApi совпадает с движковым', () => {
    expect(hostPlugin.engineApi).toBe(ENGINE_API_VERSION);
  });

  it('gameConfig проходит движковую валидацию формы (§HostPlugin API)', () => {
    expect(() => assertGameConfigShape(hostPlugin)).not.toThrow();
  });

  it('createCore возвращает объект с полной поверхностью Wasm Host ABI', async () => {
    const core = await hostPlugin.createCore(JSON.stringify({ seed: 1 }));

    const abiMethods = [
      'load_map',
      'map_info',
      'clear',
      'spawn_actor',
      'remove_actor',
      'reset_actor',
      'spawn_scripted_actor',
      'remove_scripted_actor',
      'remove_players_and_shots',
      'apply_input',
      'last_input_seq',
      'is_alive',
      'position_of',
      'players_data',
      'step',
      'take_events',
      'pack_body',
      'body_has_events',
      'pack_frame',
      'frame_bytes',
      'reset_all_vitals',
      'serialize_state',
      'deserialize_state',
    ];

    for (const method of abiMethods) {
      expect(typeof core[method]).toBe('function');
    }
  });

  it('gameConfig совместим с общим коллектором конфига ядра (buildCoreConfig)', () => {
    const config = buildCoreConfig(hostPlugin.gameConfig, { seed: 1 });

    expect(config.engine.mapScale).toBe(hostPlugin.gameConfig.mapScale);
    expect(config.game.models).toBe(hostPlugin.gameConfig.parts.models);
    // схема снапшота — игровая (Д1): ядро получает раскладку фикстуры
    expect(config.engine.snapshot.keys).toBe(hostPlugin.gameConfig.snapshot);
  });

  it('ClientPlugin несёт минимум 1-2 заглушечных part и совпадающий engineApi', () => {
    expect(clientPlugin.engineApi).toBe(hostPlugin.engineApi);
    expect(Object.keys(clientPlugin.parts).length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(clientPlugin.parts).length).toBeLessThanOrEqual(2);
  });

  it('stat/panel схемы фикстуры отличаются от танков (одна играющая команда)', () => {
    const teams = Object.keys(hostPlugin.gameConfig.teams).filter(
      name => name !== hostPlugin.gameConfig.spectatorTeam,
    );

    expect(teams).toHaveLength(1);
  });
});
