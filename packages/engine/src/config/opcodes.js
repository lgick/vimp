// Разметка бинарного snapshot-протокола (порт SHOT_DATA).
// Единый источник для хоста (упаковка) и клиента (распаковка) — обе стороны
// живут в Rust-ядре: packages/engine/core/src/snapshot.rs (pack) и packages/engine/core/src/client/unpack.rs.

// версия контракта движок ↔ игра-плагин (GameManifest, HostPlugin,
// ClientPlugin, Wasm Host ABI — docs/{en,ru}/plugin-api.md);
// проверяется при загрузке плагинов; ломающие изменения контрактов → +1.
// v2: явная схема форм (roomForm/authSchema.params[].options — Form schema
// в plugin-api.md), движок больше не выводит контролы из типа значения
// v3: набор control сокращён до нативных элементов — 'select'|'text'|
// 'checkbox'|'radio' (были ещё 'range'/'number'/'toggle'/'segmented')
// v4: порт ACCOLADES_DATA (места участников в глобальном топе) и пятый
// сервис пула зависимостей клиента (`accolades`) — snakes-v3 этап 4
export const ENGINE_API_VERSION = 4;

// версия формата кадра: первый байт после порта;
// увеличивать при любом изменении байтовой раскладки в ядре
// v2: per-user player-блок (gameId, inputSeq, состояние своего танка) — Фаза 5b
// v3: id автора в событиях оружия (tracers +shooterId, bombs +ownerId) — Фаза 5c
// v4: опциональный хвост строки блока (schema.optionalFrom) — скорости
//     динамики карты (vx/vy/angvel) у движущихся тел, покоящиеся не дорожают
// v5: угловая скорость танка (m1 +angvel) — предсказание доворота чужого
//     корпуса при контакте
export const SNAPSHOT_FORMAT_VERSION = 5;

// Реестр ключей снапшота (SNAPSHOT_KEYS) — игровая схема: живёт в
// gameConfig.snapshot игры (например src/config/snapshot.js в vimp-tanks),
// движок передаёт её ядру (lib/coreConfig.js) и клиенту в CONFIG_DATA
// (lib/buildClientConfig.js), не зная раскладки.

// флаги hot-буфера рендер-тика клиентского ядра
// (зеркало core/src/client/mod.rs в репозитории игры, например vimp-tanks)
export const HOT_FLAGS = {
  GAME: 1,
  CAMERA: 2,
  // «за группами есть хвостовые записи»: свой актор (render_overlay)
  // и/или тела, предсказанные игрой (render_rows)
  PREDICTED: 4,
  FRAMES: 8,
};
