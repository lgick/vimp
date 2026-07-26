import { describe, it, expect, beforeEach, vi } from 'vitest';

// Panel — синглтон, перезагружаем модуль для изоляции
let Panel;

// схема панели (аналог games/tanks config game.js -> panel)
const panelConfig = {
  fields: {
    health: { key: 'h', value: 100 },
    w1: { key: 'w1', value: 200 },
    w2: { key: 'w2', value: 100 },
  },
  activeKey: 'wa',
};

// мок TimerManager с управляемым оставшимся временем раунда
const makeTimerManager = (time = 120) => ({
  _time: time,
  getRoundTimeLeft() {
    return this._time;
  },
});

beforeEach(async () => {
  vi.resetModules();
  Panel = (await import('../../packages/engine/src/host/meta/modules/Panel.js')).default;
});

describe('Panel.updateUser', () => {
  it('decrement уменьшает значение (по умолчанию)', () => {
    const panel = new Panel(panelConfig);
    panel.addUser('g1');

    panel.updateUser('g1', 'health', 30);
    expect(panel.getCurrentValue('g1', 'health')).toBe(70);
  });

  it('increment увеличивает значение', () => {
    const panel = new Panel(panelConfig);
    panel.addUser('g1');

    panel.updateUser('g1', 'w1', 50, 'increment');
    expect(panel.getCurrentValue('g1', 'w1')).toBe(250);
  });

  it('set задаёт абсолютное значение', () => {
    const panel = new Panel(panelConfig);
    panel.addUser('g1');

    panel.updateUser('g1', 'health', 42, 'set');
    expect(panel.getCurrentValue('g1', 'health')).toBe(42);
  });

  it('значение не опускается ниже 0', () => {
    const panel = new Panel(panelConfig);
    panel.addUser('g1');

    panel.updateUser('g1', 'health', 999);
    expect(panel.getCurrentValue('g1', 'health')).toBe(0);
  });
});

describe('Panel.hasResources', () => {
  it('true, если ресурса достаточно', () => {
    const panel = new Panel(panelConfig);
    panel.addUser('g1');
    expect(panel.hasResources('g1', 'w1', 200)).toBe(true);
    expect(panel.hasResources('g1', 'w1', 201)).toBe(false);
  });
});

describe('Panel.processUpdates', () => {
  it('включает время раунда при изменении и pendingChanges', () => {
    const panel = new Panel(panelConfig);
    const tm = makeTimerManager(100);
    panel.injectTimerManager(tm);
    panel.addUser('g1');

    panel.updateUser('g1', 'health', 10); // pendingChanges h:90
    tm._time = 99; // время изменилось

    const updates = panel.processUpdates();
    expect(updates.g1).toContain('t:99');
    expect(updates.g1).toContain('h:90');
  });

  it('очищает pendingChanges после обработки', () => {
    const panel = new Panel(panelConfig);
    const tm = makeTimerManager(100);
    panel.injectTimerManager(tm);
    panel.addUser('g1');

    panel.updateUser('g1', 'health', 10);
    panel.processUpdates();

    // время не менялось и pendingChanges пуст → нет обновлений
    const updates = panel.processUpdates();
    expect(updates.g1).toBeUndefined();
  });

  it('setActiveWeapon пишет activeKey схемы (wa)', () => {
    const panel = new Panel(panelConfig);
    const tm = makeTimerManager(100);
    panel.injectTimerManager(tm);
    panel.addUser('g1');

    panel.setActiveWeapon('g1', 'w2');
    const updates = panel.processUpdates();
    expect(updates.g1).toContain('wa:w2');
  });

  it('activeKey берётся из схемы, а не хардкода', async () => {
    vi.resetModules();
    const FreshPanel = (await import('../../packages/engine/src/host/meta/modules/Panel.js'))
      .default;
    const panel = new FreshPanel({
      fields: { health: { key: 'h', value: 100 } },
      activeKey: 'aw',
    });
    panel.injectTimerManager(makeTimerManager(100));
    panel.addUser('g1');

    panel.setActiveWeapon('g1', 'w1');
    expect(panel.processUpdates().g1).toContain('aw:w1');
  });

  it('invalidate сбрасывает pendingChanges', () => {
    const panel = new Panel(panelConfig);
    const tm = makeTimerManager(100);
    panel.injectTimerManager(tm);
    panel.addUser('g1');

    panel.updateUser('g1', 'health', 10);
    panel.invalidate('g1');
    tm._time = 100; // время не менялось

    const updates = panel.processUpdates();
    expect(updates.g1).toBeUndefined();
  });
});

describe('Panel.getFullPanel / getEmptyPanel', () => {
  it('getFullPanel возвращает время и все значения', () => {
    const panel = new Panel(panelConfig);
    panel.injectTimerManager(makeTimerManager(120));
    panel.addUser('g1');

    const full = panel.getFullPanel('g1');
    expect(full).toContain('t:120');
    expect(full).toContain('h:100');
    expect(full).toContain('w1:200');
    expect(full).toContain('w2:100');
  });

  it('getEmptyPanel возвращает время и ключи без значений', () => {
    const panel = new Panel(panelConfig);
    panel.injectTimerManager(makeTimerManager(120));

    const empty = panel.getEmptyPanel();
    expect(empty).toEqual(['t:120', 'h', 'w1', 'w2']);
  });
});

describe('Panel.reset', () => {
  it('возвращает значения пользователей к дефолтным', () => {
    const panel = new Panel(panelConfig);
    panel.addUser('g1');
    panel.updateUser('g1', 'health', 80); // health = 20

    panel.reset();
    expect(panel.getCurrentValue('g1', 'health')).toBe(100);
  });
});
