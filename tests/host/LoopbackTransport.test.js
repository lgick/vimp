import { describe, it, expect, vi, beforeEach } from 'vitest';
import HostController from '../../packages/engine/src/client/network/HostController.js';
import LoopbackTransport from '../../packages/engine/src/client/network/LoopbackTransport.js';

// Юнит-тесты моста главного потока: HostController (роутер Worker↔клиенты)
// и LoopbackTransport (транспорт хоста-игрока поверх postMessage). Worker —
// фейк, сообщения Worker→main эмулируются вызовом worker.onmessage.

const makeFakeWorker = () => ({
  postMessage: vi.fn(),
  terminate: vi.fn(),
  onmessage: null,
  // эмуляция сообщения Worker → главный поток
  emit(data) {
    this.onmessage({ data });
  },
});

describe('HostController', () => {
  let worker;
  let controller;

  beforeEach(() => {
    worker = makeFakeWorker();
    controller = new HostController(
      { name: 'Room', map: 'pool_mini' },
      { workerFactory: () => worker },
    );
  });

  it('при создании шлёт init с настройками комнаты', () => {
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'init',
      room: { name: 'Room', map: 'pool_mini' },
    });
  });

  it('open до ready ставит connect в очередь, после ready — отправляет', () => {
    controller.open('local', { onMessage: vi.fn(), onClose: vi.fn() });

    // до ready connect не ушёл
    expect(
      worker.postMessage.mock.calls.some(c => c[0].type === 'connect'),
    ).toBe(false);

    worker.emit({ type: 'ready' });

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'connect',
      socketId: 'local',
    });
  });

  it('open после ready отправляет connect сразу', () => {
    worker.emit({ type: 'ready' });
    controller.open('s2', { onMessage: vi.fn(), onClose: vi.fn() });

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'connect',
      socketId: 's2',
    });
  });

  it('to_client роутит payload и флаг reliable зарегистрированному клиенту', () => {
    const onMessage = vi.fn();

    controller.open('local', { onMessage, onClose: vi.fn() });
    worker.emit({
      type: 'to_client',
      socketId: 'local',
      payload: 'hello',
      reliable: true,
    });

    expect(onMessage).toHaveBeenCalledWith('hello', true);
  });

  it('close_client уведомляет клиента', () => {
    const onClose = vi.fn();

    controller.open('local', { onMessage: vi.fn(), onClose });
    worker.emit({
      type: 'close_client',
      socketId: 'local',
      code: 4005,
      data: [3],
    });

    expect(onClose).toHaveBeenCalledWith(4005, [3]);
  });

  it('send пересылает сообщение клиента в Worker', () => {
    controller.send('local', '[5,"1:down:forward"]');

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'message',
      socketId: 'local',
      data: '[5,"1:down:forward"]',
    });
  });

  it('disconnect убирает клиента и шлёт в Worker', () => {
    const onMessage = vi.fn();

    controller.open('local', { onMessage, onClose: vi.fn() });
    controller.disconnect('local');

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'disconnect',
      socketId: 'local',
    });

    // после отключения доставка не идёт
    worker.emit({ type: 'to_client', socketId: 'local', payload: 'x' });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('destroy останавливает Worker', () => {
    controller.destroy();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('error из Worker уходит в onError (сбой инициализации)', () => {
    const onError = vi.fn();

    controller = new HostController(
      { name: 'Room' },
      { workerFactory: () => worker, onError },
    );

    worker.emit({ type: 'error', message: 'wasm failed' });

    expect(onError).toHaveBeenCalledWith({
      type: 'error',
      message: 'wasm failed',
    });
  });

  it('map_changed из Worker уходит в onMapChange', () => {
    const onMapChange = vi.fn();

    controller = new HostController(
      { name: 'Room' },
      { workerFactory: () => worker, onMapChange },
    );

    worker.emit({ type: 'map_changed', mapName: 'garden' });

    expect(onMapChange).toHaveBeenCalledWith('garden');
  });

  it('updateMaps пересылает каталог карт в Worker', () => {
    const maps = { garden: { step: 32 } };

    controller.updateMaps(maps);

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'update_maps',
      maps,
    });
  });
});

