import { describe, it, expect, beforeEach, vi } from 'vitest';

// LobbyModel — синглтон, перезагружаем модуль для изоляции
let LobbyModel;

const server = (hostId, over = {}) => ({
  hostId,
  name: over.name || `room-${hostId}`,
  mapName: over.mapName || 'arena',
  currentPlayers: over.currentPlayers ?? 0,
  maxPlayers: over.maxPlayers ?? 8,
  region: over.region || 'EU',
  ...('gameId' in over ? { gameId: over.gameId } : { gameId: 'tanks' }),
});

let model;

beforeEach(async () => {
  vi.resetModules();
  LobbyModel = (await import('../../packages/engine/src/client/components/model/Lobby.js'))
    .default;
  model = new LobbyModel({ pageSize: 10, pingInterval: 5000 });
});

describe('LobbyModel: запросы списка', () => {
  it('refresh эмитит fetch с нулевым offset', () => {
    const fetches = [];

    model.publisher.on('fetch', q => fetches.push(q));
    model.refresh();

    expect(fetches[0]).toEqual({
      offset: 0,
      limit: 10,
      search: '',
      append: false,
    });
  });

  it('setSearch тримит текст и сбрасывает пагинацию', () => {
    const fetches = [];

    model.publisher.on('fetch', q => fetches.push(q));
    model.loadMore(); // offset → 10
    model.setSearch('  Boss  ');

    expect(fetches[1]).toEqual({
      offset: 0,
      limit: 10,
      search: 'Boss',
      append: false,
    });
  });

  it('loadMore сдвигает offset и помечает append', () => {
    const fetches = [];

    model.publisher.on('fetch', q => fetches.push(q));
    model.loadMore();

    expect(fetches[0]).toMatchObject({ offset: 10, append: true });
  });
});

describe('LobbyModel: применение списка', () => {
  it('setList публикует список и флаг hasMore', () => {
    const lists = [];

    model.publisher.on('list', l => lists.push(l));
    model.setList({ total: 3, servers: [server('a'), server('b')] });

    expect(lists[0].servers.map(s => s.hostId)).toEqual(['a', 'b']);
    expect(lists[0].hasMore).toBe(true); // 2 из 3
  });

  it('append дополняет список, replace — заменяет', () => {
    model.setList({ total: 4, servers: [server('a'), server('b')] });
    model.setList({ total: 4, servers: [server('c'), server('d')] }, true);

    const lists = [];

    model.publisher.on('list', l => lists.push(l));
    model.setList({ total: 4, servers: [server('a')] }); // replace

    expect(model._order).toEqual(['a']);
    expect(lists[0].hasMore).toBe(true); // 1 из 4
  });

  it('latency переживает обновление списка', () => {
    model.setList({ total: 1, servers: [server('a')] });
    model.pingHost('a', 1000);
    model.resolvePong(1, 1080);

    model.setList({ total: 1, servers: [server('a')] }); // refresh

    expect(model._servers.get('a').latency).toBe(80);
  });
});

describe('LobbyModel: выбор сервера', () => {
  it('join известного сервера эмитит hostId и gameId комнаты', () => {
    const joins = [];

    model.publisher.on('join', payload => joins.push(payload));
    model.setList({ total: 1, servers: [server('a', { gameId: 'snakes' })] });
    model.join('a');

    expect(joins).toEqual([{ hostId: 'a', gameId: 'snakes' }]);
  });

  // хосты старше 6.4 не присылают gameId — клиент должен зайти на активной
  // игре, а не отказать во входе
  it('join сервера без gameId эмитит undefined вместо отказа', () => {
    const joins = [];

    model.publisher.on('join', payload => joins.push(payload));
    model.setList({ total: 1, servers: [server('a', { gameId: undefined })] });
    model.join('a');

    expect(joins).toEqual([{ hostId: 'a', gameId: undefined }]);
  });

  it('join неизвестного сервера игнорируется', () => {
    const joins = [];

    model.publisher.on('join', payload => joins.push(payload));
    model.join('ghost');

    expect(joins).toEqual([]);
  });
});

