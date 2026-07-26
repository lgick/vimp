import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// LobbyAuthCtrl — синглтон, перезагружаем модуль для изоляции
let LobbyAuthCtrl;

const makeModel = () => ({
  boot: vi.fn(() => true),
  loginUrl: vi.fn(provider => `http://auth.test/oauth/${provider}/start`),
  submitNick: vi.fn(),
  logout: vi.fn(),
});

const makeView = () => ({ publisher: new Publisher() });

let model;
let view;
let ctrl;

beforeEach(async () => {
  vi.resetModules();
  LobbyAuthCtrl = (
    await import('../../packages/engine/src/client/components/controller/LobbyAuth.js')
  ).default;
  model = makeModel();
  view = makeView();
  ctrl = new LobbyAuthCtrl(model, view);

  delete window.location;
  window.location = { href: '' };
});

describe('LobbyAuthCtrl: init', () => {
  it('делегирует разбор query-string модели и возвращает её результат', () => {
    const result = ctrl.init('?token=abc');

    expect(model.boot).toHaveBeenCalledWith('?token=abc');
    expect(result).toBe(true);
  });
});

describe('LobbyAuthCtrl: проксирование view-событий в модель', () => {
  it('login → редирект на loginUrl провайдера', () => {
    view.publisher.emit('login', 'github');

    expect(model.loginUrl).toHaveBeenCalledWith('github');
    expect(window.location.href).toBe('http://auth.test/oauth/github/start');
  });

  it('nick → model.submitNick', () => {
    view.publisher.emit('nick', 'Vanya');

    expect(model.submitNick).toHaveBeenCalledWith('Vanya');
  });

  it('logout → model.logout', () => {
    view.publisher.emit('logout');

    expect(model.logout).toHaveBeenCalled();
  });
});
