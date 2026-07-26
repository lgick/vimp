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
};

const seedDom = () => {
  document.body.innerHTML = `
    <div id="lobby">
      <input id="lobby-search" />
      <ul id="lobby-list"></ul>
      <p id="lobby-empty"></p>
      <button id="lobby-more"></button>
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
    expect(document.getElementById('lobby').style.display).toBe('block');

    view.hide();
    expect(document.getElementById('lobby').style.display).toBe('none');
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
      'room-a',
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
