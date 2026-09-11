import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SoundManager from '../../packages/engine/src/client/SoundManager.js';

const P = SoundManager.prototype;

// Конструктор SoundManager трогает Howler (тот грузит аудио), поэтому
// экземпляр собирается в обход него: настоящий прототип + полное состояние
// полей класса. Фабрика ОДНА нарочно — поле, забытое в одном из пяти
// самодельных литералов, не роняло тест, а молча выключало проверку.
const makeManager = (overrides = {}) =>
  Object.assign(
    Object.create(P),
    {
      _sounds: new Map(),
      _activeInstances: new Map(),
      _registeredSounds: new Map(),
      _equalPowerIds: new Set(),
      _pannedIds: new Set(),
      _pannerPos: new Map(),
      _lastPositionWrite: -Infinity,
      _spatial: P._resolveSpatialConfig.call({}),
      _listenerScale: 1,
      _listenerX: 0,
      _listenerY: 0,
    },
    overrides,
  );

const makeHowl = () => ({
  pos: vi.fn(),
  volume: vi.fn(),
  rate: vi.fn(),
  stop: vi.fn(),
  pannerAttr: vi.fn(),
});

// один кадр менеджера: громкость применяется всегда, позиция — только если
// источник слышим. Ровно этой парой его зовут updateActiveSounds и
// processAudibility
const frame = (ctx, sound, id, x, y, volume, spatial = true) => {
  if (ctx._applyVolume(sound, id, x, y, volume, spatial)) {
    ctx._updateSpatialSound(sound, id, x, y, spatial);
  }
};

// один зацикленный экземпляр в активных: сценарии updateActiveSounds
const makeLoopCtx = (regSound, sound) =>
  makeManager({
    _registeredSounds: new Map([['owner', regSound]]),
    _activeInstances: new Map([[7, { sound, ownerId: 'owner', loop: true }]]),
    _updateSpatialSound: vi.fn(),
  });

// processAudibility отбирает кандидатов; воспроизведение и позиционирование
// в этих тестах замоканы. (maxDistance в хелпере 100; WORLD_VOICE_LIMIT = 30)
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

  return makeManager({
    _registeredSounds: new Map(sounds.map(s => [s.id, s])),
    _spatial: { ...P._resolveSpatialConfig.call({}), maxDistance: 100 },
    _internalPlay: vi.fn(() => `play${counter++}`),
    _internalStop: vi.fn(),
    _applyVolume: vi.fn(() => true),
    _updateSpatialSound: vi.fn(),
    _cleanupUnplayedOneShots: vi.fn(),
  });
};

