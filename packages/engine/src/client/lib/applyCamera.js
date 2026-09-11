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
 */
export default function applyCamera(canvasManager, soundManager, camera) {
  if (!camera || camera === 0) {
    return;
  }

  canvasManager.updateCoords(camera);
  soundManager.setListenerPosition(
    camera[0],
    camera[1],
    canvasManager.getCameraZoom(),
  );
}
