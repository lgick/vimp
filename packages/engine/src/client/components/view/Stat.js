import Publisher from '../../../lib/Publisher.js';

// Singleton StatView

let statView;

export default class StatView {
  // config — { elems (движок: контейнер), params (схема игры: columns —
  // подписи колонок, bodies — таблицы команд) }
  constructor(model, config) {
    if (statView) {
      return statView;
    }

    statView = this;

    const { elems, params } = config;

    this._stat = document.getElementById(elems.stat);
    // контейнер списка глобального топа — только в режиме 'leaderboard'
    this._leaderboard = null;

    // DOM scoreboard генерируется по схеме игры: произвольное число
    // команд (bodies) и колонок (columns)
    this._buildStat(params);

    this.publisher = new Publisher();

    this._mPublic = model.publisher;

    this._mPublic.on('open', 'open', this);
    this._mPublic.on('close', 'close', this);
    this._mPublic.on('tHead', 'updateTableHead', this);
    this._mPublic.on('tBody', 'updateTableBody', this);
    this._mPublic.on('clearBodies', 'clearBodies', this);
    this._mPublic.on('leaderboard', 'updateLeaderboard', this);
  }

  // генерирует шапку и таблицы по схеме (замена хардкода stat.pug)
  _buildStat(params) {
    const { columns, bodies } = params;

    // snakes-v3 этап 4: режим 'leaderboard' — один список глобального топа
    // вместо шапки и таблиц команд. Строки рисует updateLeaderboard, здесь
    // заводится только контейнер
    if (params.mode === 'leaderboard') {
      this._leaderboard = document.createElement('div');
      this._leaderboard.className = 'stat-leaderboard';
      this._stat.appendChild(this._leaderboard);

      return;
    }

    const head = document.createElement('div');

    head.className = 'stat-head';

    for (const label of columns) {
      const span = document.createElement('span');

      span.textContent = label;
      head.appendChild(span);
    }

    const tables = document.createElement('div');

    tables.className = 'stat-tables';

    // порядок таблиц — по числовым ключам bodies (id команд)
    const tableNames = Object.keys(bodies)
      .sort((a, b) => a - b)
      .map(key => bodies[key]);

    for (const name of tableNames) {
      const table = document.createElement('table');

      table.setAttribute('id', name);

      const tHead = table.createTHead();
      const headRow = tHead.insertRow(-1);

      for (let i = 0, len = columns.length; i < len; i += 1) {
        headRow.insertCell(-1);
      }

      table.appendChild(document.createElement('tbody'));
      tables.appendChild(table);
    }

    this._stat.appendChild(head);
    this._stat.appendChild(tables);
  }

  // перерисовывает список глобального топа (режим 'leaderboard'):
  // место · ник · очки, своя строка помечена is-self. Список короткий и
  // приходит целиком — точечное обновление строк тут не окупается
  updateLeaderboard(rows) {
    if (!this._leaderboard) {
      return;
    }

    this._leaderboard.textContent = '';

    for (const row of rows) {
      const line = document.createElement('div');

      line.className = row.isSelf ? 'stat-row is-self' : 'stat-row';

      // неранжированный за период игрок места не имеет — прочерк вместо
      // числа честнее, чем выдуманная позиция
      for (const value of [row.place ?? '—', row.nick, row.score]) {
        const cell = document.createElement('span');

        // String(): ноль очков — это «0», а не пустая ячейка
        cell.textContent = String(value);
        line.appendChild(cell);
      }

      this._leaderboard.appendChild(line);
    }
  }

  // открывает статистику
  open() {
    this._stat.style.display = 'block';
  }

  // закрывает статистику
  close() {
    this._stat.style.display = 'none';
  }

  // очищает таблицы <tbody>
  clearBodies(bodiesList) {
    for (let i = 0, len = bodiesList.length; i < len; i += 1) {
      const table = document.getElementById(bodiesList[i]);
      const tBodies = table.tBodies;

      for (let i2 = 0, len2 = tBodies.length; i2 < len2; i2 += 1) {
        tBodies[i2].textContent = '';
      }
    }
  }

  // обновляет <thead>
  updateTableHead(data) {
    const table = document.getElementById(data.tableId);
    const cells = table.tHead.rows[data.rowNumber].cells;
    const cellsData = data.cellsData;

    for (let i = 0, len = cells.length; i < len; i += 1) {
      cells[i].textContent = cellsData[i];
    }
  }

  // обновляет <tbody>
  updateTableBody(data) {
    const table = document.getElementById(data.tableId);
    const tbody = table.tBodies[data.bodyNumber];
    let row = tbody.rows.namedItem(`stat_${data.id}`);
    const { cellsData, sortData } = data;

    // сортирует
    const sorting = rowIndex => {
      const row = tbody.rows[rowIndex];
      const prevRow = tbody.rows[rowIndex - 1];
      const nextRow = tbody.rows[rowIndex + 1];

      // если есть предыдущая строка
      if (prevRow) {
        for (let i = 0, len = sortData.length; i < len; i += 1) {
          const number = sortData[i][0];
          const type = sortData[i][1];
          const value = ~~row.cells[number].textContent;
          const prevValue = ~~prevRow.cells[number].textContent;

          // если type == true, значит сортировка по убыванию
          if (type) {
            // если предыдущее значение меньше текущего
            if (prevValue < value) {
              tbody.insertBefore(row, prevRow);
              sorting(rowIndex - 1);
              return;
            }

            if (prevValue > value) {
              break;
            }

            // иначе сортировка по возрастанию
          } else {
            // если предыдущее значение больше текущего
            if (prevValue > value) {
              tbody.insertBefore(row, prevRow);
              sorting(rowIndex - 1);
              return;
            }

            if (prevValue < value) {
              break;
            }
          }
        }
      }

      // если есть следующая строка
      if (nextRow) {
        for (let i = 0, len = sortData.length; i < len; i += 1) {
          const number = sortData[i][0];
          const type = sortData[i][1];
          const value = ~~row.cells[number].textContent;
          const nextValue = ~~nextRow.cells[number].textContent;

          // если type == true, значит сортировка по убыванию
          if (type) {
            // если следующее значение больше текущего
            if (nextValue > value) {
              tbody.insertBefore(nextRow, row);
              sorting(rowIndex + 1);
              return;
            }

            if (nextValue < value) {
              break;
            }

            // иначе сортировка по возрастанию
          } else {
            // если следующее значение меньше текущего
            if (nextValue < value) {
              tbody.insertBefore(nextRow, row);
              sorting(rowIndex + 1);
              return;
            }

            if (nextValue > value) {
              break;
            }
          }
        }
      }
    };

    // если строка отсутствует
    if (row === null) {
      // если есть данные для создания строки, создать ее
      if (cellsData !== null) {
        row = tbody.insertRow(-1);
        row.setAttribute('id', `stat_${data.id}`);

        for (let i = 0, len = cellsData.length; i < len; i += 1) {
          const cell = row.insertCell(i);
          cell.textContent = cellsData[i];
        }

        if (sortData) {
          sorting(row.sectionRowIndex);
        }
      }

      // иначе, если строка присутствует
    } else {
      // если данные строки === null, удалить строку
      if (cellsData === null) {
        row.parentNode.removeChild(row);

        // иначе обновить строку
      } else {
        const cells = row.cells;

        for (let i = 0, len = cells.length; i < len; i += 1) {
          cells[i].textContent = cellsData[i];
        }

        if (sortData) {
          sorting(row.sectionRowIndex);
        }
      }
    }
  }
}
