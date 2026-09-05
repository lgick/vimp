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
    _equalPowerIds: new Set(),
    _pannedIds: new Set(),
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
  _equalPowerIds: new Set(),
  _pannedIds: new Set(),
  _listenerX: 0,
  _listenerY: 0,
  _internalStop: vi.fn(),
  getSoundConfig: P.getSoundConfig,
  setListenerPosition: P.setListenerPosition,
  registerSound: P.registerSound,
  unregisterSound: P.unregisterSound,
  releaseSound: P.releaseSound,
  updateSoundData: P.updateSoundData,
  reset: P.reset,
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

describe('SoundManager.reset', () => {
  it('сохраняет регистрацию лупа и обнуляет id воспроизведения', () => {
    const ctx = makeRegistryCtx(
      new Map([['s', { sound: {}, config: { priority: 50, loop: true } }]]),
    );
    const id = ctx.registerSound('s', { position: { x: 0, y: 0 } });
    ctx._registeredSounds.get(id).activeSoundId = 42;
    ctx._activeInstances.set(42, {});

    ctx.reset();

    // владелец регистрации — сущность, она снимет её сама в destroy()
    expect(ctx._registeredSounds.has(id)).toBe(true);
    expect(ctx._registeredSounds.get(id).activeSoundId).toBe(null);
    expect(ctx._activeInstances.size).toBe(0);
  });

  it('уцелевший луп перезапускается ближайшим processAudibility', () => {
    const reg = snd('a', 10, 1, { loop: true, activeSoundId: 42 });
    const ctx = makeCtx([reg]);
    ctx.reset = P.reset;

    ctx.reset();
    ctx.processAudibility();

    expect(ctx._internalPlay).toHaveBeenCalledTimes(1);
  });

  it('снимает регистрацию одноразового звука и не играет его заново', () => {
    const reg = snd('a', 10, 1, { loop: false, activeSoundId: 42 });
    const ctx = makeCtx([reg]);
    ctx.reset = P.reset;

    ctx.reset();

    expect(ctx._registeredSounds.size).toBe(0);

    ctx.processAudibility();

    expect(ctx._internalPlay).not.toHaveBeenCalled();
  });
});

describe('SoundManager.releaseSound', () => {
  const ctxWith = loop =>
    makeRegistryCtx(
      new Map([['s', { sound: {}, config: { priority: 50, loop } }]]),
    );

  it('не глушит звучащий одноразовый звук', () => {
    const ctx = ctxWith(false);
    const id = ctx.registerSound('s', { position: { x: 0, y: 0 } });
    ctx._registeredSounds.get(id).activeSoundId = 42;

    ctx.releaseSound(id);

    expect(ctx._internalStop).not.toHaveBeenCalled();
    expect(ctx._registeredSounds.has(id)).toBe(false);
  });

  it('глушит луп вместе с владельцем', () => {
    const ctx = ctxWith(true);
    const id = ctx.registerSound('s', { position: { x: 0, y: 0 } });
    ctx._registeredSounds.get(id).activeSoundId = 42;

    ctx.releaseSound(id);

    expect(ctx._internalStop).toHaveBeenCalledWith(42);
    expect(ctx._registeredSounds.has(id)).toBe(false);
  });

  it('игнорирует неизвестный id без ошибки', () => {
    const ctx = ctxWith(false);
    expect(() => ctx.releaseSound(Symbol('x'))).not.toThrow();
  });
});

// Непространственный источник (свой танк): звук принадлежит игроку, а не
// миру. HRTF на нулевой дистанции сворачивается в гребенчатую окраску
// («гул»), поэтому такому источнику PannerNode не создаётся вовсе: Howler
// заводит узел лениво, на первом pos()/pannerAttr(id), и заканчивает
// создание парой pause()/play() — то есть щелчком, а сам узел вдобавок
// схлопывает стерео сэмпла в моно.
const makeSpatialCtx = () => ({
  _listenerX: 100,
  _listenerY: 100,
  _equalPowerIds: new Set(),
  _pannedIds: new Set(),
  _updateSpatialSound: P._updateSpatialSound,
  _recenterIfPanned: P._recenterIfPanned,
  _applyEqualPower: P._applyEqualPower,
});

const makeHowl = () => ({
  pos: vi.fn(),
  volume: vi.fn(),
  rate: vi.fn(),
  stop: vi.fn(),
  pannerAttr: vi.fn(),
});

