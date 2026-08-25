import Publisher from '../../../lib/Publisher.js';
import { bindLiveErrors, buildForm, renderFormErrors } from '../../lib/formBuilder.js';

// Singleton AuthView

let authView;

export default class AuthView {
  // texts — игровые тексты формы (authSchema.texts: title, sections);
  // сам каркас (auth.pug) нейтрален и текстов игры не содержит.
  // params — та же дескрипторная схема формы, что и у room-формы
  // (docs/en/plugin-api.md "Form schema"), едет по сети в PS_AUTH_DATA
  constructor(model, elems, texts = null, params = null) {
    if (authView) {
      return authView;
    }

    authView = this;

    this._mPublic = model.publisher;

    this._auth = document.getElementById(elems.authId);
    this._error = document.getElementById(elems.errorId);
    this._enter = document.getElementById(elems.enterId);
    this._fieldsContainer = document.getElementById(elems.fieldsId);
    this._fields = new Map();
    this._descriptors = [];

    this.publisher = new Publisher();

    this._renderTexts(elems, texts);
    this._renderFields(elems, params);

    // ошибки видны по ходу правки (см. bindLiveErrors), а не по клику:
    // до сабмита — по тронутым полям, после — по всей форме
    this._liveErrors = bindLiveErrors(this._fieldsContainer, this._error, () => ({
      descriptors: this._descriptors,
      fields: this._fields,
    }));

    // форма заполнена; клиентская проверка (required/regExp/min/max) —
    // сервер всё равно валидирует своими validators (renderError), это лишь
    // UX-фильтр до отправки
    this._enter.onclick = () => {
      if (this._liveErrors.arm().length) {
        return;
      }

      authView.publisher.emit('enter');
    };

    this._mPublic.on('form', 'renderData', this);
    this._mPublic.on('error', 'renderError', this);
    this._mPublic.on('ok', 'hideAuth', this);
  }

  // строит контролы формы игрока из той же дескрипторной схемы, что и
  // room-форма (единый formBuilder, docs/en/plugin-api.md "Form schema")
  _renderFields(elems, params) {
    if (!Array.isArray(params)) {
      return;
    }

    const container = document.getElementById(elems.fieldsId);

    if (!container) {
      return;
    }

    // param.options — дескриптор-хвост (control/label/min/max/... —
    // "options" здесь ключ протокола PS_AUTH_DATA, не список выбора select
    const descriptors = params.map(({ name, value, options: descriptorRest }) => ({
      name,
      default: value,
      ...descriptorRest,
    }));

    this._descriptors = descriptors;
    // params сюда приходят чужие (PS_AUTH_DATA, тот же массив main.js
    // отдаёт следом в AuthCtrl.init) и остаются нетронутыми: значение поля
    // с единственным вариантом закрепляет main.js (resolveForcedValue) до
    // разветвления на solo-путь, а не эта форма
    this._fields = buildForm(descriptors, container, {}, ({ name, value }) => {
      this.publisher.emit('input', { name, value });
    });
  }

  // заполняет нейтральный каркас текстами игры: заголовок и help-секции
  // (sections: [{ heading, lines: [{ keys, text, last? } | { separator }] }])
  _renderTexts(elems, texts) {
    if (!texts) {
      return;
    }

    const title = document.getElementById(elems.titleId);
    const informs = document.getElementById(elems.informsId);

    if (title && texts.title) {
      title.textContent = texts.title;
    }

    if (!informs || !Array.isArray(texts.sections)) {
      return;
    }

    informs.textContent = '';

    for (const section of texts.sections) {
      const block = document.createElement('div');

      block.className = 'auth-inform';

      if (section.heading) {
        const heading = document.createElement('h4');

        heading.textContent = section.heading;
        block.appendChild(heading);
      }

      for (const line of section.lines || []) {
        if (line.separator) {
          block.appendChild(document.createElement('hr'));
          continue;
        }

        const p = document.createElement('p');

        if (line.last) {
          p.className = 'last';
        }

        const keys = document.createElement('b');

        keys.textContent = line.keys;
        p.appendChild(keys);
        p.appendChild(document.createTextNode(` - ${line.text}`));
        block.appendChild(p);
      }

      informs.appendChild(block);
    }
  }

  // показывает форму
  showAuth() {
    this._auth.style.display = 'block';
  }

  // скрывает форму
  hideAuth(data) {
    if (data) {
      data.forEach(item => {
        localStorage[item.name] = item.value;
      });
    }

    this._auth.style.display = 'none';
  }

  // обновляет форму
  renderData(data) {
    const { name, value } = data;

    // блок ошибок ведёт bindLiveErrors — он перевалидирует форму по 'input',
    // то есть по ходу правки. Чистка, стоявшая здесь, висела на событии
    // модели, а оно приходит из 'change' (у text-инпута — blur): игрок,
    // перейдя из починенного поля в следующее, терял ошибки полей, которых
    // ещё не касался
    this._fields.get(name)?.setValue(value);
  }

  // отображает серверные ошибки (PS_AUTH_DATA/validators) — тот же рендер,
  // что и у клиентской collectFormErrors (formBuilder.renderFormErrors)
  renderError(data) {
    renderFormErrors(this._error, data);
  }
}
