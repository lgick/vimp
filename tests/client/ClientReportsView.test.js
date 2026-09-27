import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// ClientReportsView — синглтон, перезагружаем модуль для изоляции
let ClientReportsView;

const config = {
  statuses: [
    { id: 'open', title: 'Open' },
    { id: 'fixed', title: 'Fixed' },
    { id: 'ignored', title: 'Ignored' },
    { id: 'all', title: 'All' },
  ],
  elems: {
    panelId: 'reports-panel',
    lobbyId: 'lobby',
    openBtnId: 'reports-open',
    closeBtnId: 'reports-close',
    filtersId: 'reports-filters',
    gameSelectId: 'reports-game',
    listId: 'reports-list',
    moreBtnId: 'reports-more',
    errorId: 'reports-error',
  },
};

const seedDom = () => {
  document.body.innerHTML = `
    <div id="lobby" style="display:flex">
      <input type="button" id="reports-open" style="display:none">
    </div>
    <div id="reports-panel" style="display:none">
      <input type="button" id="reports-close">
      <div id="reports-filters"></div>
      <select id="reports-game"><option value="">All games</option></select>
      <ul id="reports-list"></ul>
      <div id="reports-error"></div>
      <input type="button" id="reports-more">
    </div>
  `;
};

const XSS = '<img src=x onerror=alert(1)>';

const report = (overrides = {}) => ({
  id: 1,
  fingerprint: 'a'.repeat(64),
  source: 'client',
  kind: 'error',
  code: null,
  message: 'TypeError: boom',
  stack: 'at x (client.js:1:2)',
  details: null,
  engineVersion: '0.35.0',
  gameId: 'tanks',
  gameVersion: '1.2.3',
  box: 'vimp.example',
  mode: 'lobby',
  role: 'host',
  page: '/room/abc',
  userAgent: 'UA',
  count: 4,
  firstSeen: '2026-09-01T00:00:00.000Z',
  lastSeen: new Date(Date.now() - 5 * 60000).toISOString(),
  status: 'open',
  statusNote: null,
  statusByNick: null,
  statusAt: null,
  ...overrides,
});

const state = (items, extra = {}) => ({
  items,
  total: items.length,
  status: 'open',
  gameId: null,
  loading: false,
  error: null,
  ...extra,
});

let model;
let view;

beforeEach(async () => {
  vi.resetModules();
  seedDom();
  ClientReportsView = (
    await import('../../packages/engine/src/client/components/view/ClientReports.js')
  ).default;
  model = { publisher: new Publisher() };
  view = new ClientReportsView(model, config);
});

const $ = id => document.getElementById(id);
const actions = () =>
  [...$('reports-list').querySelectorAll('.reports-action-btn')].map(btn => btn.dataset.status);

