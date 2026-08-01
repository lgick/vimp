import Publisher from '../../../lib/Publisher.js';
import { lerp } from '../../../lib/math.js';

// Singleton PanelView

let panelView;

// дефолты bar-поля (могут переопределяться схемой игры)
const DEFAULT_BAR_BLOCKS = 30;
const DEFAULT_BAR_MAX = 100;
const EMPTY_BLOCK_COLOR = '#888';
const BAR_FILL_DELAY_MS = 500;
const BAR_FILL_DURATION_MS = 500;

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
      // последнее известное целевое состояние — используется для
      // синхронизированного заполнения бара в начале раунда
      lastBlocksToShow: 0,
      lastBlink: false,
      // true пока идёт заполнение слева направо в начале раунда — обычные
      // update() в это время не должны перерисовывать бар мгновенно
      animating: false,
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
    const bar = this._bars[name];
    const blocksToShow = Math.ceil((value / bar.max) * bar.total);
    const exactBlocks = (value / bar.max) * bar.total;
    const blink = value > 0 && exactBlocks % 1 !== 0;

    // запоминаем целевое состояние — из него в начале раунда собирается
    // заполнение слева направо
    bar.lastBlocksToShow = blocksToShow;
    bar.lastBlink = blink;

    // пока идёт заполнение бара в начале раунда, не перерисовываем его
    // мгновенно — иначе повторный update() (например, эхо того же
    // значения) перебьёт постепенное заполнение
    if (!bar.animating) {
      this._paintBar(name, blocksToShow, blink);
    }
  }

  // отрисовывает бар мгновенно: blocksToShow закрашенных блоков слева,
  // остальные — пустые; blink — мигание последнего неполного блока
  _paintBar(name, blocksToShow, blink) {
    const { blocks, colors } = this._bars[name];

    blocks.forEach((block, index) => {
      if (index < blocksToShow) {
        block.className = 'panel-bar-block';
        block.style.backgroundColor = colors[index];
      } else {
        block.className = 'panel-bar-block-empty';
        block.style.backgroundColor = EMPTY_BLOCK_COLOR;
      }
    });

    if (blink) {
      blocks[blocksToShow - 1].classList.add('panel-bar-blink');
    }
  }

  // заполняет бар слева направо блок за блоком за BAR_FILL_DURATION_MS,
  // до последнего известного целевого значения (lastBlocksToShow)
  _animateBarFill(name) {
    const bar = this._bars[name];
    const { blocks, colors, lastBlocksToShow, lastBlink } = bar;
    const step =
      lastBlocksToShow > 0 ? BAR_FILL_DURATION_MS / lastBlocksToShow : 0;

    for (let index = 0; index < lastBlocksToShow; index += 1) {
      setTimeout(() => {
        blocks[index].className = 'panel-bar-block';
        blocks[index].style.backgroundColor = colors[index];

        if (lastBlink && index === lastBlocksToShow - 1) {
          blocks[index].classList.add('panel-bar-blink');
        }
      }, step * index);
    }

    setTimeout(() => {
      bar.animating = false;
    }, step * lastBlocksToShow);
  }

  hidePanel(name) {
    this._panels[name].style.display = 'none';
  }

  // проигрывает shimmer-анимацию лого один раз в начале раунда и с
  // задержкой BAR_FILL_DELAY_MS заполняет bar-поля (например, здоровье)
  // слева направо за BAR_FILL_DURATION_MS: к этому моменту актуальное
  // значение уже пришло через PS_PANEL_DATA (см. порядок отправки в
  // RoundManager._startRound)
  playRoundStart() {
    const logo = document.getElementById('logo');

    logo.classList.remove('logo-round-start');
    void logo.offsetWidth; // reflow: перезапуск анимации при повторном добавлении класса
    logo.classList.add('logo-round-start');

    logo.addEventListener(
      'animationend',
      () => logo.classList.remove('logo-round-start'),
      { once: true },
    );

    for (const name of Object.keys(this._bars)) {
      const bar = this._bars[name];

      bar.animating = true;
      this._paintBar(name, 0, false);

      setTimeout(() => this._animateBarFill(name), BAR_FILL_DELAY_MS);
    }
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
