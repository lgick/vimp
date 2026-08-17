import { describe, it, expect, beforeEach, vi } from 'vitest';
import WebSocketTransport from '../../../packages/engine/src/client/network/WebSocketTransport.js';

// Третий транспорт клиента (Этап 2 плана standalone-sdk): прямой WebSocket
// dedicated-сервера. Сокет фейковый — важен контракт, а не сеть.

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = CONNECTING;
    this.binaryType = 'blob';
    this.sent = [];
    this.closeCalls = 0;
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = CLOSED;
  }

  // события сервера
  emitOpen() {
    this.readyState = OPEN;
    this.onopen();
  }

  emitMessage(data) {
    this.onmessage({ data });
  }

  emitClose() {
    this.readyState = CLOSED;
    this.onclose();
  }
}

describe('WebSocketTransport', () => {
  let socket;
  let transport;

  beforeEach(() => {
    socket = null;
    transport = new WebSocketTransport('ws://host/game', {
      socketFactory: url => {
        socket = new FakeSocket(url);

        return socket;
      },
    });
  });

  it('поднимает сокет с binaryType=arraybuffer', () => {
    transport.connect();

    expect(socket.url).toBe('ws://host/game');
    // иначе клиент получит Blob и не отличит кадр снапшота от JSON-порта
    expect(socket.binaryType).toBe('arraybuffer');
  });

  it('транслирует open/message/close в publisher', () => {
    const open = vi.fn();
    const message = vi.fn();
    const close = vi.fn();
    const buffer = new ArrayBuffer(4);

    transport.publisher.on('open', open);
    transport.publisher.on('message', message);
    transport.publisher.on('close', close);
    transport.connect();

    socket.emitOpen();
    socket.emitMessage('[0,null]');
    socket.emitMessage(buffer);
    socket.emitClose();

    expect(open).toHaveBeenCalledTimes(1);
    expect(message).toHaveBeenNthCalledWith(1, '[0,null]');
    expect(message).toHaveBeenNthCalledWith(2, buffer);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('шлёт строки и бинарь только после open', () => {
    const buffer = new ArrayBuffer(2);

    transport.connect();
    transport.send('[6,"hi"]');

    expect(socket.sent).toEqual([]);

    socket.emitOpen();
    transport.send('[6,"hi"]');
    // reliable у WebSocket смысла не имеет и игнорируется
    transport.send(buffer, false);

    expect(socket.sent).toEqual(['[6,"hi"]', buffer]);
  });

  it('после закрытия ничего не отправляет', () => {
    transport.connect();
    socket.emitOpen();
    socket.emitClose();
    transport.send('[6,"late"]');

    expect(socket.sent).toEqual([]);
  });

  it('close() закрывает сокет и эмитит close ровно один раз', () => {
    const close = vi.fn();

    transport.publisher.on('close', close);
    transport.connect();
    socket.emitOpen();

    transport.close();
    transport.close();
    socket.emitClose();

    expect(socket.closeCalls).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
