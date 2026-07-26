import { describe, it, expect, vi } from 'vitest';
import SoundManager from '../../packages/engine/src/client/SoundManager.js';

// processAudibility использует множество внутренних полей и методов.
// Тестируем через прототип, подставляя минимальный `this` с моками.
// (maxDistance = 1000 → maxDistSquared = 1_000_000; WORLD_VOICE_LIMIT = 30)
const snd = (id, x, priority = 1, opts = {}) => ({
  id,
  position: { x, y: 0 },
  priority,
  loop: opts.loop || false,
  activeSoundId: opts.activeSoundId ?? null,
  volume: 1,
  rate: 1,
});

const makeCtx = sounds => {
  let counter = 0;
  return {
    _registeredSounds: new Map(sounds.map(s => [s.id, s])),
    _listenerX: 0,
    _listenerY: 0,
    _activeInstances: new Map(),
    _internalPlay: vi.fn(() => `play${counter++}`),
    _internalStop: vi.fn(),
    _updateSpatialSound: vi.fn(),
    _cleanupUnplayedOneShots: vi.fn(),
    processAudibility: SoundManager.prototype.processAudibility,
  };
};

describe('SoundManager.processAudibility', () => {
  it('удаляет далёкий одноразовый звук', () => {
    const ctx = makeCtx([snd('a', 2000)]); // дальше maxDistance
    ctx.processAudibility();

    expect(ctx._registeredSounds.has('a')).toBe(false);
    expect(ctx._cleanupUnplayedOneShots).toHaveBeenCalled();
  });

  it('сохраняет далёкий зацикленный звук и проигрывает его', () => {
    const ctx = makeCtx([snd('a', 2000, 1, { loop: true })]);
    ctx.processAudibility();

    expect(ctx._registeredSounds.has('a')).toBe(true);
    expect(ctx._internalPlay).toHaveBeenCalledTimes(1);
  });

  it('проигрывает все слышимые звуки в пределах лимита', () => {
    const ctx = makeCtx([snd('a', 10), snd('b', 20)]);
    ctx.processAudibility();

    expect(ctx._internalPlay).toHaveBeenCalledTimes(2);
    expect(ctx._updateSpatialSound).toHaveBeenCalledTimes(2);
  });

  it('ограничивает число одновременных голосов лимитом (30)', () => {
    const sounds = Array.from({ length: 35 }, (_, i) => snd(`s${i}`, i + 1));
    const ctx = makeCtx(sounds);
    ctx.processAudibility();

    // из 35 кандидатов проигрываются только 30
    expect(ctx._internalPlay).toHaveBeenCalledTimes(30);
  });

  it('останавливает играющий звук, вытесненный из лимита по приоритету', () => {
    const sounds = [
      // 30 громких приоритетных звуков (не играют)
      ...Array.from({ length: 30 }, (_, i) => snd(`hi${i}`, 10, 100)),
      // 1 тихий, уже играющий — должен быть вытеснен
      snd('low', 10, 1, { activeSoundId: 'oldId' }),
    ];
    const ctx = makeCtx(sounds);
    ctx.processAudibility();

    expect(ctx._internalStop).toHaveBeenCalledWith('oldId');
  });

  it('без кандидатов очищает одноразовые звуки', () => {
    const ctx = makeCtx([]);
    ctx.processAudibility();
    expect(ctx._cleanupUnplayedOneShots).toHaveBeenCalled();
  });
});

// Методы реестра звуков тестируем через прототип с минимальным `this`,
// чтобы не поднимать Howler (конструктор грузит аудио).
const P = SoundManager.prototype;

const makeRegistryCtx = (sounds = new Map()) => ({
  _sounds: sounds,
  _registeredSounds: new Map(),
  _activeInstances: new Map(),
  _listenerX: 0,
  _listenerY: 0,
  _internalStop: vi.fn(),
  getSoundConfig: P.getSoundConfig,
  setListenerPosition: P.setListenerPosition,
  registerSound: P.registerSound,
  unregisterSound: P.unregisterSound,
  updateSoundData: P.updateSoundData,
});

describe('SoundManager.getSoundConfig', () => {
  it('возвращает конфигурацию загруженного звука', () => {
    const ctx = makeRegistryCtx(
      new Map([['shot', { sound: {}, config: { priority: 80 } }]]),
    );
    expect(ctx.getSoundConfig('shot')).toEqual({ priority: 80 });
  });

  it('возвращает undefined для неизвестного звука', () => {
    const ctx = makeRegistryCtx();
    expect(ctx.getSoundConfig('nope')).toBeUndefined();
  });
});

describe('SoundManager.setListenerPosition', () => {
  it('сохраняет координаты слушателя', () => {
    const ctx = makeRegistryCtx();
    ctx.setListenerPosition(15, -7);
    expect(ctx._listenerX).toBe(15);
    expect(ctx._listenerY).toBe(-7);
  });
});

describe('SoundManager.registerSound', () => {
  it('регистрирует звук и возвращает уникальный symbol-id', () => {
    const ctx = makeRegistryCtx(
      new Map([
        ['engine', { sound: { _h: 1 }, config: { priority: 50, loop: true } }],
      ]),
    );

    const id = ctx.registerSound('engine', { position: { x: 1, y: 2 } });

    expect(typeof id).toBe('symbol');
    const reg = ctx._registeredSounds.get(id);
    expect(reg.priority).toBe(50); // из config
    expect(reg.position).toEqual({ x: 1, y: 2 }); // из data
    expect(reg.sound).toBe(ctx._sounds.get('engine').sound);
    expect(reg.activeSoundId).toBeNull();
  });

  it('возвращает null и предупреждает для несуществующего звука', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = makeRegistryCtx();

    expect(ctx.registerSound('ghost', { position: { x: 0, y: 0 } })).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('SoundManager.unregisterSound', () => {
  it('удаляет звук из реестра', () => {
    const ctx = makeRegistryCtx(
      new Map([['s', { sound: {}, config: { priority: 50 } }]]),
    );
    const id = ctx.registerSound('s', { position: { x: 0, y: 0 } });

    ctx.unregisterSound(id);

    expect(ctx._registeredSounds.has(id)).toBe(false);
    expect(ctx._internalStop).not.toHaveBeenCalled(); // не играл
  });

  it('останавливает играющий звук перед снятием с регистрации', () => {
    const ctx = makeRegistryCtx(
      new Map([['s', { sound: {}, config: { priority: 50 } }]]),
    );
    const id = ctx.registerSound('s', { position: { x: 0, y: 0 } });
    ctx._registeredSounds.get(id).activeSoundId = 42;

    ctx.unregisterSound(id);

    expect(ctx._internalStop).toHaveBeenCalledWith(42);
    expect(ctx._registeredSounds.has(id)).toBe(false);
  });
});

describe('SoundManager.updateSoundData', () => {
  it('мёржит новые параметры в зарегистрированный звук', () => {
    const ctx = makeRegistryCtx(
      new Map([['s', { sound: {}, config: { priority: 50 } }]]),
    );
    const id = ctx.registerSound('s', { position: { x: 0, y: 0 }, volume: 1 });

    ctx.updateSoundData(id, { position: { x: 9, y: 9 }, volume: 0.3 });

    const reg = ctx._registeredSounds.get(id);
    expect(reg.position).toEqual({ x: 9, y: 9 });
    expect(reg.volume).toBe(0.3);
  });

  it('игнорирует неизвестный id без ошибки', () => {
    const ctx = makeRegistryCtx();
    expect(() => ctx.updateSoundData(Symbol('x'), { volume: 1 })).not.toThrow();
  });
});
