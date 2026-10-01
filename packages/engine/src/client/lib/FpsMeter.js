// Средний FPS рендера за окно (host-migration этап 9c): гость сообщает его
// мастеру в caps.fps, и мастер не назначает бетой слабую вкладку.
// Ticker.shared.FPS для этого не годится — это скорость одного последнего
// кадра: пауза сборщика мусора в момент замера сняла бы бету с прогревом.

// окно короче — замер шумный, не сообщается
const MIN_WINDOW_MS = 1000;

export default class FpsMeter {
  /**
   * @param {Object} [options]
   * @param {Function} [options.now] - монотонные часы, мс.
   */
  constructor({ now = () => performance.now() } = {}) {
    this._now = now;
    this._frames = 0;
    this._since = now();
  }

  // кадр отрисован (колбэк тикера)
  frame() {
    this._frames++;
  }

  // окно заново: кадры до этого момента не в счёт (вкладка была скрыта)
  reset() {
    this._frames = 0;
    this._since = this._now();
  }

  /**
   * Средний FPS с прошлого замера; окно начинается заново.
   * @returns {number|null} null — кадров не было или окно короче 1 с.
   */
  sample() {
    const elapsedMs = this._now() - this._since;
    const fps =
      this._frames > 0 && elapsedMs >= MIN_WINDOW_MS
        ? (this._frames * 1000) / elapsedMs
        : null;

    this.reset();

    return fps;
  }
}
