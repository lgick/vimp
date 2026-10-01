# Этап 5. Хост: контрольная точка посреди раунда (формат v4), хуки плагина, opt-in игр ✅ выполнен

Цель: Worker умеет в любой момент (на границе кадра) снять **контрольную
точку** — полный дамп ядра + всю мету, нужную, чтобы продолжить раунд с того
же места, — и поднять матч из неё в другом Worker'е (в том числе на другой
машине). Плюс исправление известного бага с потерей токенов `PlayerDataSync`
после Worker handoff.

Зависит от этапа 0 (размеры/интервалы) и этапа 4 (отсоединённые участники и
RESUME — восстановленные люди поднимаются отсоединёнными и ждут
возобновления).

## 5.1. Сначала баг (тест → фикс)

`HostGame._restoreFromHandoff` (`host/HostGame.js:793-847`) не передаёт
токены: `restoreHuman` (`meta/player/ParticipantManager.js:97-137`) без
токена, `PlayerDataSync.load` не вызывается → после смены кода в открытой
комнате rank/state не пишутся до конца сессии. Плюс `initiateNewRound` по
таймеру не делает `flushAll` перед handoff — накопленные очки теряются при
`terminate()` старого Worker'а.

1. Тест в `tests/host/` (fixture-harness `tests/host/fixtureHarness.js`):
   handoff → restore → `addPoints` → flush содержит запись игрока. Красный.
2. Фикс: in-tab handoff (тот же процесс браузера, postMessage) может нести
   токены — поле `localTokens: { [gameId]: token }` **только** в
   boundary-handoff внутри вкладки (никогда в сетевых контрольных точках
   5.3); restore вызывает `PlayerDataSync.load`. Перед `handoff_state`
   старый Worker делает `PlayerDataSync.flushAll()` (и дожидается
   `inFlight`, с таймаутом).

## 5.2. Ядро через адаптер

`host/GameCoreAdapter.js`: `serializeState() → Uint8Array` и
`deserializeState(bytes)` — обёртки над `core.serialize_state()`/
`core.deserialize_state(bytes)` (ABI заморожен, экспорты уже есть,
`core/src/abi.rs:314-325`). Вызывать **только** на границе кадра — сразу
после `pack_body` в `HostGame._onShotTick` (аккумуляторы снапшота
опустошены, предусловие `core/src/game.rs:473-475`). Ошибка ядра →
исключение с понятным текстом (контрольная точка пропускается, матч
продолжается).

## 5.3. Формат контрольной точки (`HANDOFF_VERSION = 4`)

Изоморфный кодек `packages/engine/src/lib/checkpointCodec.js`:

- контейнер: `[u32 metaLen LE][meta JSON utf-8][core bytes]`, весь буфер
  сжат `CompressionStream('gzip')` (есть в Worker и в Node ≥ 18 — сверить с
  `engines` в `package.json`); `encode(meta, coreBytes) → Promise<Uint8Array>`,
  `decode(bytes) → Promise<{meta, core}>`; лимит распакованного размера
  (`maxCheckpointBytes`, по данным этапа 0, напр. 8 МБ) — защита от
  «zip-бомбы» от чужого хоста.
- мета v4 (все поля JSON-сериализуемы, **без токенов и секретов**):