describe('SoundManager.processAudibility', () => {
  it('удаляет далёкий одноразовый звук', () => {
    const ctx = makeCtx([snd('a', 200)]); // дальше maxDistance
    ctx.processAudibility();

    expect(ctx._registeredSounds.has('a')).toBe(false);
    expect(ctx._cleanupUnplayedOneShots).toHaveBeenCalled();
  });

  it('сохраняет далёкий зацикленный звук и проигрывает его', () => {
    const ctx = makeCtx([snd('a', 200, 1, { loop: true })]);
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

const makeRegistryCtx = (sounds = new Map()) =>
  makeManager({ _sounds: sounds, _internalStop: vi.fn() });

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
const makeSpatialCtx = (spatial, scale = 1) =>
  makeManager({
    _listenerX: 100,
    _listenerY: 100,
    _listenerScale: scale,
    _spatial: P._resolveSpatialConfig.call({}, spatial),
  });

describe('SoundManager._updateSpatialSound', () => {
  it('непространственный источник не создаёт паннер вовсе', () => {
    const ctx = makeSpatialCtx();
    const sound = makeHowl();

    frame(ctx, sound, 1, 500, 700, 0.8, false);

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
    frame(ctx, sound, 1, 400, 100, 1);
    sound.pos.mockClear();

    frame(ctx, sound, 1, 100, 100, 1, false);
    frame(ctx, sound, 1, 100, 100, 1, false);
    frame(ctx, sound, 1, 100, 100, 1, false);

    // центр пишется через тот же порог смещения: собственный двигатель
    // игрока звучит непрерывно, и переписывать ему (0, 0, 0) каждый кадр —
    // ровно тот поток автоматизации, который чинится ради WebKit
    expect(sound.pos).toHaveBeenCalledTimes(1);
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

    frame(ctx, sound, 1, 400, 100, 1);

    expect(sound.pannerAttr).not.toHaveBeenCalled();
    expect(sound.pos).toHaveBeenCalledWith(300, -180, 0, 1);
  });

  it('источник вплотную к слушателю звучит из-под него', () => {
    const ctx = makeSpatialCtx();
    const sound = makeHowl();

    // расхождение камеры и танка в пару единиц — не повод для азимута:
    // вектор гасится smoothstep'ом почти в ноль, а высота держит источник
    // под слушателем
    frame(ctx, sound, 1, 102, 100, 1);

    expect(sound.pos.mock.calls[0][0]).toBeCloseTo(0.0145, 3);
    expect(sound.pos.mock.calls[0][1]).toBe(-180);
    expect(sound.volume).toHaveBeenCalledWith(1, 1);
  });

  it('источник ровно под слушателем звучит из-под него', () => {
    const ctx = makeSpatialCtx();
    const sound = makeHowl();

    frame(ctx, sound, 1, 100, 100, 1);

    expect(sound.pos).toHaveBeenCalledWith(0, -180, 0, 1);
  });

  it('вблизи слушателя панорама мягкая', () => {
    const ctx = makeSpatialCtx();
    const sound = makeHowl();

    frame(ctx, sound, 1, 120, 100, 1);

    expect(sound.pos).toHaveBeenCalledWith(10, -180, 0, 1);
    // угол на источник — единицы градусов, а не крайнее ухо
    expect(Math.atan2(10, 180)).toBeLessThan(0.1);
  });

  it('панорама непрерывна там, где раньше была ступенька', () => {
    const ctx = makeSpatialCtx();
    const sound = makeHowl();

    // прежний порог MIN_SPATIAL_DISTANCE = 16 давал здесь разрыв
    for (const x of [114, 115, 116, 117, 118]) {
      frame(ctx, sound, 1, x, 100, 1);
    }

    const xs = sound.pos.mock.calls.map(call => call[0]);

    for (let i = 1; i < xs.length; i += 1) {
      expect(xs[i]).toBeGreaterThan(xs[i - 1]);
      expect(xs[i] - xs[i - 1]).toBeLessThan(1.5);
    }
  });

  it('за радиусом рассеивания вектор не гасится', () => {
    const ctx = makeSpatialCtx();
    const sound = makeHowl();

    frame(ctx, sound, 1, 200, 180, 1);

    expect(sound.pos).toHaveBeenCalledWith(100, -180, 80, 1);
  });

  it('мировой источник не переводится на equalpower', () => {
    const ctx = makeSpatialCtx();
    const sound = makeHowl();

    frame(ctx, sound, 1, 400, 100, 1);

    // equalpower — только для источника игрока: миру HRTF ещё понадобится
    expect(sound.pannerAttr).not.toHaveBeenCalled();
  });

  it('зум камеры поднимает уши', () => {
    const ctx = makeSpatialCtx(undefined, 0.5);
    const sound = makeHowl();

    frame(ctx, sound, 1, 400, 100, 1);

    expect(sound.pos).toHaveBeenLastCalledWith(300, -360, 0, 1);

    // радиус рассеивания растянут тем же зумом
    frame(ctx, sound, 1, 140, 100, 1);

    expect(sound.pos).toHaveBeenLastCalledWith(20, -360, 0, 1);
  });

  it('за maxDistance источник глушится', () => {
    const sound = makeHowl();

    frame(makeSpatialCtx(), sound, 1, 1400, 100, 1);

    expect(sound.volume).toHaveBeenCalledWith(0, 1);
    expect(sound.pos).not.toHaveBeenCalled();

    // отсечка в мировых координатах: зумом она не масштабируется
    const zoomed = makeHowl();

    frame(makeSpatialCtx(undefined, 0.5), zoomed, 1, 1400, 100, 1);

    expect(zoomed.volume).toHaveBeenCalledWith(0, 1);
    expect(zoomed.pos).not.toHaveBeenCalled();
  });

  it('профиль sideScroller кладёт вертикаль на ось Y', () => {
    const ctx = makeSpatialCtx({ mode: 'sideScroller' });
    const sound = makeHowl();

    frame(ctx, sound, 1, 300, 300, 1);

    expect(sound.pos).toHaveBeenCalledWith(200, -40, -180, 1);
  });

  it('профиль cockpit кладёт вертикаль полностью', () => {
    const ctx = makeSpatialCtx({ mode: 'cockpit' });
    const sound = makeHowl();

    frame(ctx, sound, 1, 300, 300, 1);

    expect(sound.pos).toHaveBeenCalledWith(200, -200, -180, 1);
  });

  it('innerRadius: 0 не даёт NaN', () => {
    const ctx = makeSpatialCtx({ innerRadius: 0 });
    const sound = makeHowl();

    frame(ctx, sound, 1, 101, 100, 1);

    expect(sound.pos).toHaveBeenCalledWith(1, -180, 0, 1);
    expect(sound.pos.mock.calls[0].every(Number.isFinite)).toBe(true);
  });
});

describe('SoundManager._resolveSpatialConfig', () => {
  const resolve = custom => P._resolveSpatialConfig.call({}, custom);

  let warn;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('без объявления игры отдаёт дефолты молча', () => {
    for (const custom of [undefined, {}]) {
      const cfg = resolve(custom);

      expect(cfg.mode).toBe('topDown');
      expect(cfg.virtualElevation).toBe(180);
      expect(cfg.innerRadius).toBe(40);
      expect(cfg.panningModel).toBe('HRTF');
      expect(cfg.refDistance).toBe(200);
      expect(cfg.maxDistance).toBe(1200);
    }

    expect(warn).not.toHaveBeenCalled();
  });

  it('неизвестный профиль падает на topDown с предупреждением', () => {
    expect(resolve({ mode: 'side-scroller' }).mode).toBe('topDown');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('битое число падает на дефолт с предупреждением', () => {
    expect(resolve({ virtualElevation: -1 }).virtualElevation).toBe(180);
    expect(resolve({ innerRadius: NaN }).innerRadius).toBe(40);
    expect(resolve({ refDistance: '200' }).refDistance).toBe(200);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('неизвестная модель панорамирования падает на дефолт профиля', () => {
    expect(resolve({ panningModel: 'stereo' }).panningModel).toBe('HRTF');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sideScroller приносит свой equalpower молча', () => {
    expect(resolve({ mode: 'sideScroller' }).panningModel).toBe('equalpower');
    expect(warn).not.toHaveBeenCalled();
  });

  it('maxDistance не больше refDistance откатывает обе дистанции', () => {
    const cfg = resolve({ refDistance: 500, maxDistance: 400 });

    expect(cfg.refDistance).toBe(200);
    expect(cfg.maxDistance).toBe(1200);
    expect(warn).toHaveBeenCalledTimes(1);

    // выброшены оба ключа, и предупреждение обязано назвать оба: иначе
    // автор игры не узнает, что его корректный refDistance тоже сброшен
    const [message] = warn.mock.calls[0];

    expect(message).toContain('refDistance');
    expect(message).toContain('maxDistance');
    expect(message).toContain('200');
    expect(message).toContain('1200');
  });

  it('одна дистанция против дефолта второй — тоже нарушение', () => {
    // maxDistance 150 при движковом refDistance 200: PannerNode с такой
    // парой ведёт себя неопределённо, поэтому откат
    const cfg = resolve({ maxDistance: 150 });

    expect(cfg.refDistance).toBe(200);
    expect(cfg.maxDistance).toBe(1200);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('innerRadius: 0 легален', () => {
    expect(resolve({ innerRadius: 0 }).innerRadius).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('SoundManager.setListenerPosition: зум', () => {
  const makeZoomCtx = () => makeManager();

  it('мусорный зум не доходит до геометрии', () => {
    for (const args of [[0, 0], [0, 0, 0], [0, 0, NaN], [0, 0, -1]]) {
      const ctx = makeZoomCtx();

      ctx.setListenerPosition(...args);

      expect(ctx._listenerScale).toBe(1);
    }
  });

  it('корректный зум сохраняется', () => {
    const ctx = makeZoomCtx();

    ctx.setListenerPosition(0, 0, 0.5);

    expect(ctx._listenerScale).toBe(0.5);
  });
});

describe('SoundManager.updateActiveSounds', () => {

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

    expect(ctx._updateSpatialSound).toHaveBeenCalledWith(sound, 7, 5, 6, false);
  });
});

// Поток pos() — главная стоимость мирового звука: каждый вызов внутри
// Howler это три setValueAtTime на positionX/Y/Z плюс событие 'pos'. На
// 60 Гц и лимите голосов WebKit отвечает артефактами, клиппингом и
// обрывами, поэтому запись позиции ограничена с двух сторон: порогом
// смещения (неподвижный источник) и гейтом частоты (движущийся).
describe('SoundManager: экономия записей позиции', () => {

  it('неподвижный источник переписывает позицию один раз', () => {
    const sound = makeHowl();
    const ctx = makeSpatialCtx();

    frame(ctx, sound, 1, 400, 100, 1);
    frame(ctx, sound, 1, 400, 100, 1);
    frame(ctx, sound, 1, 400, 100, 1);

    expect(sound.pos).toHaveBeenCalledTimes(1);
  });

  it('смещение за порогом снова пишет позицию', () => {
    const sound = makeHowl();
    const ctx = makeSpatialCtx();

    frame(ctx, sound, 1, 400, 100, 1);
    frame(ctx, sound, 1, 500, 100, 1);

    expect(sound.pos).toHaveBeenCalledTimes(2);
    expect(sound.pos).toHaveBeenLastCalledWith(400, -180, 0, 1);
  });

  it('возврат в центр запоминается: порог не сравнивает со старым', () => {
    const sound = makeHowl();
    const ctx = makeSpatialCtx();

    // источник побывал в стороне, затем стал непространственным
    frame(ctx, sound, 1, 400, 100, 1);
    frame(ctx, sound, 1, 400, 100, 1, false);
    sound.pos.mockClear();

    // снова мировой и снова там же — позиция в узле сейчас (0, 0, 0),
    // поэтому запись обязана произойти
    frame(ctx, sound, 1, 400, 100, 1);

    expect(sound.pos).toHaveBeenCalledTimes(1);
    expect(sound.pos).toHaveBeenLastCalledWith(300, -180, 0, 1);
  });

  it('гейт частоты: внутри интервала позиция не трогается', () => {
    const sound = makeHowl();
    const ctx = makeLoopCtx(
      { position: { x: 5, y: 6 }, volume: 1, loop: true },
      sound,
    );
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);

    ctx.updateActiveSounds();
    nowSpy.mockReturnValue(1010); // < 1000/30 мс
    ctx.updateActiveSounds();

    expect(ctx._updateSpatialSound).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  it('гейт частоты: за интервалом позиция пишется снова', () => {
    const sound = makeHowl();
    const ctx = makeLoopCtx(
      { position: { x: 5, y: 6 }, volume: 1, loop: true },
      sound,
    );
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);

    ctx.updateActiveSounds();
    nowSpy.mockReturnValue(1040); // > 1000/30 мс
    ctx.updateActiveSounds();

    expect(ctx._updateSpatialSound).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it('громкость идёт каждый кадр, позиция — под гейтом', () => {
    const sound = makeHowl();
    const reg = { position: { x: 400, y: 100 }, volume: 1, loop: true };
    const ctx = makeLoopCtx(reg, sound);

    // настоящая геометрия вместо мока: проверяется, что под гейт попала
    // ровно запись позиции, а не громкость вместе с ней
    ctx._updateSpatialSound = P._updateSpatialSound;

    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);

    ctx.updateActiveSounds();
    reg.volume = 0.2;
    reg.position = { x: 500, y: 100 };
    nowSpy.mockReturnValue(1010); // гейт закрыт
    ctx.updateActiveSounds();

    expect(sound.pos).toHaveBeenCalledTimes(1);
    expect(sound.volume).toHaveBeenCalledTimes(2);
    expect(sound.volume).toHaveBeenLastCalledWith(0.2, 7);

    nowSpy.mockRestore();
  });

  it('за maxDistance источник глушится в том же кадре, а не через 33 мс', () => {
    const sound = makeHowl();
    const reg = { position: { x: 0, y: 0 }, volume: 1, loop: true };
    const ctx = makeLoopCtx(reg, sound);

    ctx._updateSpatialSound = P._updateSpatialSound;

    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);

    ctx.updateActiveSounds();
    reg.position = { x: 5000, y: 0 }; // дальше maxDistance
    nowSpy.mockReturnValue(1010); // гейт позиции закрыт
    ctx.updateActiveSounds();

    expect(sound.volume).toHaveBeenLastCalledWith(0, 7);

    nowSpy.mockRestore();
  });

  it('гейт держит 30 Гц с допуском, а не скачет на 20', () => {
    const sound = makeHowl();
    const ctx = makeLoopCtx(
      { position: { x: 5, y: 6 }, volume: 1, loop: true },
      sound,
    );
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);

    // кадры 60 Гц: 32 мс чуть меньше 1000/30, но внутри допуска — без него
    // запись уехала бы на 48 мс и такт упал бы до 20 Гц
    for (const now of [0, 32, 64]) {
      nowSpy.mockReturnValue(now);
      ctx.updateActiveSounds();
    }

    expect(ctx._updateSpatialSound).toHaveBeenCalledTimes(3);

    nowSpy.mockRestore();
  });

  it('уборка экземпляра забывает его во всех коллекциях', () => {
    const sound = makeHowl();
    const ctx = makeManager({
      _activeInstances: new Map([[7, { sound, ownerId: 'owner', loop: true }]]),
      _equalPowerIds: new Set([7]),
      _pannedIds: new Set([7]),
      _pannerPos: new Map([[7, [1, 2, 3]]]),
    });

    ctx._internalStop(7);

    expect(sound.stop).toHaveBeenCalledWith(7);
    expect(ctx._activeInstances.has(7)).toBe(false);
    expect(ctx._equalPowerIds.has(7)).toBe(false);
    expect(ctx._pannedIds.has(7)).toBe(false);
    expect(ctx._pannerPos.has(7)).toBe(false);
  });

  it('гейт частоты не задерживает уборку мёртвого экземпляра', () => {
    const sound = makeHowl();
    const ctx = makeLoopCtx(
      { position: { x: 5, y: 6 }, volume: 1, loop: true },
      sound,
    );
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1000);

    ctx.updateActiveSounds();
    ctx._registeredSounds.delete('owner');
    nowSpy.mockReturnValue(1010); // гейт закрыт, уборка всё равно обязана
    ctx.updateActiveSounds();

    expect(sound.stop).toHaveBeenCalledWith(7);
    expect(ctx._activeInstances.has(7)).toBe(false);

    nowSpy.mockRestore();
  });
});