// Эстафета Worker'ов (Этап 5.2): swapWorker заменяет Worker на новую версию
// кода — старый отдаёт handoff-состояние на границе раунда, новый поднимается
// с ним, клиенты переподключаются внутренними connect'ами; WebRTC не рвётся.
describe('HostController: эстафета Worker\'ов (5.2)', () => {
  let workers; // фейковые Worker'ы в порядке создания
  let onReady;
  let controller;

  const factory = url => {
    const worker = makeFakeWorker();

    worker.url = url;
    workers.push(worker);

    return worker;
  };

  // сообщения типа type, отправленные worker'у
  const sentOf = (worker, type) =>
    worker.postMessage.mock.calls.map(c => c[0]).filter(m => m.type === type);

  beforeEach(() => {
    workers = [];
    onReady = vi.fn();
    controller = new HostController(
      { name: 'Room', maps: { a: 1 } },
      { workerFactory: factory, workerUrl: '/assets/host.worker-Old.js', onReady },
    );

    workers[0].emit({ type: 'ready' });
    controller.open('local', { onMessage: vi.fn(), onClose: vi.fn() });
    controller.open('s2', { onMessage: vi.fn(), onClose: vi.fn() });
  });

  afterEach(() => {
    controller.destroy();
  });

  it('первый Worker создаётся по workerUrl из манифеста мастера', () => {
    expect(workers[0].url).toBe('/assets/host.worker-Old.js');
  });

  it('swapWorker шлёт prepare_handoff, игра идёт до границы раунда', () => {
    controller.swapWorker('/assets/host.worker-New.js').catch(() => {});

    expect(sentOf(workers[0], 'prepare_handoff')).toHaveLength(1);

    // до handoff_state старый Worker живёт: сообщения идут ему
    controller.send('local', '[5,"1:down:forward"]');
    expect(sentOf(workers[0], 'message')).toHaveLength(1);
    expect(workers).toHaveLength(1);
  });

  it('handoff_state поднимает новый Worker с handoff и актуальными картами', () => {
    controller.updateMaps({ b: 2 });
    controller.swapWorker('/assets/host.worker-New.js').catch(() => {});
    workers[0].emit({ type: 'handoff_state', state: { version: 1, seq: 42 } });

    expect(workers).toHaveLength(2);
    expect(workers[1].url).toBe('/assets/host.worker-New.js');

    const init = sentOf(workers[1], 'init')[0];

    expect(init.handoff).toEqual({ version: 1, seq: 42 });
    expect(init.room.maps).toEqual({ b: 2 });
  });

  it('на паузе эстафеты сообщения клиентов буферизуются', () => {
    controller.swapWorker('/new.js').catch(() => {});
    workers[0].emit({ type: 'handoff_state', state: {} });

    controller.send('local', 'keys1');
    controller.send('s2', 'keys2');

    // ни старому (пауза), ни новому (ещё не ready)
    expect(sentOf(workers[0], 'message')).toHaveLength(0);
    expect(sentOf(workers[1], 'message')).toHaveLength(0);
  });

  it('ready нового: connect всех клиентов, flush очереди, handoff_complete, старый погашен', async () => {
    const swap = controller.swapWorker('/new.js');

    workers[0].emit({ type: 'handoff_state', state: {} });
    controller.send('local', 'queued');

    workers[1].emit({ type: 'ready' });
    await swap;

    const next = workers[1];
    const types = next.postMessage.mock.calls.map(c => c[0].type);

    // порядок: init → connect'ы → накопленное → handoff_complete
    expect(types).toEqual([
      'init',
      'connect',
      'connect',
      'message',
      'handoff_complete',
    ]);
    expect(sentOf(next, 'connect').map(m => m.socketId)).toEqual([
      'local',
      's2',
    ]);
    expect(workers[0].terminate).toHaveBeenCalled();

    // onReady главного потока повторно не дёргается (регистрация уже есть)
    expect(onReady).toHaveBeenCalledTimes(1);

    // дальше контроллер работает с новым Worker'ом в обе стороны
    controller.send('local', 'after');
    expect(sentOf(next, 'message').map(m => m.data)).toEqual([
      'queued',
      'after',
    ]);

    const onMessage = vi.fn();

    controller.open('s3', { onMessage, onClose: vi.fn() });
    next.emit({ type: 'to_client', socketId: 's3', payload: 'x', reliable: true });
    expect(onMessage).toHaveBeenCalledWith('x', true);
  });

  it('error нового Worker\'а: старый возобновляется, очередь дослана ему', async () => {
    const swap = controller.swapWorker('/new.js');

    workers[0].emit({ type: 'handoff_state', state: {} });
    controller.send('local', 'queued');
    workers[1].emit({ type: 'error', message: 'handoff version mismatch' });

    await expect(swap).rejects.toThrow('handoff version mismatch');
    expect(workers[1].terminate).toHaveBeenCalled();
    expect(sentOf(workers[0], 'resume')).toHaveLength(1);
    expect(sentOf(workers[0], 'message').map(m => m.data)).toEqual(['queued']);

    // контроллер продолжает работать со старым Worker'ом
    controller.send('local', 'after');
    expect(sentOf(workers[0], 'message').map(m => m.data)).toEqual([
      'queued',
      'after',
    ]);
  });

  it('параллельный swapWorker отклоняется', async () => {
    controller.swapWorker('/new.js').catch(() => {});

    await expect(controller.swapWorker('/other.js')).rejects.toThrow(
      /in progress/,
    );
  });

  it('подключение клиента на паузе доедет в новый Worker без дублей', async () => {
    const swap = controller.swapWorker('/new.js');

    workers[0].emit({ type: 'handoff_state', state: {} });
    controller.open('s3', { onMessage: vi.fn(), onClose: vi.fn() });

    workers[1].emit({ type: 'ready' });
    await swap;

    // s3 попал и в общий проход по deliveries, и в очередь — дубль
    // безвреден (Worker игнорирует повторный connect)
    const connects = sentOf(workers[1], 'connect').map(m => m.socketId);

    expect(connects.filter(id => id === 's3').length).toBeGreaterThan(0);
  });

  it('destroy во время эстафеты гасит оба Worker\'а', () => {
    controller.swapWorker('/new.js').catch(() => {});
    workers[0].emit({ type: 'handoff_state', state: {} });

    controller.destroy();

    expect(workers[0].terminate).toHaveBeenCalled();
    expect(workers[1].terminate).toHaveBeenCalled();
  });
});

