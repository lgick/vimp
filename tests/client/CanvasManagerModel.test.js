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
    // ВНИМАНИЕ: текущее поведение — ширина число, а высота остаётся
    // строкой (в коде `+parts[1] ? parts[1] : parts[0]` присваивает
    // строковый parts[1] вместо числа). Зафиксировано как есть.
    expect(radar.data.sizes).toEqual({ width: 200, height: '100' });
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
