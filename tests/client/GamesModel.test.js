import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// GamesModel — синглтон, перезагружаем модуль для изоляции
let GamesModel;

const config = {
  urls: {
    mine: '/games/mine',
    submit: '/games/submit',
    version: id => `/games/mine/${id}/version`,
    admin: '/admin/games',
    staged: '/admin/games/manifest.json',
    stage: id => `/admin/games/${id}/stage`,
    moderate: id => `/admin/games/${id}`,
    versions: id => `/admin/games/${id}/versions`,
  },
  statuses: [{ id: 'pending', title: 'Ожидают' }, { id: 'approved', title: 'Опубликованы' }],
  defaultStatus: 'pending',
};

const answer = (body, ok = true) => ({ ok, json: async () => body });

let model;
let fetchMock;

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  GamesModel = (
    await import('../../packages/engine/src/client/components/model/Games.js')
  ).default;
  model = new GamesModel(config, () => 'token123');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GamesModel: заявки вызывающего', () => {
  it('loadMine публикует список и шлёт Bearer', async () => {
    const games = [{ id: 'tanks', status: 'pending' }];
    const seen = [];

    fetchMock.mockResolvedValue(answer({ games }));
    model.publisher.on('mine-changed', list => seen.push(list));

    await model.loadMine();

    expect(seen).toEqual([games]);
    expect(fetchMock.mock.calls[0][0]).toBe('/games/mine');
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer token123');
  });

  it('список проблем пакета едет наружу событием error', async () => {
    const errors = [];

    fetchMock.mockResolvedValue(answer({ errors: ['нет manifest.json'] }, false));
    model.publisher.on('error', e => errors.push(e));

    await model.submit({ id: 'tanks', packageName: '@vimp-games/tanks' });

    expect(errors[0].scope).toBe('mine');
    expect(errors[0].errors).toEqual([{ name: 'package', error: 'нет manifest.json' }]);
  });

  it('код отказа сервиса тоже превращается в одну ошибку', async () => {
    const errors = [];

    fetchMock.mockResolvedValue(answer({ error: 'gameExists' }, false));
    model.publisher.on('error', e => errors.push(e));

    await model.submit({ id: 'tanks', packageName: '@vimp-games/tanks' });

    expect(errors[0].errors).toEqual([{ name: 'request', error: 'gameExists' }]);
  });

  it('успешная заявка перезапрашивает свой список и объявляет об успехе', async () => {
    const submitted = [];

    fetchMock
      .mockResolvedValueOnce(answer({ game: { id: 'tanks' } }))
      .mockResolvedValueOnce(answer({ games: [{ id: 'tanks' }] }));
    model.publisher.on('submitted', () => submitted.push(true));

    await model.submit({ id: 'tanks', packageName: '@vimp-games/tanks' });

    expect(fetchMock.mock.calls[1][0]).toBe('/games/mine');
    expect(submitted).toHaveLength(1);
  });

  it('отказ по заявке события об успехе не даёт', async () => {
    const submitted = [];

    fetchMock.mockResolvedValue(answer({ error: 'gameExists' }, false));
    model.publisher.on('submitted', () => submitted.push(true));
    model.publisher.on('error', () => {});

    await model.submit({ id: 'tanks', packageName: '@vimp-games/tanks' });

    expect(submitted).toHaveLength(0);
  });

  it('без токена запрос не уходит вовсе', async () => {
    // синглтон: чистый инстанс — только через перезагрузку модуля
    vi.resetModules();

    const Fresh = (
      await import('../../packages/engine/src/client/components/model/Games.js')
    ).default;
    const model2 = new Fresh(config, () => null);
    const errors = [];

    model2.publisher.on('error', e => errors.push(e));

    await model2.loadMine();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors[0].errors).toEqual([{ name: 'request', error: 'unauthorized' }]);
  });
});

describe('GamesModel: модерация', () => {
  const games = [
    { id: 'tanks', status: 'pending' },
    { id: 'snakes', status: 'approved' },
  ];

  it('admin-changed отдаёт только строки открытого фильтра', async () => {
    const seen = [];

    fetchMock.mockResolvedValue(answer({ games }));
    model.publisher.on('admin-changed', data => seen.push(data));

    await model.loadAdmin();

    expect(seen[0].games).toEqual([games[0]]);
    expect(seen[0].filter).toBe('pending');

    model.setFilter('approved');

    expect(seen[1].games).toEqual([games[1]]);
  });

  it('stage публикует манифест застейдженной версии', async () => {
    const staged = [];

    fetchMock
      .mockResolvedValueOnce(answer({ version: '1.1.0', manifest: { id: 'tanks' } }))
      .mockResolvedValueOnce(answer({ games }));
    model.publisher.on('staged', e => staged.push(e));

    await model.stage('tanks', '1.1.0');

    expect(staged).toEqual([
      { id: 'tanks', version: '1.1.0', manifest: { id: 'tanks' } },
    ]);
  });

  it('loadStaged возвращает манифесты уже скачанных черновиков', async () => {
    const staged = [];

    fetchMock.mockResolvedValue(
      answer({ manifests: [{ id: 'tanks', version: '1.1.0', manifest: { id: 'tanks' } }] }),
    );
    model.publisher.on('staged', e => staged.push(e));

    await model.loadStaged();

    expect(fetchMock.mock.calls[0][0]).toBe('/admin/games/manifest.json');
    expect(staged).toEqual([
      { id: 'tanks', version: '1.1.0', manifest: { id: 'tanks' } },
    ]);
  });

  it('moderate шлёт PATCH и перечитывает очередь', async () => {
    fetchMock
      .mockResolvedValueOnce(answer({ game: { id: 'tanks' } }))
      .mockResolvedValueOnce(answer({ games }));

    await model.moderate('tanks', { status: 'approved' });

    expect(fetchMock.mock.calls[0][0]).toBe('/admin/games/tanks');
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(fetchMock.mock.calls[1][0]).toBe('/admin/games');
  });

  it('версии из npm попадают в admin-changed', async () => {
    const seen = [];

    fetchMock.mockResolvedValueOnce(answer({ versions: ['1.0.0', '1.1.0'] }));
    model.publisher.on('admin-changed', data => seen.push(data));

    await model.loadVersions('tanks');

    expect(seen[0].versions.get('tanks')).toEqual(['1.0.0', '1.1.0']);
  });

  it('сетевой сбой не роняет модель', async () => {
    const errors = [];

    fetchMock.mockRejectedValue(new Error('offline'));
    model.publisher.on('error', e => errors.push(e));

    await model.loadAdmin();

    expect(errors[0].errors).toEqual([{ name: 'request', error: 'network' }]);
  });
});
