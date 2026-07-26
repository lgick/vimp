import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// LobbyAuthView — синглтон, перезагружаем модуль для изоляции
let LobbyAuthView;

const config = {
  elems: {
    containerId: 'lobby-auth',
    loginSectionId: 'lobby-auth-login',
    loginErrorId: 'lobby-auth-login-error',
    nickSectionId: 'lobby-auth-nick',
    nickInputId: 'lobby-auth-nick-input',
    nickErrorId: 'lobby-auth-nick-error',
    nickSubmitId: 'lobby-auth-nick-submit',
    lobbyId: 'lobby',
    userId: 'lobby-user',
    userNickId: 'lobby-user-nick',
    userLogoutId: 'lobby-user-logout',
  },
  providerButtonClass: 'lobby-auth-provider',
};

const seedDom = () => {
  document.body.innerHTML = `
    <div id="lobby-auth">
      <div id="lobby-auth-login">
        <button class="lobby-auth-provider" id="lobby-auth-login-github" data-provider="github"></button>
        <button class="lobby-auth-provider" id="lobby-auth-login-google" data-provider="google"></button>
        <div id="lobby-auth-login-error"></div>
      </div>
      <div id="lobby-auth-nick">
        <input id="lobby-auth-nick-input" />
        <div id="lobby-auth-nick-error"></div>
        <button id="lobby-auth-nick-submit"></button>
      </div>
    </div>
    <div id="lobby">
      <div id="lobby-user">
        <b id="lobby-user-nick"></b>
        <button id="lobby-user-logout"></button>
      </div>
    </div>
  `;
};

const makeModel = () => ({ publisher: new Publisher() });

let model;
let view;

beforeEach(async () => {
  vi.resetModules();
  seedDom();
  LobbyAuthView = (
    await import('../../packages/engine/src/client/components/view/LobbyAuth.js')
  ).default;
  model = makeModel();
  view = new LobbyAuthView(model, config);
});

describe('LobbyAuthView: переключение секций', () => {
  it('login-required показывает login, скрывает nick/lobby/user', () => {
    model.publisher.emit('login-required', ['github']);

    expect(document.getElementById('lobby-auth').style.display).toBe('block');
    expect(document.getElementById('lobby-auth-login').style.display).toBe('block');
    expect(document.getElementById('lobby-auth-nick').style.display).toBe('none');
    expect(document.getElementById('lobby').style.display).toBe('none');
    expect(document.getElementById('lobby-user').style.display).toBe('none');
  });

  it('login-required фильтрует кнопки провайдеров по списку', () => {
    model.publisher.emit('login-required', ['github']);

    expect(document.getElementById('lobby-auth-login-github').style.display).toBe('');
    expect(document.getElementById('lobby-auth-login-google').style.display).toBe('none');
  });

  it('nick-required показывает форму ника, очищает инпут и ошибку', () => {
    document.getElementById('lobby-auth-nick-input').value = 'stale';
    document.getElementById('lobby-auth-nick-error').textContent = 'stale error';

    model.publisher.emit('nick-required');

    expect(document.getElementById('lobby-auth-login').style.display).toBe('none');
    expect(document.getElementById('lobby-auth-nick').style.display).toBe('block');
    expect(document.getElementById('lobby-auth-nick-input').value).toBe('');
    expect(document.getElementById('lobby-auth-nick-error').textContent).toBe('');
  });

  it('authenticated скрывает lobby-auth и показывает lobby + бейдж ника', () => {
    model.publisher.emit('authenticated', { nick: 'Vanya' });

    expect(document.getElementById('lobby-auth').style.display).toBe('none');
    expect(document.getElementById('lobby').style.display).toBe('block');
    expect(document.getElementById('lobby-user').style.display).toBe('block');
    expect(document.getElementById('lobby-user-nick').textContent).toBe('Vanya');
  });
});

describe('LobbyAuthView: события пользователя', () => {
  it('клик по кнопке провайдера эмитит login с provider', () => {
    const logins = [];

    view.publisher.on('login', p => logins.push(p));
    document.getElementById('lobby-auth-login-github').click();

    expect(logins).toEqual(['github']);
  });

  it('сабмит ника эмитит nick с тримленным значением', () => {
    const nicks = [];

    view.publisher.on('nick', n => nicks.push(n));
    document.getElementById('lobby-auth-nick-input').value = '  Vanya  ';
    document.getElementById('lobby-auth-nick-submit').click();

    expect(nicks).toEqual(['Vanya']);
  });

  it('Enter в поле ника эмитит nick', () => {
    const nicks = [];

    view.publisher.on('nick', n => nicks.push(n));

    const input = document.getElementById('lobby-auth-nick-input');

    input.value = 'Vanya';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(nicks).toEqual(['Vanya']);
  });

  it('клик по logout эмитит logout', () => {
    const logouts = [];

    view.publisher.on('logout', () => logouts.push(true));
    document.getElementById('lobby-user-logout').click();

    expect(logouts).toEqual([true]);
  });
});

describe('LobbyAuthView: ошибки', () => {
  it('login-error рендерит сообщение', () => {
    model.publisher.emit('login-error', 'oauthFailed');

    expect(document.getElementById('lobby-auth-login-error').textContent).toBe('oauthFailed');
  });

  it('nick-error nickTaken рендерит человекочитаемое сообщение', () => {
    model.publisher.emit('nick-error', 'nickTaken');

    expect(document.getElementById('lobby-auth-nick-error').textContent).toBe(
      'This nick is already taken',
    );
  });

  it('неизвестный код nick-error даёт общий фолбэк', () => {
    model.publisher.emit('nick-error', 'somethingWeird');

    expect(document.getElementById('lobby-auth-nick-error').textContent).toBe(
      'Something went wrong',
    );
  });
});
