import { describe, it, expect, vi } from 'vitest';
import HostController from '../../../packages/engine/src/client/network/HostController.js';

// Мост отладочных запросов главного потока в Worker хоста (этап 6 плана
// plan/done/ai-debug). postMessage односторонний, а отладке нужен именно результат:
// проверяется корреляция по requestId и то, что промис не остаётся висеть.

const createFakeWorker = () => {
  const worker = {
    posted: [],
    onmessage: null,
    postMessage: msg => worker.posted.push(msg),
    terminate: vi.fn(),
    emit: data => worker.onmessage({ data }),
  };

  return worker;
};

const createController = () => {
  const worker = createFakeWorker();
  const controller = new HostController(
    { name: 'room' },
    { workerFactory: () => worker },
  );

  return { controller, worker };
};

describe('HostController: отладочный контур', () => {
  it('ответ Worker\'а разрешает промис по requestId', async () => {
    const { controller, worker } = createController();

    const pending = controller.dump();
    const sent = worker.posted.find(msg => msg.type === 'debug');

    expect(sent).toMatchObject({ action: 'dump', requestId: 1 });

    worker.emit({
      type: 'debug_result',
      requestId: sent.requestId,
      result: { seed: 7 },
    });

    await expect(pending).resolves.toEqual({ seed: 7 });
  });

  it('ошибка Worker\'а становится исключением, а не тишиной', async () => {
    const { controller, worker } = createController();

    const pending = controller.startRecording();

    worker.emit({
      type: 'debug_result',
      requestId: 1,
      error: 'host is not ready',
    });

    await expect(pending).rejects.toThrow('host is not ready');
  });

  it('параллельные запросы не путаются между собой', async () => {
    const { controller, worker } = createController();

    const dump = controller.dump();
    const recording = controller.stopRecording();

    worker.emit({ type: 'debug_result', requestId: 2, result: null });
    worker.emit({ type: 'debug_result', requestId: 1, result: { seed: 1 } });

    await expect(recording).resolves.toBeNull();
    await expect(dump).resolves.toEqual({ seed: 1 });
  });

  it('зависший Worker отваливается по таймауту, а не висит молча', async () => {
    vi.useFakeTimers();

    try {
      const { controller } = createController();
      const pending = controller.dump();

      // ровно тот случай, ради которого отладка и нужна: ответа не будет
      vi.advanceTimersByTime(5000);

      await expect(pending).rejects.toThrow(/'dump' timed out after 5000 ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ответ снимает таймаут: поздний таймер не роняет разрешённый промис', async () => {
    vi.useFakeTimers();

    try {
      const { controller, worker } = createController();
      const pending = controller.dump();

      worker.emit({ type: 'debug_result', requestId: 1, result: { seed: 1 } });
      vi.advanceTimersByTime(10000);

      await expect(pending).resolves.toEqual({ seed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('закрытие комнаты не оставляет висящих промисов', async () => {
    const { controller } = createController();

    const pending = controller.dump();

    controller.destroy();

    await expect(pending).rejects.toThrow('host destroyed');
  });
});
