import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  absoluteLink,
  classifyRoomPoll,
  decideExitRoute,
  decideRouteAction,
  formatGameLink,
  formatRoomLink,
  isMigrating,
  parseRoute,
  pickQuickPlayRoom,
  quickPlayCreateDelay,
  reloadTo,
  setRoute,
} from '../../../packages/engine/src/client/lib/roomLink.js';

// Роутер прямых ссылок (host-migration, этап 3): три вида URL лобби-режима —
// без hash (лобби), #/<gameId> (быстрая игра), #/<gameId>/<roomId> (комната)

const ROOM = 'k7m2qx3a';

describe('parseRoute', () => {
  it('#/<gameId>/<roomId> — комната', () => {
    expect(parseRoute(`#/tanks/${ROOM}`)).toEqual({
      kind: 'room',
      gameId: 'tanks',
      roomId: ROOM,
    });
  });

  it('#/<gameId> — быстрая игра', () => {
    expect(parseRoute('#/tanks')).toEqual({ kind: 'game', gameId: 'tanks' });
  });

  it('регистр и хвостовой слэш не мешают (ссылку набирают руками)', () => {
    expect(parseRoute(`#/TANKS/${ROOM.toUpperCase()}/`)).toEqual({
      kind: 'room',
      gameId: 'tanks',
      roomId: ROOM,
    });
    expect(parseRoute('#/Tanks/')).toEqual({ kind: 'game', gameId: 'tanks' });
  });

  it('hash без # тоже разбирается', () => {
    expect(parseRoute('/tanks')).toEqual({ kind: 'game', gameId: 'tanks' });
  });

  it.each([
    [''],
    ['#'],
    ['#auth'],
    ['#lobby'],
    ['#/'],
    ['#//'],
    ['#/1tanks'],
    ['#/t'],
    ['#/tanks/short'],
    ['#/tanks/k7m2qx3i'], // i нет в crockford-base32
    [`#/tanks/${ROOM}/extra`],
    [null],
    [undefined],
  ])('чужое или мусор %j — none', hash => {
    expect(parseRoute(hash)).toEqual({ kind: 'none' });
  });
});

describe('format*/absoluteLink', () => {
  it('форматы ссылок разбираются обратно', () => {
    expect(formatRoomLink('tanks', ROOM)).toBe(`#/tanks/${ROOM}`);
    expect(formatGameLink('tanks')).toBe('#/tanks');
    expect(parseRoute(formatRoomLink('tanks', ROOM)).kind).toBe('room');
    expect(parseRoute(formatGameLink('tanks')).kind).toBe('game');
  });

  it('absoluteLink — origin + pathname + hash', () => {
    const loc = { origin: 'https://vimp.dev', pathname: '/' };

    expect(absoluteLink('#/tanks', loc)).toBe('https://vimp.dev/#/tanks');
  });
});

