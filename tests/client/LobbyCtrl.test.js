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
  it('show-tab → view.showTab и первое открытие Leaderboard эмитит leaderboard-needed', () => {
    const needed = [];

    ctrl.publisher.on('leaderboard-needed', gameId => needed.push(gameId));
    view.publisher.emit('show-tab', 'leaderboard');

    expect(view.showTab).toHaveBeenCalledWith('leaderboard');
    expect(needed).toEqual([null]); // gameChanged ещё не вызывался
  });

  it('повторное открытие Leaderboard без смены игры не эмитит повторно', () => {
    const needed = [];

    view.publisher.emit('show-tab', 'leaderboard');
    ctrl.publisher.on('leaderboard-needed', gameId => needed.push(gameId));
    view.publisher.emit('show-tab', 'servers');
    view.publisher.emit('show-tab', 'leaderboard');

    expect(needed).toEqual([]);
  });

  it('gameChanged всегда эмитит leaderboard-needed и обновляет заголовок', () => {
    const needed = [];

    ctrl.publisher.on('leaderboard-needed', gameId => needed.push(gameId));
    ctrl.gameChanged('tanks', 'VIMP Tanks');
    ctrl.gameChanged('other', 'Other Game');

    expect(view.setGameTitle).toHaveBeenNthCalledWith(1, 'VIMP Tanks');
    expect(view.setGameTitle).toHaveBeenNthCalledWith(2, 'Other Game');
    expect(needed).toEqual(['tanks', 'other']);
  });
});
