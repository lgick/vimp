import { describe, it, expect, beforeEach, vi } from 'vitest';

// CanvasManagerModel — синглтон, перезагружаем для изоляции
let CanvasManagerModel;

const makeModel = (overrides = {}) =>
  new CanvasManagerModel({
    dynamicCamera: {
      lookAheadFactor: 0,
      zoomOutFactor: 0,
      maxZoomOut: 1,
      smoothnessPosition: 0.1,
      smoothnessZoom: 0.005,
      smoothnessVelocity: 0.1,
      ...overrides.dynamicCamera,
    },
    canvases: overrides.canvases || {
      vimp: {
        baseScale: '16:9',
        aspectRatio: '16:9',
        dynamicCamera: true,
        shakeCamera: false,
      },
      radar: { baseScale: '1:1', fixSize: '200:100' },
    },
  });

const collect = model => {
  const events = [];
  ['resize', 'updateCoords'].forEach(type =>
    model.publisher.on(type, data => events.push({ type, data })),
  );
  return events;
};

beforeEach(async () => {
  vi.resetModules();
  CanvasManagerModel = (
    await import('../../packages/engine/src/client/components/model/CanvasManager.js')
  ).default;
});

describe('CanvasManagerModel: конструктор', () => {
  it('парсит baseScale из соотношения сторон', () => {
    const model = makeModel();
    expect(model._data.vimp.baseScale).toBe(1.78); // 16/9
    expect(model._data.radar.baseScale).toBe(1); // 1/1
  });

  it('инициализирует currentScale равным baseScale', () => {
    const model = makeModel();
    expect(model._data.vimp.currentScale).toBe(1.78);
  });

  it('приводит dynamicCamera/shakeCamera к булеву', () => {
    const model = makeModel();
    expect(model._data.vimp.dynamicCamera).toBe(true);
    expect(model._data.radar.dynamicCamera).toBe(false);
  });

  it('deadZone = 0.5 при lookAheadFactor 0', () => {
    expect(makeModel({ dynamicCamera: { lookAheadFactor: 0 } })._deadZone).toBe(
      0.5,
    );
  });

  it('deadZone уменьшается с ростом lookAheadFactor', () => {
    expect(
      makeModel({ dynamicCamera: { lookAheadFactor: 10 } })._deadZone,
    ).toBeCloseTo(0.05);
  });
});

// Зум для слушателя звука — это ВЕСЬ масштаб сцены: и размер полотна, и
// динамический зум. Пока учитывался только второй, на окне вполовину
// расчётного панорама оказывалась заметно шире картинки — ровно тот дефект,
// ради которого зум и пробрасывали в SoundManager.
describe('CanvasManagerModel.getCameraZoom', () => {
  it('до первого resize зум равен 1', () => {
    const model = makeModel();

    expect(model.getCameraZoom()).toBe(1);
  });

  it('без динамической камеры отдаёт только масштаб полотна', () => {
    const model = makeModel({
      canvases: { radar: { baseScale: '1:1', fixSize: '200:100' } },
    });
    model._camZoomModifier = 0.5;

    // fixSize: currentScale остаётся baseScale, масштаб полотна равен 1
    expect(model.getCameraZoom()).toBe(1);
  });

  it('с динамической камерой отдаёт текущий модификатор', () => {
    const model = makeModel();
    model._camZoomModifier = 0.5;

    expect(model.getCameraZoom()).toBe(0.5);
  });

  it('узкое окно сжимает стереобазу вместе с картинкой', () => {
    const model = makeModel();

    model.resize({ width: 960, height: 540 });
    model._camZoomModifier = 1;

    // полотно вдвое уже расчётных 1920: видно вдвое больше мира, и
    // виртуальная высота обязана вырасти во столько же
    expect(model.getCameraZoom()).toBeCloseTo(0.5);

    model._camZoomModifier = 0.5;

    // динамический зум умножается на масштаб полотна, как и finalScale
    expect(model.getCameraZoom()).toBeCloseTo(0.25);
  });

  it('расчётное окно 1920 даёт ровно 1', () => {
    const model = makeModel();

    model.resize({ width: 1920, height: 1080 });

    expect(model.getCameraZoom()).toBeCloseTo(1);
  });
});

