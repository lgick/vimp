import { supportsModuleWorker } from '../network/workerSupport.js';

// Возможности участника комнаты (host-migration этап 6): мастер по ним
// выбирает преемника хоста (master/successor.js). Шлются в join_room /
// register_host и в member_update при смене видимости вкладки или типа
// ICE-кандидата, а гостем — раз в 10 с ради свежего FPS (этап 9c).

/**
 * Мобильное устройство: Client Hints, а без них — грубый указатель.
 * @param {Object} [env] - { navigator, matchMedia } (тесты).
 * @returns {boolean}
 */
export function isMobileDevice(env = globalThis) {
  const hinted = env.navigator?.userAgentData?.mobile;

  if (typeof hinted === 'boolean') {
    return hinted;
  }

  try {
    return env.matchMedia?.('(pointer: coarse)').matches === true;
  } catch {
    return false;
  }
}

/**
 * Может ли вкладка поднять Worker хоста и принимать WebRTC.
 * @param {Object} [env] - { RTCPeerConnection, WebAssembly, navigator,
 *   matchMedia, moduleWorker: () => boolean } (тесты).
 * @returns {boolean}
 */
export function canHostIn(env = globalThis) {
  const moduleWorker = env.moduleWorker ?? supportsModuleWorker;

  return (
    typeof env.RTCPeerConnection !== 'undefined' &&
    typeof env.WebAssembly === 'object' &&
    env.WebAssembly !== null &&
    !isMobileDevice(env) &&
    moduleWorker()
  );
}

/**
 * Собирает caps участника.
 * @param {Object} options
 * @param {boolean} options.canHost - результат canHostIn (считается один
 *   раз: проба Worker'а не бесплатна).
 * @param {string|null} [options.iceType] - тип своего локального
 *   ICE-кандидата в выбранной паре с хостом ('host'|'srflx'|'prflx'|'relay').
 * @param {number|null} [options.fps] - FPS рендера (гость; мастер не
 *   назначает бетой вкладку ниже master.room.minSuccessorFps).
 * @param {Object} [env] - { document, navigator, matchMedia } (тесты).
 * @returns {{ canHost: boolean, mobile: boolean, hidden: boolean,
 *   iceType: string|null, fps: number|null }}
 */
export function buildHostCaps(
  { canHost, iceType = null, fps = null },
  env = globalThis,
) {
  return {
    canHost: canHost === true,
    mobile: isMobileDevice(env),
    hidden: env.document?.hidden === true,
    iceType: iceType ?? null,
    fps: Number.isFinite(fps) ? Math.round(fps) : null,
  };
}
