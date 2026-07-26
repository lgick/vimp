import { describe, it, expect, vi } from 'vitest';
import PlayerDataSync from '../../packages/engine/src/host/meta/modules/PlayerDataSync.js';

const makeFetch = responses => {
  let call = 0;
  return vi.fn(async () => responses[call++] ?? responses[responses.length - 1]);
};

describe('PlayerDataSync', () => {
  it('load подгружает rank и state с мастера по Bearer-токену', async () => {
    const fetchImpl = makeFetch([
      { ok: true, json: async () => ({ rank: 7 }) },
      { ok: true, json: async () => ({ state: { skill: 3 } }) },
    ]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');

    expect(sync.getRank('p1')).toBe(7);
    expect(sync.getState('p1')).toEqual({ skill: 3 });
    expect(fetchImpl).toHaveBeenCalledWith('/auth/rank?game=tanks', {
      method: 'GET',
      headers: { authorization: 'Bearer tok' },
      body: undefined,
    });
  });

  it('load оставляет дефолты при сбое auth-сервиса', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const sync = new PlayerDataSync('tanks', { fetchImpl, defaultState: { skill: 0 } });

    await sync.load('p1', 'tok');

    expect(sync.getRank('p1')).toBe(0);
    expect(sync.getState('p1')).toEqual({ skill: 0 });
  });

  it('addRank накапливает дельту ранга', async () => {
    const fetchImpl = makeFetch([
      { ok: true, json: async () => ({ rank: 10 }) },
      { ok: true, json: async () => ({ state: {} }) },
    ]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');
    sync.addRank('p1', 1);
    sync.addRank('p1', -1);
    sync.addRank('p1', 1);

    expect(sync.getRank('p1')).toBe(11);
  });

  it('setState заменяет state участника', async () => {
    const fetchImpl = makeFetch([
      { ok: true, json: async () => ({ rank: 0 }) },
      { ok: true, json: async () => ({ state: {} }) },
    ]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');
    sync.setState('p1', { skill: 9 });

    expect(sync.getState('p1')).toEqual({ skill: 9 });
  });

  it('flush отправляет PUT rank дельтой (не абсолютом) и state текущим значением', async () => {
    const fetchImpl = makeFetch([
      { ok: true, json: async () => ({ rank: 5 }) },
      { ok: true, json: async () => ({ state: {} }) },
      { ok: true, json: async () => ({ ok: true }) },
      { ok: true, json: async () => ({ ok: true }) },
    ]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');
    sync.addRank('p1', 2);
    await sync.flush('p1');

    expect(fetchImpl).toHaveBeenLastCalledWith('/auth/state?game=tanks', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ state: {} }),
    });
    expect(fetchImpl).toHaveBeenCalledWith('/auth/rank?game=tanks', {
      method: 'PUT',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ delta: 2 }),
    });
  });

  it('flush после успеха не переотправляет уже учтённую дельту', async () => {
    const fetchImpl = makeFetch([
      { ok: true, json: async () => ({ rank: 5 }) },
      { ok: true, json: async () => ({ state: {} }) },
      { ok: true, json: async () => ({ ok: true }) },
      { ok: true, json: async () => ({ ok: true }) },
    ]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');
    sync.addRank('p1', 2);
    await sync.flush('p1');

    fetchImpl.mockClear();
    fetchImpl.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    await sync.flush('p1');

    const rankPut = fetchImpl.mock.calls.find(([url]) => url.startsWith('/auth/rank'));
    expect(rankPut[1].body).toBe(JSON.stringify({ delta: 0 }));
  });

  it('flush не теряет дельту, если PUT rank завершился неуспехом', async () => {
    const fetchImpl = makeFetch([
      { ok: true, json: async () => ({ rank: 5 }) },
      { ok: true, json: async () => ({ state: {} }) },
      { ok: false, json: async () => ({ error: 'down' }) },
      { ok: true, json: async () => ({ ok: true }) },
    ]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');
    sync.addRank('p1', 3);
    await sync.flush('p1');

    fetchImpl.mockClear();
    fetchImpl.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    await sync.flush('p1');

    const rankPut = fetchImpl.mock.calls.find(([url]) => url.startsWith('/auth/rank'));
    expect(rankPut[1].body).toBe(JSON.stringify({ delta: 3 }));
  });

  it('flush неизвестного участника не бросает исключение', async () => {
    const sync = new PlayerDataSync('tanks', { fetchImpl: vi.fn() });

    await expect(sync.flush('ghost')).resolves.toBeUndefined();
  });

  it('removeUser удаляет запись участника', async () => {
    const fetchImpl = makeFetch([
      { ok: true, json: async () => ({ rank: 0 }) },
      { ok: true, json: async () => ({ state: {} }) },
    ]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');
    sync.removeUser('p1');

    expect(sync.getRank('p1')).toBe(0);
    expect(sync.getState('p1')).toEqual({});
  });

  it('flush не шлёт PUT, если load ни разу не удался (F4 — не клобберить сохранённый rank)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');
    fetchImpl.mockClear();
    await sync.flush('p1');

    // flush пытается повторить load (2 GET), но PUT не шлёт — ничего не loaded
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'PUT' }));
  });

  it('flush отправляет PUT только для успешно загруженной части (rank ок, state — нет)', async () => {
    const fetchImpl = vi.fn(async url => (url.startsWith('/auth/rank')
      ? { ok: true, json: async () => ({ rank: 5 }) }
      : { ok: false }));
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok');
    fetchImpl.mockClear();
    await sync.flush('p1');

    // stateLoaded всё ещё false -> flush повторяет load() (2 GET), затем
    // шлёт PUT только для rank (уже загруженного ранее)
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const putCalls = fetchImpl.mock.calls.filter(([, opts]) => opts.method === 'PUT');

    expect(putCalls).toHaveLength(1);
    expect(putCalls[0][0]).toBe('/auth/rank?game=tanks');
  });

  it('addRank во время загрузки не теряется под серверным rank (F9)', async () => {
    let resolveRank;
    const fetchImpl = vi.fn(url => {
      if (url.startsWith('/auth/rank')) {
        return new Promise(resolve => {
          resolveRank = () => resolve({ ok: true, json: async () => ({ rank: 100 }) });
        });
      }

      return Promise.resolve({ ok: true, json: async () => ({ state: {} }) });
    });
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    const loadPromise = sync.load('p1', 'tok');

    sync.addRank('p1', 5);
    resolveRank();
    await loadPromise;

    expect(sync.getRank('p1')).toBe(105);
  });

  it('defaultState клонируется на каждую запись, не расшаривается между участниками (F10)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false }));
    const sync = new PlayerDataSync('tanks', { fetchImpl, defaultState: { skill: 0 } });

    await sync.load('p1', 'tok1');
    await sync.load('p2', 'tok2');

    sync.getState('p1').skill = 99;

    expect(sync.getState('p2')).toEqual({ skill: 0 });
  });

  it('flushAll синхронизирует всех текущих участников', async () => {
    const fetchImpl = makeFetch([{ ok: true, json: async () => ({}) }]);
    const sync = new PlayerDataSync('tanks', { fetchImpl });

    await sync.load('p1', 'tok1');
    await sync.load('p2', 'tok2');

    fetchImpl.mockClear();
    await sync.flushAll();

    // 2 участника × (rank + state) = 4 запроса
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
