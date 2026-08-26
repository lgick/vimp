import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// LobbyView — синглтон, перезагружаем модуль для изоляции
let LobbyView;

const elems = {
  lobbyId: 'lobby',
  listId: 'lobby-list',
  searchId: 'lobby-search',
  moreId: 'lobby-more',
  emptyId: 'lobby-empty',
  tabServersBtnId: 'btn-show-servers',
  tabLeaderboardBtnId: 'btn-show-leaderboard',
  serversContentId: 'lobby-servers-content',
  leaderboardContentId: 'lobby-leaderboard-content',
  leaderboardListId: 'lobby-leaderboard-list',
  leaderboardTitleId: 'leaderboard-title',
  leaderboardTotalId: 'leaderboard-total',
  myPlacementId: 'lobby-my-placement',
  versionId: 'lobby-version',
  linkId: 'lobby-link',
};

const seedDom = () => {
  document.body.innerHTML = `
    <div id="lobby">
      <button id="btn-show-servers"></button>
      <button id="btn-show-leaderboard"></button>
      <div id="lobby-servers-content">
        <input id="lobby-search" />
        <ul id="lobby-list"></ul>
        <p id="lobby-empty"></p>
        <button id="lobby-more"></button>
      </div>
      <div id="lobby-leaderboard-content">
        <span id="leaderboard-title"></span>
        <span id="leaderboard-total"></span>
        <ol id="lobby-leaderboard-list"></ol>
        <p id="lobby-my-placement"></p>
      </div>
      <div id="lobby-footer">
        <p><a id="lobby-link"></a></p>
        <p id="lobby-version"></p>
        <p>&copy; 2026 VIMP</p>
      </div>
    </div>
  `;
};

// фейковый IntersectionObserver: ручной триггер видимости карточек
class FakeObserver {
  constructor(cb) {
    this.cb = cb;
    this.observed = [];
  }

  observe(el) {
    this.observed.push(el);
  }

  disconnect() {
    this.observed = [];
  }

  // симулирует попадание карточки в область видимости
  trigger(el) {
    this.cb([{ isIntersecting: true, target: el }]);
  }
}

const makeModel = () => ({ publisher: new Publisher() });

const server = (hostId, over = {}) => ({
  hostId,
  gameId: over.gameId || 'tanks',
  name: over.name || `room-${hostId}`,
  mapName: over.mapName || 'arena',
  currentPlayers: over.currentPlayers ?? 1,
  maxPlayers: over.maxPlayers ?? 8,
  region: over.region || 'EU',
  latency: over.latency ?? null,
  rating: over.rating ?? 0,
});

let observer;
let observerFactory;

beforeEach(async () => {
  vi.resetModules();
  seedDom();
  LobbyView = (await import('../../packages/engine/src/client/components/view/Lobby.js'))
    .default;
  observer = null;
  observerFactory = cb => {
    observer = new FakeObserver(cb);

    return observer;
  };
});

describe('LobbyView: показ/скрытие', () => {
  it('show/hide переключают display', () => {
    const view = new LobbyView(makeModel(), elems, observerFactory);

    view.show();
    expect(document.getElementById('lobby').style.display).toBe('flex');

    view.hide();
    expect(document.getElementById('lobby').style.display).toBe('none');
  });
});

describe('LobbyView: футер движка', () => {
  it('пишет голую версию пакета движка в #lobby-version', async () => {
    const { ENGINE_VERSION } = await import(
      '../../packages/engine/src/client/lib/engineVersion.js'
    );

    new LobbyView(makeModel(), elems, observerFactory);

    expect(document.getElementById('lobby-version').textContent).toBe(
      ENGINE_VERSION,
    );
  });

  it('ставит ссылку на репозиторий движка', () => {
    new LobbyView(makeModel(), elems, observerFactory);

    const link = document.getElementById('lobby-link');

    expect(link.textContent).toBe('GitHub');
    expect(link.getAttribute('href')).toBe('https://github.com/lgick/vimp');
  });

  it('без элементов футера конструктор не падает', () => {
    document.getElementById('lobby-footer').remove();

    expect(() => new LobbyView(makeModel(), elems, observerFactory)).not.toThrow();
  });
});

