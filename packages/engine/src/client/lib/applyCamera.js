// Применение данных камеры: позиция слушателя звука + полотно. Вынесено из
// main.js отдельным модулем ради одной вещи — порядка вызовов, который
// ничем больше не защищён: main.js целиком поднять в тесте нельзя, у него
// побочные эффекты уровня приложения.

/**
 * Применяет кадр камеры: сначала полотно, затем слушатель звука.
 *
 * Порядок обязателен. Множитель зума пересчитывается внутри
 * `updateCoords`, и слушателю нужен зум ЭТОГО кадра, а не прошлого: при
 * обратном порядке стереобаза отстаёт от картинки на кадр, и на разгоне
 * (когда зум как раз и меняется) это слышно как запаздывающую панораму.
 * @param {object} canvasManager - Контроллер CanvasManager.
 * @param {object} soundManager - Экземпляр SoundManager.
 * @param {Array | number} camera - `[x, y, cameraReset, shakeData]` из
 * горячего буфера ядра; `0` или пустое значение — кадра камеры нет.
 * @param {Function} [onInvalid] - Зовётся с кадром, у которого x или y — не
 * конечное число (NaN, Infinity, undefined, null); такой кадр не применяется.
 */
export default function applyCamera(
  canvasManager,
  soundManager,
  camera,
  onInvalid,
) {
  if (!camera || camera === 0) {
    return;
  }

  // Неконечная координата не применяется ни к полотну, ни к слушателю.
  // Полотну один NaN вредит надолго: CanvasManagerModel сглаживает камеру
  // через lerp, NaN оседает в его накопителях до cameraReset — масштаб
  // сцены NaN, картинки нет. Слушателю — сразу: NaN уходит в Howl.pos(),
  // тот бросает, и тикер Pixi останавливается. null отсекается тоже: serde
  // пишет неконечное число JSON-кадра как null, а в арифметике null молча
  // стал бы нулём — прыжок камеры в начало координат
  if (!Number.isFinite(camera[0]) || !Number.isFinite(camera[1])) {
    onInvalid?.(camera);
    return;
  }

  canvasManager.updateCoords(camera);
  soundManager.setListenerPosition(
    camera[0],
    camera[1],
    canvasManager.getCameraZoom(),
  );
}
