import { describe, it, expect, vi } from 'vitest';
import { dispatchSocketMessage } from '../../packages/engine/src/client/lib/socketDispatch.js';

// Порт без обработчика (этап 3 плана plugin-forward-compat): раньше
// socketMethods[msg[0]](msg[1]) бросал TypeError и ронял обработку сообщения
// целиком — получатель падал от того, что отправитель знает больше.

describe('dispatchSocketMessage', () => {
  it('отдаёт payload обработчику своего порта', () => {
    const handler = vi.fn();
    const methods = [];

    methods[15] = handler;

    expect(dispatchSocketMessage(methods, [15, { name: 'a' }])).toBe(true);
    expect(handler).toHaveBeenCalledWith({ name: 'a' });
  });

  it('неизвестный порт игнорируется, а не бросает', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    expect(() => dispatchSocketMessage([], [42, 'payload'])).not.toThrow();
    expect(dispatchSocketMessage([], [42, 'payload'])).toBe(false);
    expect(debug).toHaveBeenCalled();

    debug.mockRestore();
  });

  it('пустое сообщение тоже не бросает', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    expect(dispatchSocketMessage([], [])).toBe(false);

    debug.mockRestore();
  });
});