```js
{
  version: 4, kind: 'checkpoint' | 'boundary', mode: 'midRound' | 'soft',
  gameId, gameVersion, engineVersion, createdAt, checkpointId, seq,
  room: { roomId, epoch, settings /* настройки комнаты для одинакового
          конфига ядра: карта, maxPlayers, таймеры, friendly fire — всё, что
          читает applyRoomOverrides */, game: { id, version } },
  map: { name, data /* JSON карты как в каталоге, если влезает (этап 0) */,
         mapsVersion, override /* overrideMapData (snakes ArenaScaler) */ },
  timers: { mapTimeLeft, roundTimeLeft, teamChangeGraceLeft,
            pending: [{ kind: 'roundRestart', leftMs }, { kind: 'mapChange',
            leftMs, targetMap }], voteCooldowns: [{ name, leftMs }] },
  round: { isRoundEnding, wipedTeamIds, removedPlayers, startMapNumber },
  participants: {
    humans: [{ gameId, name, model, team, teamId, status, isWatching,
               watchedGameId, respawnIndex, lastInputSeq, chatColor,
               resumeKey, isHostPlayer }],
    scripted: [{ gameId, name, model, team, teamId }],
    teamSizes, activePlayers },
  stat: { head, body }, panel: { [gameId]: values },
  playerData: { [gameId]: { ratings, currentGamePoints, pendingPoints,
                pendingBest, state, lastSyncedState, writeSeq } },
  plugin: { [moduleName]: <то, что вернул module.serializeState()> },
}
```

`mode: 'midRound'` — только если игра включила
`gameConfig.migration.midRound` (5.5) **и** дамп ядра снялся; иначе
`'soft'` (ядро не прикладывается, восстановление = нынешний handoff:
раунд начинается заново).

Что сознательно **не** переносится и почему (записать в доки): активные
голосования (их `resultFunc` — замыкания; клиенты закрывают окно
голосования при возобновлении), история чата (живёт у клиентов), RTT
(перемеряется), `lastActionTime` (сбрасывается на «сейчас»).

## 5.4. Сериализация мета-модулей

Каждый модуль получает пару `serialize()`/`restore(state)` (модули —
синглтоны уровня модуля, см. `TimerManager.js:4-16`; восстановление в той
же области видимости требует их `reset*`-экспортов — использовать их):

- `meta/modules/TimerManager.js` — остатки по дедлайнам (`Date.now()`):
  карта (`getMapTimeLeft` `:81-86`), раунд (сейчас `getRoundTimeLeft`
  отдаёт целые секунды `:109-113` — нужен остаток в мс), грейс смены
  команды (`:116-120`), `roundRestartDelay` (`:201-207`), отложенная смена
  карты (`startMapChangeDelay(cb)` `:215` держит целевую карту в замыкании →
  сделать декларативной: хранить `targetMap`, колбэк строить при
  restore), кулдауны `voteBlock:*` (`:163-198`). Активные `vote:*` —
  не переносятся.
- `meta/core/RoundManager.js` — флаги `:73-84`, текущая/override карта
  (`:244-249`); restore **без** `createMap`/`load_map` (карта уже внутри
  дампа ядра) — только JS-сторона (`_currentMapData`, `_scaledMapData` из
  `map.data`); проверить, что `restoreMap` (`:134-138`) не пересоздаёт
  ботов в ядре через `scripted.createMap` при `mode: 'midRound'`.
- `meta/player/ParticipantManager.js` + `HumanParticipant.js:17-29`,
  `Participant.js:10-20` — поля из 5.3; люди восстанавливаются
  **отсоединёнными** (этап 4: `detachedAt = now`, слот занят, ждут
  RESUME); `isHostPlayer` — тот, кто был `'local'` у старого хоста.
- `meta/modules/Panel.js:17-23`, `Stat.js:217-219` (уже есть),
  `Vote.js` (только кулдауны), `PlayerDataSync.js:43-118` (без `token`,
  `inFlight` → в `pending`; `writeSeq` — монотонный счётчик записей
  участника, понадобится этапу 7 для идемпотентности).
- `HostGame` — `_seq` (`:255`), `SnapshotThrottle._tick`.

## 5.5. Контракт плагина (append-only)

- `gameConfig.migration = { midRound: false }` — новое необязательное поле;
  дефолт и валидация — в `lib/gameConfigView.js` (единственная точка
  чтения конфига игры). `true` — игра гарантирует, что
  `GameSim::serialize/deserialize` переносят всё её состояние в ядре, а
  JS-модули, если держат состояние, реализуют хуки ниже.
