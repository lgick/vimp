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

describe('HostController: комната у мастера', () => {
  it("setRoom шлёт Worker'у set_room и сохраняет поля для эстафеты", () => {
    const { controller, workers } = createController();
    const room = { roomId: 'abcd1234', roomSecret: 's', epoch: 1 };

    controller.setRoom(room);

    expect(workers[0].posted).toContainEqual({ type: 'set_room', ...room });
    expect(controller._room).toMatchObject(room);
  });
});

describe('HostController: переподключение гостя (host-migration этап 4)', () => {
  const delivery = { onMessage: () => {}, onClose: () => {} };

  it("resume доезжает до Worker'а флагом connect", () => {
    const { controller, workers } = createController();

    workers[0].emit({ type: 'ready' });
    controller.open('c1', { ...delivery, resume: true });
    controller.open('c2', delivery);

    expect(workers[0].posted).toContainEqual({
      type: 'connect',
      socketId: 'c1',
      resume: true,
    });
    // обычный connect — то же сообщение, что понимал Worker до этапа 4
    expect(workers[0].posted).toContainEqual({
      type: 'connect',
      socketId: 'c2',
    });
  });

  it('resume не теряется, пока Worker не готов', () => {
    const { controller, workers } = createController();

    controller.open('c1', { ...delivery, resume: true });
    workers[0].emit({ type: 'ready' });

    expect(workers[0].posted).toContainEqual({
      type: 'connect',
      socketId: 'c1',
      resume: true,
    });
  });
});

