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
  it('join известного сервера эмитит join', () => {
    const joins = [];

    model.publisher.on('join', id => joins.push(id));
    model.setList({ total: 1, servers: [server('a')] });
    model.join('a');

    expect(joins).toEqual(['a']);
  });

  it('join неизвестного сервера игнорируется', () => {
    const joins = [];

    model.publisher.on('join', id => joins.push(id));
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
