import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// AuthView — синглтон, перезагружаем модуль для изоляции
let AuthView;

const elems = {
  authId: 'auth',
  formId: 'auth-form',
  errorId: 'auth-error',
  enterId: 'auth-enter',
};

const seedDom = () => {
  document.body.innerHTML = `
    <div id="auth">
      <form id="auth-form">
        <input type="text" name="login" value="" />
        <input type="radio" name="team" value="1" />
        <input type="radio" name="team" value="2" />
      </form>
      <div id="auth-error"></div>
      <button id="auth-enter">OK</button>
    </div>
  `;
};

const makeModel = () => ({ publisher: new Publisher() });

beforeEach(async () => {
  vi.resetModules();
  seedDom();
  AuthView = (await import('../../packages/engine/src/client/components/view/Auth.js')).default;
});

describe('AuthView: показ/скрытие', () => {
  it('showAuth/hideAuth переключают display', () => {
    const view = new AuthView(makeModel(), elems);

    view.showAuth();
    expect(document.getElementById('auth').style.display).toBe('block');

    view.hideAuth();
    expect(document.getElementById('auth').style.display).toBe('none');
  });

  it('hideAuth сохраняет данные в localStorage', () => {
    const store = {};
    vi.stubGlobal('localStorage', store);
    const view = new AuthView(makeModel(), elems);

    view.hideAuth([{ name: 'login', value: 'Bob' }]);
    expect(store.login).toBe('Bob');

    vi.unstubAllGlobals();
  });
});

describe('AuthView.renderData', () => {
  it('заполняет текстовый инпут и чистит ошибку', () => {
    const view = new AuthView(makeModel(), elems);
    document.getElementById('auth-error').textContent = 'старая ошибка';

    view.renderData({ name: 'login', value: 'Alice' });

    const input = document.querySelector('input[name="login"]');
    expect(input.value).toBe('Alice');
    expect(document.getElementById('auth-error').textContent).toBe('');
  });

  it('отмечает нужный radio', () => {
    const view = new AuthView(makeModel(), elems);

    view.renderData({ name: 'team', value: '2' });

    const radios = document.querySelectorAll('input[name="team"]');
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
  });
});

describe('AuthView.renderError', () => {
  it('добавляет строку ошибки с текстом', () => {
    const view = new AuthView(makeModel(), elems);

    view.renderError([{ name: 'login', error: 'too short' }]);

    const err = document.getElementById('auth-error');
    expect(err.children.length).toBe(1);
    expect(err.textContent).toBe('LOGIN: too short');
  });

  it('использует дефолтный текст при отсутствии error', () => {
    const view = new AuthView(makeModel(), elems);

    view.renderError([{ name: 'team', error: '' }]);

    expect(document.getElementById('auth-error').textContent).toBe(
      'TEAM is not correctly!',
    );
  });
});

describe('AuthView: события DOM', () => {
  it('изменение инпута эмитит input', () => {
    const model = makeModel();
    const view = new AuthView(model, elems);
    const events = [];
    view.publisher.on('input', d => events.push(d));

    const input = document.querySelector('input[name="login"]');
    input.value = 'Neo';
    // событие всплывает от инпута к форме, e.target === инпут
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(events[0]).toEqual({ name: 'login', value: 'Neo' });
  });

  it('клик по enter эмитит enter', () => {
    const view = new AuthView(makeModel(), elems);
    const enterSpy = vi.fn();
    view.publisher.on('enter', enterSpy);

    document.getElementById('auth-enter').click();

    expect(enterSpy).toHaveBeenCalled();
  });

  it('событие ok модели скрывает форму', () => {
    const model = makeModel();
    new AuthView(model, elems);

    model.publisher.emit('ok');
    expect(document.getElementById('auth').style.display).toBe('none');
  });
});

describe('AuthView: тексты игры (authSchema.texts, Д2)', () => {
  const textElems = {
    ...elems,
    titleId: 'auth-title',
    informsId: 'auth-informs',
  };

  const seedTextDom = () => {
    seedDom();
    const form = document.getElementById('auth-form');
    const title = document.createElement('h2');
    title.id = 'auth-title';
    const informs = document.createElement('div');
    informs.id = 'auth-informs';
    form.appendChild(title);
    form.appendChild(informs);
  };

  it('подставляет заголовок и help-секции в нейтральный каркас', () => {
    seedTextDom();

    new AuthView(makeModel(), textElems, {
      title: 'My Game',
      sections: [
        {
          heading: 'Controls',
          lines: [
            { keys: 'W, S', text: 'move' },
            { separator: true },
            { keys: 'J', text: 'fire', last: true },
          ],
        },
      ],
    });

    expect(document.getElementById('auth-title').textContent).toBe('My Game');

    const section = document.querySelector('#auth-informs .auth-inform');
    expect(section.querySelector('h4').textContent).toBe('Controls');
    expect(section.querySelector('hr')).not.toBeNull();

    const lines = [...section.querySelectorAll('p')];
    expect(lines[0].textContent).toBe('W, S - move');
    expect(lines[1].className).toBe('last');
  });

  it('без texts каркас не трогается (обратная совместимость)', () => {
    seedTextDom();

    new AuthView(makeModel(), textElems);

    expect(document.getElementById('auth-title').textContent).toBe('');
    expect(document.getElementById('auth-informs').children.length).toBe(0);
  });
});
