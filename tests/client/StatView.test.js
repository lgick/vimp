import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// StatView — синглтон, перезагружаем модуль для изоляции
let StatView;

// схема scoreboard: DOM генерируется view (контейнер — движок, схема — игра)
const config = {
  elems: { stat: 'stat' },
  params: {
    columns: ['names', 'score'],
    heads: { 1: 'table1' },
    bodies: { 1: 'table1', 2: 'table2' },
  },
};

// happy-dom 20 не реализует HTMLTableSectionElement.rows; StatView активно
// использует tHead.rows / tbody.rows / namedItem. Полифиллим живой геттер,
// вычисляющий строки из дочерних <tr> (insertRow/insertCell/cells работают).
const addRowsPolyfill = el => {
  Object.defineProperty(el, 'rows', {
    configurable: true,
    get() {
      const trs = [...this.children].filter(c => c.tagName === 'TR');
      trs.namedItem = id => trs.find(tr => tr.id === id) || null;
      return trs;
    },
  });
};

const seedDom = () => {
  document.body.innerHTML = '<div id="stat"></div>';
};

const makeModel = () => ({ publisher: new Publisher() });

// конструирует view и полифиллит секции сгенерированных таблиц
const makeView = (model = makeModel()) => {
  const view = new StatView(model, config);

  document
    .querySelectorAll('#stat thead, #stat tbody')
    .forEach(addRowsPolyfill);

  return view;
};

beforeEach(async () => {
  vi.resetModules();
  seedDom();
  StatView = (await import('../../packages/engine/src/client/components/view/Stat.js')).default;
});

describe('StatView: генерация DOM по схеме', () => {
  it('строит шапку по columns и таблицы по bodies', () => {
    makeView();

    const headSpans = document.querySelectorAll('#stat .stat-head span');
    expect([...headSpans].map(s => s.textContent)).toEqual(['names', 'score']);

    const tables = document.querySelectorAll('#stat .stat-tables table');
    expect([...tables].map(t => t.id)).toEqual(['table1', 'table2']);

    // в шапке каждой таблицы — по ячейке на колонку
    const headCells = document.querySelectorAll('#table1 thead td');
    expect(headCells.length).toBe(2);
    expect(document.querySelector('#table2 tbody')).not.toBeNull();
  });
});

describe('StatView: открытие/закрытие', () => {
  it('open/close переключают display', () => {
    const view = makeView();

    view.open();
    expect(document.getElementById('stat').style.display).toBe('block');

    view.close();
    expect(document.getElementById('stat').style.display).toBe('none');
  });
});

describe('StatView.updateTableHead', () => {
  it('заполняет ячейки заголовка', () => {
    const view = makeView();

    view.updateTableHead({
      tableId: 'table1',
      rowNumber: 0,
      cellsData: ['Имя', 'Очки'],
    });

    const cells = document.querySelector('#table1 thead tr').cells;
    expect(cells[0].textContent).toBe('Имя');
    expect(cells[1].textContent).toBe('Очки');
  });
});

describe('StatView.clearBodies', () => {
  it('очищает содержимое всех tbody', () => {
    const view = makeView();
    view.updateTableBody({
      tableId: 'table1',
      bodyNumber: 0,
      id: 'p1',
      cellsData: ['Bob', '10'],
      sortData: null,
    });

    view.clearBodies(['table1']);

    expect(document.querySelector('#table1 tbody').textContent).toBe('');
  });
});

describe('StatView.updateTableBody', () => {
  it('создаёт строку при отсутствии и наличии данных', () => {
    const view = makeView();

    view.updateTableBody({
      tableId: 'table1',
      bodyNumber: 0,
      id: 'p1',
      cellsData: ['Bob', '10'],
      sortData: null,
    });

    const row = document.getElementById('stat_p1');
    expect(row).not.toBeNull();
    expect(row.cells[0].textContent).toBe('Bob');
    expect(row.cells[1].textContent).toBe('10');
  });

  it('обновляет ячейки существующей строки', () => {
    const view = makeView();
    const base = { tableId: 'table1', bodyNumber: 0, id: 'p1', sortData: null };

    view.updateTableBody({ ...base, cellsData: ['Bob', '10'] });
    view.updateTableBody({ ...base, cellsData: ['Bob', '25'] });

    expect(document.getElementById('stat_p1').cells[1].textContent).toBe('25');
  });

  it('удаляет строку при cellsData === null', () => {
    const view = makeView();
    const base = { tableId: 'table1', bodyNumber: 0, id: 'p1', sortData: null };

    view.updateTableBody({ ...base, cellsData: ['Bob', '10'] });
    view.updateTableBody({ ...base, cellsData: null });

    expect(document.getElementById('stat_p1')).toBeNull();
  });

  it('сортирует строки по убыванию указанной колонки', () => {
    const view = makeView();
    const base = { tableId: 'table1', bodyNumber: 0, sortData: [[1, true]] };

    // сначала игрок с меньшим счётом, затем с большим
    view.updateTableBody({ ...base, id: 'low', cellsData: ['Low', '10'] });
    view.updateTableBody({ ...base, id: 'high', cellsData: ['High', '20'] });

    const rows = document.querySelectorAll('#table1 tbody tr');
    // строка с большим счётом должна оказаться первой
    expect(rows[0].id).toBe('stat_high');
    expect(rows[1].id).toBe('stat_low');
  });
});

describe('StatView: события модели', () => {
  it('open/close/tHead/tBody/clearBodies проксируются', () => {
    const model = makeModel();
    makeView(model);

    model.publisher.emit('open');
    expect(document.getElementById('stat').style.display).toBe('block');

    model.publisher.emit('tBody', {
      tableId: 'table1',
      bodyNumber: 0,
      id: 'p9',
      cellsData: ['Z', '1'],
      sortData: null,
    });
    expect(document.getElementById('stat_p9')).not.toBeNull();
  });
});