describe('setRoute/reloadTo', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/play?token=x#/tanks');
  });

  it('setRoute меняет hash без записи в историю и чистит query', () => {
    const length = window.history.length;

    setRoute(`#/tanks/${ROOM}`);

    expect(window.location.pathname).toBe('/play');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe(`#/tanks/${ROOM}`);
    expect(window.history.length).toBe(length);
  });

  it("setRoute('') — лобби без hash", () => {
    setRoute('');

    expect(window.location.hash).toBe('');
  });

  it('reloadTo ставит маршрут и перезагружает', () => {
    const reload = vi.fn();
    const spy = vi.spyOn(window.location, 'reload').mockImplementation(reload);

    reloadTo('#/snakes');

    expect(window.location.hash).toBe('#/snakes');
    expect(reload).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe('decideRouteAction', () => {
  const catalog = new Map([
    ['tanks', { id: 'tanks' }],
    ['snakes', { id: 'snakes' }],
    ['broken', { id: 'broken', compat: { ok: false } }],
  ]);
  const room = (over = {}) => ({
    roomId: ROOM,
    gameId: 'tanks',
    currentPlayers: 1,
    maxPlayers: 8,
    ...over,
  });
  const roomRoute = (gameId = 'tanks') => ({
    kind: 'room',
    gameId,
    roomId: ROOM,
  });

  it.each([
    ['none → лобби', { kind: 'none' }, null, { action: 'lobby' }],
    [
      'живая комната → вход',
      roomRoute(),
      room(),
      { action: 'join', gameId: 'tanks', roomId: ROOM },
    ],
    [
      'комнаты нет → быстрая игра той же игры',
      roomRoute(),
      null,
      { action: 'quickPlay', gameId: 'tanks' },
    ],
    [
      'полная → быстрая игра',
      roomRoute(),
      room({ currentPlayers: 8 }),
      { action: 'quickPlay', gameId: 'tanks' },
    ],
    [
      'комната другой игры → верим комнате',
      roomRoute('tanks'),
      room({ gameId: 'snakes' }),
      { action: 'join', gameId: 'snakes', roomId: ROOM },
    ],
    [
      '#/<gameId> → быстрая игра',
      { kind: 'game', gameId: 'snakes' },
      null,
      { action: 'quickPlay', gameId: 'snakes' },
    ],
    [
      'комната меняет хоста → ждать (host-migration 7)',
      roomRoute(),
      room({ status: 'migrating' }),
      { action: 'wait', gameId: 'tanks', roomId: ROOM },
    ],
    [
      'online-комната → вход',
      roomRoute(),
      room({ status: 'online' }),
      { action: 'join', gameId: 'tanks', roomId: ROOM },
    ],
  ])('%s', (_, route, roomInfo, expected) => {
    expect(decideRouteAction(route, roomInfo, catalog)).toEqual(expected);
  });

  it.each([
    [{ kind: 'game', gameId: 'chess' }, null],
    [{ kind: 'game', gameId: 'broken' }, null],
    [roomRoute('chess'), null],
    [roomRoute(), room({ gameId: 'chess' })],
  ])(
    'игры нет в каталоге или она недоступна → лобби с причиной',
    (route, info) => {
      const decision = decideRouteAction(route, info, catalog);

      expect(decision.action).toBe('lobby');
      expect(decision.informer).toMatch(/not available/);
    },
  );
});

describe('isMigrating', () => {
  it('только status migrating; без status (старый мастер) — online', () => {
    expect(isMigrating({ status: 'migrating' })).toBe(true);
    // плановая передача хоста (этап 8) — комната так же ждёт нового хоста
    expect(isMigrating({ status: 'handing_off' })).toBe(true);
    expect(isMigrating({ status: 'online' })).toBe(false);
    expect(isMigrating({})).toBe(false);
    expect(isMigrating(null)).toBe(false);
  });
});

describe('classifyRoomPoll', () => {
  it.each([
    [
      'online-комната → вход',
      { status: 200, info: { status: 'online' } },
      'online',
    ],
    [
      'ответ старого мастера без status → online',
      { status: 200, info: {} },
      'online',
    ],
    [
      'всё ещё мигрирует → ждать',
      { status: 200, info: { status: 'migrating' } },
      'retry',
    ],
    ['404 — комнаты нет', { status: 404, info: null }, 'gone'],
    ['5xx — сбой, не повод уходить', { status: 502, info: null }, 'retry'],
    ['запрос не дошёл — повтор', { status: null, info: null }, 'retry'],
  ])('%s', (_, poll, expected) => {
    expect(classifyRoomPoll(poll)).toBe(expected);
  });
});

describe('quickPlayCreateDelay', () => {
  const range = { createDelayMinMs: 500, createDelayMaxMs: 2000 };

  it('случайная пауза в пределах [min, max]', () => {
    expect(quickPlayCreateDelay(range, () => 0)).toBe(500);
    expect(quickPlayCreateDelay(range, () => 0.5)).toBe(1250);
    expect(quickPlayCreateDelay(range, () => 0.999999)).toBe(2000);
  });

  it('кривой диапазон не даёт отрицательной паузы', () => {
    expect(
      quickPlayCreateDelay(
        { createDelayMinMs: -5, createDelayMaxMs: -10 },
        () => 0.5,
      ),
    ).toBe(0);
    expect(quickPlayCreateDelay(undefined, () => 0.5)).toBe(0);
  });
});

describe('pickQuickPlayRoom', () => {
  const s = (roomId, currentPlayers, over = {}) => ({
    roomId,
    gameId: 'tanks',
    currentPlayers,
    maxPlayers: 4,
    ...over,
  });

  it('берёт самую наполненную неполную комнату игры', () => {
    const servers = [s('a', 1), s('b', 3), s('c', 4), s('d', 2)];

    expect(pickQuickPlayRoom(servers, 'tanks').roomId).toBe('b');
  });

  it('при равенстве — первая в списке мастера', () => {
    expect(pickQuickPlayRoom([s('a', 2), s('b', 2)], 'tanks').roomId).toBe('a');
  });

  it('gameId — строго (поиск мастера подстрочный)', () => {
    const servers = [s('a', 3, { gameId: 'tanks2' }), s('b', 1)];

    expect(pickQuickPlayRoom(servers, 'tanks').roomId).toBe('b');
  });

  it('нет подходящих — null', () => {
    expect(pickQuickPlayRoom([s('a', 4)], 'tanks')).toBeNull();
    expect(pickQuickPlayRoom([], 'tanks')).toBeNull();
    expect(pickQuickPlayRoom(undefined, 'tanks')).toBeNull();
  });
});

describe('decideExitRoute', () => {
  it('кик — на главную без перезагрузки', () => {
    expect(decideExitRoute({ kicked: true, gameId: 'tanks' })).toEqual({
      route: '',
    });
  });

  it('закрытие комнаты — перезагрузка в быструю игру той же игры', () => {
    expect(decideExitRoute({ kicked: false, gameId: 'tanks' })).toEqual({
      reload: '#/tanks',
    });
  });

  it('игра неизвестна — перезагрузка в лобби', () => {
    expect(decideExitRoute({ kicked: false })).toEqual({ reload: '' });
  });
});
