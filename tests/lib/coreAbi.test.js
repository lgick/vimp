/* eslint-disable camelcase -- фейк ядра повторяет snake_case ABI wasm */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  readCoreAbi,
  dispatchCoreOp,
  ABI_UNKNOWN,
} from '../../packages/engine/src/lib/coreAbi.js';
import { ABI_OP_DEBUG_JSON } from '../../packages/engine/src/config/abiOps.js';

// Единая точка чтения самоописания ядра. Фрагмент жил в трёх местах с
// рукописным дефолтом, и JSON.parse не был обёрнут: ядро, отдающее не-JSON,
// роняло конструктор адаптера и async-обработчик PS_CONFIG_DATA на клиенте.
// Битое самоописание обязано читаться как поколение 0, а не как отказ движка.

const coreWith = json => ({ abi_describe: () => json });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readCoreAbi', () => {
  it('ядро без метода — поколение 0, без предупреждения', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(readCoreAbi({})).toEqual(ABI_UNKNOWN);
    expect(warn).not.toHaveBeenCalled();
  });

  it('валидное самоописание читается как есть', () => {
    expect(
      readCoreAbi(
        coreWith(
          JSON.stringify({ abi: 1, core: '0.9.0', ops: ['debug.json'] }),
        ),
      ),
    ).toEqual({ abi: 1, core: '0.9.0', ops: ['debug.json'] });
  });

  it('не-JSON — поколение 0 и предупреждение, а не исключение', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(readCoreAbi(coreWith('<html>500</html>'), 'game core')).toEqual(
      ABI_UNKNOWN,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('game core: abi_describe is not JSON'),
    );
  });

  it('ops не массив — пустой список, а не TypeError у первого вызова', () => {
    expect(
      readCoreAbi(coreWith(JSON.stringify({ abi: 1, ops: null }))).ops,
    ).toEqual([]);
    expect(readCoreAbi(coreWith(JSON.stringify({ abi: 1 }))).ops).toEqual([]);
  });

  it('не-строки из ops выбрасываются: по ним нечего диспетчеризовать', () => {
    expect(
      readCoreAbi(coreWith(JSON.stringify({ ops: ['debug.json', 7, null] })))
        .ops,
    ).toEqual(['debug.json']);
  });

  it('нечисловой abi и нестроковый core нормализуются', () => {
    expect(
      readCoreAbi(coreWith(JSON.stringify({ abi: 'один', core: 42, ops: [] }))),
    ).toEqual({ abi: 0, core: null, ops: [] });
  });
});

describe('dispatchCoreOp', () => {
  const core = answer => ({
    calls: [],
    dispatch(op, payload) {
      this.calls.push([op, [...payload]]);

      return answer;
    },
  });

  const abiWith = ops => ({ abi: 1, core: 'x', ops });

  it('опкод вне реестра — дефект движка: бросает до вызова ядра', () => {
    const c = core(new Uint8Array(0));

    expect(() => dispatchCoreOp(c, abiWith(['whatever']), 'whatever')).toThrow(
      /unknown opcode/,
    );
    expect(c.calls).toEqual([]);
  });

  it('ядро опкода не заявило — вызова не происходит', () => {
    const c = core(new Uint8Array([1]));

    expect(dispatchCoreOp(c, abiWith([]), ABI_OP_DEBUG_JSON)).toEqual({
      handled: false,
      bytes: null,
    });
    expect(c.calls).toEqual([]);
  });

  it('три исхода ответа различимы', () => {
    const abi = abiWith(['debug.json']);

    expect(
      dispatchCoreOp(core(new Uint8Array(0)), abi, ABI_OP_DEBUG_JSON),
    ).toEqual({ handled: false, bytes: null });

    expect(
      dispatchCoreOp(core(new Uint8Array([0x00])), abi, ABI_OP_DEBUG_JSON),
    ).toEqual({ handled: true, bytes: null });

    const { handled, bytes } = dispatchCoreOp(
      core(new Uint8Array([5, 6])),
      abi,
      ABI_OP_DEBUG_JSON,
    );

    expect(handled).toBe(true);
    expect([...bytes]).toEqual([5, 6]);
  });

  it('нагрузка доезжает до ядра как есть', () => {
    const c = core(new Uint8Array([1]));

    dispatchCoreOp(
      c,
      abiWith(['debug.json']),
      ABI_OP_DEBUG_JSON,
      new Uint8Array([9]),
    );

    expect(c.calls).toEqual([['debug.json', [9]]]);
  });
});
