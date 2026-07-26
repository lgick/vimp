// Разметка бинарного snapshot-протокола (порт SHOT_DATA).
// Единый источник для хоста (упаковка) и клиента (распаковка) — обе стороны
// живут в Rust-ядре: packages/engine/core/src/snapshot.rs (pack) и packages/engine/core/src/client/unpack.rs.

// версия контракта движок ↔ игра-плагин (GameManifest, HostPlugin,
// ClientPlugin, Wasm Host ABI — docs/{en,ru}/plugin-api.md);
// проверяется при загрузке плагинов; ломающие изменения контрактов → +1.
// Пока номинальная: код движка и игры ещё монолитен (см. PLAN.md)
export const ENGINE_API_VERSION = 1;

// версия формата кадра: первый байт после порта;
// увеличивать при любом изменении байтовой раскладки в ядре
// v2: per-user player-блок (gameId, inputSeq, состояние своего танка) — Фаза 5b
// v3: id автора в событиях оружия (tracers +shooterId, bombs +ownerId) — Фаза 5c
export const SNAPSHOT_FORMAT_VERSION = 3;

// Реестр ключей снапшота (SNAPSHOT_KEYS) — игровая схема: живёт в
// gameConfig.snapshot игры (например src/config/snapshot.js в vimp-tanks),
// движок передаёт её ядру (lib/coreConfig.js) и клиенту в CONFIG_DATA
// (lib/buildClientConfig.js), не зная раскладки.

// флаги hot-буфера рендер-тика клиентского ядра
// (зеркало core/src/client/mod.rs в репозитории игры, например vimp-tanks)
export const HOT_FLAGS = {
  GAME: 1,
  CAMERA: 2,
  PREDICTED: 4,
  FRAMES: 8,
};