describe('LobbyView: рендер списка', () => {
  it('рисует карточку на сервер с именем, инфо и latency', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);

    model.publisher.emit('list', {
      servers: [server('a', { latency: 40 })],
      hasMore: false,
    });

    const cards = document.querySelectorAll('.lobby-card');

    expect(cards).toHaveLength(1);
    expect(cards[0].dataset.hostId).toBe('a');
    expect(cards[0].querySelector('.lobby-card-name').textContent).toBe(
      'tanks/room-a',
    );
    expect(cards[0].querySelector('.lobby-card-info').textContent).toBe(
      'arena · 1/8 · EU',
    );
    expect(cards[0].querySelector('.lobby-card-latency').textContent).toBe(
      '40 ms',
    );
  });

  it('рисует рейтинг хостера со знаком для положительных значений', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);
    model.publisher.emit('list', {
      servers: [server('a', { rating: 7 }), server('b', { rating: -3 }), server('c', { rating: 0 })],
      hasMore: false,
    });

    const ratings = [...document.querySelectorAll('.lobby-card-rating')].map(
      el => el.textContent,
    );

    expect(ratings).toEqual(['+7', '-3', '0']);
  });

  it('неизвестная latency показывается как …', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);
    model.publisher.emit('list', { servers: [server('a')], hasMore: false });

    expect(document.querySelector('.lobby-card-latency').textContent).toBe('…');
  });

  it('пустой список показывает заглушку и прячет «Загрузить ещё»', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);
    model.publisher.emit('list', { servers: [], hasMore: false });

    expect(document.getElementById('lobby-empty').style.display).toBe('block');
    expect(document.getElementById('lobby-more').style.display).toBe('none');
  });

  it('hasMore показывает кнопку «Загрузить ещё»', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);
    model.publisher.emit('list', { servers: [server('a')], hasMore: true });

    expect(document.getElementById('lobby-more').style.display).toBe('block');
  });

  it('перерисовка очищает прежние карточки и observer', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);
    model.publisher.emit('list', { servers: [server('a')], hasMore: false });
    model.publisher.emit('list', { servers: [server('b')], hasMore: false });

    const cards = document.querySelectorAll('.lobby-card');

    expect(cards).toHaveLength(1);
    expect(cards[0].dataset.hostId).toBe('b');
  });
});

describe('LobbyView: события', () => {
  it('ввод в поиск эмитит search с текстом', () => {
    const view = new LobbyView(makeModel(), elems, observerFactory);
    const events = [];

    view.publisher.on('search', t => events.push(t));

    const input = document.getElementById('lobby-search');

    input.value = 'boss';
    input.oninput();

    expect(events).toEqual(['boss']);
  });

  it('клик по «Загрузить ещё» эмитит more', () => {
    const view = new LobbyView(makeModel(), elems, observerFactory);
    const spy = vi.fn();

    view.publisher.on('more', spy);
    document.getElementById('lobby-more').onclick();

    expect(spy).toHaveBeenCalled();
  });

  it('клик по карточке эмитит join с hostId', () => {
    const model = makeModel();
    const view = new LobbyView(model, elems, observerFactory);
    const joins = [];

    view.publisher.on('join', id => joins.push(id));
    model.publisher.emit('list', { servers: [server('a')], hasMore: false });

    document.querySelector('.lobby-card').onclick();

    expect(joins).toEqual(['a']);
  });

  it('видимость карточки эмитит visible с hostId', () => {
    const model = makeModel();
    const view = new LobbyView(model, elems, observerFactory);
    const visible = [];

    view.publisher.on('visible', id => visible.push(id));
    model.publisher.emit('list', { servers: [server('a')], hasMore: false });

    observer.trigger(document.querySelector('.lobby-card'));

    expect(visible).toEqual(['a']);
  });
});

