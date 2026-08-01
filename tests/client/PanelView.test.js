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

describe('PanelView.playRoundStart: заполнение bar-поля', () => {
  const filledCount = () =>
    [...document.querySelectorAll('#panel-energy div div')].filter(
      b => b.className === 'panel-bar-block',
    ).length;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('заполняет бар слева направо до значения текущего раунда за 500+500мс', () => {
    const view = new PanelView(makeModel(), config);

    view.playRoundStart();
    expect(filledCount()).toBe(0);

    // PS_PANEL_DATA текущего раунда пришёл сразу после триггера
    view.update({ name: 'energy', value: 100 });

    vi.advanceTimersByTime(500); // BAR_FILL_DELAY_MS — старт поблочного заполнения
    vi.advanceTimersByTime(500); // BAR_FILL_DURATION_MS — заполнение завершено
    expect(filledCount()).toBe(30);
  });

  it('данные, пришедшие позже 500мс, не заполняются до устаревшего значения', () => {
    const view = new PanelView(makeModel(), config);

    // предыдущий раунд оставил полный бар
    view.update({ name: 'energy', value: 100 });

    view.playRoundStart();
    expect(filledCount()).toBe(0);

    // задержка PS_PANEL_DATA — данные ещё не пришли к моменту истечения
    // BAR_FILL_DELAY_MS
    vi.advanceTimersByTime(500);
    expect(filledCount()).toBe(0);

    // данные текущего раунда пришли позже — отрисовываются мгновенно, без
    // поблочной анимации
    view.update({ name: 'energy', value: 40 });
    expect(filledCount()).toBe(12);
  });

  it('изменение значения во время заполнения — по завершении показан актуальный HP', () => {
    const view = new PanelView(makeModel(), config);

    view.playRoundStart();
    view.update({ name: 'energy', value: 100 });

    vi.advanceTimersByTime(500); // старт поблочного заполнения к 100

    // урон пришёл в процессе заполнения
    view.update({ name: 'energy', value: 50 });

    vi.advanceTimersByTime(500); // BAR_FILL_DURATION_MS истекает
    expect(filledCount()).toBe(15);
  });

  it('повторный playRoundStart не гонится со старой анимацией', () => {
    const view = new PanelView(makeModel(), config);

    view.playRoundStart();
    view.update({ name: 'energy', value: 100 });
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(250); // заполнение первого раунда на середине

    // новый раунд начался раньше, чем предыдущая анимация завершилась
    view.playRoundStart();
    expect(filledCount()).toBe(0);

    view.update({ name: 'energy', value: 60 });
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(500);
    expect(filledCount()).toBe(18);
  });
});