- Модули из `HostPlugin.createModules(ctx)` могут реализовать
  необязательные `serializeState() → JSON` и `restoreState(state)`; движок
  вызывает их при снятии/восстановлении точки (ключ — имя модуля в
  объекте `createModules`). Нет метода — модулю ничего не переносится.
- `lib/capabilities.js` — запись `{ value: 'host.migration', since: '<следующая minor>' }`
  с комментарием (игре писать её в `requires` не нужно: на старом движке
  флаг просто игнорируется).
- `npm run surface:update` — проверить, что в `contract/surface.json`
  только добавились строки. Правила контракта `vimp-contract`
  (`src/devtools/contract/rules/`) — при необходимости новое правило:
  «`migration.midRound: true`, а у модуля с полями-состоянием нет
  `serializeState`» — **не делать**, если это нельзя проверить
  статически надёжно (не плодить ложные срабатывания).

## 5.6. Сообщения главный поток ↔ Worker

В `host/host.worker.js` (старые сообщения не трогать):

- `checkpoint_start { intervalMs }` / `checkpoint_stop` — периодические
  точки: флаг «точка нужна», исполняется в конце ближайшего `_onShotTick`;
- `checkpoint_request { final }` — одна точка сейчас (на ближайшей границе
  кадра);
- Worker → `checkpoint { checkpointId, seq, createdAt, final, mode, bytes }`
  — `bytes` (сжатый результат `checkpointCodec.encode`) передаётся
  **только** списком переноса: `self.postMessage(msg, [bytes.buffer])`,
  без копии и без лишней работы GC 2 раза/с (так же уже уходят бинарные
  кадры `to_client`). Убедиться, что `bytes` — это собственный буфер, а
  не view на память wasm (`serialize_state` через wasm-bindgen возвращает
  копию `Vec<u8>` в JS-куче — эта одна копия неизбежна; после сжатия буфер
  новый). Тот же приём — в обратную сторону для `init { checkpoint }`;
- `init { room, checkpoint, seqFloor }` — восстановление из точки (рядом с
  нынешним `init { room, handoff }`): матч поднимается **на паузе**
  (таймеры и цикл стоят), `seq = max(meta.seq, seqFloor) + 30` (клиенты
  видели кадры новее точки — номер должен уйти вперёд, иначе
  интерполятор отбросит кадры как старые);
- `start_after_restore` — запустить цикл и таймеры (этап 7 зовёт его, когда
  все люди возобновились или истёк `resumeWaitMs`);
- `freeze` / `unfreeze` — остановить/продолжить цикл и таймеры (этап 8:
  финальная точка при плановой передаче, откат при сбое).
- Новый Worker принимает `handoff` и **v3**, и **v4** (README →
  инварианты).

`HostController` (`client/network/HostController.js`) получает методы-обёртки:
`startCheckpoints(ms)`, `stopCheckpoints()`, `requestCheckpoint({final})`,
`onCheckpoint(cb)`, `freeze()`, `unfreeze()`, `startAfterRestore()`;
конструктор принимает `{ checkpoint, seqFloor }` вместо `handoff`.

## 5.7. Headless-проверка для игр (devtools)

Шаг сценария `vimp-sim` `{ "checkpointRestore": true }` (или флаг
`--checkpoint-every <ms>`): в заданный момент раннер снимает точку,
поднимает **новый** runtime из неё (`createHostRuntime` с `checkpoint`),
переподключает виртуальных клиентов через RESUME и продолжает сценарий;
все 12 инвариантов (`src/devtools/invariants.js`) должны остаться
зелёными. Это главный инструмент автора игры проверить свой `serialize`.
Файлы: `src/devtools/ScenarioRunner.js`, `VirtualClient.js` (RESUME),
`bin/vimp-sim.js`; доки — `docs/{en,ru}/debugging.md`,
`docs/ai/13-debugging.md`.

## 5.8. Тесты