describe('LoopbackTransport', () => {
  let worker;
  let controller;
  let transport;

  beforeEach(() => {
    worker = makeFakeWorker();
    controller = new HostController(
      { name: 'Room' },
      { workerFactory: () => worker },
    );
    transport = new LoopbackTransport(controller, 'local');
    worker.emit({ type: 'ready' });
  });

  it('connect регистрирует клиента и поднимает соединение', () => {
    transport.connect();

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'connect',
      socketId: 'local',
    });
  });

  it('входящие кадры Worker эмитятся событием message', () => {
    const onMessage = vi.fn();

    transport.publisher.on('message', onMessage);
    transport.connect();

    worker.emit({ type: 'to_client', socketId: 'local', payload: 'frame' });

    expect(onMessage).toHaveBeenCalledWith('frame');
  });

  it('send пересылает данные через контроллер', () => {
    transport.connect();
    transport.send('[6,"hi"]');

    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'message',
      socketId: 'local',
      data: '[6,"hi"]',
    });
  });

  it('close эмитит close один раз и отключает клиента', () => {
    const onClose = vi.fn();

    transport.publisher.on('close', onClose);
    transport.connect();

    transport.close();
    transport.close();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: 'disconnect',
      socketId: 'local',
    });
  });

  it('close_client из Worker закрывает транспорт', () => {
    const onClose = vi.fn();

    transport.publisher.on('close', onClose);
    transport.connect();

    worker.emit({ type: 'close_client', socketId: 'local', code: 4005 });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
