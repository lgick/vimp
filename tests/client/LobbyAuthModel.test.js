import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// LobbyAuthModel — синглтон, перезагружаем модуль для изоляции
let LobbyAuthModel;

const encodeSegment = obj =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const makeToken = payload => `${encodeSegment({ alg: 'RS256' })}.${encodeSegment(payload)}.sig`;

const config = {
  serviceUrl: 'http://auth.test',
  providers: ['github'],
  tokenStorageKey: 'vimpAuthToken',
  queryParams: { token: 'token', pendingToken: 'pendingToken', error: 'authError' },
};

let model;
let store;

beforeEach(async () => {
  vi.resetModules();
  store = {};
  vi.stubGlobal('localStorage', store);
  LobbyAuthModel = (
    await import('../../packages/engine/src/client/components/model/LobbyAuth.js')
  ).default;
  model = new LobbyAuthModel(config);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LobbyAuthModel: boot', () => {
  it('без query и без сессии — login-required со списком провайдеров', () => {
    const events = [];

    model.publisher.on('login-required', p => events.push(p));

    const hadParams = model.boot('');

    expect(hadParams).toBe(false);
    expect(events).toEqual([['github']]);
  });

  it('identity-токен в localStorage восстанавливает сессию', () => {
    store[config.tokenStorageKey] = makeToken({ sub: 'u1', nick: 'Vanya' });

    const events = [];

    model.publisher.on('authenticated', d => events.push(d));

    model.boot('');

    expect(events).toEqual([{ nick: 'Vanya' }]);
    expect(model.getNick()).toBe('Vanya');
  });

  it('просроченный identity-токен в localStorage не восстанавливает сессию (F5)', () => {
    store[config.tokenStorageKey] = makeToken({
      sub: 'u1',
      nick: 'Vanya',
      exp: Math.floor(Date.now() / 1000) - 10,
    });

    const errors = [];
    const required = [];

    model.publisher.on('login-error', e => errors.push(e));
    model.publisher.on('login-required', () => required.push(true));

    model.boot('');

    expect(errors).toEqual(['tokenExpired']);
    expect(required).toEqual([true]);
    expect(model.getNick()).toBeNull();
    expect(store[config.tokenStorageKey]).toBeUndefined();
  });

  it('?token= в query авторизует и сохраняет в localStorage', () => {
    const token = makeToken({ sub: 'u1', nick: 'Vanya' });
    const events = [];

    model.publisher.on('authenticated', d => events.push(d));

    const hadParams = model.boot(`?token=${token}`);

    expect(hadParams).toBe(true);
    expect(events).toEqual([{ nick: 'Vanya' }]);
    expect(store[config.tokenStorageKey]).toBe(token);
  });

  it('?pendingToken= в query требует выбора ника, не сохраняет в localStorage', () => {
    const events = [];

    model.publisher.on('nick-required', () => events.push('nick-required'));

    const hadParams = model.boot('?pendingToken=pending-abc');

    expect(hadParams).toBe(true);
    expect(events).toEqual(['nick-required']);
    expect(store[config.tokenStorageKey]).toBeUndefined();
  });

  it('?authError= эмитит ошибку и падает обратно на login-required', () => {
    const errors = [];
    const required = [];

    model.publisher.on('login-error', e => errors.push(e));
    model.publisher.on('login-required', () => required.push(true));

    const hadParams = model.boot('?authError=oauthFailed');

    expect(hadParams).toBe(true);
    expect(errors).toEqual(['oauthFailed']);
    expect(required).toEqual([true]);
  });
});

describe('LobbyAuthModel: submitNick', () => {
  it('без pendingToken эмитит sessionExpired', async () => {
    const errors = [];

    model.publisher.on('nick-error', e => errors.push(e));
    await model.submitNick('Vanya');

    expect(errors).toEqual(['sessionExpired']);
  });

  it('успешный POST /nick авторизует и сохраняет токен', async () => {
    model.boot('?pendingToken=pending-abc');

    const token = makeToken({ sub: 'u1', nick: 'Vanya' });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token }),
    });

    const events = [];

    model.publisher.on('authenticated', d => events.push(d));
    await model.submitNick('Vanya');

    expect(fetch).toHaveBeenCalledWith(
      'http://auth.test/nick',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer pending-abc' }),
      }),
    );
    expect(events).toEqual([{ nick: 'Vanya' }]);
    expect(store[config.tokenStorageKey]).toBe(token);
  });

  it('занятый ник (409) эмитит nick-error nickTaken', async () => {
    model.boot('?pendingToken=pending-abc');

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'nickTaken' }),
    });

    const errors = [];

    model.publisher.on('nick-error', e => errors.push(e));
    await model.submitNick('Vanya');

    expect(errors).toEqual(['nickTaken']);
  });

  it('сетевая ошибка эмитит nick-error network', async () => {
    model.boot('?pendingToken=pending-abc');

    global.fetch = vi.fn().mockRejectedValue(new Error('boom'));

    const errors = [];

    model.publisher.on('nick-error', e => errors.push(e));
    await model.submitNick('Vanya');

    expect(errors).toEqual(['network']);
  });
});

describe('LobbyAuthModel: logout', () => {
  it('очищает токен и возвращает к login-required', () => {
    store[config.tokenStorageKey] = makeToken({ sub: 'u1', nick: 'Vanya' });
    model.boot('');

    const events = [];

    model.publisher.on('login-required', p => events.push(p));
    model.logout();

    expect(events).toEqual([['github']]);
    expect(model.getToken()).toBeNull();
    expect(store[config.tokenStorageKey]).toBeUndefined();
  });
});

describe('LobbyAuthModel: loginUrl', () => {
  it('строит URL старта OAuth с returnUrl текущей страницы', () => {
    const url = model.loginUrl('github');

    expect(url).toBe(
      `http://auth.test/oauth/github/start?returnUrl=${encodeURIComponent(
        `${window.location.origin}${window.location.pathname}`,
      )}`,
    );
  });
});
