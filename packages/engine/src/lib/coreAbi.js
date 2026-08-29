// Единственная точка чтения самоописания wasm-ядра (`abi_describe`).
//
// Фрагмент жил в трёх местах — конструкторе GameCoreAdapter и двух местах
// client/main.js — и дефолт `{abi: 0, core: null, ops: []}` был написан
// руками трижды: разъехавшись, они дали бы `ops === undefined` и TypeError
// в первом же вызове опкода.
//
// Плюс `JSON.parse` не был обёрнут. Ядро, отдающее не-JSON, роняло
// конструктор адаптера и (на клиенте) async-обработчик PS_CONFIG_DATA —
// невыловленным промисом, после которого конфиг не применяется вовсе. Это
// тот же режим «получатель падает от того, что отправитель другой», который
// на JSON-портах уже вылечен веткой по умолчанию
// (client/lib/socketDispatch.js): битое самоописание обязано читаться как
// поколение 0, а не как отказ движка.

import { abiOps } from '../config/abiOps.js';

// пустая нагрузка опкода: ядро ждёт байты всегда, даже когда их нет
const EMPTY_PAYLOAD = new Uint8Array(0);

// «опкод не обработан»: ядро его не знает либо вернуло пустой вектор
// (соглашение abi::dispatch_result в крейте)
const NOT_HANDLED = Object.freeze({ handled: false, bytes: null });

// ядро старше самоописания: ни одного опционального опкода (И2 плана
// plugin-forward-compat). Один объект на все такие ядра — он заморожен и
// никем не правится
export const ABI_UNKNOWN = Object.freeze({ abi: 0, core: null, ops: [] });

/**
 * Читает самоописание ядра: версия формата, версия движкового крейта,
 * список опкодов `dispatch`.
 * @param {Object} core - Экземпляр wasm-ядра (игрового или клиентского).
 * @param {string} [label] - Имя ядра в тексте предупреждения.
 * @returns {{abi: number, core: string|null, ops: Array<string>}} Всегда
 *   пригодный к чтению объект: `abi: 0` с пустым `ops` — ядро старше
 *   механизма ЛИБО его самоописание нечитаемо.
 */
export function readCoreAbi(core, label = 'core') {
  if (typeof core?.abi_describe !== 'function') {
    return ABI_UNKNOWN;
  }

  let described;

  try {
    described = JSON.parse(core.abi_describe());
  } catch (err) {
    console.warn(`${label}: abi_describe is not JSON (${err.message})`);

    return ABI_UNKNOWN;
  }

  // нормализация, а не проверка: движок обязан продолжить работу на любом
  // содержимом. Не-строки из ops выбрасываются — по ним всё равно нечего
  // диспетчеризовать
  return {
    abi: Number.isInteger(described?.abi) ? described.abi : 0,
    core: typeof described?.core === 'string' ? described.core : null,
    ops: Array.isArray(described?.ops)
      ? described.ops.filter(op => typeof op === 'string')
      : [],
  };
}

export default readCoreAbi;

/**
 * Зовёт необязательную возможность ядра опкодом. Единственное место, где
 * движок вызывает `dispatch` — и игровой половины, и клиентской: таблица
 * экспортов wasm заморожена (И1/И3), поэтому новая возможность приезжает
 * строкой, а не новым символом.
 *
 * Исходов ровно три, и они РАЗЛИЧИМЫ (соглашение `abi::dispatch_result`,
 * core/src/abi.rs): пустой ответ — «опкод не понят», маркер `[0x00]` —
 * «понят, ответа нет», иначе — полезные байты. Схлопывать первые два в один
 * `null` нельзя: опкод-команда (ради них механизм и делался) отдавала бы
 * вызывающему сырой `Uint8Array [0]`, который поехал бы в TextDecoder и
 * JSON.parse.
 * @param {Object} core - Экземпляр wasm-ядра.
 * @param {Object} abi - Результат readCoreAbi для этого ядра.
 * @param {string} op - Опкод из config/abiOps.js.
 * @param {Uint8Array} [payload] - Полезная нагрузка опкода.
 * @returns {{handled: boolean, bytes: Uint8Array|null}} `handled: false` —
 *   ядро опкода не знает (вызывающий идёт по запасному пути);
 *   `handled: true, bytes: null` — обработано без ответа.
 */
export function dispatchCoreOp(core, abi, op, payload = EMPTY_PAYLOAD) {
  // опкод вне реестра — дефект ДВИЖКА, а не старого ядра: имя, которого нет
  // в config/abiOps.js, не попадает ни в слепок поверхности, ни в CHANGELOG.
  // Падаем сразу, а не на игре, которая его однажды поймёт
  if (!abiOps.has(op)) {
    throw new Error(
      `dispatchCoreOp: unknown opcode "${op}" — declare it in ` +
        'config/abiOps.js (append-only, И1)',
    );
  }

  const resolved = abiOps.resolve(op);

  if (!abi.ops.includes(resolved)) {
    return NOT_HANDLED;
  }

  const out = core.dispatch(resolved, payload);

  if (out.length === 0) {
    return NOT_HANDLED;
  }

  // [0x00] — «обработан, ответа нет»: полезных байтов у него нет
  return {
    handled: true,
    bytes: out.length === 1 && out[0] === 0x00 ? null : out,
  };
}
