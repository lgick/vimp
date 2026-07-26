import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Publisher from '../../packages/engine/src/lib/Publisher.js';

// ChatView — синглтон, перезагружаем модуль для изоляции
let ChatView;

const elems = { chatBox: 'chat-box', cmd: 'chat-cmd' };

const seedDom = () => {
  document.body.innerHTML = `
    <div id="chat-box"></div>
    <input id="chat-cmd" />
  `;
};

const makeModel = () => ({ publisher: new Publisher() });

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  seedDom();
  ChatView = (await import('../../packages/engine/src/client/components/view/Chat.js')).default;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ChatView: командная строка', () => {
  it('openCmd очищает и показывает поле ввода', () => {
    const view = new ChatView(makeModel(), elems);
    const cmd = document.getElementById('chat-cmd');
    cmd.value = 'мусор';

    view.openCmd();

    expect(cmd.value).toBe('');
    expect(cmd.style.display).toBe('block');
  });

  it('closeCmd при успехе эмитит message с текстом', () => {
    const view = new ChatView(makeModel(), elems);
    const cmd = document.getElementById('chat-cmd');
    cmd.value = 'привет всем';
    const messages = [];
    view.publisher.on('message', m => messages.push(m));

    view.closeCmd(true);

    expect(messages).toEqual(['привет всем']);
    expect(cmd.style.display).toBe('none');
    expect(cmd.value).toBe('');
  });

  it('closeCmd без успеха не эмитит message', () => {
    const view = new ChatView(makeModel(), elems);
    const spy = vi.fn();
    view.publisher.on('message', spy);

    view.closeCmd(false);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ChatView: строки чата', () => {
  it('createLine добавляет div с текстом и data-name', () => {
    const view = new ChatView(makeModel(), elems);

    view.createLine({ id: 5, message: ['Hello', 'Alice', 1] });

    const line = document.getElementById('line_5');
    expect(line).not.toBeNull();
    expect(line.textContent).toBe('Hello');
    expect(line.className).toBe('line1');
    expect(line.getAttribute('data-name')).toBe('Alice: ');
  });

  it('createLine использует System при отсутствии имени', () => {
    const view = new ChatView(makeModel(), elems);

    view.createLine({ id: 6, message: ['Раунд начался'] });

    expect(document.getElementById('line_6').getAttribute('data-name')).toBe(
      'System: ',
    );
  });

  it('removeLine скрывает и удаляет строку через 2с', () => {
    const view = new ChatView(makeModel(), elems);
    view.createLine({ id: 7, message: ['bye', 'Bob', 0] });

    view.removeLine(7);
    expect(document.getElementById('line_7').style.opacity).toBe('0');

    vi.advanceTimersByTime(2000);
    expect(document.getElementById('line_7')).toBeNull();
  });
});

describe('ChatView: таймеры сообщений', () => {
  it('createTimer эмитит newTimer и oldTimer по истечении времени', () => {
    const view = new ChatView(makeModel(), elems);
    const newTimers = [];
    const oldSpy = vi.fn();
    view.publisher.on('newTimer', d => newTimers.push(d));
    view.publisher.on('oldTimer', oldSpy);

    view.createTimer({ id: 9, time: 1000 });

    expect(newTimers[0].messageId).toBe(9);
    expect(newTimers[0].timerId).toBeDefined();

    vi.advanceTimersByTime(1000);
    expect(oldSpy).toHaveBeenCalled();
  });
});
