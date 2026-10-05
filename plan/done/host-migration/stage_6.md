# Этап 6. Преемник: назначение мастером, канал `standby`, поток контрольных точек, прогрев Worker'а ✅ выполнен

Цель: в каждой комнате с ≥ 2 людьми у хоста есть назначенный мастером
**преемник (бета)**, который постоянно держит свежую контрольную точку
(≤ `checkpointIntervalMs` давности) и заранее прогретый Worker (плагин
загружен, wasm скомпилирован). Сама передача — этапы 7 и 8.

Зависит от этапов 2 (участники на мастере) и 5 (контрольные точки).

## 6.1. Возможности участника (`caps`)

Клиент (`client/main.js`, модуль-хелпер `client/lib/hostCaps.js`):

```js
caps = {
  canHost: supportsModuleWorker() && hasWebRtc && typeof WebAssembly === 'object' && !isMobile,
  mobile: isMobile, // navigator.userAgentData?.mobile ?? matchMedia('(pointer: coarse)').matches
  hidden: document.hidden,
  // тип своего локального ICE-кандидата в выбранной паре с текущим хостом:
  // 'host' | 'srflx' | 'prflx' | 'relay' | null (ещё не известно / сам хост)
  iceType,
};
```

`supportsModuleWorker`/проверка WebRTC уже есть в `main.js`
(`connectAsHost` `:1578+`, `ensureWebRtcAvailable` `:1543`) — вынести и
переиспользовать. `caps` уходят в `join_room` (этап 2) и в новое
`member_update {roomId, caps}` при `visibilitychange` и при смене
`iceType`. Хост тоже шлёт свои `caps` (в `register_host`).

**`iceType` — P2P-связность кандидата.** Игрок с отличным RTT до мастера
может сидеть за симметричным NAT: до старого хоста он дотянулся (через
TURN), но стань он хостом — часть игроков не пробьёт к нему P2P, а TURN в
проекте необязателен (`master.md` → `iceServers`). Как получить:
`WebRtcManager` после открытия каналов (и раз в 30 с) читает
`pc.getStats()` → `transport.selectedCandidatePairId` (или пара с
`nominated && state === 'succeeded'`) → `local-candidate.candidateType`.
`relay` значит, что этому игроку для связи нужен ретранслятор.
Точное определение типа NAT (две STUN-пробы) — не делаем: тип
выбранного кандидата — дешёвая и достаточная эвристика.

## 6.2. Мастер: RTT участников

`SignalingServer`: каждой сессии раз в `master.room.rttProbeIntervalMs`
(5000) — `ws.ping()`, на `pong` — RTT; EMA (`α = 0.2`) и EMA джиттера
(`|rtt − ema|`). Сессия без `pong` дольше `wsDeadAfterMs` (12000) →
`terminate()` (это заодно ускоряет обнаружение «тихо умершего» хоста,
которое сейчас занимает до 30 с heartbeat). `score(session) = rttEma + 2 ×
jitterEma` — единая линейка «насколько хорошо этот участник подключён к
сети», одинаковая для хоста и кандидатов (нужна и этапу 9).

## 6.3. Мастер: выбор преемника

Чистая функция `master/successor.js` → `pickSuccessor(room, now, opts)`:

- кандидаты — участники, кроме хоста: живая сессия, `caps.canHost`,
  `!caps.hidden`, в комнате ≥ `minMemberAgeMs` (10000), не `demotedUntil >
now` (этап 10);
- порядок — сначала **ярус связности**: `iceType` ∈ {`host`, `srflx`,
  `prflx`} лучше, чем неизвестный (`null`), который лучше, чем `relay`;
  внутри яруса — `score` по возрастанию, при равенстве — раньше вошедший.
  Кандидат с `relay` становится бетой, только если других нет (в аварии
  комната важнее, чем идеальная связность);
- после промоушена (этап 7) мастер следит, сколько гостей не смогли
  возобновиться к новому хосту (`host_unreachable` с новой эпохой в
  первые 15 с): если это ≥ половины гостей — новому хосту ставится
  `iceType: 'relay'`-штраф до конца его членства в комнате (его не
  выберут снова), а сама ситуация обрабатывается обычной логикой 7.3;
- **гистерезис**: текущего преемника меняем, только если он перестал быть
  кандидатом **или** лучший кандидат держит `score ≤ 0.65 × score(текущего)`
  дольше `successorSwitchSustainMs` (30000) — частая смена беты стоит
  повторного прогрева и трафика.

Пересчёт: на join/leave/detach/`member_update` и по таймеру
`successorReviewMs` (15000). Мастер хранит `room.successorMemberId`.
Сообщения:

- хосту: `successor_assigned {roomId, epoch, successorMemberId}` (или
  `successorMemberId: null` — некого);
- новой бете: `standby_assigned {roomId, epoch}`; прежней —
  `standby_released {roomId}`;
- бета, получив первую полную точку, сообщает `standby_status {roomId,
epoch, checkpointId, createdAt}` (и далее раз в 5 с) — мастер знает, есть
  ли у беты точка и насколько свежая (этап 7 выбирает режим `checkpoint`
  или `cold` по этому).

## 6.4. Хост: канал `standby` и отправка точек

Новый модуль `client/network/StandbySender.js`:

