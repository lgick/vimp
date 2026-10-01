# Этап 9. Автотриггеры: перегрузка, скрытая вкладка, сетевой лаг; отложенная передача ✅ выполнен

Цель: хост сам (или по требованию мастера) отдаёт роль, когда из-за него
страдает матч у всех. Все триггеры зовут `startPlannedHandoff` из этапа 8 с
`stay: true` (бывший хост остаётся играть гостем). Защита от «пинг-понга»
обязательна.

Зависит от этапа 8.

## Подэтапы (согласовано 2026-10-03)

| #   | Тема                                                                                                                                                  | Статус      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 9a  | Здоровье хоста в Worker: `tickRate`/`maxGapMs`/`lostMs`, медиана RTT, сообщение `health`, `HostController.onHealth`, сводка скрытого эпизода в журнал | ✅ выполнен |
| 9b  | `HostHealthPolicy` + подключение в `client/main.js`: перегрузка, скрытая вкладка, отмена отложенной передачи                                          | ✅ выполнен |
| 9c  | Мастер: `host_health`, правило лага, `request_handoff`, `caps.fps`/`minSuccessorFps`, общий кулдаун `lastAutoMigrationAt`                             | ✅ выполнен |
| 9d  | `reason` в `host_changed` + коды текстов (игры, шаблон, фикстура), сквозные доки, CHANGELOG                                                           | ✅ выполнен |

Решения разработчика (2026-10-03):

- **Граница раунда — механизм 8d**: `round_boundary_wait`/`round_boundary_cancel`
  Worker'а, `PlannedHandoff` с `defer`, конфиг `lobby.migration.deferMaxMs`
  (в `migration.auto` не дублируется). Новых сообщений
  `notify_round_boundary`/`cancel_round_boundary` и заморозки с точкой
  `kind: 'boundary'` нет; в 9b добавляется только отмена отложенной передачи,
  когда условие исчезло. Пункты 9.4 и 9.6 ниже читать с этой поправкой.
- **`caps.fps`** шлют все гости комнаты (не хост) раз в 10 с; участник без
  `fps` (старый клиент) не отсеивается.
- **Диагностика скрытой вкладки** — одна сводка за эпизод: пока вкладка-хост
  скрыта, копятся min `tickRate`, max `maxGapMs`, сумма `lostMs`,
  длительность; при возврате видимости, потере роли хоста или `pagehide` (сразу с
  `diagnostics.flush()`) — один
  `diagnostics.warn('engine.host.hiddenHealth', сводка)`.
- **`peerRttMedian`** — только люди с хотя бы одним измеренным pong (без
  стартовой догадки 100 мс); таких нет — `peerRttMedian: null`,
  `peerCount: 0`.
- **Пока матч заморожен/на паузе, `health` не шлётся** (иначе `tickRate` 0 —
  ложная перегрузка): окно метрик живёт внутри игрового цикла и
  сбрасывается при его (пере)запуске.

Решения разработчика по 9b (2026-10-03):

- **Сэмпл** — одно сообщение `health` (раз в 1 с). Окна политики — подряд
  идущие сэмплы: мягкая перегрузка — среднее последних 5 < 100, жёсткая —
  среднее последних 3 < 60 или `lostMs > 0` у 3 сэмплов подряд. Разрыв
  потока (сэмпла нет > 2 интервалов — матч заморожен/на паузе) окна
  обнуляет.
- **Отмена отложенной передачи (гистерезис)**: каждый из последних 5
  сэмплов подряд > `recoverTickRate` (110) → `PlannedHandoff.cancelDeferred()`
  → `round_boundary_cancel`; сэмпл ≤ 110 сбрасывает счёт. Конфиг
  `migration.auto.recoverTickRate`/`recoverWindowMs` (5000). Отменяется
  только своя авто-передача в фазе `deferred` — ручную «Hand over host»
  политика не трогает.
- **Эскалация**: передача отложена, а наступило жёсткое условие или
  скрытая вкладка → `PlannedHandoff.hurry()`: снять ожидание границы
  (`round_boundary_cancel`) и сразу `handoff_begin`.
- **Кулдаун** `autoHandoffCooldownMs` отсчитывается с запуска авто-передачи
  при любом исходе (удалась, отказ мастера, дедлайн); отмена отложенной по
  стабилизации кулдаун снимает (от мигания защищают гистерезис и окна).
  Политика живёт дольше роли хоста (кулдаун переживает смену ролей);
  `minHostTenureMs` — от получения роли.
- «В комнате есть другие люди» = назначена бета (`successor_assigned`).
  Скрытая вкладка: если на 1.5 с общие условия не выполнены — передача,
  как только выполнятся, пока вкладка скрыта.
