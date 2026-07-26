import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// PanelView — синглтон, перезагружаем модуль для изоляции
let PanelView;

// схема панели: контейнер — движок, ячейки генерирует view по типам
// схемы игры (Д2: семантику задаёт type, а не имя поля)
const config = {
  containerId: 'panel',
  fields: [
    { name: 'energy', elem: 'panel-energy', type: 'bar', max: 100, blocks: 30 },
    { name: 'w1', elem: 'panel-w1', type: 'weapon' },
    { name: 'w2', elem: 'panel-w2', type: 'weapon' },
    { name: 'time', elem: 'panel-time', type: 'time' },
  ],
};

const seedDom = () => {
  document.body.innerHTML = '<div id="panel"></div>';
};

const makeModel = () => ({ publisher: new Publisher() });

beforeEach(async () => {
  vi.resetModules();
  seedDom();
  PanelView = (await import('../../packages/engine/src/client/components/view/Panel.js'))
    .default;
});

describe('PanelView: генерация DOM по схеме', () => {
  it('строит ячейки в порядке fields схемы', () => {
    new PanelView(makeModel(), config);

    const cells = document.querySelectorAll('#panel table td');
    expect([...cells].map(c => c.id)).toEqual([
      'panel-energy',
      'panel-w1',
      'panel-w2',
      'panel-time',
    ]);
  });
});

describe('PanelView: bar-поле', () => {
  it('создаёт заданное схемой число блоков внутри обёртки', () => {
    new PanelView(makeModel(), config);

    const wrapper = document.querySelector('.panel-bar-wrapper');
    expect(wrapper).not.toBeNull();
    expect(wrapper.querySelectorAll('.panel-bar-block').length).toBe(30);
  });

  it('уважает нестандартное число блоков', () => {
    new PanelView(makeModel(), {
      containerId: 'panel',
      fields: [{ name: 'fuel', elem: 'panel-fuel', type: 'bar', blocks: 10 }],
    });

    expect(document.querySelectorAll('.panel-bar-block').length).toBe(10);
  });
});

describe('PanelView.update', () => {
  it('текстовая панель получает значение', () => {
    const view = new PanelView(makeModel(), config);

    view.update({ name: 'time', value: '02:30' });

    // happy-dom не хранит display: table-cell, проверяем смысловую часть
    expect(document.getElementById('panel-time').textContent).toBe('02:30');
  });

  it('полное значение bar-поля подсвечивает все блоки', () => {
    const view = new PanelView(makeModel(), config);

    view.update({ name: 'energy', value: 100 });

    const blocks = document.querySelectorAll('#panel-energy div div');
    const filled = [...blocks].filter(
      b => b.className === 'panel-bar-block',
    );
    expect(filled.length).toBe(30);
  });

  it('половина значения заполняет половину блоков', () => {
    const view = new PanelView(makeModel(), config);

    view.update({ name: 'energy', value: 50 });

    const blocks = [...document.querySelectorAll('#panel-energy div div')];
    const empty = blocks.filter(
      b => b.className === 'panel-bar-block-empty',
    );
    expect(empty.length).toBe(15);
  });

  it('bar масштабируется по max из схемы', () => {
    const view = new PanelView(makeModel(), {
      containerId: 'panel',
      fields: [
        { name: 'fuel', elem: 'panel-fuel', type: 'bar', max: 200, blocks: 10 },
      ],
    });

    view.update({ name: 'fuel', value: 100 });

    const blocks = [...document.querySelectorAll('#panel-fuel div div')];
    const filled = blocks.filter(b => b.className === 'panel-bar-block');
    expect(filled.length).toBe(5);
  });
});

describe('PanelView.hidePanel / setCurrentWeapon', () => {
  it('hidePanel скрывает указанную панель', () => {
    const view = new PanelView(makeModel(), config);

    view.hidePanel('time');
    expect(document.getElementById('panel-time').style.display).toBe('none');
  });

  it('setCurrentWeapon помечает активное оружие классом active', () => {
    const view = new PanelView(makeModel(), config);

    view.setCurrentWeapon('w2');

    expect(
      document.getElementById('panel-w1').classList.contains('active'),
    ).toBe(false);
    expect(
      document.getElementById('panel-w2').classList.contains('active'),
    ).toBe(true);
  });
});

describe('PanelView: события модели', () => {
  it('data → update, activeWeapon → setCurrentWeapon', () => {
    const model = makeModel();
    new PanelView(model, config);

    model.publisher.emit('data', { name: 'time', value: '01:00' });
    model.publisher.emit('activeWeapon', 'w1');

    expect(document.getElementById('panel-time').textContent).toBe('01:00');
    expect(
      document.getElementById('panel-w1').classList.contains('active'),
    ).toBe(true);
  });
});
