# Этап 9. Автотриггеры: перегрузка, скрытая вкладка, сетевой лаг; отложенная передача

Цель: хост сам (или по требованию мастера) отдаёт роль, когда из-за него
страдает матч у всех. Все триггеры зовут `startPlannedHandoff` из этапа 8 с
`stay: true` (бывший хост остаётся играть гостем). Защита от «пинг-понга»
обязательна.

Зависит от этапа 8.

## 9.1. Здоровье хоста (Worker → главный поток)

- `host/meta/modules/TimerManager.js` (игровой цикл `:123-155`, шаг
  1000/120, `AbstractTimer` + `clock.js`): считать итерации цикла в
  скользящем окне 1 с → `tickRate` (Гц), максимум разрыва между итерациями
  → `maxGapMs`. Плюс «потерянное время»: сумма `dt`, срезанного капом 0.1 с
  (`core/src/game.rs` `MAX_ACCUMULATED_TIME`) — если она > 0, симуляция
  отстаёт от реального времени.
- `RTTManager` (`host/meta/modules/RTTManager.js:52-66`): медиана EMA RTT
  по удалённым людям (без `'local'`) → `peerRttMedian`, `peerCount`.
- Worker раз в 1 с: `health { tickRate, maxGapMs, lostMs, peerRttMedian,
peerCount }` → `HostController.onHealth(cb)`.
- Для этапа 0-гипотезы «цикл в скрытой вкладке» — использовать те же
  метрики (логировать в `diagnostics` при `document.hidden`).

## 9.2. Политика хоста (`client/network/HostHealthPolicy.js`)

Чистый модуль на фейковых часах, вход — поток `health` + `visibility` +
`successorAvailable`, выход — `{ trigger: 'overload' | 'hidden', defer }`:

| Триггер            | Условие                                                                                      | Действие                                                       |
| ------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| перегрузка мягкая  | средний `tickRate` < `overloadTickRate` (100) на окне `overloadWindowMs` (5000)              | плановая передача, **отложенная** до границы раунда (9.4)      |
| перегрузка жёсткая | средний `tickRate` < `criticalTickRate` (60) на 3000 мс **или** `lostMs` > 0 три окна подряд | плановая передача сразу                                        |
| скрытая вкладка    | `document.hidden` непрерывно `hiddenHandoffMs` (7000; уточнить по этапу 0)                   | плановая передача сразу (вкладку могут усыпить в любой момент) |

Общие условия: бета назначена (`successor_assigned`), в комнате есть другие
люди, с прошлой авто-передачи этой вкладки прошло `autoHandoffCooldownMs`
(90000), идёт не первая минута роли хоста (`minHostTenureMs`, 30000 — не
отдавать роль, только что получив её, пока прогревается JIT). Бета сама
должна быть «здоровой» — мастер не назначает скрытую (этап 6); дополнительно
бета сообщает свой FPS рендера в `member_update.caps.fps` раз в 10 с, и
мастер не назначает бету с `fps < 30`.

## 9.3. Сетевой лаг — решает мастер

Хост не может сам сравнить себя с бетой (бета не видит других игроков),
поэтому арбитр — мастер, у которого единая линейка `score` для всех
(RTT до мастера + джиттер, этап 6):

- хост раз в 2 с шлёт `host_health {roomId, epoch, tickRate,
peerRttMedian, peerCount}` (из 9.1);
- `MigrationCoordinator`: «лаг хоста» = `peerRttMedian >
lagRttThresholdMs` (250) непрерывно `lagSustainMs` (10000) при
  `peerCount ≥ 1`;
- **гистерезис**: `score(беты) ≤ (1 − lagImprovementRatio) × score(хоста)`,
  `lagImprovementRatio = 0.35`;
- **cooldown**: с последней автоматической смены хоста в этой комнате ≥
  `autoMigrationCooldownMs` (90000) и хост в роли ≥ того же срока;
- тогда хосту `request_handoff {roomId, epoch, reason: 'network', defer:
true}` → хост вызывает `startPlannedHandoff({reason: 'network', stay:
true, defer: true})`.
- Хост, проигнорировавший `request_handoff` (`reason: 'network'`) — не
  наказывается (это может быть старый клиент); принудительно мастер
  переводит хост только по голосованию (этап 10).