- `tests/lib/checkpointCodec.test.js` — round-trip, лимит размера, битый
  буфер.
- `tests/host/HostGame.checkpoint.test.js` — на фейковом ядре (добавить
  `serialize_state`/`deserialize_state` в фейк fixture-harness):
  точка снимается только на границе кадра; restore → таймеры с остатками,
  флаги раунда, участники отсоединены, панель/счёт/кулдауны на месте,
  `seq` ≥ `seqFloor + 30`, цикл стоит до `start_after_restore`;
  `mode: 'soft'` для игры без opt-in; v3 по-прежнему принимается.
- Тесты модулей: `TimerManager`, `RoundManager`, `ParticipantManager`,
  `Panel`, `Vote`, `PlayerDataSync` — `serialize`/`restore`.
- `tests/devtools/ScenarioRunner.test.js` — шаг `checkpointRestore`.
- `tests/lib/gameConfigView.test.js` — дефолт `migration`.
- e2e с реальным ядром: `npm run sim -- --game <tanks> --checkpoint-every
5000` и то же для snakes — инварианты зелёные.

## 5.9. Репозитории игр (отдельные репо, отдельные изменения разработчика)

После выхода движковой части (локально — через `npm link`, см.
`docs/en/getting-started.md`):

- `../vimp-tanks`: `gameConfig.migration = { midRound: true }`; проверить
  JS-модули хоста (`src/host/`) на состояние в памяти; прогнать
  `npm run sim` с `checkpointRestore`; доки игры
  (`docs/{en,ru}/architecture.md` — раздел о миграции); CHANGELOG игры.
- `../vimp-snakes`: то же + `serializeState`/`restoreState` у модулей с
  состоянием (`ArenaScaler`: `_population/_size/_delivered`; `StatBridge`:
  `_totals`); проверить, что override карты (ArenaScaler) переносится через
  `map.override`.
- `packages/create-vimp-game/templates/default/`: включить
  `migration.midRound: true` в шаблонном `gameConfig` (у шаблона есть
  `serialize` в `core/src/game.rs:532`), добавить шаг `checkpointRestore` в
  шаблонный сценарий; `packages/create-vimp-game/CHANGELOG.md` →
  `### Added`; `npm run test:scaffold`.

## 5.10. Документация

`docs/{en,ru}/host.md` — новый раздел «Checkpoints» (формат v4, что
переносится/нет, `mode`, сообщения Worker'а), «Worker handoff» (v3/v4,
`localTokens`, flush перед handoff); `plugin-api.md` — `gameConfig.migration`,
хуки модулей, capability; `core.md` — `serialize_state` теперь используется
(было «for future use»); `docs/ai/03-host-plugin.md` (раздел «Handoff»
переписать: «Not carried: physics world» больше неверно при opt-in),
`docs/ai/05-wasm-core.md:484`, `docs/ai/10-pitfalls.md:296` (новый пункт:
«`migration.midRound: true` — всё состояние должно быть в
`serialize`/`serializeState`; проверка — `checkpointRestore`»),
`docs/ai/12-questionnaire.md` (вопрос «переживать ли смену хоста
посреди раунда?» + строка в таблице соответствия).

## 5.11. CHANGELOG

`packages/engine/CHANGELOG.md`: `### Added` — host checkpoints
(`HANDOFF_VERSION` 4), `gameConfig.migration.midRound`, module hooks
`serializeState`/`restoreState`, capability `host.migration`, sim step
`checkpointRestore`; `### Fixed` — rank/state writes lost after a Worker
handoff (tokens), unflushed points lost at handoff.

## Готово, когда

Автотесты и `npm run sim` с точками по обеим играм зелёные;
`contract/surface.json` только дополнен; доки en/ru/ai синхронны;
CHANGELOG'и обновлены; в отчёте — release impact (npm `vimp-engine` minor;
`create-vimp-game` minor; игры — opt-in по желанию, без него мягкий режим).