describe('LobbyView: обновление пинга', () => {
  it('updatePing пишет задержку в карточку', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);
    model.publisher.emit('list', { servers: [server('a')], hasMore: false });

    model.publisher.emit('ping-update', { hostId: 'a', latency: 55 });

    expect(document.querySelector('.lobby-card-latency').textContent).toBe(
      '55 ms',
    );
  });

  it('сортирует карточки по возрастанию latency', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);
    model.publisher.emit('list', {
      servers: [server('a'), server('b'), server('c')],
      hasMore: false,
    });

    model.publisher.emit('ping-update', { hostId: 'c', latency: 20 });
    model.publisher.emit('ping-update', { hostId: 'a', latency: 90 });
    model.publisher.emit('ping-update', { hostId: 'b', latency: 50 });

    const order = [...document.querySelectorAll('.lobby-card')].map(
      c => c.dataset.hostId,
    );

    // c(20) < b(50) < a(90)
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('updatePing неизвестного сервера игнорируется', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);
    model.publisher.emit('list', { servers: [server('a')], hasMore: false });

    expect(() =>
      model.publisher.emit('ping-update', { hostId: 'ghost', latency: 10 }),
    ).not.toThrow();
  });
});

describe('LobbyView: вкладки (lobby-page-plan)', () => {
  it('клик по вкладкам эмитит show-tab и переключает active/display', () => {
    const view = new LobbyView(makeModel(), elems, observerFactory);
    const tabs = [];

    view.publisher.on('show-tab', t => tabs.push(t));
    document.getElementById('btn-show-leaderboard').onclick();

    expect(tabs).toEqual(['leaderboard']);

    view.showTab('leaderboard');
    expect(document.getElementById('lobby-servers-content').style.display).toBe('none');
    expect(document.getElementById('lobby-leaderboard-content').style.display).toBe('flex');
    expect(document.getElementById('btn-show-leaderboard').classList.contains('active')).toBe(true);
    expect(document.getElementById('btn-show-servers').classList.contains('active')).toBe(false);

    view.showTab('servers');
    expect(document.getElementById('lobby-servers-content').style.display).toBe('flex');
    expect(document.getElementById('lobby-leaderboard-content').style.display).toBe('none');
  });
});

