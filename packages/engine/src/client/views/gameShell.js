// DOM-каркас игрового интерфейса в коде (Этап 2 плана standalone-sdk).
// В прод-сборке движка разметку даёт pug (./includes/*.pug), но standalone
// SDK встраивается в чужую страницу репозитория игры, где никакого pug нет —
// а движковые модули (Auth, Chat, Panel, Stat, информеры) ищут элементы по
// фиксированным id. Поэтому каркас должен уметь собираться и без сборщика.
//
// Функция идемпотентна: существующие элементы не трогает и не переносит,
// поэтому в lobby-режиме (разметка уже в документе) не делает ничего.
// Второй источник разметки обязан совпадать с pug — расхождение ловит
// тест паритета (tests/client/gameShell.test.js).
//
// Здесь нет #vote (его создаёт в рантайме components/view/Vote.js) и нет
// канвасов: их размеры приходят в CONFIG_DATA — см. ensureCanvas().

const SHELL = [
  {
    tag: 'div',
    id: 'panel',
    children: [{ tag: 'h1', id: 'logo', text: 'VIMP' }],
  },
  {
    tag: 'div',
    id: 'chat',
    children: [
      { tag: 'div', id: 'chat-box' },
      // maxlength — UX-подсказка; авторитетный лимит на хосте (chatMaxLength)
      {
        tag: 'input',
        id: 'cmd',
        attrs: { type: 'text', maxlength: '60', autocomplete: 'off' },
      },
    ],
  },
  { tag: 'div', id: 'stat' },
  {
    tag: 'div',
    id: 'auth',
    children: [
      {
        tag: 'div',
        id: 'auth-form',
        attrs: { class: 'card' },
        children: [
          // заголовок и help-секции заполняет AuthView из authSchema.texts
          { tag: 'h2', id: 'auth-title' },
          { tag: 'div', id: 'auth-error', attrs: { class: 'form-error' } },
          { tag: 'div', id: 'auth-fields' },
          {
            tag: 'input',
            id: 'auth-enter',
            attrs: { type: 'button', autofocus: '', value: 'Start' },
          },
          { tag: 'div', id: 'auth-informs' },
          {
            tag: 'div',
            id: 'auth-link',
            children: [
              {
                tag: 'p',
                children: [
                  {
                    tag: 'a',
                    attrs: { href: 'https://github.com/lgick/vimp' },
                    text: 'GitHub',
                  },
                ],
              },
              // версия пакета игры (manifest.packageVersion) — текст пишет
              // main.js по AUTH_DATA
              { tag: 'p', id: 'auth-version' },
              { tag: 'p', text: `© ${new Date().getFullYear()} VIMP` },
            ],
          },
        ],
      },
    ],
  },
  { tag: 'div', id: 'game-informer' },
  { tag: 'div', id: 'tech-informer' },
];

// класс-маркер: правило `.vimp-shell > *` в style.css держит экраны скрытыми
// до того, как их покажет свой модуль. В прод-сборке контейнер — body, и
// правило совпадает с прежним `body > *`; в SDK это чужой div
export const SHELL_CLASS = 'vimp-shell';

/**
 * Достраивает недостающие контейнеры игрового интерфейса.
 *
 * Контейнер обязан быть полноэкранным и позиционированным
 * (`position: relative`): #panel, #stat и создаваемый в рантайме #vote —
 * `position: absolute`, и их containing block — ближайший позиционированный
 * предок.
 * @param {HTMLElement} [container] - Точка монтирования (по умолчанию body).
 * @returns {HTMLElement} Контейнер.
 */
export function ensureGameShell(container = document.body) {
  container.classList.add(SHELL_CLASS);
  buildNodes(SHELL, container, false);

  return container;
}

/**
 * Полотно игры по id из конфига канвасов (CONFIG_DATA). Уже размещённый в
 * документе элемент переиспользуется как есть — если игра положила
 * <canvas id="vimp"> в свою разметку, движок его не переносит.
 * @param {string} canvasId
 * @param {Object} size - { width, height } из конфига канвасов.
 * @param {HTMLElement} [container] - Точка монтирования (по умолчанию body).
 * @returns {HTMLCanvasElement}
 */
export function ensureCanvas(canvasId, size, container = document.body) {
  const canvas =
    document.getElementById(canvasId) ?? document.createElement('canvas');

  if (!canvas.parentNode) {
    canvas.setAttribute('id', canvasId);
    canvas.width = size.width;
    canvas.height = size.height;
    // палец на полотне ведёт игру, а не страницу: без этого браузер
    // смартфона забирает жест себе — прокрутка, pull-to-refresh, зум
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
  }

  return canvas;
}

/**
 * Набор id, которые собирает каркас. Нужен тесту паритета с pug.
 * @returns {Set<string>}
 */
export function shellIds() {
  const ids = new Set();
  const walk = nodes => {
    for (const node of nodes) {
      if (node.id) {
        ids.add(node.id);
      }

      walk(node.children ?? []);
    }
  };

  walk(SHELL);

  return ids;
}

// рекурсивно достраивает узлы: элемент с таким id уже есть — берём его и
// спускаемся внутрь (каркас мог быть собран частично), иначе создаём.
// Безымянные узлы (декоративные p/a внутри #auth-link) достраиваются только
// вместе со своим родителем: по ним нельзя проверить, есть ли они уже, и в
// готовой разметке они бы удвоились
function buildNodes(nodes, parent, parentCreated) {
  for (const node of nodes) {
    if (!node.id) {
      if (parentCreated) {
        const elem = createNode(node);

        parent.appendChild(elem);
        buildNodes(node.children ?? [], elem, true);
      }

      continue;
    }

    const existing = document.getElementById(node.id);
    const elem = existing ?? createNode(node);

    if (!existing) {
      parent.appendChild(elem);
    }

    buildNodes(node.children ?? [], elem, !existing);
  }
}

function createNode({ tag, id, attrs, text }) {
  const elem = document.createElement(tag);

  if (id) {
    elem.setAttribute('id', id);
  }

  for (const [name, value] of Object.entries(attrs ?? {})) {
    elem.setAttribute(name, value);
  }

  if (text !== undefined) {
    elem.textContent = text;
  }

  return elem;
}