describe('CanvasManagerModel.resize', () => {
  it('по соотношению сторон вписывает в ширину экрана', () => {
    const model = makeModel();
    const events = collect(model);

    model.resize({ width: 1920, height: 1080 });

    const vimp = events.find(e => e.type === 'resize' && e.data.id === 'vimp');
    expect(vimp.data.sizes).toEqual({ width: 1920, height: 1080 });
  });

  it('ограничивает по высоте, если не вмещается', () => {
    const model = makeModel();
    const events = collect(model);

    // узкий и низкий экран: высота должна ограничить ширину
    model.resize({ width: 1920, height: 540 });

    const vimp = events.find(e => e.type === 'resize' && e.data.id === 'vimp');
    expect(vimp.data.sizes.height).toBe(540);
    expect(vimp.data.sizes.width).toBe(960); // 540/9*16
  });

  it('fixSize задаёт фиксированные размеры', () => {
    const model = makeModel();
    const events = collect(model);

    model.resize({ width: 800, height: 600 });

    const radar = events.find(e => e.type === 'resize' && e.data.id === 'radar');
    expect(radar.data.sizes).toEqual({ width: 200, height: 100 });
    // размеры — числа на выходе самого парсинга, а не после Math.max
    expect(typeof radar.data.sizes.height).toBe('number');
  });

  it('fixSize без второй части задаёт квадрат', () => {
    const model = makeModel({
      canvases: { radar: { baseScale: '1:1', fixSize: '150' } },
    });
    const events = collect(model);

    model.resize({ width: 800, height: 600 });

    const radar = events.find(e => e.type === 'resize' && e.data.id === 'radar');

    expect(radar.data.sizes).toEqual({ width: 150, height: 150 });
    expect(typeof radar.data.sizes.height).toBe('number');
  });

  it('игнорирует нулевые размеры экрана', () => {
    const model = makeModel();
    const events = collect(model);

    model.resize({ width: 1920, height: 1080 });
    const scaleBefore = model._data.vimp.currentScale;

    events.length = 0;
    model.resize({ width: 0, height: 0 });

    // ни события, ни обнулённого масштаба: следующий настоящий resize
    // масштаб бы не пересчитал, и полотно осталось бы пустым
    expect(events).toHaveLength(0);
    expect(model._data.vimp.currentScale).toBe(scaleBefore);
  });

  it('не отдаёт нулевой размер при вырожденном соотношении сторон', () => {
    const model = makeModel({
      canvases: { radar: { baseScale: '1:1', fixSize: '0:0' } },
    });
    const events = collect(model);

    model.resize({ width: 1920, height: 1080 });

    const radar = events.find(e => e.type === 'resize' && e.data.id === 'radar');
    expect(radar.data.sizes).toEqual({ width: 1, height: 1 });
  });
});

describe('CanvasManagerModel.updateCoords', () => {
  it('статическая камера отдаёт координаты игрока и базовый масштаб', () => {
    const model = makeModel();
    const events = collect(model);

    model.updateCoords(100, 200, true);

    const radar = events.find(
      e => e.type === 'updateCoords' && e.data.id === 'radar',
    );
    expect(radar.data.coords).toEqual({ x: 100, y: 200 });
    expect(radar.data.scale).toBe(1); // baseScale радара
  });

  it('динамическая камера при сбросе центрируется без смещения', () => {
    const model = makeModel();
    const events = collect(model);

    model.updateCoords(100, 200, true); // cameraReset

    const vimp = events.find(
      e => e.type === 'updateCoords' && e.data.id === 'vimp',
    );
    // смещения и зум сброшены → координаты совпадают с игроком
    expect(vimp.data.coords).toEqual({ x: 100, y: 200 });
    expect(vimp.data.scale).toBe(1.78);
  });

  it('сброс камеры обнуляет накопленные смещения', () => {
    const model = makeModel();
    model._camOffsetX = 50;
    model._avgDx = 5;

    model.updateCoords(0, 0, true);

    expect(model._camOffsetX).toBe(0);
    expect(model._avgDx).toBe(0);
  });
});