- на `successor_assigned` находит пира по `memberId` в
  `HostConnectionManager` (с этапа 2 он хранит `memberId` пира из оффера) и
  открывает `pc.createDataChannel('standby', { ordered: true })` —
  ре-согласование SDP не нужно, SCTP-ассоциация уже есть (каналы `meta`/
  `state`); старый канал прежней беты закрывает;
- `HostController.startCheckpoints(checkpointIntervalMs)` (этап 5) пока
  бета есть, `stopCheckpoints()` — когда нет;
- на `checkpoint` — нарезка на куски ≤ `standbyChunkBytes` (этап 0,
  ~64 КБ); кусок = 24-байтный заголовок `{u32 checkpointId, u32 index,
u32 count, u32 totalBytes, u32 seq, u8 final, …}` + данные;
- **backpressure**: если `channel.bufferedAmount > standbyHighWaterBytes`
  — очередная периодическая точка пропускается (в канале никогда нет
  больше одной недоотправленной точки); `final` точки (этап 8) ждут
  `bufferedamountlow`, а не пропускаются;
- метрики в `diagnostics` (размер, время, пропуски) — для настройки.

## 6.5. Бета: приём и прогрев

- `client/network/WebRtcManager.js` — `pc.ondatachannel` с меткой
  `standby` → `StandbyReceiver` (новый модуль): собирает куски по
  `checkpointId` (незавершённую точку выбрасывает, когда пришла более
  новая), хранит **последнюю полную** `{bytes, checkpointId, seq,
createdAt, final}`; API `latest()`, `waitForFinal(minCheckpointId,
timeoutMs)`, событие `checkpoint`. Также запоминает `lastSeenSeq` своего
  интерполятора (для `seqFloor`, этап 5) — взять из `clientCore` или
  считать в `handleMessage`.
- **Прогрев** (`client/network/HostPrewarm.js`): после первой полной точки
  (в ней `room.settings`/`room.game`) — повторить подготовительные шаги
  `connectAsHost` (`main.js:1578-1640`: `fetchMasterMaps`,
  `fetchWorkerManifest`, манифест игры → `room.game`) — **вынести их из
  `connectAsHost` в переиспользуемую функцию** `prepareHostRoom(settings,
gameRef)` — и создать `HostController` в режиме ожидания: Worker получает
  новое сообщение `preload { room }` — импортирует `HostPlugin`, собирает
  view конфига, компилирует wasm (`createCore` можно отложить, если он
  требует карту — тогда только `WebAssembly.compileStreaming`), матч **не**
  создаёт. Игра комнаты должна совпасть с версией из точки
  (`/games/<id>/<version>/…`, версионированные URL мастера).
- `standby_released`, уход из комнаты, смена эпохи → прогретый Worker
  `terminate()`, точки выбросить.

## 6.6. Конфиг

`config/lobby.js` (`lobbyConfig.migration.*`): `checkpointIntervalMs`,
`standbyChunkBytes`, `standbyHighWaterBytes` (значения из этапа 0).
`config/master.js` (`master.room.*`): `rttProbeIntervalMs`, `wsDeadAfterMs`,
`minMemberAgeMs`, `successorReviewMs`, `successorSwitchSustainMs`,
`successorSwitchRatio` (0.65). Описать в `docs/{en,ru}/configuration.md`.

## 6.7. Тесты

- `tests/master/successor.test.js` — табличные кейсы выбора, фильтры,
  ярусы `iceType` (`relay` с лучшим RTT проигрывает `srflx` с худшим;
  только `relay` — всё равно выбирается), штраф после неудачного
  промоушена, гистерезис на фейковых часах.
- `tests/master/SignalingServer.test.js` — `ping/pong` EMA (фейковый ws с
  `ping`), `member_update`, сообщения назначения/снятия, `standby_status`,
  `terminate` мёртвой сессии.
- `tests/client/network/StandbySender.test.js` /
  `StandbyReceiver.test.js` — нарезка/сборка, пропуск при backpressure,
  выброс устаревшей незавершённой точки, `waitForFinal`.
- `tests/client/network/HostController.test.js` — режим `preload`.
- `tests/client/lib/hostCaps.test.js`; `tests/client/network/WebRtcManager.test.js`
  — извлечение `iceType` из фейкового `getStats()` (оба способа найти
  выбранную пару, отсутствие пары → `null`).

## 6.8. Документация

`docs/{en,ru}/master.md` — RTT участников, выбор преемника, сообщения;
`host.md` — «Standby successor» (канал, точки, backpressure); `client.md` —
`StandbyReceiver`, прогрев; `network.md` — третий DataChannel `standby`
(таблица каналов, его не бывает у обычного гостя).

## 6.9. CHANGELOG

`### Added`: standby successor — the master designates a successor per
room, the host streams checkpoints to it over a `standby` data channel and
the successor pre-warms a Worker.

## Проверка

Автотесты зелёные. Вручную (3 профиля): у хоста в консоли метрики точек
(размер, интервал), у беты — счётчик принятых точек; бета прячет вкладку →
мастер переназначает преемника на третьего игрока; во вкладке беты в
DevTools виден второй Worker (прогретый).

## Готово, когда

Проверки зелёные, доки en/ru синхронны, CHANGELOG обновлён, release impact
в отчёте.
