# Этап 2 — баги 1+2, ядро плагина (`vimp-tanks`)

## 1.B. `reset()` в ядрах означает «мира больше нет»

- `Predictor::reset()` (`vimp-tanks/core/src/client/predictor.rs`) —
  добавить `self.has_state = false;`. Согласовано с уже стоящим там
  `pending_reset = true`: следующее авторитетное состояние берётся без
  replay, а до его прихода рендерить нечего. Затрагивает и третьего
  вызывающего — `force_reset` камеры при респауне: один кадр (~33 мс) без
  предсказанного танка вместо кадра со старой позицией, это корректнее.
- `TanksClient::reset()` (`vimp-tanks/core/src/client/mod.rs`) — добавить
  `self.my_tank_meta = None;`.

## 2.2. Детерминированный `setIdList`

`remove_players_and_shots` (`vimp-tanks/core/src/tanks.rs`) собирает имена
моделей танков **из живых танков** (`self.tanks.drain(..)`), а имена оружий и
исходов — из конфига. Сразу после смены карты живых танков нет → в списке нет
`m1` → на клиенте `gameSets['m1']` (`Tank`/`TankRadar`/`Smoke`/`Tracks`) не
очищается.

Правка: возвращать **все сконфигурированные ключи моделей**, а не только
модели живых танков. Тогда частичный CLEAR перестаёт зависеть от того, был ли
кто-то жив.

## 2.3. Страховка в `Tank.update()` (необязательная)

При `this._condition > 0 && this._soundId === null` вызывать `_initSounds()`.
Танк, потерявший звук по любой причине, вернёт его на следующем кадре.
Дёшево, без нового API.

## Баг 2a — отдельной правки не требует

«Звук остаётся после смены карты» — прямое следствие бага 1: призрачный
`Tank` создаётся **после** `soundManager.reset()`, поэтому его
`registerSound('tankEngine')` легитимен, а луп играет бесконечно с
`rate`/`volume` от замороженного `engineLoad`. Чинится этапами 1+2.

## Файлы

- `vimp-tanks/core/src/client/predictor.rs`
- `vimp-tanks/core/src/client/mod.rs`
- `vimp-tanks/core/src/tanks.rs`
- `vimp-tanks/src/client/parts/Tank.js` (опционально)

## Тесты (cargo плагина + Vitest плагина)

- `Predictor::reset()` → `has_state()` == `false`;
- `TanksClient::reset()` → `render_overlay()` == `None` (регрессия бага 1);
- `remove_players_and_shots` возвращает ключи моделей и при пустом
  `self.tanks`;
- `tests/core/clientCore.test.js` — сценарий «CLEAR → тик → в hot-буфере нет
  predicted-хвоста».
