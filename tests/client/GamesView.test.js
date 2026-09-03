import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// GamesView — синглтон, перезагружаем модуль для изоляции
let GamesView;

const config = {
  statuses: [
    { id: 'pending', title: 'Pending' },
    { id: 'approved', title: 'Published' },
    { id: 'deleted', title: 'Deleted' },
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
      packageName: 'games-field-package',
      version: 'games-field-version',
    },
    lookupBtnId: 'games-lookup',
    previewId: 'games-preview',
    versionListId: 'games-version-list',
    mineId: 'games-mine',
    titleId: 'games-title',
    switchBtnId: 'games-switch',
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
      <input type="button" id="games-open-mine">
      <input type="button" id="games-open-moderation">
      <div class="games-head">
        <h3 id="games-title">My games</h3>
        <input type="button" id="games-switch" value="Moderation">
        <input type="button" id="games-close">
      </div>
      <div id="games-mine">
        <ul id="games-mine-list"></ul>
        <form id="games-submit-form">
          <input type="text" id="games-field-package">
          <input type="button" id="games-lookup">
          <input type="text" id="games-field-version" list="games-version-list">
          <datalist id="games-version-list"></datalist>
          <div id="games-preview"></div>
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
  it('открывается вместо лобби, карточки показываются по одной', () => {
    view.show(false);

    expect($('games-panel').style.display).toBe('flex');
    expect($('lobby').style.display).toBe('none');
    expect($('games-mine').style.display).toBe('block');
    expect($('games-moderation').style.display).toBe('none');
    expect($('games-title').textContent).toBe('My games');

    view.show(true);

    expect($('games-mine').style.display).toBe('none');
    expect($('games-moderation').style.display).toBe('block');
    expect($('games-title').textContent).toBe('Moderation');
  });

  it('«Назад в лобби» доступна на обеих страницах панели', () => {
    view.show(true);
    $('games-close').click();

    expect($('games-panel').style.display).toBe('none');
    expect($('lobby').style.display).toBe('flex');
  });

  it('переключатель страниц виден только админу и ведёт на другую страницу', () => {
    const seen = [];

    view.publisher.on('open-moderation', () => seen.push('open-moderation'));
    view.publisher.on('open-mine', () => seen.push('open-mine'));

    view.setAdmin(false);

    expect($('games-switch').style.display).toBe('none');

    view.setAdmin(true);

    expect($('games-switch').style.display).toBe('');

    view.show(false);

    expect($('games-switch').value).toBe('Moderation');

    $('games-switch').click();
    view.show(true);

    expect($('games-switch').value).toBe('My games');

    $('games-switch').click();

    expect(seen).toEqual(['open-moderation', 'open-mine']);
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
  // разобранный пакет — предпросмотр мастера: id, title и репозиторий
  // человек не вводит вовсе
  const preview = (over = {}) =>
    model.publisher.emit('looked-up', {
      id: 'tanks',
      title: 'Tanks',
      version: '1.1.0',
      versions: ['1.0.0', '1.1.0'],
      repoUrl: 'https://github.com/lgick/vimp-tanks',
      engineApi: 4,
      compat: null,
      errors: [],
      ...over,
    });

  it('submit отдаёт только пакет и версию', () => {
    const seen = [];

    view.publisher.on('submit', form => seen.push(form));
    $('games-field-package').value = ' @vimp-games/tanks ';
    $('games-field-version').value = '1.1.0';
    $('games-submit-form').dispatchEvent(new Event('submit'));

    expect(seen[0]).toEqual({
      packageName: '@vimp-games/tanks',
      version: '1.1.0',
    });
  });

  it('успешная заявка очищает поля формы и предпросмотр', () => {
    $('games-field-package').value = '@vimp-games/tanks';
    $('games-field-version').value = '1.0.0';
    preview();

    model.publisher.emit('submitted');

    Object.values(config.elems.fieldIds).forEach(id => {
      expect($(id).value).toBe('');
    });
    expect($('games-preview').textContent).toBe('');
    expect($('games-submit').disabled).toBe(true);
  });

  it('«Load» и уход из поля пакета публикуют lookup', () => {
    const seen = [];

    view.publisher.on('lookup', e => seen.push(e));
    $('games-field-package').value = ' @vimp-games/tanks ';
    $('games-field-version').value = ' 1.1.0 ';
    $('games-lookup').click();
    $('games-field-package').dispatchEvent(new Event('blur'));

    // пара mousedown → blur → click даёт РОВНО один разбор: каждый стоит
    // мастеру скачанного тарболла и единицы общего лимитера заявок
    expect(seen).toEqual([
      { packageName: '@vimp-games/tanks', version: '1.1.0' },
    ]);

    // другой пакет — снова разбор
    seen.length = 0;
    $('games-field-package').value = '@vimp-games/other';
    $('games-lookup').click();

    expect(seen).toEqual([
      { packageName: '@vimp-games/other', version: '1.1.0' },
    ]);

    // пустое поле в сеть не ходит: мастер качает чужой тарболл
    seen.length = 0;
    $('games-field-package').value = '  ';
    $('games-lookup').click();

    expect(seen).toEqual([]);
  });

  // renderPreview подставляет в поле версии разрешённую мастером версию:
  // без обновления запрета следующий blur прошёл бы как «другой пакет»
  it('разрешённая версия в поле не открывает повторный разбор', () => {
    const seen = [];

    view.publisher.on('lookup', e => seen.push(e));
    $('games-field-package').value = '@vimp-games/tanks';
    $('games-field-version').value = 'latest';
    $('games-lookup').click();
    preview();
    $('games-field-package').dispatchEvent(new Event('blur'));

    expect(seen).toEqual([
      { packageName: '@vimp-games/tanks', version: 'latest' },
    ]);

    // правка поля обесценивает предпросмотр — и снимает запрет
    seen.length = 0;
    $('games-field-package').dispatchEvent(new Event('input'));
    $('games-lookup').click();

    expect(seen).toHaveLength(1);
  });

  it('предпросмотр печатает разобранный пакет и подставляет версию', () => {
    preview();

    const text = $('games-preview').textContent;

    expect(text).toContain('Tanks');
    expect(text).toContain('tanks');
    expect(text).toContain('1.1.0');
    expect(text).toContain('4');
    expect($('games-preview').querySelector('a').href).toBe(
      'https://github.com/lgick/vimp-tanks',
    );
    // 'latest' в поле осталась бы ссылкой, которая завтра значит другое
    expect($('games-field-version').value).toBe('1.1.0');
    expect(
      [...$('games-version-list').querySelectorAll('option')].map(o => o.value),
    ).toEqual(['1.0.0', '1.1.0']);
    expect($('games-submit').disabled).toBe(false);
  });

  it('пакет с проблемами не отправляется, замечания видны', () => {
    preview({ errors: ['dist/manifest.json отсутствует'] });

    expect($('games-submit-error').textContent).toContain('manifest.json');
    expect($('games-submit').disabled).toBe(true);
  });

  it('правка поля пакета сбрасывает предпросмотр', () => {
    preview();

    $('games-field-package').value = '@vimp-games/other';
    $('games-field-package').dispatchEvent(new Event('input'));

    expect($('games-preview').textContent).toBe('');
    expect($('games-submit').disabled).toBe(true);
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

    // по подписи, а не по позиции: в строке живёт ещё и «Set author»
    const click = value =>
      [...item.querySelectorAll('input[type="button"]')]
        .find(btn => btn.value === value)
        .click();

    click('Test');
    click('Approve');
    click('Reject');
    click('Disable');

    expect(seen).toEqual([
      ['stage', { id: 'tanks', version: '1.1.0' }],
      ['approve', { id: 'tanks' }],
      ['reject', { id: 'tanks', note: 'нет карт' }],
      ['disable', { id: 'tanks' }],
    ]);
  });

  it('поле автора предзаполнено и публикует set-author, пустое — снимает автора', () => {
    const seen = [];

    view.publisher.on('set-author', data => seen.push(data));
    model.publisher.emit('admin-changed', {
      games: [{ id: 'tanks', packageName: 'p', status: 'pending', authorNick: 'dev' }],
      filter: 'pending',
      versions: new Map(),
    });

    const item = $('games-admin-list').querySelector('.games-item');
    const author = item.querySelector('.games-author-input');
    const setAuthor = [...item.querySelectorAll('input[type="button"]')]
      .find(btn => btn.value === 'Set author');

    expect(author.value).toBe('dev');

    author.value = ' Player1 ';
    setAuthor.click();

    // очистка поля — законное действие: игры платформы бывают ничьи
    author.value = '';
    setAuthor.click();

    expect(seen).toEqual([
      { id: 'tanks', nick: 'Player1' },
      { id: 'tanks', nick: '' },
    ]);
  });

  it('игра без автора оставляет поле пустым', () => {
    model.publisher.emit('admin-changed', {
      games: [{ id: 'tanks', packageName: 'p', status: 'pending' }],
      filter: 'pending',
      versions: new Map(),
    });

    const item = $('games-admin-list').querySelector('.games-item');

    expect(item.textContent).toContain('Author: —');
    expect(item.querySelector('.games-author-input').value).toBe('');
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

  it('предупреждение о пустом каталоге — человеческой строкой', () => {
    // решение принято, отказа не было: модератор снял с раздачи последнюю
    // игру и обязан узнать об этом здесь, а не от игроков
    model.publisher.emit('warning', { scope: 'admin', code: 'catalogEmpty' });

    expect($('games-admin-error').textContent).toContain('No published games left');

    // неизвестный код едет как есть — лучше сырой, чем проглоченный
    model.publisher.emit('warning', { scope: 'admin', code: 'somethingNew' });

    expect($('games-admin-error').textContent).toBe('somethingNew');
  });

  it('поле формы, разъехавшееся с разметкой, бросает в конструкторе', async () => {
    vi.resetModules(); // синглтон: без сброса вернулся бы уже созданный view
    $('games-field-version').remove();

    const Fresh = (
      await import('../../packages/engine/src/client/components/view/Games.js')
    ).default;

    // сообщение называет и id, и поле: молчаливый null падал бы позже —
    // безымянным TypeError внутри clearForm или _readForm
    expect(() => new Fresh(model, config)).toThrow(/games-field-version.*version/);
  });
});

describe('GamesView: удаление игры', () => {
  const deleteBtn = item => item.querySelector('.games-delete-btn');

  // удаление обратимо (игра уходит в графу Deleted на 30 суток), поэтому
  // подтверждения вторым нажатием у кнопки нет
  it('одно нажатие публикует событие', () => {
    const seen = [];

    view.publisher.on('delete', e => seen.push(e));
    model.publisher.emit('mine-changed', [{ id: 'tanks', packageName: 'p', status: 'pending' }]);

    deleteBtn($('games-mine-list').querySelector('.games-item')).click();

    expect(seen).toEqual([{ id: 'tanks', scope: 'mine' }]);
  });

  it('карточка модерации удаляет в scope admin', () => {
    const seen = [];

    view.publisher.on('delete', e => seen.push(e));
    model.publisher.emit('admin-changed', {
      games: [{ id: 'tanks', packageName: 'p', status: 'approved' }],
      filter: 'approved',
      versions: new Map(),
    });

    deleteBtn($('games-admin-list').querySelector('.games-item')).click();

    expect(seen).toEqual([{ id: 'tanks', scope: 'admin' }]);
  });
});

describe('GamesView: графа Deleted', () => {
  const deleted = {
    id: 'tanks',
    packageName: 'p',
    status: 'approved',
    deletedAt: '2026-09-01T00:00:00Z',
    purgeAt: '2026-10-01T00:00:00Z',
  };

  const render = () => {
    model.publisher.emit('admin-changed', {
      games: [deleted],
      filter: 'deleted',
      versions: new Map(),
    });

    return $('games-admin-list').querySelector('.games-item');
  };

  it('фильтров столько же, сколько граф в конфиге', () => {
    expect($('games-filters').querySelectorAll('input').length).toBe(config.statuses.length);
  });

  it('карточка показывает срок полного удаления', () => {
    const line = render().querySelector('.games-purge-line').textContent;

    expect(line).toContain(new Date(deleted.deletedAt).toLocaleDateString());
    expect(line).toContain(new Date(deleted.purgeAt).toLocaleDateString());
    // прежний статус — след того, куда игру вернёт Restore
    expect(line).toContain('published');
  });

  it('модерировать удалённую игру нечем: только Restore', () => {
    const values = [...render().querySelectorAll('input[type="button"]')].map(btn => btn.value);

    expect(values).toEqual(['Restore']);
  });

  it('Restore публикует событие', () => {
    const seen = [];

    view.publisher.on('restore', e => seen.push(e));
    render().querySelector('input[type="button"]').click();

    expect(seen).toEqual([{ id: 'tanks' }]);
  });
});
