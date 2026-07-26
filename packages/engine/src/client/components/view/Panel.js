import Publisher from '../../../lib/Publisher.js';
import { lerp } from '../../../lib/math.js';

// Singleton PanelView

let panelView;

// дефолты bar-поля (могут переопределяться схемой игры)
const DEFAULT_BAR_BLOCKS = 30;
const DEFAULT_BAR_MAX = 100;
const EMPTY_BLOCK_COLOR = '#888';

export default class PanelView {
  // config — { containerId (движок), fields (схема игры: массив
  // { name, elem, type: 'bar'|'value'|'time'|'weapon', max?, blocks? }) }
  // Семантику ячейки задаёт type, а не имя поля: игра с полем `energy`
  // вместо `health` получает тот же бар
  constructor(model, config) {
    if (panelView) {
      return panelView;
    }

    panelView = this;

    const { containerId, fields } = config;

    this._panels = {};
    this._fields = {};
    this._bars = {};
    this._weaponList = fields
      .filter(field => field.type === 'weapon')
      .map(field => field.name);

    // DOM панели генерируется по схеме игры в порядке fields
    this._buildPanel(document.getElementById(containerId), fields);

    this.publisher = new Publisher();

    this._mPublic = model.publisher;
    this._mPublic.on('data', 'update', this);
    this._mPublic.on('hide', 'hidePanel', this);
    this._mPublic.on('activeWeapon', 'setCurrentWeapon', this);
  }

  // генерирует таблицу панели по схеме игры (замена хардкода panel.pug)
  _buildPanel(container, fields) {
    const table = document.createElement('table');
    const row = table.insertRow(-1);

    for (const field of fields) {
      const cell = row.insertCell(-1);

      cell.setAttribute('id', field.elem);
      this._panels[field.name] = cell;
      this._fields[field.name] = field;

      if (field.type === 'bar') {
        this._initBar(field, cell);
      }
    }

    container.appendChild(table);
  }

  // инициализирует полосу-бар поля type: 'bar'
  _initBar(field, cell) {
    cell.textContent = '';

    const wrapper = document.createElement('div');

    wrapper.className = 'panel-bar-wrapper';

    const total = field.blocks ?? DEFAULT_BAR_BLOCKS;
    const bar = {
      max: field.max ?? DEFAULT_BAR_MAX,
      total,
      blocks: [],
      colors: [],
    };

    for (let i = 0; i < total; i += 1) {
      const block = document.createElement('div');

      block.className = 'panel-bar-block';
      block.style.backgroundColor = EMPTY_BLOCK_COLOR;
      block.textContent = ' '; // неразрывный пробел

      wrapper.appendChild(block);

      bar.blocks.push(block);
      bar.colors.push(this.getBarBlockColor(i, total));
    }

    this._bars[field.name] = bar;
    cell.appendChild(wrapper);
  }

  // вычисляет цвет блока бара на основе его индекса
  getBarBlockColor(index, total) {
    const progress = index / (total - 1);

    const colors = [
      { p: 0, c: { r: 255, g: 50, b: 50 } }, // red
      { p: 0.25, c: { r: 255, g: 165, b: 0 } }, // orange
      { p: 0.5, c: { r: 255, g: 255, b: 0 } }, // yellow
      { p: 0.75, c: { r: 50, g: 205, b: 50 } }, // green
      { p: 1, c: { r: 0, g: 220, b: 220 } }, // cyan
    ];

    let start, end;

    for (let i = 1, len = colors.length; i < len; i += 1) {
      if (progress <= colors[i].p) {
        start = colors[i - 1];
        end = colors[i];
        break;
      }
    }

    const localProgress = (progress - start.p) / (end.p - start.p);
    const r = Math.round(lerp(start.c.r, end.c.r, localProgress));
    const g = Math.round(lerp(start.c.g, end.c.g, localProgress));
    const b = Math.round(lerp(start.c.b, end.c.b, localProgress));

    return `rgb(${r}, ${g}, ${b})`;
  }

  // обновляет пользовательскую панель
  update(data) {
    const { name, value } = data;
    const elem = this._panels[name];

    if (this._fields[name]?.type === 'bar') {
      this._updateBar(name, value);
    } else {
      elem.textContent = value;
    }

    elem.style.display = 'table-cell';
  }

  // перерисовывает бар по текущему значению
  _updateBar(name, value) {
    const { max, total, blocks, colors } = this._bars[name];
    const blocksToShow = Math.ceil((value / max) * total);

    blocks.forEach((block, index) => {
      if (index < blocksToShow) {
        block.className = 'panel-bar-block';
        block.style.backgroundColor = colors[index];
      } else {
        block.className = 'panel-bar-block-empty';
        block.style.backgroundColor = EMPTY_BLOCK_COLOR;
      }
    });

    // мигание для последнего неполного блока
    const exactBlocks = (value / max) * total;

    if (value > 0 && exactBlocks % 1 !== 0) {
      blocks[blocksToShow - 1].classList.add('panel-bar-blink');
    }
  }

  hidePanel(name) {
    this._panels[name].style.display = 'none';
  }

  // устанавливает активное оружие
  setCurrentWeapon(activeWeaponName) {
    for (const weaponName of this._weaponList) {
      const elem = this._panels[weaponName];

      if (weaponName === activeWeaponName) {
        elem.classList.add('active');
      } else {
        elem.classList.remove('active');
      }
    }
  }
}
