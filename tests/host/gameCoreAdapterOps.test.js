/* eslint-disable camelcase -- фейк ядра повторяет snake_case ABI GameCore */
import { describe, it, expect } from 'vitest';
import GameCoreAdapter from '../../packages/engine/src/host/GameCoreAdapter.js';

// Опкоды dispatch (этап 4 плана plugin-forward-compat). Проверяется главное
// свойство: ядро ЛЮБОГО возраста работает. Три поколения ядра —
// с abi_describe и dispatch, без них но с замороженным методом debug_json,
// и без обоих — обязаны давать один и тот же наблюдаемый результат, кроме
// самого дампа.

const DUMP = { bodies: [], map: null };

const participants = { get: () => undefined };

// поколение 2: ядро с самоописанием и опкодом
const modernCore = (ops = ['debug.json']) => ({
  calls: [],
  abi_describe() {
    return JSON.stringify({ abi: 1, core: '0.9.0', ops });
  },
  dispatch(op, payload) {
    this.calls.push([op, [...payload]]);

    if (op === 'debug.json') {
      return new TextEncoder().encode(JSON.stringify(DUMP));
    }

    // «обработан, ответа нет» — это НЕ то же самое, что «не обработан»
    if (op === 'engine.ack') {
      return new Uint8Array([0x00]);
    }

    return new Uint8Array(0);
  },
  debug_json() {
    throw new Error('ядро с опкодом не должно падать на запасной путь');
  },
});

// поколение 1: ядро до dispatch, но с замороженным методом
const legacyCore = () => ({
  debug_json() {
    return JSON.stringify(DUMP);
  },
});

// поколение 0: ядро старше и метода (собрано до его появления)
const ancientCore = () => ({});

const adapterFor = core => new GameCoreAdapter(core, { participants });

describe('самоописание ядра', () => {
  it('читается один раз при загрузке', () => {
    const core = modernCore();
    const adapter = adapterFor(core);

    expect(adapter.abi).toEqual({ abi: 1, core: '0.9.0', ops: ['debug.json'] });
  });

  it('ядро без abi_describe — поколение 0, а не ошибка', () => {
    expect(adapterFor(ancientCore()).abi).toEqual({
      abi: 0,
      core: null,
      ops: [],
    });
  });
});

describe('_op', () => {
  it('незаявленный опкод не зовётся вовсе', () => {
    const core = modernCore();
    const adapter = adapterFor(core);

    expect(adapter._op('snapshot.deltaV2')).toBeNull();
    expect(core.calls).toEqual([]);
  });

  it('пустой ответ ядра — «не обработан»', () => {
    const core = modernCore(['snapshot.deltaV2']);

    expect(adapterFor(core)._op('snapshot.deltaV2')).toBeNull();
    expect(core.calls).toEqual([['snapshot.deltaV2', []]]);
  });

  it('маркер [0x00] — «обработан, ответа нет»', () => {
    const out = adapterFor(modernCore(['engine.ack']))._op('engine.ack');

    expect([...out]).toEqual([0x00]);
  });

  it('нагрузка доезжает до ядра как есть', () => {
    const core = modernCore(['snapshot.deltaV2']);

    adapterFor(core)._op('snapshot.deltaV2', new Uint8Array([1, 2, 3]));

    expect(core.calls).toEqual([['snapshot.deltaV2', [1, 2, 3]]]);
  });

  it('ядро без dispatch опкодов не заявляет — вызова не происходит', () => {
    expect(adapterFor(legacyCore())._op('debug.json')).toBeNull();
  });
});

describe('debugJson через опкод и запасной путь', () => {
  it('ядро с опкодом: дамп приходит из dispatch', () => {
    const core = modernCore();

    expect(adapterFor(core).debugJson()).toEqual(DUMP);
    expect(core.calls).toEqual([['debug.json', []]]);
  });

  it('ядро без опкода, но с методом: дамп приходит из debug_json', () => {
    expect(adapterFor(legacyCore()).debugJson()).toEqual(DUMP);
  });

  it('ядро без обоих: null, а не исключение посреди прогона', () => {
    expect(adapterFor(ancientCore()).debugJson()).toBeNull();
  });
});