describe('HostController: контрольные точки (host-migration этап 5)', () => {
  it("обёртки шлют Worker'у сообщения протокола", () => {
    const { controller, workers } = createController();

    controller.startCheckpoints(500);
    controller.stopCheckpoints();
    controller.requestCheckpoint({ final: true });
    controller.freeze();
    controller.unfreeze();
    controller.startAfterRestore();

    expect(workers[0].posted.slice(1)).toEqual([
      { type: 'checkpoint_start', intervalMs: 500 },
      { type: 'checkpoint_stop' },
      { type: 'checkpoint_request', final: true },
      { type: 'freeze' },
      { type: 'unfreeze' },
      { type: 'start_after_restore' },
    ]);
  });

  it('awaitRoundBoundary: колбэк на round_boundary один раз; cancel — сообщение Worker’у', () => {
    const { controller, workers } = createController();
    const cb = vi.fn();

    controller.cancelRoundBoundary(); // ожидания нет — Worker'у нечего слать
    controller.awaitRoundBoundary(cb);
    workers[0].emit({ type: 'round_boundary' });
    workers[0].emit({ type: 'round_boundary' });
    controller.awaitRoundBoundary(cb);
    controller.cancelRoundBoundary();

    expect(cb).toHaveBeenCalledOnce();
    expect(workers[0].posted.slice(1)).toEqual([
      { type: 'round_boundary_wait' },
      { type: 'round_boundary_wait' },
      { type: 'round_boundary_cancel' },
    ]);
  });

  it('готовая точка уходит подписчикам onCheckpoint, отписка работает', () => {
    const { controller, workers } = createController();
    const cb = vi.fn();
    const off = controller.onCheckpoint(cb);
    const bytes = new Uint8Array([1]);

    workers[0].emit({ type: 'checkpoint', checkpointId: 'c', seq: 1, bytes });

    expect(cb).toHaveBeenCalledWith({ checkpointId: 'c', seq: 1, bytes });

    off();
    workers[0].emit({ type: 'checkpoint', checkpointId: 'd', seq: 2, bytes });

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('метрики здоровья уходят подписчикам onHealth, отписка работает', () => {
    const { controller, workers } = createController();
    const cb = vi.fn();
    const off = controller.onHealth(cb);
    const health = { tickRate: 120, maxGapMs: 9, lostMs: 0 };

    workers[0].emit({ type: 'health', health });

    expect(cb).toHaveBeenCalledWith(health);

    off();
    workers[0].emit({ type: 'health', health });

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("init с точкой передаёт её Worker'у списком переноса и seqFloor", () => {
    const transfers = [];
    const checkpoint = new Uint8Array([1, 2, 3]);
    const worker = createFakeWorker();

    worker.postMessage = (msg, transfer) => {
      worker.posted.push(msg);
      transfers.push(transfer);
    };

    new HostController(
      { name: 'room' },
      { workerFactory: () => worker, checkpoint, seqFloor: 77 },
    );

    expect(worker.posted[0]).toMatchObject({
      type: 'init',
      checkpoint,
      seqFloor: 77,
    });
    expect(transfers[0]).toEqual([checkpoint.buffer]);
  });
});

describe('HostController: режим preload (host-migration этап 6)', () => {
  it('Worker получает preload вместо init, готовность — onPreloaded', () => {
    const onPreloaded = vi.fn();
    const { controller, workers } = createController({
      preload: true,
      onPreloaded,
    });

    expect(workers[0].posted).toEqual([
      { type: 'preload', room: { name: 'room' } },
    ]);
    expect(controller.preloaded).toBe(false);

    workers[0].emit({
      type: 'preloaded',
      gameId: 'tanks',
      gameVersion: '1.0.0',
      wasmCompiled: true,
    });

    expect(controller.preloaded).toBe(true);
    expect(onPreloaded).toHaveBeenCalledWith(
      expect.objectContaining({ gameId: 'tanks', wasmCompiled: true }),
    );
  });

  it('сбой прогрева — onError и запись в журнал', () => {
    const onError = vi.fn();
    const { workers, diagnostics } = createController({
      preload: true,
      onError,
    });

    workers[0].emit({ type: 'error', message: 'no wasm' });

    expect(onError).toHaveBeenCalled();
    expect(diagnostics.capture).toHaveBeenCalled();
  });

  it('без preload — обычный init', () => {
    const { workers } = createController();

    expect(workers[0].posted[0]).toMatchObject({ type: 'init' });
  });
});

describe('HostController: периодические точки и эстафета (host-migration этап 6)', () => {
  const swapTo = async (controller, workers, finish = 'ready') => {
    const swap = controller.swapWorker('/worker-2.js');

    workers[0].emit({ type: 'handoff_state', state: {} });
    workers[1].emit(
      finish === 'ready' ? { type: 'ready' } : { type: 'error', message: 'x' },
    );

    await swap.catch(() => {});
  };

  it('включённые точки переезжают в новый Worker эстафеты', async () => {
    const { controller, workers } = createController();

    workers[0].emit({ type: 'ready' });
    controller.startCheckpoints(500);
    await swapTo(controller, workers);

    expect(workers[1].posted).toContainEqual({
      type: 'checkpoint_start',
      intervalMs: 500,
    });
  });

  it('выключенные точки новому Worker-у не включаются', async () => {
    const { controller, workers } = createController();

    workers[0].emit({ type: 'ready' });
    await swapTo(controller, workers);

    expect(workers[1].posted.some(msg => msg.type === 'checkpoint_start')).toBe(
      false,
    );
  });

  it('включение во время паузы эстафеты доходит до нового Worker-а', async () => {
    const { controller, workers } = createController();

    workers[0].emit({ type: 'ready' });

    const swap = controller.swapWorker('/worker-2.js');

    workers[0].emit({ type: 'handoff_state', state: {} });
    controller.startCheckpoints(500);
    controller.requestCheckpoint({ final: true });

    expect(workers[0].posted.some(msg => msg.type === 'checkpoint_start')).toBe(
      false,
    );

    workers[1].emit({ type: 'ready' });
    await swap;

    expect(workers[1].posted).toContainEqual({
      type: 'checkpoint_start',
      intervalMs: 500,
    });
    expect(workers[1].posted).toContainEqual({
      type: 'checkpoint_request',
      final: true,
    });
  });

  it('откат эстафеты: старому Worker-у — состояние на конец паузы', async () => {
    const { controller, workers } = createController();

    workers[0].emit({ type: 'ready' });

    const swap = controller.swapWorker('/worker-2.js');

    workers[0].emit({ type: 'handoff_state', state: {} });
    controller.startCheckpoints(250);
    workers[1].emit({ type: 'error', message: 'boom' });
    await swap.catch(() => {});

    expect(workers[0].posted.at(-1)).toEqual({
      type: 'checkpoint_start',
      intervalMs: 250,
    });
  });
});