describe('LobbyView: leaderboard (lobby-page-plan)', () => {
  it('renderLeaderboard рисует топ-N по серверному place, total и позицию вызывающего', () => {
    const model = makeModel();
    const view = new LobbyView(model, elems, observerFactory);

    view.setGameTitle('VIMP Tanks');
    view.setLeaderboardLimit(2);
    model.publisher.emit('leaderboard', {
      leaderboard: [
        { nick: 'player3', rank: 1500, place: 1 },
        { nick: 'user203', rank: 1420, place: 2 },
      ],
      total: 3400,
      myPlacement: { placement: 20, total: 3400, rank: 240 },
    });

    expect(document.getElementById('leaderboard-title').textContent).toBe('VIMP TANKS TOP-2');
    expect(document.getElementById('leaderboard-total').textContent).toBe('Total: 3400 players');

    const rows = [...document.querySelectorAll('#lobby-leaderboard-list li')].map(
      li => li.textContent,
    );

    expect(rows).toEqual(['1. player31500 pts', '2. user2031420 pts']);

    const placement = document.getElementById('lobby-my-placement');

    expect(placement.textContent).toBe('20. You240 pts');
    // вне отрисованного топа (20 > 2) — разделитель показан
    expect(placement.classList.contains('lobby-placement-gap')).toBe(true);
  });

  // code review M3: номер строки — серверный competition-ranking `place`,
  // а не index+1 — ничьи по rank должны делить место
  it('renderLeaderboard использует entry.place, а не порядковый индекс, при ничьих', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);
    model.publisher.emit('leaderboard', {
      leaderboard: [
        { nick: 'a', rank: 100, place: 1 },
        { nick: 'b', rank: 100, place: 1 },
        { nick: 'c', rank: 50, place: 3 },
      ],
      total: 3,
      myPlacement: null,
    });

    const rows = [...document.querySelectorAll('#lobby-leaderboard-list li')].map(
      li => li.textContent,
    );

    expect(rows).toEqual(['1. a100 pts', '1. b100 pts', '3. c50 pts']);
  });

  // code review M4 (доработка): видимость плашки решается членством ника в
  // отрисованном списке, а не сравнением чисел placement/leaderboard.length
  // (разные шкалы — расходятся при ничьих на границе LIMIT)
  it('плашка "You" не рендерится, если собственный ник уже виден в топе', () => {
    const model = makeModel();
    const view = new LobbyView(model, elems, observerFactory);

    view.setSelfNick('user203');
    model.publisher.emit('leaderboard', {
      leaderboard: [
        { nick: 'player3', rank: 1500, place: 1 },
        { nick: 'user203', rank: 1420, place: 2 },
      ],
      total: 2,
      myPlacement: { placement: 2, total: 2, rank: 1420 },
    });

    const placement = document.getElementById('lobby-my-placement');

    expect(placement.textContent).toBe('');
    expect(placement.classList.contains('lobby-placement-gap')).toBe(false);
  });

  // без setSelfNick (main.js ещё не проставил ник) плашка не должна молчать —
  // лучше показать её (как раньше), чем спрятать без уверенности в членстве
  it('без setSelfNick плашка рендерится, даже если place совпадает с числом строк', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);
    model.publisher.emit('leaderboard', {
      leaderboard: [
        { nick: 'player3', rank: 1500, place: 1 },
        { nick: 'user203', rank: 1420, place: 2 },
      ],
      total: 2,
      myPlacement: { placement: 2, total: 2, rank: 1420 },
    });

    expect(document.getElementById('lobby-my-placement').textContent).toBe('2. You1420 pts');
  });

  // граница LIMIT с ничьими: несколько игроков делят одно competition-place,
  // но по LIMIT в список попала лишь часть — сравнение чисел placement/length
  // раньше могло спрятать плашку у игрока, которого нет в отрисованном топе;
  // membership по нику этого не допускает
  it('ничьи на границе LIMIT: игрок с малым placement, но вне топа по LIMIT — плашка показана', () => {
    const model = makeModel();
    const view = new LobbyView(model, elems, observerFactory);

    view.setSelfNick('outsider');
    model.publisher.emit('leaderboard', {
      leaderboard: [
        { nick: 'a', rank: 100, place: 1 },
        { nick: 'b', rank: 100, place: 1 },
      ],
      total: 15,
      // outsider делит то же place=1 (та же ничья), но не попал в LIMIT=2
      myPlacement: { placement: 1, total: 15, rank: 100 },
    });

    const placement = document.getElementById('lobby-my-placement');

    expect(placement.textContent).toBe('1. You100 pts');
    expect(placement.classList.contains('lobby-placement-gap')).toBe(true);
  });

  it('myPlacement === null (не ранжирован) показывает соответствующий текст', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);
    model.publisher.emit('leaderboard', {
      leaderboard: [],
      total: 0,
      myPlacement: { placement: null, total: 0, rank: 0 },
    });

    expect(document.getElementById('lobby-my-placement').textContent).toBe('Not ranked yet');
  });

  // code review L7: пустой топ показывает заглушку, а не голый "TOP-0"
  it('пустой leaderboard показывает заглушку "No ranked players yet"', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);
    model.publisher.emit('leaderboard', { leaderboard: [], total: 0, myPlacement: null });

    expect(document.getElementById('leaderboard-title').textContent).toBe(' TOP-0');
    expect(document.querySelector('#lobby-leaderboard-list li').textContent).toBe(
      'No ranked players yet',
    );
  });

  // code review мелочь (lobby-page-review-status): пока ответ не пришёл
  // (loaded=false — clearLeaderboard уже обнулила список), заглушка должна
  // отличаться от "ответ пришёл, пусто"
  it('пустой leaderboard с loaded=false показывает "Loading…", а не "No ranked players yet"', () => {
    const model = makeModel();

    new LobbyView(model, elems, observerFactory);
    model.publisher.emit('leaderboard', {
      leaderboard: [],
      total: 0,
      myPlacement: null,
      loaded: false,
    });

    expect(document.querySelector('#lobby-leaderboard-list li').textContent).toBe('Loading…');
  });
});
