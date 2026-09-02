import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// GamesView — синглтон, перезагружаем модуль для изоляции
let GamesView;

const config = {
  statuses: [
    { id: 'pending', title: 'Pending' },
    { id: 'approved', title: 'Published' },
  ],
  defaultStatus: 'pending',
  stagedSuffix: ' (test)',
  elems: {
    panelId: 'games-panel',
    lobbyId: 'lobby',
    openMineBtnId: 'games-open-mine',
    openModerationBtnId: 'games-open-moderation',
    closeBtnId: 'games-close',
    mineListId: 'games-mine-list',
    submitFormId: 'games-submit-form',
    submitErrorId: 'games-submit-error',
    submitBtnId: 'games-submit',
    fieldIds: {
      id: 'games-field-id',
      packageName: 'games-field-package',
      version: 'games-field-version',
      repoUrl: 'games-field-repo',
      title: 'games-field-title',
    },
    moderationId: 'games-moderation',
    adminListId: 'games-admin-list',
    adminErrorId: 'games-admin-error',
    filtersId: 'games-filters',
  },
};

const seedDom = () => {
  document.body.innerHTML = `
    <div id="lobby"></div>
    <div id="games-panel">
      <div id="games-mine">
        <input type="button" id="games-open-mine">
        <input type="button" id="games-open-moderation">
        <input type="button" id="games-close">
        <ul id="games-mine-list"></ul>
        <form id="games-submit-form">
          <input type="text" id="games-field-id">
          <input type="text" id="games-field-package">
          <input type="text" id="games-field-version">
          <input type="text" id="games-field-repo">
          <input type="text" id="games-field-title">
          <div id="games-submit-error"></div>
          <input type="submit" id="games-submit">
        </form>
      </div>
      <div id="games-moderation">
        <div id="games-filters"></div>
        <ul id="games-admin-list"></ul>
        <div id="games-admin-error"></div>
      </div>
    </div>
  `;
};

let model;
let view;

beforeEach(async () => {
  vi.resetModules();
  seedDom();
  GamesView = (
    await import('../../packages/engine/src/client/components/view/Games.js')
  ).default;
  model = { publisher: new Publisher() };
  view = new GamesView(model, config);
});

const $ = id => document.getElementById(id);

describe('GamesView: панель', () => {
  it('открывается вместо лобби, модерация — только по флагу', () => {
    view.show(false);

    expect($('games-panel').style.display).toBe('flex');
    expect($('lobby').style.display).toBe('none');
    expect($('games-moderation').style.display).toBe('none');

    view.show(true);

    expect($('games-moderation').style.display).toBe('block');
  });

  it('кнопка модерации показывается только админу', () => {
    view.setAdmin(false);

    expect($('games-open-moderation').style.display).toBe('none');

    view.setAdmin(true);

    expect($('games-open-moderation').style.display).toBe('');
  });

  it('закрытая панель разметку лобби не трогает', () => {
    $('games-panel').style.display = 'none';
    $('lobby').style.display = 'none';
    view.hide();

    expect($('lobby').style.display).toBe('none');
  });

  it('«Назад в лобби» возвращает лобби', () => {
    view.show(false);
    $('games-close').click();

    expect($('games-panel').style.display).toBe('none');
    expect($('lobby').style.display).toBe('flex');
  });
});

describe('GamesView: формы и списки', () => {
  it('submit отдаёт значения полей', () => {
    const seen = [];

    view.publisher.on('submit', form => seen.push(form));
    $('games-field-id').value = ' tanks ';
    $('games-field-package').value = '@vimp-games/tanks';
    $('games-submit-form').dispatchEvent(new Event('submit'));

    expect(seen[0]).toMatchObject({ id: 'tanks', packageName: '@vimp-games/tanks' });
  });

  it('успешная заявка очищает поля формы', () => {
    $('games-field-id').value = 'tanks';
    $('games-field-package').value = '@vimp-games/tanks';
    $('games-field-version').value = '1.0.0';

    model.publisher.emit('submitted');

    Object.values(config.elems.fieldIds).forEach(id => {
      expect($(id).value).toBe('');
    });
  });

  it('рисует свои заявки со статусом и замечанием модератора', () => {
    model.publisher.emit('mine-changed', [
      { id: 'tanks', packageName: '@vimp-games/tanks', version: '1.0.0', status: 'rejected', moderatorNote: 'нет карт' },
    ]);

    const text = $('games-mine-list').textContent;

    expect(text).toContain('tanks');
    expect(text).toContain('rejected');
    expect(text).toContain('нет карт');
  });

  it('заявка на новую версию едет с id строки', () => {
    const seen = [];

    view.publisher.on('update-version', e => seen.push(e));
    model.publisher.emit('mine-changed', [{ id: 'tanks', packageName: 'p', status: 'approved' }]);

    const item = $('games-mine-list').querySelector('.games-item');

    item.querySelector('.games-version-input').value = '1.2.0';
    item.querySelectorAll('input[type="button"]')[0].click();

    expect(seen).toEqual([{ id: 'tanks', version: '1.2.0' }]);
  });

  it('карточка модерации показывает локальное состояние и версию из npm', () => {
    model.publisher.emit('admin-changed', {
      games: [
        {
          id: 'tanks',
          packageName: '@vimp-games/tanks',
          authorNick: 'dev',
          version: '1.0.0',
          pendingVersion: '1.1.0',
          status: 'pending',
          local: { downloaded: true, stagedVersion: '1.1.0', lastError: null },
        },
      ],
      filter: 'pending',
      versions: new Map([['tanks', ['1.0.0', '1.1.0']]]),
    });

    const text = $('games-admin-list').textContent;

    expect(text).toContain('dev');
    expect(text).toContain('in npm: 1.1.0');
    expect(text).toContain('staged 1.1.0');
  });

  it('кнопки модерации публикуют свои события', () => {
    const seen = [];

    ['stage', 'approve', 'reject', 'disable'].forEach(event =>
      view.publisher.on(event, data => seen.push([event, data])),
    );
    model.publisher.emit('admin-changed', {
      games: [{ id: 'tanks', packageName: 'p', status: 'pending', pendingVersion: '1.1.0' }],
      filter: 'pending',
      versions: new Map(),
    });

    const item = $('games-admin-list').querySelector('.games-item');

    item.querySelector('.games-note-input').value = 'нет карт';

    const buttons = item.querySelectorAll('input[type="button"]');

    buttons[0].click();
    buttons[1].click();
    buttons[2].click();
    buttons[3].click();

    expect(seen).toEqual([
      ['stage', { id: 'tanks', version: '1.1.0' }],
      ['approve', { id: 'tanks' }],
      ['reject', { id: 'tanks', note: 'нет карт' }],
      ['disable', { id: 'tanks' }],
    ]);
  });

  it('фильтры отмечают открытый и публикуют выбор', () => {
    const seen = [];

    view.publisher.on('filter', id => seen.push(id));
    model.publisher.emit('admin-changed', { games: [], filter: 'pending', versions: new Map() });

    const buttons = $('games-filters').querySelectorAll('input');

    expect(buttons[0].classList.contains('active')).toBe(true);

    buttons[1].click();

    expect(seen).toEqual(['approved']);
  });

  it('ошибки рисуются в блоке своей области', () => {
    model.publisher.emit('error', { scope: 'mine', errors: [{ name: 'request', error: 'gameExists' }] });

    expect($('games-submit-error').textContent).toContain('already exists');

    model.publisher.emit('error', { scope: 'admin', errors: [{ name: 'package', error: 'нет manifest.json' }] });

    expect($('games-admin-error').textContent).toContain('нет manifest.json');
  });
});
