import { HOT_FLAGS } from '../config/opcodes.js';

// Разбор плоского hot-буфера клиентского ядра. Вынесено из client/main.js:
// раскладку читают двое — браузерный рендер-тик и headless-runner
// (devtools/VirtualClient.js), а расходиться им нельзя.

/**
 * Строит обратный индекс снапшот-схемы игры: keyId → { key, kind, width }.
 * Раскладку hot-буфера диктует схема игры (CONFIG_DATA.snapshot), движковый
 * бандл её не знает.
 * @param {Object} snapshot - Секция snapshot CONFIG_DATA.
 * @returns {Object} Индекс по числовому id ключа.
 */
export const buildSnapshotKeysById = snapshot =>
  Object.fromEntries(
    Object.entries(snapshot).map(([key, { id, kind, fields }]) => [
      id,
      { key, kind, width: 2 + fields.length },
    ]),
  );

/**
 * Разбирает hot-буфер и сообщает, сколько float'ов ушло на разбор: длина
 * пройденного куска обязана совпасть с длиной буфера, иначе раскладка ядра
 * разъехалась со схемой игры (проверка инвариантов, devtools/invariants.js).
 * @param {Float32Array} hot - Буфер рендер-тика (hot_ptr/hot_values).
 * @param {Object} snapshotKeysById - Результат buildSnapshotKeysById.
 * @returns {Object} { game, consumed }.
 */
export function parseHot(hot, snapshotKeysById) {
  const game = {};
  let i = 3;

  const readRecord = () => {
    const spec = snapshotKeysById[hot[i]];

    if (!spec) {
      throw new Error(`hot buffer: unknown snapshot key id ${hot[i]}`);
    }

    const { key, kind, width } = spec;
    const id = kind === 'indexedNoNull8' ? `d${hot[i + 1]}` : hot[i + 1];

    (game[key] ??= {})[id] = Array.from(hot.subarray(i + 2, i + width));
    i += width;
  };

  // две группы: Indexed8 (акторы), затем IndexedNoNull8 (динамика карты)
  for (let g = 0; g < 2; g += 1) {
    const count = hot[i];

    i += 1;

    for (let n = 0; n < count; n += 1) {
      readRecord();
    }
  }

  if (hot[0] & HOT_FLAGS.PREDICTED) {
    readRecord();
  }

  return { game, consumed: i };
}

/**
 * Восстанавливает объект игровых данных из плоского hot-буфера ядра:
 * [3] N записей Indexed8-группы, затем M записей IndexedNoNull8-группы;
 * каждая запись — keyId, id, поля по схеме игры (ширина = 2 + fields);
 * у IndexedNoNull8 id получает префикс 'd' (динамика карты, зеркало
 * snapshot_to_json ядра). Predicted-запись (последняя) перекрывает свою —
 * предикт поверх интерполяции тем же parse-конвейером.
 * @param {Float32Array} hot - Буфер рендер-тика (hot_ptr/hot_values).
 * @param {Object} snapshotKeysById - Результат buildSnapshotKeysById.
 * @returns {Object} { [ключ схемы]: { [id]: [поля] } }.
 */
export const reconstructHot = (hot, snapshotKeysById) =>
  parseHot(hot, snapshotKeysById).game;
