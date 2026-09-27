import { HOT_FLAGS } from '../../config/opcodes.js';
import { reconstructHot } from '../../lib/reconstructHot.js';

// Рендер-тик клиентского ядра: сэмпл, событийные кадры, горячие данные,
// камера. Вынесено из main.js ради одной вещи — порядка ЧТЕНИЯ, который
// ничем больше не защищён: main.js целиком в тесте не поднять.
//
// Hot-буфер читается view поверх памяти WASM (zero-copy), а view живёт
// ровно до следующего роста этой памяти: `memory.grow` отцепляет старый
// ArrayBuffer, длина view становится 0, hot[i] — undefined. Растить память
// может любой аллоцирующий вызов ядра: take_frames() собирает строку JSON
// в куче WASM, парты при разборе кадров сами зовут ядро. Поэтому всё нужное
// из буфера снимается копией СРАЗУ, а применяется в прежнем порядке.
// Раньше камера читалась после take_frames(): undefined в ней становился
// NaN, NaN навсегда оседал в сглаживании камеры (картинка пропадала до
// cameraReset), а слушатель звука с NaN ронял Howl.pos() — и тикер Pixi.

/**
 * Один рендер-тик клиентского ядра.
 * @param {Object} deps
 * @param {Object} deps.core - ClientCore: sample, hot_ptr, take_frames.
 * @param {WebAssembly.Memory} deps.memory - Память WASM клиентского ядра.
 * @param {Object} deps.snapshotKeysById - Результат buildSnapshotKeysById.
 * @param {number} deps.now - Время рендера (performance.now()).
 * @param {Function} deps.applyShot - (game, camera): событийный кадр.
 * @param {Function} deps.applyGameData - (game): горячие данные сущностей.
 * @param {Function} deps.applyCamera - ([x, y]): камера тика.
 */
export default function runHotTick({
  core,
  memory,
  snapshotKeysById,
  now,
  applyShot,
  applyGameData,
  applyCamera,
}) {
  const len = core.sample(now);
  // указатель — раньше memory.buffer: аргументы `new Float32Array(...)`
  // вычисляются слева направо, и buffer, взятый до вызова ядра, мог бы уже
  // оказаться отцепленным
  const ptr = core.hot_ptr();
  const hot = new Float32Array(memory.buffer, ptr, len);
  const flags = hot[0];
  // reconstructHot копирует поля (Array.from): после разбора view не нужен
  const game =
    flags & (HOT_FLAGS.GAME | HOT_FLAGS.PREDICTED)
      ? reconstructHot(hot, snapshotKeysById)
      : null;
  const camera = flags & HOT_FLAGS.CAMERA ? [hot[1], hot[2]] : null;

  if (flags & HOT_FLAGS.FRAMES) {
    JSON.parse(core.take_frames()).forEach(frame => {
      applyShot(frame.game, frame.camera);
    });
  }

  if (game) {
    applyGameData(game);
  }

  // камера уже разрешена ядром: предсказанная позиция либо интерполированная
  if (camera) {
    applyCamera(camera);
  }
}