describe('ClientReportsView: безопасность', () => {
  it('поля отчёта выводятся буквально, без разметки', () => {
    model.publisher.emit(
      'changed',
      state([
        report({
          message: XSS,
          stack: XSS,
          details: { html: XSS },
          box: XSS,
          userAgent: XSS,
          page: XSS,
          gameId: XSS,
          statusNote: XSS,
          statusAt: '2026-09-02T00:00:00.000Z',
          status: 'fixed',
        }),
      ]),
    );

    const list = $('reports-list');

    expect(list.querySelector('img')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(list.querySelector('.reports-full-message').textContent).toBe(XSS);
    expect(list.querySelectorAll('pre')[0].textContent).toBe(XSS);
    expect(list.querySelectorAll('pre')[1].textContent).toContain(XSS);
    expect(list.textContent).toContain(XSS);
  });
});

describe('ClientReportsView: список', () => {
  it('свёрнутая строка: давность, счётчик, вид, сообщение, версии, бокс, статус', () => {
    model.publisher.emit('changed', state([report()]));

    const summary = $('reports-list').querySelector('.reports-summary').textContent;

    expect(summary).toContain('5 min ago');
    expect(summary).toContain('×4');
    expect(summary).toContain('error/client');
    expect(summary).toContain('TypeError: boom');
    expect(summary).toContain('tanks@1.2.3');
    expect(summary).toContain('engine 0.35.0');
    expect(summary).toContain('vimp.example');
  });

  it('развёрнутая часть: роль и страница текстом, пустые — прочерк', () => {
    model.publisher.emit('changed', state([report({ id: 1 }), report({ id: 2, role: null, page: null })]));

    const details = [...$('reports-list').querySelectorAll('.reports-details')];

    expect(details[0].textContent).toContain('Role: host; page: /room/abc');
    expect(details[1].textContent).toContain('Role: —; page: —');
  });

  it('код важнее сообщения, длинное сообщение обрезается до 120', () => {
    model.publisher.emit(
      'changed',
      state([report({ id: 1, code: 'level.bad' }), report({ id: 2, message: 'x'.repeat(300) })]),
    );

    const messages = [...$('reports-list').querySelectorAll('.reports-message')];

    expect(messages[0].textContent).toBe('level.bad');
    expect(messages[1].textContent).toHaveLength(120);
  });

  it('развёрнутая часть открывается по клику и переживает перерисовку', () => {
    model.publisher.emit('changed', state([report()]));

    const details = () => $('reports-list').querySelector('.reports-details');

    expect(details().style.display).toBe('none');
    $('reports-list').querySelector('.reports-summary').click();
    expect(details().style.display).toBe('');

    model.publisher.emit('changed', state([report()]));
    expect(details().style.display).toBe('');
    expect(details().textContent).toContain('Fingerprint: aaaaaaaaaaaa');
  });

  it.each([
    ['open', ['fixed', 'ignored']],
    ['fixed', ['ignored', 'open']],
    ['ignored', ['fixed', 'open']],
  ])('кнопки статуса для %s', (status, expected) => {
    model.publisher.emit('changed', state([report({ status })]));

    expect(actions()).toEqual(expected);
  });

  it('кнопка решения публикует id, статус и заметку', () => {
    const seen = [];

    view.publisher.on('set-status', data => seen.push(data));
    model.publisher.emit('changed', state([report({ id: 7 })]));
    $('reports-list').querySelector('.reports-note-input').value = '  in 1.3  ';
    $('reports-list').querySelector('[data-status="fixed"]').click();
    $('reports-list').querySelector('.reports-note-input').value = '';
    $('reports-list').querySelector('[data-status="ignored"]').click();

    expect(seen).toEqual([
      { id: 7, status: 'fixed', note: 'in 1.3' },
      { id: 7, status: 'ignored', note: null },
    ]);
  });

  it('«Load more» виден, пока загружено меньше total', () => {
    model.publisher.emit('changed', state([report()], { total: 5 }));
    expect($('reports-more').style.display).toBe('');

    model.publisher.emit('changed', state([report()], { total: 1 }));
    expect($('reports-more').style.display).toBe('none');
  });

  it('ошибка — человеческой строкой', () => {
    model.publisher.emit('changed', state([], { error: 'forbidden' }));

    expect($('reports-error').textContent).toBe('Not enough rights');
  });
});

describe('ClientReportsView: панель и фильтры', () => {
  it('setAdmin прячет и показывает кнопку «Errors»', () => {
    view.setAdmin(true);
    expect($('reports-open').style.display).toBe('');

    view.setAdmin(false);
    expect($('reports-open').style.display).toBe('none');
  });

  it('открывается вместо лобби и возвращает его', () => {
    view.show();
    expect($('reports-panel').style.display).toBe('flex');
    expect($('lobby').style.display).toBe('none');

    $('reports-close').click();
    expect($('reports-panel').style.display).toBe('none');
    expect($('lobby').style.display).toBe('flex');
  });

  it('графы из конфига, активная выделена, клик публикует id', () => {
    const seen = [];

    view.publisher.on('filter', id => seen.push(id));
    model.publisher.emit('changed', state([], { status: 'fixed' }));

    const buttons = [...$('reports-filters').querySelectorAll('input')];

    expect(buttons.map(btn => btn.value)).toEqual(['Open', 'Fixed', 'Ignored', 'All']);
    expect(buttons.filter(btn => btn.classList.contains('active')).map(b => b.value)).toEqual([
      'Fixed',
    ]);

    buttons[3].click();
    expect(seen).toEqual(['all']);
  });

  it('игры каталога в селекте, смена публикует gameId (пусто → null)', () => {
    const seen = [];

    view.publisher.on('game', id => seen.push(id));
    view.setGames([{ id: 'tanks', title: 'Tanks' }]);

    const select = $('reports-game');

    expect([...select.options].map(o => o.value)).toEqual(['', 'tanks']);

    select.value = 'tanks';
    select.onchange();
    select.value = '';
    select.onchange();

    expect(seen).toEqual(['tanks', null]);
  });
});
