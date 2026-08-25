import { describe, it, expect, beforeEach, vi } from 'vitest';

// AuthModel — синглтон, перезагружаем модуль для изоляции
let AuthModel;

// validateAuth инжектится; по умолчанию — без ошибок
const makeModel = (validateAuth = () => undefined) =>
  new AuthModel(validateAuth);

const collect = model => {
  const events = [];
  ['form', 'socket', 'ok', 'error'].forEach(type =>
    model.publisher.on(type, data => events.push({ type, data })),
  );
  return events;
};

beforeEach(async () => {
  vi.resetModules();
  AuthModel = (await import('../../packages/engine/src/client/components/model/Auth.js')).default;
});

describe('AuthModel.add / update', () => {
  it('add сохраняет значение и эмитит form', () => {
    const model = makeModel();
    const events = collect(model);

    model.add({ name: 'login', value: 'Bob', options: {} });
    expect(events.find(e => e.type === 'form').data).toEqual({
      name: 'login',
      value: 'Bob',
    });
  });

  // формат поля проверяет formBuilder.collectFormErrors перед сабмитом —
  // модель второй, параллельной проверки по options.regExp больше не
  // делает: по проводу (PS_AUTH_DATA) regExp приезжает строкой, у которой
  // нет .test, а молчаливое зануление значения не давало игроку ни строки
  // ошибки, ни понимания, куда делся ввод
  it('update принимает значение как есть, даже когда в options лежит regExp', () => {
    const model = makeModel();
    model.add({ name: 'login', value: '', options: { regExp: '^[a-z]+$' } });
    const events = collect(model);

    expect(() => model.update({ name: 'login', value: '123' })).not.toThrow();
    expect(events.find(e => e.type === 'form').data.value).toBe('123');
  });

  it('update для имени без предшествующего add не падает (нет записи в _options)', () => {
    const model = makeModel();
    const events = collect(model);

    expect(() =>
      model.update({ name: 'unknown', value: 'x' }),
    ).not.toThrow();
    expect(events.find(e => e.type === 'form').data).toEqual({
      name: 'unknown',
      value: 'x',
    });
  });
});

describe('AuthModel.send', () => {
  it('при ошибках валидации эмитит error', () => {
    const errors = [{ name: 'login', error: 'not valid' }];
    const model = makeModel(() => errors);
    model.add({ name: 'login', value: 'x', options: {} });
    const events = collect(model);

    model.send();
    expect(events.find(e => e.type === 'error').data).toBe(errors);
    expect(events.find(e => e.type === 'socket')).toBeUndefined();
  });

  it('без ошибок отправляет данные на сервер', () => {
    const model = makeModel(() => undefined);
    model.add({ name: 'login', value: 'Bob', options: {} });
    const events = collect(model);

    model.send();
    expect(events.find(e => e.type === 'socket').data).toEqual({ login: 'Bob' });
  });

  it('повторный send блокируется до ответа сервера', () => {
    const model = makeModel(() => undefined);
    model.add({ name: 'login', value: 'Bob', options: {} });
    const events = collect(model);

    model.send();
    model.send(); // должен быть проигнорирован (sendStatus)

    expect(events.filter(e => e.type === 'socket')).toHaveLength(1);
  });
});

describe('AuthModel.parseRes', () => {
  it('успех эмитит ok с данными из storage', () => {
    const model = makeModel();
    model.add({
      name: 'login',
      value: 'Bob',
      options: { storage: 'savedLogin' },
    });
    const events = collect(model);

    model.parseRes(null);
    expect(events.find(e => e.type === 'ok').data).toEqual([
      { name: 'savedLogin', value: 'Bob' },
    ]);
  });

  it('ошибка эмитит error и снимает блокировку send', () => {
    const model = makeModel(() => undefined);
    model.add({ name: 'login', value: 'Bob', options: {} });
    const events = collect(model);

    model.send(); // ставит sendStatus = true
    model.parseRes([{ error: 'bad' }]); // снимает блокировку
    model.send(); // снова можно отправить

    expect(events.filter(e => e.type === 'socket')).toHaveLength(2);
    expect(events.find(e => e.type === 'error')).toBeDefined();
  });
});
