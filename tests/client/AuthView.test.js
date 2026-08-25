import { describe, it, expect, beforeEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// AuthView — синглтон, перезагружаем модуль для изоляции
let AuthView;

const elems = {
  authId: 'auth',
  errorId: 'auth-error',
  enterId: 'auth-enter',
  fieldsId: 'auth-fields',
};

const seedDom = () => {
  document.body.innerHTML = `
    <div id="auth">
      <div id="auth-form">
        <div id="auth-error"></div>
        <div id="auth-fields"></div>
        <button id="auth-enter">OK</button>
      </div>
    </div>
  `;
};

const authParams = [
  { name: 'login', value: '', options: { control: 'text', label: 'Login' } },
  {
    name: 'team',
    value: '2',
    options: {
      control: 'radio',
      label: 'Team',
      options: [
        { value: '1', label: 'Red' },
        { value: '2', label: 'Blue' },
      ],
    },
  },
];

const makeModel = () => ({ publisher: new Publisher() });

beforeEach(async () => {
  vi.resetModules();
  seedDom();
  AuthView = (await import('../../packages/engine/src/client/components/view/Auth.js')).default;
});

describe('AuthView: показ/скрытие', () => {
  it('showAuth/hideAuth переключают display', () => {
    const view = new AuthView(makeModel(), elems, null, authParams);

    view.showAuth();
    expect(document.getElementById('auth').style.display).toBe('block');

    view.hideAuth();
    expect(document.getElementById('auth').style.display).toBe('none');
  });

  it('hideAuth сохраняет данные в localStorage', () => {
    const store = {};
    vi.stubGlobal('localStorage', store);
    const view = new AuthView(makeModel(), elems, null, authParams);

    view.hideAuth([{ name: 'login', value: 'Bob' }]);
    expect(store.login).toBe('Bob');

    vi.unstubAllGlobals();
  });
});

describe('AuthView.renderData', () => {
  it('заполняет текстовый инпут и чистит ошибку', () => {
    const view = new AuthView(makeModel(), elems, null, authParams);
    document.getElementById('auth-error').textContent = 'старая ошибка';

    view.renderData({ name: 'login', value: 'Alice' });

    const input = document.querySelector('input[name="login"]');
    expect(input.value).toBe('Alice');
    expect(document.getElementById('auth-error').textContent).toBe('');
  });

  it('отмечает нужный radio-инпут', () => {
    const view = new AuthView(makeModel(), elems, null, authParams);

    view.renderData({ name: 'team', value: '1' });

    const inputs = document.querySelectorAll('input[type=radio]');
    expect(inputs[0].checked).toBe(true);
    expect(inputs[1].checked).toBe(false);
  });
});

describe('AuthView: единственный вариант select/radio', () => {
  // vimp-snakes/model: поле скрыто (singleOption), поправить рассинхрон
  // некому — при устаревшем/несуществующем значении с сервера (например,
  // localStorage[storage] от версии игры, где вариантов было больше) поле
  // должно принудительно нести единственно возможное значение
  it('поправляет устаревшее value в params на принудительное — тот же массив едет в AuthCtrl.init', () => {
    const params = [
      {
        name: 'model',
        value: 's0-no-longer-exists',
        options: { control: 'select', label: 'Snake', options: ['s1'], storage: 'model' },
      },
    ];

    new AuthView(makeModel(), elems, null, params);

    expect(params[0].value).toBe('s1');
  });

  it('не трогает params для поля с несколькими вариантами', () => {
    const params = [...authParams];

    new AuthView(makeModel(), elems, null, params);

    expect(params.find(p => p.name === 'team').value).toBe('2');
  });
});

describe('AuthView.renderError', () => {
  it('добавляет строку ошибки с текстом', () => {
    const view = new AuthView(makeModel(), elems, null, authParams);

    view.renderError([{ name: 'login', error: 'too short' }]);

    const err = document.getElementById('auth-error');
    expect(err.children.length).toBe(1);
    expect(err.textContent).toBe('LOGIN: too short');
  });

  it('использует дефолтный текст при отсутствии error', () => {
    const view = new AuthView(makeModel(), elems, null, authParams);

    view.renderError([{ name: 'team', error: '' }]);

    expect(document.getElementById('auth-error').textContent).toBe(
      'TEAM is not correctly!',
    );
  });
});

describe('AuthView: события DOM', () => {
  it('изменение инпута эмитит input', () => {
    const model = makeModel();
    const view = new AuthView(model, elems, null, authParams);
    const events = [];
    view.publisher.on('input', d => events.push(d));

    const input = document.querySelector('input[name="login"]');
    input.value = 'Neo';
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(events[0]).toEqual({ name: 'login', value: 'Neo' });
  });

  it('смена radio-инпута эмитит input', () => {
    const model = makeModel();
    const view = new AuthView(model, elems, null, authParams);
    const events = [];
    view.publisher.on('input', d => events.push(d));

    const input = document.querySelectorAll('input[type=radio]')[0];
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(events[0]).toEqual({ name: 'team', value: '1' });
  });

  it('клик по enter эмитит enter', () => {
    const view = new AuthView(makeModel(), elems, null, authParams);
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

  it('клик по enter с невалидным полем не эмитит enter и рисует ошибку', () => {
    const requiredParams = [
      { name: 'login', value: '', options: { control: 'text', label: 'Login', required: true } },
    ];
    const view = new AuthView(makeModel(), elems, null, requiredParams);
    const enterSpy = vi.fn();
    view.publisher.on('enter', enterSpy);

    document.getElementById('auth-enter').click();

    expect(enterSpy).not.toHaveBeenCalled();
    expect(document.getElementById('auth-error').textContent).toBe('LOGIN: required');
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