describe('SoundManager._updateSpatialSound', () => {
  it('непространственный источник не создаёт паннер вовсе', () => {
    const ctx = makeSpatialCtx();
    const sound = makeHowl();

    ctx._updateSpatialSound(sound, 1, 500, 700, 0.8, false);

    // ни pos(), ни pannerAttr(): PannerNode не появляется, сигнал идёт
    // прямо в gain и остаётся стерео
    expect(sound.pos).not.toHaveBeenCalled();
    expect(sound.pannerAttr).not.toHaveBeenCalled();
    expect(sound.volume).toHaveBeenCalledWith(0.8, 1);
  });

  it('уже панорамированный источник, ставший непространственным, возвращается в центр на equalpower ровно один раз', () => {
    const ctx = makeSpatialCtx();
    const sound = makeHowl();

    // паннер уже создан: источник побывал в стороне от слушателя
    ctx._updateSpatialSound(sound, 1, 400, 100, 1);
    sound.pos.mockClear();

    ctx._updateSpatialSound(sound, 1, 100, 100, 1, false);
    ctx._updateSpatialSound(sound, 1, 100, 100, 1, false);

    expect(sound.pos).toHaveBeenCalledTimes(2);
    expect(sound.pos).toHaveBeenLastCalledWith(0, 0, 0, 1);
    expect(sound.pannerAttr).toHaveBeenCalledTimes(1);
    expect(sound.pannerAttr).toHaveBeenCalledWith(
      { panningModel: 'equalpower' },
      1,
    );
  });

  it('мировой источник по умолчанию панорамируется', () => {
    const ctx = makeSpatialCtx();
    const sound = makeHowl();

    ctx._updateSpatialSound(sound, 1, 400, 100, 1);

    expect(sound.pannerAttr).not.toHaveBeenCalled();
    expect(sound.pos).toHaveBeenCalledWith(300, 0, 0, 1);
  });

  it('внутри дед-зоны направления панорама не строится', () => {
    const ctx = makeSpatialCtx();
    const sound = makeHowl();

    // расхождение камеры и танка в пару пикселей — не повод для азимута.
    // Узла ещё нет — и заводить его здесь незачем
    ctx._updateSpatialSound(sound, 1, 102, 100, 1);

    expect(sound.pos).not.toHaveBeenCalled();
    expect(sound.volume).toHaveBeenCalledWith(1, 1);
  });

  it('мировой источник в дед-зоне возвращается в центр, но HRTF сохраняет', () => {
    const ctx = makeSpatialCtx();
    const sound = makeHowl();

    ctx._updateSpatialSound(sound, 1, 400, 100, 1);
    ctx._updateSpatialSound(sound, 1, 102, 100, 1);

    expect(sound.pos).toHaveBeenLastCalledWith(0, 0, 0, 1);
    // equalpower — только для источника игрока: миру HRTF ещё понадобится
    expect(sound.pannerAttr).not.toHaveBeenCalled();
  });
});

describe('SoundManager.updateActiveSounds', () => {
  const makeLoopCtx = (regSound, sound) => ({
    _registeredSounds: new Map([['owner', regSound]]),
    _activeInstances: new Map([[7, { sound, ownerId: 'owner', loop: true }]]),
    _equalPowerIds: new Set(),
    _updateSpatialSound: vi.fn(),
    updateActiveSounds: P.updateActiveSounds,
  });

  it('не зовёт rate повторно, если значение не изменилось', () => {
    const sound = makeHowl();
    const ctx = makeLoopCtx(
      { position: { x: 0, y: 0 }, volume: 1, rate: 1.5, loop: true },
      sound,
    );

    ctx.updateActiveSounds();
    ctx.updateActiveSounds();

    expect(sound.rate).toHaveBeenCalledTimes(1);
  });

  it('зовёт rate на изменение', () => {
    const sound = makeHowl();
    const reg = { position: { x: 0, y: 0 }, volume: 1, rate: 1.5, loop: true };
    const ctx = makeLoopCtx(reg, sound);

    ctx.updateActiveSounds();
    reg.rate = 2;
    ctx.updateActiveSounds();

    expect(sound.rate).toHaveBeenCalledTimes(2);
    expect(sound.rate).toHaveBeenLastCalledWith(2, 7);
  });

  it('пробрасывает spatial в позиционирование', () => {
    const sound = makeHowl();
    const ctx = makeLoopCtx(
      { position: { x: 5, y: 6 }, volume: 1, spatial: false, loop: true },
      sound,
    );

    ctx.updateActiveSounds();

    expect(ctx._updateSpatialSound).toHaveBeenCalledWith(sound, 7, 5, 6, 1, false);
  });
});
