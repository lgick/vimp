# Д7. Отложенные улучшения (низкий приоритет, по желанию)

Не блокируют релиз; делать по мере надобности.

- ✅ выполнен — Форма комнаты генерируется по ключам `roomDefaults`
  манифеста (`populateRoomForm` в `client/main.js`): контрол из типа
  значения (boolean → checkbox, number → number, `map` → select карт),
  подпись из camelCase-ключа; движковые подсказки — `lobbyConfig.form`
  (`secondsKeys` для мс↔с, `attrs` для min/max). Из `config/lobby.js` и
  `lobby.pug` игровые поля (`friendlyFire` и пр.) удалены.
- ✅ выполнен — Stat-колонки объявляются схемой игры: `Stat.updateUser` /
  `Stat.updateHead` молча игнорируют записи в не объявленные схемой
  колонки (движковые `status/score/deaths/latency` из
  RoundManager/RTTManager перестали быть обязательными; тесты в
  `tests/host/Stat.test.js`).
- ✅ выполнен — Нейтральные имена в Rust-трейте `GameClientDef`:
  `cycle_weapon` → `cycle_item`, `try_fire` → `try_action` (трейт и
  обёртки `ClientState<G>` в engine-crate; wasm-ABI `try_fire`/`cycle_weapon`
  игрового crate не изменился, JS не затронут).
- ✅ выполнен — `pixi.js`/`howler` → devDependencies `@vimp/engine`:
  `npm ci --omit=dev` в runner-образе не тащит клиентские пакеты
  (build-stage Dockerfile ставит полный `npm ci` — Vite-сборка не задета).
- ✅ выполнен — cwd-зависимые пути мастера → якорь от `import.meta.url`:
  `gamesDir`/`dist/assets` (WorkerCatalog)/`express.static` в `main.js` и
  dev-сертификаты в `config/master.js`; мастер стартует из любой директории
  (проверено smoke-запуском с cwd `/tmp`).
