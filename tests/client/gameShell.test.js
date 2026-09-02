import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ensureGameShell,
  ensureCanvas,
  shellIds,
  SHELL_CLASS,
  LETTERBOX_CLASS,
  showBootFailure,
} from '../../packages/engine/src/client/views/gameShell.js';

// DOM-каркас игрового интерфейса (Этап 2 плана standalone-sdk). Главное
// здесь — паритет двух источников разметки: pug прод-сборки и код каркаса
// SDK. Разъедутся — движковые модули начнут искать несуществующие id.

const PUG_FILES = ['panel', 'chat', 'stat', 'auth', 'informer'];

const readRepoFile = path => readFileSync(resolve(process.cwd(), path), 'utf8');

// [селектор, тело] всех правил таблицы. Разбор грубый, но полный: сначала
// снимаются комментарии (иначе текст про `body > *` попал бы в проверки),
// затем разворачиваются вложенные at-правила (@media/@supports/@keyframes) —
// раньше они просто отбрасывались, и правило внутри @media проходило бы мимо
// проверок незамеченным (review-3.md, R3-5)
const cssRules = source =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // at-правила без блока (@charset/@import/@namespace/@layer a;) снимаются
    // первыми: иначе `[^{]*` следующей регулярки прошла бы сквозь `;` до
    // скобки ПЕРВОГО настоящего правила и съела бы его вместе с селектором
    // (review-4.md, R4-1 — в style.css первой строкой стоит @charset).
    // Список закрытый, чтобы `@` внутри url() или строки не выглядел для
    // регулярки началом at-правила (review-5.md, R5-4)
    .replace(/@(charset|import|namespace|layer)\b[^;{]*;/g, '')
    // тело at-правила поднимается на верхний уровень вместе со своими
    // правилами, сам заголовок (@media …) выбрасывается
    .replace(/@[\w-]+[^{]*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g, '$1')
    .split('}')
    .map(chunk => chunk.split('{'))
    .filter(parts => parts.length === 2)
    .map(([selector, body]) => [selector.trim(), body.trim()]);

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

  // каскад CSS happy-dom не считает, поэтому единственная страховка от
  // повторения P1-1 (чёрный экран в контейнере SDK) — статика
  it('скрытие экранов: класс-форма в style.css, FOUC-форма в index.html', () => {
    const rules = cssRules(readRepoFile('packages/engine/src/client/style.css'));
    const shellRule = rules.find(
      ([selector]) => selector === `.${SHELL_CLASS} > *`,
    );

    expect(shellRule, `правило .${SHELL_CLASS} > * в style.css`).toBeDefined();
    expect(shellRule[1]).toMatch(/display:\s*none/);

    // `body > *` в публикуемой таблице погасило бы и первый уровень страницы,
    // встраивающей SDK, — там правило целится только в контейнер каркаса
    expect(rules.map(([selector]) => selector)).not.toContain('body > *');

    // на своей странице оно, наоборот, нужно: до исполнения JS класса на body
    // ещё нет и pug-разметка мигнула бы
    const html = readRepoFile('packages/engine/index.html').replace(/\s+/g, ' ');

    expect(html).toMatch(/body > \* \{ display: none; \}/);
  });

  // сам парсер: правило, спрятанное в @media, обязано доезжать до проверок
  // ниже — иначе страховка от P1-1 имеет слепое пятно (review-3.md, R3-5).
  // Фикстура повторяет форму настоящего style.css: @charset первой строкой
  // (review-4.md, R4-1 — без его снятия первое правило пропадало из разбора)
  it('разбор CSS видит правила внутри at-правил', () => {
    const rules = cssRules(
      '@charset "UTF-8"; #a { color: red; } @media (max-width: 1px) { #stat { display: block; } #b { color: blue; } } #c { color: green; }',
    );

    expect(rules).toContainEqual(['#stat', 'display: block;']);
    expect(rules.map(([selector]) => selector)).toEqual([
      '#a',
      '#stat',
      '#b',
      '#c',
    ]);
  });

  it('первый уровень каркаса не объявляет своего display', () => {
    const container = document.createElement('div');

    document.body.appendChild(container);
    ensureGameShell(container);

    const rules = cssRules(readRepoFile('packages/engine/src/client/style.css'));

    // именно на этом держится скрытие: собственный display у #stat или
    // #tech-informer перебил бы `.vimp-shell > *` и показал экран сразу
    for (const child of container.children) {
      for (const [selector, body] of rules) {
        if (selector === `#${child.id}`) {
          expect(body, child.id).not.toMatch(/(^|;)\s*display\s*:/);
        }
      }
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

  it('помечает классом леттербокса полотно, которое тянет движок', () => {
    const container = document.createElement('div');

    document.body.appendChild(container);

    const canvas = ensureCanvas(
      'vimp',
      { width: 960, height: 600, aspectRatio: '16:10' },
      container,
    );

    expect(canvas.classList.contains(LETTERBOX_CLASS)).toBe(true);
  });

  // регрессия: правило по типу `canvas` подмешивало оверлею игры
  // bottom/left/margin, и радар vimp-tanks уезжал из угла в центр экрана
  it('не помечает полотно фиксированного размера — его кладёт игра', () => {
    const container = document.createElement('div');

    document.body.appendChild(container);

    const canvas = ensureCanvas(
      'radar',
      { width: 150, height: 150, fixSize: '150' },
      container,
    );

    expect(canvas.classList.contains(LETTERBOX_CLASS)).toBe(false);
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

// Терминальный отказ загрузки (кодревью master-game-registry, находка 1).
// Раньше здесь стояло `document.body.textContent = …`: разметка страницы
// стиралась целиком, вместе с формой входа и панелью реестра игр, — то есть
// отказ уносил с собой и путь к своему исправлению.
describe('showBootFailure', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('пишет в информер каркаса и не трогает остальную разметку', () => {
    ensureGameShell();

    const lobby = document.createElement('div');

    lobby.setAttribute('id', 'lobby');
    document.body.appendChild(lobby);

    showBootFailure('Failed to load the game: boom');

    const informer = document.getElementById('tech-informer');

    expect(informer.textContent).toBe('Failed to load the game: boom');
    expect(informer.style.display).toBe('block');
    // главное: панель реестра и форма входа на месте — модератор, отключивший
    // последнюю игру, должен уметь вернуть её из той же вкладки
    expect(document.getElementById('lobby')).toBe(lobby);
    expect(document.getElementById('auth-form')).not.toBeNull();
  });

  it('без каркаса добавляет узел ПЕРЕД содержимым, а не вместо него', () => {
    const container = document.createElement('div');
    const kept = document.createElement('p');

    kept.textContent = 'sign in';
    container.appendChild(kept);
    document.body.appendChild(container);

    showBootFailure('boom', container);

    expect(container.firstChild.getAttribute('id')).toBe('tech-informer');
    expect(container.contains(kept)).toBe(true);
  });
});
