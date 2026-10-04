import { reloadTo } from './roomLink.js';

/**
 * Программная перезагрузка страницы: сначала guard.exit() — иначе
 * pagehide принял бы её за закрытие вкладки, и гость (бета перед холодным
 * промоушеном, возврат в ту же комнату) объявил бы уход и потерял место.
 * Единственное место, где клиент перезагружает страницу (ESLint).
 * @param {Object} deps
 * @param {Function} deps.getGuard - () → HostUnloadGuard | null.
 * @param {Function} [deps.reloadToHash] - (hashPart) — тесты.
 * @param {Function} [deps.reloadSame] - () — тесты.
 * @returns {Function} (hashPart?) => void; hashPart не задан — тот же адрес.
 */
export function createPageReload({
  getGuard,
  reloadToHash = reloadTo,
  // eslint-disable-next-line no-restricted-syntax -- сама обёртка
  reloadSame = () => window.location.reload(),
}) {
  return hashPart => {
    getGuard()?.exit();

    if (hashPart === undefined) {
      reloadSame();
    } else {
      reloadToHash(hashPart);
    }
  };
}
