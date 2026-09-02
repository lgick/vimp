// Перенос URL-ов манифеста игры под версионную базу мастера
// (направление master-game-registry, этап 3).
//
// Манифест пишет сборка в репозитории игры, и она ничего не знает о том, по
// какому адресу мастер будет раздавать именно эту версию: пакет собран под
// `/games/<id>/`, а мастер держит на диске несколько версий сразу и раздаёт
// их по `/games/<id>/<version>/`. Приём тот же, каким каталог уже переписывает
// entries в dev на Vite `/@fs/` (GameCatalog._toDevManifest) — новым здесь
// является только база.
//
// Отдельный модуль (а не метод каталога) ради юнит-теста и ради будущего
// переезда раздачи на CDN: там поменяется ровно один аргумент `base`.

// URL-ы entries, которые живут под assetsBase и потому подлежат ребейзу.
// `wasmNode` в список НЕ входит намеренно: это путь файловой системы для
// dedicated-сервера (docs/ai/02-packaging.md), а не URL
const REBASED_ENTRIES = ['client', 'host', 'wasm'];

/**
 * Переносит URL-ы манифеста под новую базу.
 * @param {Object} manifest - Манифест как его написала сборка игры.
 * @param {string} base - Новая база, оканчивается '/' (напр. '/games/tanks/0.16.1/').
 * @returns {Object} Копия с переписанными assetsBase/entries и добавленным mapsBase.
 */
export function rebaseManifest(manifest, base) {
  const from = manifest.assetsBase;
  const entries = { ...manifest.entries };

  for (const key of REBASED_ENTRIES) {
    const url = entries[key];

    // entry вне assetsBase оставляем как есть: манифест с мусором в entries
    // ловит gamePackageCheck при приёме пакета, а молча «чинить» здесь чужой
    // абсолютный URL (например, на CDN самой игры) — значит его сломать
    if (typeof from === 'string' && typeof url === 'string' && url.startsWith(from)) {
      entries[key] = base + url.slice(from.length);
    }
  }

  return {
    ...manifest,
    entries,
    assetsBase: base,
    // карты клиент берёт не из assetsBase, а по отдельному URL лобби —
    // версионность обязана доехать и туда (config/lobby.js:maps)
    mapsBase: `${base}maps`,
  };
}