describe('LobbyModel: умный пинг', () => {
  beforeEach(() => {
    model.setList({ total: 1, servers: [server('a')] });
  });

  it('pingHost эмитит ping-request и возвращает true', () => {
    const reqs = [];

    model.publisher.on('ping-request', r => reqs.push(r));

    expect(model.pingHost('a', 1000)).toBe(true);
    expect(reqs[0]).toEqual({ hostId: 'a', pingId: 1 });
  });

  it('повторный пинг в пределах интервала подавляется', () => {
    model.pingHost('a', 1000);

    expect(model.pingHost('a', 3000)).toBe(false); // < 5000
    expect(model.pingHost('a', 6001)).toBe(true); // прошёл интервал
  });

  it('пинг неизвестного сервера не отправляется', () => {
    expect(model.pingHost('ghost', 1000)).toBe(false);
  });

  it('resolvePong считает задержку и эмитит ping-update', () => {
    const updates = [];

    model.publisher.on('ping-update', u => updates.push(u));
    model.pingHost('a', 1000);
    model.resolvePong(1, 1042);

    expect(updates[0]).toEqual({ hostId: 'a', latency: 42 });
  });

  it('pong с неизвестным pingId игнорируется', () => {
    const updates = [];

    model.publisher.on('ping-update', u => updates.push(u));
    model.resolvePong(999, 1042);

    expect(updates).toEqual([]);
  });

  it('reset очищает состояние и разрешает пинг заново', () => {
    model.pingHost('a', 1000);
    model.reset();
    model.setList({ total: 1, servers: [server('a')] });

    expect(model.pingHost('a', 1001)).toBe(true); // интервал забыт
  });
});

describe('LobbyModel: leaderboard (lobby-page-plan)', () => {
  // code review M2: эмит 'leaderboard' схлопывается в один микротаск —
  // события нужно ждать через await, а не проверять синхронно
  it('setLeaderboard публикует leaderboard/total, myPlacement пока null', async () => {
    const events = [];

    model.publisher.on('leaderboard', e => events.push(e));
    model.setLeaderboard({ leaderboard: [{ nick: 'a', rank: 10 }], total: 42 });
    await null;

    expect(events).toEqual([
      { leaderboard: [{ nick: 'a', rank: 10 }], total: 42, myPlacement: null, loaded: true },
    ]);
  });

  it('setPlacement публикует myPlacement, leaderboard/total сохраняются', async () => {
    const events = [];

    model.setLeaderboard({ leaderboard: [{ nick: 'a', rank: 10 }], total: 42 });
    await null;
    model.publisher.on('leaderboard', e => events.push(e));
    model.setPlacement({ placement: 3, total: 42, rank: 5 });
    await null;

    expect(events).toEqual([
      {
        leaderboard: [{ nick: 'a', rank: 10 }],
        total: 42,
        myPlacement: { placement: 3, total: 42, rank: 5 },
        loaded: true,
      },
    ]);
  });

  it('setPlacement с placement=null (не ранжирован) сохраняется как есть', async () => {
    const events = [];

    model.publisher.on('leaderboard', e => events.push(e));
    model.setPlacement({ placement: null, total: 42, rank: 0 });
    await null;

    expect(events[0].myPlacement).toEqual({ placement: null, total: 42, rank: 0 });
  });

  // code review M1: main.js вызывает это перед fetch'ем новой игры, чтобы
  // данные прошлой игры не «залипали» на экране
  it('clearLeaderboard сбрасывает leaderboard/total/myPlacement', async () => {
    model.setLeaderboard({ leaderboard: [{ nick: 'a', rank: 10 }], total: 42 });
    model.setPlacement({ placement: 3, total: 42, rank: 5 });
    await null;

    const events = [];

    model.publisher.on('leaderboard', e => events.push(e));
    model.clearLeaderboard();
    await null;

    expect(events).toEqual([{ leaderboard: [], total: 0, myPlacement: null, loaded: false }]);
  });

  // code review мелочь (lobby-page-review-status): clearLeaderboard обнуляет
  // список до fetch'а (M1) — loaded=false отличает это от "ответ пришёл,
  // список пуст", иначе view на миг рисует "No ranked players yet" вместо
  // состояния загрузки
  it('clearLeaderboard сбрасывает loaded в false, setLeaderboard — обратно в true', async () => {
    model.setLeaderboard({ leaderboard: [{ nick: 'a', rank: 10 }], total: 42 });
    await null;

    const events = [];

    model.publisher.on('leaderboard', e => events.push(e));
    model.clearLeaderboard();
    await null;
    model.setLeaderboard({ leaderboard: [], total: 0 });
    await null;

    expect(events.map(e => e.loaded)).toEqual([false, true]);
  });

  // code review M2: несколько синхронных вызовов в одном такте (как
  // Promise.all в main.js обычно резолвит fetchLeaderboard/fetchPlacement)
  // должны дать один эмит, а не кадр с рассинхронизированным myPlacement
  it('setLeaderboard + setPlacement в одном такте дают один эмит', async () => {
    const events = [];

    model.publisher.on('leaderboard', e => events.push(e));
    model.setLeaderboard({ leaderboard: [{ nick: 'a', rank: 10 }], total: 1 });
    model.setPlacement({ placement: 1, total: 1, rank: 10 });
    await null;

    expect(events).toHaveLength(1);
    expect(events[0].myPlacement).toEqual({ placement: 1, total: 1, rank: 10 });
  });
});
