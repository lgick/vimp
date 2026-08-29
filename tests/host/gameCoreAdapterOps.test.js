/* eslint-disable camelcase -- фейк ядра повторяет snake_case ABI GameCore */
import { describe, it, expect } from 'vitest';
import GameCoreAdapter from '../../packages/engine/src/host/GameCoreAdapter.js';
import { ABI_OP_DEBUG_JSON } from '../../packages/engine/src/config/abiOps.js';

// Опкоды dispatch (этап 4 плана plugin-forward-compat). Проверяется главное
// свойство: ядро ЛЮБОГО возраста работает. Три поколения ядра —
// с abi_describe и dispatch, без них но с замороженным методом debug_json,
// и без обоих — обязаны давать один и тот же наблюдаемый результат, кроме
// самого дампа.

const DUMP = { bodies: [], map: null };

const participants = { get: () => undefined };

// поколение 2: ядро с самоописанием и опкодом. `answer` подменяет ответ на
// заявленный опкод — так проверяются все три исхода dispatch на ОДНОМ
// зарегистрированном опкоде: выдуманное имя _op больше не пропускает
const modernCore = (ops = ['debug.json'], answer = null) => ({
  calls: [],
  abi_describe() {
    return JSON.stringify({ abi: 1, core: '0.9.0', ops });
  },
  dispatch(op, payload) {
    this.calls.push([op, [...payload]]);

    if (answer !== null) {
      return answer;
    }

    if (op === 'debug.json') {
      return new TextEncoder().encode(JSON.stringify(DUMP));
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
  it('опкод вне реестра — дефект движка, а не старого ядра: бросает', () => {
    const core = modernCore();

    // имя, которого нет в config/abiOps.js, не попало бы ни в слепок
    // поверхности, ни в CHANGELOG: молчать о нём нельзя
    expect(() => adapterFor(core)._op('snapshot.deltaV2')).toThrow(
      /unknown opcode "snapshot\.deltaV2"/,
    );
    expect(core.calls).toEqual([]);
  });

  it('опкод, которого ядро не заявило, не зовётся вовсе', () => {
    const core = modernCore([]);

    expect(adapterFor(core)._op(ABI_OP_DEBUG_JSON)).toEqual({
      handled: false,
      bytes: null,
    });
    expect(core.calls).toEqual([]);
  });

  it('пустой ответ ядра — «не обработан», а не «пустой ответ»', () => {
    const core = modernCore(['debug.json'], new Uint8Array(0));

    expect(adapterFor(core)._op(ABI_OP_DEBUG_JSON)).toEqual({
      handled: false,
      bytes: null,
    });
    expect(core.calls).toEqual([['debug.json', []]]);
  });

  it('маркер [0x00] — «обработан, ответа нет»: полезных байт нет', () => {
    const core = modernCore(['debug.json'], new Uint8Array([0x00]));

    // сырой Uint8Array [0] наверх не уходит: он поехал бы в TextDecoder и
    // JSON.parse у первого же опкода-команды
    expect(adapterFor(core)._op(ABI_OP_DEBUG_JSON)).toEqual({
      handled: true,
      bytes: null,
    });
  });

  it('полезные байты приходят как есть, с handled: true', () => {
    const core = modernCore(['debug.json'], new Uint8Array([7, 8]));
    const { handled, bytes } = adapterFor(core)._op(ABI_OP_DEBUG_JSON);

    expect(handled).toBe(true);
    expect([...bytes]).toEqual([7, 8]);
  });

  it('нагрузка доезжает до ядра как есть', () => {
    const core = modernCore();

    adapterFor(core)._op(ABI_OP_DEBUG_JSON, new Uint8Array([1, 2, 3]));

    expect(core.calls).toEqual([['debug.json', [1, 2, 3]]]);
  });

  it('ядро без dispatch опкодов не заявляет — вызова не происходит', () => {
    expect(adapterFor(legacyCore())._op(ABI_OP_DEBUG_JSON)).toEqual({
      handled: false,
      bytes: null,
    });
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