- До 9c/9d мастер принимает незнакомые `reason` (`overload`/`hidden`) как
  `handover`.

Решения разработчика по 9c (2026-10-03):

- **`room.lastAutoMigrationAt`** ставится при **успешной** смене хоста
  (`completePromotion`) с причиной `overload`/`hidden`/`network` — в т.ч.
  если плановая передача деградировала в аварийную. Сорванная передача
  (отказ, таймаут, хост остался) метку не ставит.
- Общий кулдаун мастера (`autoMigrationCooldownMs`) гейтит **только его
  правило лага**; `handoff_begin` с `overload`/`hidden` мастер не отклоняет
  (их частоту держат `minHostTenureMs` и кулдаун вкладки). Хост в роли ≥
  `autoMigrationCooldownMs` — от получения роли (`room.hostSince`:
  создание комнаты/промоушен; `reclaim_host` не сбрасывает).
- **Отмены отложенной сетевой передачи нет** (нового сообщения нет):
  срабатывает на границе раунда или по `deferMaxMs`.
- Окно лага «непрерывно» сбрасывается: сэмпл ≤ порога, `peerCount` 0 или
  `peerRttMedian` null, пауза между `host_health` > 5 с, смена эпохи. После
  `request_handoff` окно начинается заново (повтор не раньше `lagSustainMs`).
  Условия: комната `online`, `score` хоста и беты измерены, бета с живым
  потоком точек.
- Хост шлёт `host_health` не чаще раза в 2 с (`migration.auto.hostHealthIntervalMs`)
  по последнему сэмплу `health` — пока матч заморожен, не шлёт. Хост с
  `migration.auto.enabled: false` игнорирует `request_handoff`.
- `caps.fps` = `Math.round(Ticker.shared.FPS)`, гость шлёт `member_update`
  раз в 10 с (`migration.auto.fpsReportIntervalMs`); `minSuccessorFps`
  проверяется при назначении беты, при аварийном промоушене
  (`allowHidden`) — нет. `fps` вне 0…1000 / не число → `null` (не
  отсеивается).
- `PLANNED_REASONS` мастера: `leave`, `handover`, `overload`, `hidden`,
  `network`.

Решения разработчика по ревью 9c (2026-10-03):

- **`caps.fps` — среднее за интервал**, а не `Ticker.shared.FPS` (тот — по
  одному последнему кадру): кадры между отправками / прошедшее время.
  Нет кадров или окно < 1 с — `null`; при возврате видимости окно
  начинается заново (кадры скрытой вкладки не считаются). Мастер не
  меняется.
- **Сорванная сетевая передача** (`_abortHandoff` с `reason: 'network'`)
  ставит `room.lastLagHandoffFailedAt`; правило лага молчит
  `autoMigrationCooldownMs` и после неё. `lastAutoMigrationAt` — по-прежнему
  только при успехе.

Решения разработчика по 9d (2026-10-03):

- **Причину показывает Worker нового хоста**, а не клиент по
  `host_changed`: главный поток преемника передаёт `promote.reason` в
  `start_after_restore {waitForResume, reason}`, и Worker после
  возобновления шлёт всем вместо `s:7` код причины. Одна строка у всех,
  включая нового и бывшего хоста. Старый главный поток (без `reason`) и
  прочие причины → `s:7`, как раньше.
- **Три кода**: `s:9` `HOST_CHANGED_OVERLOAD` «Host changed: the previous
  host was lagging», `s:10` `HOST_CHANGED_HIDDEN` «Host changed: the
  previous host went inactive», `s:11` `HOST_CHANGED_NETWORK` «Host
  changed: the previous host had a poor connection». Правило `B8`
  резервирует группу `s` до 11. Тексты — в обеих играх, шаблоне,
  фикстуре miniGame, `docs/ai`.
- Мастер всё равно кладёт `reason` (причину миграции) в `host_changed`
  (протокол, доки); клиент его не показывает.

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

| Триггер            | Условие                                                                                                                              | Действие                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| перегрузка мягкая  | средний `tickRate` < `overloadTickRate` (100) на окне `overloadWindowMs` (5000)                                                      | плановая передача, **отложенная** до границы раунда (9.4)      |
| перегрузка жёсткая | средний `tickRate` < `criticalTickRate` (60) на 3000 мс **или** `lostMs` > 0 три окна подряд                                         | плановая передача сразу                                        |
| скрытая вкладка    | `document.hidden` непрерывно `hiddenHandoffMs` (1500 — этап 0: Chrome/Safari троттлят Worker до ~12 Гц за 1–3 с, `spike-results.md`) | плановая передача сразу (вкладку могут усыпить в любой момент) |

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
