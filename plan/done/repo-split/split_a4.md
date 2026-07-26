# A4. Сборка и деплой ✅ выполнен

- **Dockerfile движка**: убрать Rust-стадию `core-builder` и `npm run game:build`
  (движок больше не собирает WASM игры). Node-стадия делает `npm ci` (ставит
  `@vimp/tanks` из registry, что приносит `dist/`) + `build:app` (Vite движка).
  Runner копирует `packages/engine/dist` + master + `node_modules/@vimp/tanks/dist`.
- **CI игры** (в её репозитории): Rust+wasm-pack стадия + `game:build` + публикация
  пакета. Обновление игры = bump версии пакета в `GAMES_MATRIX` движка (или
  автопулл «latest» по политике).
- Совместимость версий: `ENGINE_API_VERSION` теперь реально работает как контракт
  между репозиториями (в `plugin-api.md` уже отмечено: «bump policy kicks in once
  games live in external repos»). Мастер должен отвергать игру с несовпадающим
  `engineApi` (уже проверяется на импорте у хоста/клиента; добавить проверку и в
  `GameCatalog` при загрузке манифеста, чтобы не отдавать несовместимую игру).

## Критические файлы

`Dockerfile` + `.github/workflows/deploy.yml`.

## Сделано

- `Dockerfile`: убраны стадия `core-builder` (Rust/wasm-pack) и `npm run
  game:build`; node-стадия (`builder`) делает `npm ci` (ставит `@vimp/tanks`
  из registry) + `npm run build:app`; runner копирует
  `packages/engine/dist`, master (`config`/`lib`/`master`) и
  `node_modules/@vimp/tanks/dist` (вместо прежнего `games/tanks/dist`).
  `.github/workflows/deploy.yml` менять не пришлось — он не ссылается на
  `games/tanks` напрямую, вся Rust/Node-логика была внутри `Dockerfile`.
- `packages/engine/package.json`: добавлена реальная npm-зависимость
  `"@vimp/tanks": "^0.1.0"` (раньше пакет не был объявлен нигде — резолвился
  только через workspace-симлинк/`npm link`; без записи в `dependencies`
  `npm ci` в Dockerfile не поставил бы его).
- `GameCatalog` (`packages/engine/src/master/GameCatalog.js`): при чтении
  `manifest.json` добавлена проверка `manifest.engineApi !==
  ENGINE_API_VERSION` — несовместимая игра пропускается с `console.warn` и
  не попадает в `manifestList`, тем же паттерном, что уже был для
  отсутствующего манифеста / несовпадения `manifest.id`. Тест добавлен в
  `tests/master/GameCatalog.test.js`.
- Документация: `docs/en(ru)/deployment.md` (Rust-тулчейн callout переписан
  под новый Dockerfile), `docs/en(ru)/plugin-api.md` (уточнено, что
  engineApi-гейт есть и на мастере, не только на клиенте/хосте),
  корневой `CLAUDE.md` (секция Deployment — gap закрыт).
- Проверено: `npx eslint .` и `npm test` (78 файлов / 717 тестов) — зелёные.

Не сделано (вне рамок этой сессии, требует реальной публикации пакетов):
CI игры в её собственном репозитории (`vimp-tanks/.github/workflows/`)
уже подготовлен в A3.6 как черновик — не запускался в GitHub Actions;
живая проверка `docker build` этого `Dockerfile` тоже не прогонялась (нет
доступа к Docker/registry `@vimp/tanks` из этой сессии) — оба пункта
зависят от публикации `@vimp/engine`/`@vimp/tanks` в registry, которая
всё ещё не сделана (см. оговорки A3.2/A3.3).