`room.lastAutoMigrationAt` обновляется при **любой** автоматической смене
(перегрузка, скрытая вкладка, лаг) — кулдаун общий, это и есть защита от
пинг-понга между двумя слабыми хостами.

## 9.4. Отложенная передача (граница раунда)

- `defer: true` → Worker-сообщение `notify_round_boundary` → в
  `RoundManager.initiateNewRound` (`:269-285`, единая воронка: таймер
  раунда, рестарт после вайпа, смена команд) Worker постит
  `round_boundary` **и замораживается** (как нынешний `requestHandoff`,
  но вместо `handoff_state` — финальная точка `kind: 'boundary'`) →
  главный поток продолжает `startPlannedHandoff` с шага «финальная точка».
  У беты матч стартует с нового раунда — для игроков это обычная пауза
  между раундами.
- Потолок ожидания `deferMaxMs` (30000): граница не наступила →
  передача сразу (mid-round). Игры с `endlessRound` (snakes,
  `RoundManager.js:101-104`) границы не имеют — у них отложенная передача
  всегда срабатывает по потолку.
- Пока передача отложена, политика продолжает следить за условием: если
  оно исчезло (тикрейт восстановился, лаг прошёл) — отменить
  (`cancel_round_boundary` в Worker); отдельный тест.
- Жёсткие триггеры (`defer: false`) границу не ждут.

## 9.5. Сообщения игрокам

После `host_changed` с `reason` из `overload`/`hidden`/`network` клиенты
показывают короткий информ: «Host changed: the previous host was lagging»
/ «… went inactive». Тексты — в реестре кодов движка (там же, где этап 7
добавил «Host changed»).

## 9.6. Конфиг

`config/lobby.js` (`migration.auto.*`): `overloadTickRate`,
`overloadWindowMs`, `criticalTickRate`, `hiddenHandoffMs`,
`autoHandoffCooldownMs`, `minHostTenureMs`, `deferMaxMs`, `enabled`
(общий выключатель, дефолт `true`). `config/master.js` (`room.*`):
`lagRttThresholdMs`, `lagSustainMs`, `lagImprovementRatio`,
`autoMigrationCooldownMs`, `minSuccessorFps`. Доки `configuration.md`.

## 9.7. Тесты

- `tests/client/network/HostHealthPolicy.test.js` — табличные сценарии на
  фейковых часах: мягкая/жёсткая перегрузка, скрытая вкладка (в т.ч.
  мигание видимости), нет беты, кулдаун, `minHostTenureMs`.
- `tests/host/TimerManager.test.js` — `tickRate`/`maxGapMs`/`lostMs`.
- `tests/host/RTTManager.test.js` — медиана без `'local'`.
- `tests/host/RoundManager.test.js` — `notify_round_boundary` замораживает
  на границе; `cancel_round_boundary`; `endlessRound`.
- `tests/master/MigrationCoordinator.test.js` — лаг: порог, длительность,
  гистерезис 35 %, общий кулдаун, `minSuccessorFps`.

## 9.8. Документация

`docs/{en,ru}/host.md` — «Host migration» → «Automatic triggers» (таблица
9.2, лаг через мастер, отложенная передача); `master.md` — `host_health`,
`request_handoff`, правило лага; `configuration.md`; `debugging.md` —
метрики `health` в диагностике.

## 9.9. CHANGELOG

`### Added`: automatic host handoff when the host's tick rate drops, its
tab stays hidden, or its network is markedly worse than the successor's
(with hysteresis and a shared cooldown); non-critical handoffs wait for the
round boundary.

## Проверка

Автотесты зелёные. Вручную: у хоста DevTools → Performance → CPU throttling
6× → через ~5 с (или на границе раунда) хост уходит к бете; свернуть
вкладку хоста на 10 с → передача; Network throttling «Slow 3G» у хоста при
нормальной сети беты → через ~10 с передача, повторная смена не раньше 90 с.

## Готово, когда

Проверки зелёные, доки en/ru синхронны, CHANGELOG обновлён, release impact
в отчёте.
