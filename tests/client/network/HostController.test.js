import { describe, it, expect, vi } from 'vitest';
import HostController from '../../../packages/engine/src/client/network/HostController.js';

// Ошибки Worker'а хоста в журнал клиентских ошибок (plan/client-reports,
// этап 3): onerror/onmessageerror и сообщение 'diagnostic' уходят в
// capture, а 'error' из init по-прежнему ведёт в onError (откат эстафеты).

const createFakeWorker = () => {
  const worker = {
    posted: [],
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: msg => worker.posted.push(msg),
    terminate: vi.fn(),
    emit: data => worker.onmessage({ data }),
  };

  return worker;
};

const createController = (opts = {}) => {
  const workers = [];
  const diagnostics = { capture: vi.fn() };
  const controller = new HostController(
    { name: 'room' },
    {
      workerFactory: () => {
        const worker = createFakeWorker();

        workers.push(worker);

        return worker;
      },
      diagnostics,
      ...opts,
    },
  );

  return { controller, workers, diagnostics };
};

describe("HostController: журнал ошибок Worker'а", () => {
  it("onerror Worker'а — capture с source host-worker", () => {
    const { workers, diagnostics } = createController();
    const error = new Error('worker crashed');

    workers[0].onerror({ error, message: 'Uncaught Error: worker crashed' });

    expect(diagnostics.capture).toHaveBeenCalledWith(error, {
      source: 'host-worker',
      kind: 'worker',
    });
  });

  it('onerror без error — сообщение события', () => {
    const { workers, diagnostics } = createController();

    workers[0].onerror({ message: 'Script error.' });

    expect(diagnostics.capture).toHaveBeenCalledWith(
      { message: 'Script error.', stack: null },
      { source: 'host-worker', kind: 'worker' },
    );
  });

  // так ErrorEvent Worker'а выглядит в главном потоке (Chrome): error — null,
  // место — только в filename/lineno/colno
  it('onerror с error: null — кадр из filename/lineno/colno', () => {
    const { workers, diagnostics } = createController();

    workers[0].onerror({
      error: null,
      message: 'Uncaught TypeError: x',
      filename: 'https://h/assets/host.worker-abc.js',
      lineno: 1,
      colno: 38,
    });

    const [report, opts] = diagnostics.capture.mock.calls[0];

    expect(report).toEqual({
      message: 'Uncaught TypeError: x',
      stack:
        'Uncaught TypeError: x\n    at https://h/assets/host.worker-abc.js:1:38',
    });
    expect(opts).toEqual({ source: 'host-worker', kind: 'worker' });
  });

  it('onerror с пустым message — запасной текст', () => {
    const { workers, diagnostics } = createController();

    workers[0].onerror({ message: '' });

    expect(diagnostics.capture.mock.calls[0][0].message).toBe('Worker error');
  });

  it('onmessageerror — capture messageerror', () => {
    const { workers, diagnostics } = createController();

    workers[0].onmessageerror({});

    expect(diagnostics.capture).toHaveBeenCalledWith('messageerror', {
      source: 'host-worker',
      kind: 'worker',
    });
  });

  it('сообщение diagnostic — capture, onError не вызывается', () => {
    const onError = vi.fn();
    const { workers, diagnostics } = createController({ onError });

    workers[0].emit({
      type: 'diagnostic',
      kind: 'rejection',
      message: 'async boom',
      stack: 'Error: async boom\n    at x (host.js:1:1)',
    });

    expect(diagnostics.capture).toHaveBeenCalledWith(
      {
        message: 'async boom',
        stack: 'Error: async boom\n    at x (host.js:1:1)',
      },
      { source: 'host-worker', kind: 'rejection' },
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('error из init — и onError (как раньше), и capture', () => {
    const onError = vi.fn();
    const { workers, diagnostics } = createController({ onError });
    const msg = { type: 'error', message: 'wasm failed' };

    workers[0].emit(msg);

    expect(onError).toHaveBeenCalledWith(msg);
    expect(diagnostics.capture).toHaveBeenCalledTimes(1);

    const [error, opts] = diagnostics.capture.mock.calls[0];

    expect(error).toEqual({ message: 'wasm failed', stack: null });
    expect(opts).toEqual({ source: 'host-worker', kind: 'error' });
  });

  it("error из init — в журнал уходит стек Worker'а", () => {
    const { workers, diagnostics } = createController();
    const stack =
      'Error: init failed\n    at https://h/assets/host.worker-abc.js:5:7';

    workers[0].emit({ type: 'error', message: 'init failed', stack });

    expect(diagnostics.capture).toHaveBeenCalledWith(
      { message: 'init failed', stack },
      { source: 'host-worker', kind: 'error' },
    );
  });

  it('новый Worker эстафеты тоже под наблюдением', async () => {
    const { controller, workers, diagnostics } = createController();

    workers[0].emit({ type: 'ready' });

    const swap = controller.swapWorker('/worker-2.js');

    workers[0].emit({ type: 'handoff_state', state: {} });
    workers[1].onerror({ message: 'next crashed' });

    expect(diagnostics.capture).toHaveBeenCalledWith(
      { message: 'next crashed', stack: null },
      { source: 'host-worker', kind: 'worker' },
    );

    workers[1].emit({ type: 'ready' });
    await swap;
  });

  it('новый Worker эстафеты: diagnostic — в журнал, своп продолжается', async () => {
    const { controller, workers, diagnostics } = createController();

    workers[0].emit({ type: 'ready' });

    const swap = controller.swapWorker('/worker-2.js');

    workers[0].emit({ type: 'handoff_state', state: {} });
    workers[1].emit({
      type: 'diagnostic',
      kind: 'rejection',
      message: 'next async',
      stack: null,
    });

    expect(diagnostics.capture).toHaveBeenCalledWith(
      { message: 'next async', stack: null },
      { source: 'host-worker', kind: 'rejection' },
    );

    workers[1].emit({ type: 'ready' });
    await expect(swap).resolves.toBeUndefined();
  });

  it('новый Worker эстафеты: error из init — в журнал и откат', async () => {
    const onError = vi.fn();
    const { controller, workers, diagnostics } = createController({ onError });

    workers[0].emit({ type: 'ready' });

    const swap = controller.swapWorker('/worker-2.js');

    workers[0].emit({ type: 'handoff_state', state: {} });
    workers[1].emit({ type: 'error', message: 'next wasm failed' });

    await expect(swap).rejects.toThrow('next wasm failed');

    const [error, opts] = diagnostics.capture.mock.calls[0];

    expect(error.message).toBe('next wasm failed');
    expect(opts).toEqual({ source: 'host-worker', kind: 'error' });
    // откат эстафеты — не сбой комнаты: onError не зовётся, старый Worker жив
    expect(onError).not.toHaveBeenCalled();
    expect(workers[0].posted.some(msg => msg.type === 'resume')).toBe(true);
  });

  it("новый Worker эстафеты: error из init — стек этого Worker'а", async () => {
    const { controller, workers, diagnostics } = createController();
    const stack =
      'Error: init failed\n    at https://h/assets/host.worker-abc.js:5:7';

    workers[0].emit({ type: 'ready' });

    const swap = controller.swapWorker('/worker-2.js');

    workers[0].emit({ type: 'handoff_state', state: {} });
    workers[1].emit({ type: 'error', message: 'init failed', stack });

    await expect(swap).rejects.toThrow('init failed');
    expect(diagnostics.capture).toHaveBeenCalledWith(
      { message: 'init failed', stack },
      { source: 'host-worker', kind: 'error' },
    );
  });

  it("без diagnostics ошибки Worker'а не роняют контроллер", () => {
    const workers = [];
    const onError = vi.fn();

    new HostController(
      { name: 'room' },
      {
        workerFactory: () => {
          const worker = createFakeWorker();

          workers.push(worker);

          return worker;
        },
        onError,
      },
    );

    expect(() => workers[0].onerror({ message: 'x' })).not.toThrow();
    workers[0].emit({ type: 'error', message: 'init failed' });

    expect(onError).toHaveBeenCalledTimes(1);
  });
});
