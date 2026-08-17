import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ensureGameShell,
  ensureCanvas,
  shellIds,
  SHELL_CLASS,
} from '../../packages/engine/src/client/views/gameShell.js';

// DOM-каркас игрового интерфейса (Этап 2 плана standalone-sdk). Главное
// здесь — паритет двух источников разметки: pug прод-сборки и код каркаса
// SDK. Разъедутся — движковые модули начнут искать несуществующие id.

const PUG_FILES = ['panel', 'chat', 'stat', 'auth', 'informer'];

const pugIds = () => {
  const ids = new Set();

  for (const name of PUG_FILES) {
    // happy-dom подменяет import.meta.url — путь строим от корня репозитория
    const path = resolve(
      process.cwd(),
      `packages/engine/src/client/views/includes/${name}.pug`,
    );
    const source = readFileSync(path, 'utf8');

    // #id в pug: тег/класс могут идти до и после, комментарии (//-) пропускаем
    for (const line of source.split('\n')) {
      if (line.trim().startsWith('//-')) {
        continue;
      }

      for (const match of line.matchAll(/#([A-Za-z][\w-]*)/g)) {
        ids.add(match[1]);
      }
    }
  }

  return ids;
};

describe('gameShell', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.body.className = '';
  });

  it('паритет с pug: набор id совпадает с прод-разметкой', () => {
    expect([...shellIds()].sort()).toEqual([...pugIds()].sort());
  });

  it('собирает каркас в переданном контейнере', () => {
    const container = document.createElement('div');

    document.body.appendChild(container);
    ensureGameShell(container);

    for (const id of shellIds()) {
      const elem = document.getElementById(id);

      expect(elem, id).not.toBeNull();
      expect(container.contains(elem), id).toBe(true);
    }

    // #vote создаёт в рантайме view/Vote.js, канвасы — CONFIG_DATA
    expect(document.getElementById('vote')).toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('ставит класс-маркер на контейнер и на body по умолчанию', () => {
    const container = document.createElement('div');

    document.body.appendChild(container);
    ensureGameShell(container);

    expect(container.classList.contains(SHELL_CLASS)).toBe(true);
    expect(document.body.classList.contains(SHELL_CLASS)).toBe(false);

    ensureGameShell();

    expect(document.body.classList.contains(SHELL_CLASS)).toBe(true);
  });

  it('не задаёт экранам инлайновый display: видимость держит только CSS', () => {
    const container = document.createElement('div');

    document.body.appendChild(container);
    ensureGameShell(container);

    for (const id of shellIds()) {
      expect(document.getElementById(id).style.display, id).toBe('');
    }
  });

  it('идемпотентен: повторный вызов ничего не дублирует', () => {
    ensureGameShell();

    const html = document.body.innerHTML;

    ensureGameShell();
    ensureGameShell();

    expect(document.body.innerHTML).toBe(html);
  });

  it('не трогает уже готовые элементы разметки', () => {
    const panel = document.createElement('div');

    panel.setAttribute('id', 'panel');
    panel.dataset.fromPug = '1';
    document.body.appendChild(panel);

    ensureGameShell();

    expect(document.getElementById('panel')).toBe(panel);
    expect(document.querySelectorAll('#panel')).toHaveLength(1);
    // недостающий потомок достраивается внутрь существующего родителя
    expect(panel.querySelector('#logo')).not.toBeNull();
  });
});

describe('ensureCanvas', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('создаёт полотно в контейнере по размерам конфига', () => {
    const container = document.createElement('div');

    document.body.appendChild(container);

    const canvas = ensureCanvas('vimp', { width: 640, height: 480 }, container);

    expect(canvas.parentNode).toBe(container);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(480);
    expect(document.body.querySelector(':scope > canvas')).toBeNull();
  });

  it('переиспользует полотно игры и не переносит его', () => {
    const container = document.createElement('div');
    const own = document.createElement('canvas');

    own.setAttribute('id', 'vimp');
    document.body.appendChild(own);
    document.body.appendChild(container);

    const canvas = ensureCanvas('vimp', { width: 10, height: 10 }, container);

    expect(canvas).toBe(own);
    expect(own.parentNode).toBe(document.body);
    expect(container.children).toHaveLength(0);
  });
});
