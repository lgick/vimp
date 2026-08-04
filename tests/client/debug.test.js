import { describe, it, expect, vi } from 'vitest';
import {
  createDebugApi,
  DEBUG_PREFIX,
} from '../../packages/engine/src/client/debug.js';

// window.__vimpDebug (этап 6 плана plan/ai-debug): вход в отладку из DevTools
// и из Chrome MCP. Главное свойство — молчаливого отказа не бывает: «вкладка
// не хостит» и «дамп сломался» должны различаться.

const scenario = {
  version: 1,
  seed: 1,
  participants: [{ id: 'p1' }],
  timeline: [{ tick: 0, op: 'join', who: 'p1' }],
  ticks: 42,
};

const makeApi = ({ hostController = null, clientCore = null, fetchImpl } = {}) => {
  const log = vi.fn();

  const api = createDebugApi({
    getHostController: () => hostController,
    getClientCore: () => clientCore,
    reportUrl: '/debug/report',
    fetchImpl:
      fetchImpl ??
      vi.fn(async () => ({ ok: true, json: async () => ({ file: 'f.json' }) })),
    log,
  });

  return { api, log };
};

describe('createDebugApi', () => {
  it('без комнаты в этой вкладке отказ называет причину', async () => {
    const { api } = makeApi();

    await expect(api.dump()).rejects.toThrow('not hosting');
    await expect(api.startRecording()).rejects.toThrow('not hosting');
    await expect(api.stopRecording()).rejects.toThrow('not hosting');
  });

  it('stopRecording выгружает сценарий на мастер', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ file: 'scenario-now-1.json', bytes: 10 }),
    }));
    const hostController = { stopRecording: vi.fn(async () => scenario) };
    const { api, log } = makeApi({ hostController, fetchImpl });

    const result = await api.stopRecording({ note: 'tank in wall' });

    expect(result).toEqual({ scenario, file: 'scenario-now-1.json' });

    const [url, init] = fetchImpl.mock.calls[0];

    expect(url).toBe('/debug/report');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      kind: 'scenario',
      payload: scenario,
      note: 'tank in wall',
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('42 tick(s)'));
  });

  it('save: false оставляет сценарий в браузере', async () => {
    const fetchImpl = vi.fn();
    const hostController = { stopRecording: vi.fn(async () => scenario) };
    const { api } = makeApi({ hostController, fetchImpl });

    const result = await api.stopRecording({ save: false });

    expect(result.file).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('остановка незапущенной записи возвращает null, а не выгрузку', async () => {
    const fetchImpl = vi.fn();
    const hostController = { stopRecording: vi.fn(async () => null) };
    const { api } = makeApi({ hostController, fetchImpl });

    expect(await api.stopRecording()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('отказ мастера превращается в исключение с текстом', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 413,
      json: async () => ({ error: 'payload too large' }),
    }));
    const hostController = { stopRecording: vi.fn(async () => scenario) };
    const { api } = makeApi({ hostController, fetchImpl });

    await expect(api.stopRecording()).rejects.toThrow('payload too large');
  });

  it('dump по умолчанию не выгружается, по запросу — выгружается', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ file: 'dump-now-1.json' }),
    }));
    const hostController = { dump: vi.fn(async () => ({ seed: 5 })) };
    const { api } = makeApi({ hostController, fetchImpl });

    expect(await api.dump()).toEqual({ seed: 5 });
    expect(fetchImpl).not.toHaveBeenCalled();

    await api.dump({ save: true });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).kind).toBe('dump');
  });

  it('divergence вычерпывает записи ядра; без детектора — null', () => {
    const dump = { samples: 3, violations: 1, records: [] };
    const clientCore = { take_divergence: () => JSON.stringify(dump) };

    expect(makeApi({ clientCore }).api.divergence()).toEqual(dump);
    expect(makeApi().api.divergence()).toBeNull();
    expect(makeApi({ clientCore: {} }).api.divergence()).toBeNull();
  });

  it('startRecording различает отказ dev-режима и успех', async () => {
    const hostController = { startRecording: vi.fn(async () => false) };
    const { api, log } = makeApi({ hostController });

    expect(await api.startRecording()).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });

  it('префикс лога стабилен — по нему фильтруется консоль', () => {
    expect(DEBUG_PREFIX).toBe('[vimp:debug]');
  });
});
