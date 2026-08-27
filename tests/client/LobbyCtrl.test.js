import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// LobbyCtrl — синглтон, перезагружаем модуль для изоляции
let LobbyCtrl;

const makeModel = () => ({
  refresh: vi.fn(),
  setSearch: vi.fn(),
  loadMore: vi.fn(),
  pingHost: vi.fn(),
  join: vi.fn(),
});

const makeView = () => ({
  publisher: new Publisher(),
  show: vi.fn(),
  hide: vi.fn(),
  showTab: vi.fn(),
  setGameTitle: vi.fn(),
  setPeriod: vi.fn(),
});

let model;
let view;
let ctrl;
let now;

beforeEach(async () => {
  vi.resetModules();
  LobbyCtrl = (await import('../../packages/engine/src/client/components/controller/Lobby.js'))
    .default;
  model = makeModel();
  view = makeView();
  now = 1000;
  ctrl = new LobbyCtrl(model, view, () => now);
});

describe('LobbyCtrl: жизненный цикл', () => {
  it('open показывает view и запрашивает список', () => {
    ctrl.open();

    expect(view.show).toHaveBeenCalled();
    expect(model.refresh).toHaveBeenCalled();
  });

  it('close прячет view', () => {
    ctrl.close();

    expect(view.hide).toHaveBeenCalled();
  });
});

describe('LobbyCtrl: проксирование view-событий в модель', () => {
  it('search → model.setSearch', () => {
    view.publisher.emit('search', 'boss');

    expect(model.setSearch).toHaveBeenCalledWith('boss');
  });

  it('more → model.loadMore', () => {
    view.publisher.emit('more');

    expect(model.loadMore).toHaveBeenCalled();
  });

  it('join → model.join', () => {
    view.publisher.emit('join', 'a');

    expect(model.join).toHaveBeenCalledWith('a');
  });

  it('visible → model.pingHost с текущим временем', () => {
    now = 4242;
    view.publisher.emit('visible', 'a');

    expect(model.pingHost).toHaveBeenCalledWith('a', 4242);
  });
});

describe('LobbyCtrl: вкладки и leaderboard (lobby-page-plan)', () => {
  it('show-tab → view.showTab, само по себе не эмитит leaderboard-needed', () => {
    const needed = [];

    ctrl.publisher.on('leaderboard-needed', gameId => needed.push(gameId));
    view.publisher.emit('show-tab', 'leaderboard');
    view.publisher.emit('show-tab', 'servers');

    // code review L4/L5: единственный источник fetch'а — gameChanged(),
    // а не открытие вкладки — иначе до первого gameChanged() ушёл бы
    // запрос с gameId=null
    expect(view.showTab).toHaveBeenCalledWith('leaderboard');
    expect(view.showTab).toHaveBeenCalledWith('servers');
    expect(needed).toEqual([]);
  });

  it('gameChanged всегда эмитит leaderboard-needed и обновляет заголовок', () => {
    const needed = [];

    ctrl.publisher.on('leaderboard-needed', req => needed.push(req));
    ctrl.setPeriods([{ id: 'all', title: 'ALL-TIME' }], 'all');
    ctrl.gameChanged('tanks', 'VIMP Tanks');
    ctrl.gameChanged('other', 'Other Game');

    expect(view.setGameTitle).toHaveBeenNthCalledWith(1, 'VIMP Tanks');
    expect(view.setGameTitle).toHaveBeenNthCalledWith(2, 'Other Game');
    // запрос всегда несёт обе координаты: игру и открытый срез
    expect(needed).toEqual([
      { gameId: 'tanks', period: 'all' },
      { gameId: 'other', period: 'all' },
    ]);
  });
});

// rank-periods: срез времени — это другой ответ сервера, а не другая
// сортировка того же списка, поэтому переключение перезапрашивает данные
describe('LobbyCtrl: срезы рейтинга', () => {
  const periods = [
    { id: 'day', title: 'TODAY' },
    { id: 'month', title: 'THIS MONTH' },
    { id: 'all', title: 'ALL-TIME' },
  ];

  it('setPeriods подсвечивает срез по умолчанию и не запрашивает ничего', () => {
    const needed = [];

    ctrl.publisher.on('leaderboard-needed', req => needed.push(req));
    ctrl.setPeriods(periods, 'all');

    expect(view.setPeriod).toHaveBeenCalledWith('all', 'ALL-TIME');
    expect(needed).toEqual([]);
  });

  it('show-period перезапрашивает список активной игры в новом срезе', () => {
    const needed = [];

    ctrl.setPeriods(periods, 'all');
    ctrl.gameChanged('tanks', 'VIMP Tanks');
    ctrl.publisher.on('leaderboard-needed', req => needed.push(req));
    view.publisher.emit('show-period', 'day');

    expect(view.setPeriod).toHaveBeenCalledWith('day', 'TODAY');
    expect(needed).toEqual([{ gameId: 'tanks', period: 'day' }]);
  });

  it('повторный клик по открытому срезу ничего не запрашивает', () => {
    const needed = [];

    ctrl.setPeriods(periods, 'all');
    ctrl.gameChanged('tanks', 'VIMP Tanks');
    ctrl.publisher.on('leaderboard-needed', req => needed.push(req));
    view.publisher.emit('show-period', 'all');

    expect(needed).toEqual([]);
  });

  // до первого gameChanged() запрашивать нечего: gameId ещё неизвестен
  it('срез до выбора игры не уходит в запрос', () => {
    const needed = [];

    ctrl.setPeriods(periods, 'all');
    ctrl.publisher.on('leaderboard-needed', req => needed.push(req));
    view.publisher.emit('show-period', 'month');

    expect(needed).toEqual([]);
  });
});
