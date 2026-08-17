# Архив: разделение на два репозитория + авторизация на лобби + рейтинг серверов

Все направления ниже реализованы и заархивированы:

- [repo-split/](repo-split/) — направление A: вынос игры в отдельный
  репозиторий, публикация движка как npm-пакета + Rust-crate
  (`split_a1.md`–`split_a5.md`).
- [central-auth/](central-auth/) — направление B: OAuth-авторизация на
  лобби, глобальный ник, rank/state через центральный auth-сервис
  (`auth_b1.md`–`auth_b6.md`, `auth_fixes.md`).
- [engine-game-split/](engine-game-split/) — более ранний архив: разделение
  движка/игры на рантайм-уровне (Этапы 1–8 + доработки Д1–Д7).
- [server-rating/](server-rating/) — направление C: рейтинг серверов
  (`/like`·`/unlike`), модель доверия игр к профилю, аннулирование
  rank/skills при бане хостера (`stage_1.md`–`stage_5.md`, `review.md`).
- [ai-debug/](ai-debug/) — направление F: среда отладки игровых плагинов
  для нейросети (`stage_1.md`–`stage_8.md`, `original-statement.md`,
  `review.md`).
- [lobby-page/](lobby-page/) — направление D: подготовка страницы лобби к
  нескольким играм + Leaderboard (✅ 2026-08-02): селектор игр, две колонки
  лобби, вкладка Leaderboard, серверный поиск `gameId/name`. Пост-ревью —
  [lobby-page/lobby-page-review-status.md](lobby-page/lobby-page-review-status.md).
- Направление E: документация движка для нейросети (`docs/ai/`) — ✅
  выполнено целиком (коммит `eba94a6`, 2026-08-03); план удалён за
  ненадобностью.
- [render-sound/](render-sound/) — направление G: 4 бага рендера и звука
  (✅ 2026-08-08). Крейт `vimp-engine-core` minor (`reset()`/`resync()`),
  npm `vimp-engine` patch (`RoundManager`). `ENGINE_API_VERSION` не менялся.
- [standalone-sdk/](standalone-sdk/) — направление H: browser SDK
  (`startStandaloneGame`), dedicated-сервер (`src/dedicated/`) и режимы
  `boot.js` (`lobby`/`solo`/`dedicated`) (✅ 2026-08-17, 5 раундов ревью,
  `review.md`–`review-5.md`). Крейт `vimp-engine-core` не тронут,
  `ENGINE_API_VERSION` не менялся; npm `vimp-engine` minor — публикуемый
  клиент вырос до `src/client`/`src/standalone`, добавлен
  `src/config/closeCodes.js`.

## Зафиксированные решения

- Подключение игр — готовые npm-бандлы (игра сама собирает `dist/`,
  включая WASM, в своём CI и публикует пакет).
- Аккаунты/рейтинг — центральный auth-сервис с общей БД PostgreSQL, все
  мастера ходят к нему по API.
- Ник/rank — JWT + отчёт хоста: мастер выдаёт подписанный токен, хост
  проверяет подпись и берёт ник из токена, итоги матча хост шлёт на мастер
  аутентифицированным REST.
- Имя игрового scope (2026-07-26): `@vimp/tanks` тоже оказался занят на
  npmjs.com третьей стороной — референсная игра опубликована как
  `@vimp-games/tanks`. Обновлены зависимость в корневом `package.json`,
  дефолт `packages/engine/src/config/master.js` (`games[].package`),
  ESLint-барьер `no-restricted-imports` (обобщён на весь scope
  `@vimp-games/*`) и все доки/комментарии.
- Реестр пакетов движка (2026-07-26): `vimp-engine` — публичный npm,
  `vimp-engine-core` — публичный crates.io (не приватный registry, не
  git-зависимость) — игры создают сторонние разработчики. См.
  [repo-split/split_a1.md](repo-split/split_a1.md).
- Имя npm-пакета (2026-07-26): изначально планировался scope
  `@vimp/engine`, но организация `vimp` на npmjs.com оказалась занята
  третьей стороной — опубликован без scope как `vimp-engine`.
- Публичность (2026-07-26): публично только то, что нужно стороннему
  разработчику игры — `vimp-engine` + `vimp-engine-core`. `@vimp/auth` —
  приватный сервис. Плагины игр — на усмотрение автора; референс
  `@vimp-games/tanks` — публичный.
- Модель доверия игр к профилю (2026-07-26): rank/skills пишет любая игра
  из каталога мастера, каждая только в свой `game_id`; rank — общий формат
  (публичный SDK-контракт), skills — приватный формат игры (JSONB
  `state`); ник/идентичность игра не трогает (только JWT). См.
  [server-rating/](server-rating/).

## Контекст

Проект уже прошёл внутреннее разделение движка и игры: граница
«движок↔игра» — это URL-driven плагин-контракт. Движок нигде не
импортирует игру статически; он грузит её только динамически по
манифесту: `import(manifest.entries.client)` в клиенте,
`import(room.game.hostEntryUrl)` в Worker хоста, `GameCatalog` на мастере
читает `dist/manifest.json`. Барьер ESLint (`no-restricted-imports`) и
Rust-трейты `GameDef`/`GameSim`/`GameClientDef` уже разводят код.

Авторизация реализована: центральный auth-сервис (`packages/auth`, см.
[docs/en/auth.md](../../docs/en/auth.md)) выдаёт OAuth-логин, глобальный
ник, JWT-идентичность и rank/state по играм; хост верифицирует токен по
`/jwks`, итоги матча репортит на мастер аутентифицированным REST.

Оговорка (важно держать в доках): хост — недоверенный браузер, поэтому
любые присылаемые им rank/скиллы технически подделываемы. Это ограничение
P2P-архитектуры; полноценный анти-чит вне рамок этого плана. JWT защищает
идентичность (ник нельзя подменить), но не защищает от накрутки результата
своего матча. Единственная реально принятая мера — социальная: рейтинг
сервера `/like`·`/unlike` ([server-rating](server-rating/README.md)) даёт
игрокам топить накручивающего хостера голосами до блокировки, после
которой его вклад в rank/skills аннулируется (см.
[docs/en/master.md](../../docs/en/master.md#server-rating-likeunlike),
[docs/en/auth.md](../../docs/en/auth.md#schema)) — это компенсация, а не
предотвращение подделки.
