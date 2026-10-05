# Этап 4. Клиент: супервизор сессии + протокол RESUME (переподключение к тому же хосту) ✅ выполнен

Цель: клиент перестаёт умирать при обрыве транспорта. Сессия (рендер, MVC,
`clientCore`, карта, свой `gameId`) живёт дольше конкретного транспорта: при
потере соединения клиент переподключается к **текущему хосту комнаты**
(мастер сам маршрутизирует оффер по `roomId`) и **возобновляет** своё место
в матче без повторного рукопожатия. На этом этапе это лечит сетевые
провалы до того же хоста; этап 7 использует ровно тот же путь при смене
хоста.

Зависит от этапа 2 (`roomId`, `memberId`, маршрутизация офферов по комнате).

## 4.1. Сетевые примитивы

- `packages/engine/src/lib/Publisher.js` — добавить `off(event, handler)`
  (сейчас отписки нет) + тест `tests/lib/Publisher.test.js`.
- `client/network/WebRtcManager.js`:
  - подписка на `signaling.publisher` (`:36-37`) — запоминать хендлеры,
    `destroy()` отписывает их и закрывает `pc` без эмита `close`;
  - фильтр входящих `webrtc_answer`/`ice_candidate` по своему `roomId` и
    `epoch` (из ответа мастера) — старый менеджер не должен съесть
    сообщения нового;
  - таймаут установления: каналы не открылись за
    `lobbyConfig.webrtc.connectTimeoutMs` (10000) → `close('connectTimeout')`;
  - в оффер — `resume: true`, когда это переподключение.
- `client/network/HostConnectionManager.js`: `webrtc_offer` с `resume: true`
  → `HostController.open(socketId, { resume: true })` → Worker
  `connect { socketId, resume: true }`.

## 4.2. Порты (append-only, `config/wsports.js`)

Сверить, что номера свободны (на 2026-10-01: server до 18, client до 8):

- server `SESSION_DATA: 19` — `{ resumeKey }`, хост шлёт участнику после
  успешного входа в игру (после `FIRST_SHOT_READY`) и после каждого
  успешного RESUME (ключ можно ротировать);
- server `RESUME_RESULT: 20` — `{ ok: true, gameId, epoch } | { ok: false,
reason: 'unknown' | 'expired' | 'auth' | 'version' }`;
- client `RESUME_REQUEST: 9` — `{ v: 1, gameId, resumeKey, token }`;
- client `LEAVE: 10` — без данных: игрок уходит сам, хост удаляет его
  сразу, без grace (используется кнопкой «Leave server» этапа 8 и в
  `pagehide` гостя).

`npm run surface:update` — раздел `ports` поверхности только дополняется.
Обработчики на клиенте — через `socketMethods` (`dispatchSocketMessage`
логирует неизвестный порт и не падает — старые клиенты не сломаются).

## 4.3. Хост: отсоединённые участники и RESUME

Сейчас `PortMachine.disconnect` (`host/PortMachine.js:172-187`) сразу
`host.removeUser`. Новое поведение (только когда у хоста включён resume —
опция `resumeGraceMs > 0`, дефолт из `config/hostDefaults.js`, в лобби
20000; в dedicated/standalone — 0, поведение как сейчас):

1. **Detach.** Сокет участника в игровом состоянии закрылся без `LEAVE` →
   `host.detachUser(gameId)`: участник остаётся (слот занят, `isFull`
   считает его), его актор остаётся в мире, **все клавиши отпускаются**
   (для каждой команды из keyset игры — `applyInput(gameId, seq, 'up',
name)`; найти, откуда `HostGame` знает список команд — `KEYSET_DATA`/
   `gameConfig`), участник снимается с RTT- и idle-киков
   (`RTTManager`, `HostGame.js:477`), помечается `detachedAt`. Через
   `resumeGraceMs` без возобновления → обычный `removeUser`.
2. **`LEAVE`** (клиентский порт 10) → немедленный `removeUser` и закрытие.
3. **Resume-подключение.** `connect(socketId, { resume: true })` —
   `PortMachine` **не** шлёт `CONFIG_DATA`; разрешён только порт
   `RESUME_REQUEST`; таймер `resumeRequestTimeoutMs` (5000) → закрыть.
4. **`RESUME_REQUEST`**: (а) `v` поддерживается, иначе `version`;
   (б) участник `gameId` существует и отсоединён (или ещё подключён старым
   сокетом — тогда старый сокет закрыть: «перехват» сессии после
   полуоткрытого соединения), иначе `unknown`; (в) `resumeKey` совпадает
   (сравнение постоянного времени), иначе `unknown`; (г) токен проверяется
   стратегией идентичности (`host/identity.js`, `resolve` → ник), ник ==
   `participant.name`, иначе `auth`; (д) успех → привязать новый `socketId`
   к `gameId` (как `PortMachine.restore`, `:120-141`, плюс порты 9/10),
   снять `detachedAt`, вернуть в RTT/idle, `PlayerDataSync` получает свежий
   токен (метод `attachToken(gameId, token)`), ответ `RESUME_RESULT {ok}`,
   затем **полный пакет входа в игру** тому же сокету: `CLEAR`, полный кадр
   (тот же путь, что `host.mapReady` → `FIRST_SHOT_DATA`, без смены карты),
   полные `STAT`/`PANEL`/`KEYSET`/`ACCOLADES` (как при первом входе —
   найти в `HostGame` код отправки при `firstShotReady`), новый
   `SESSION_DATA`.
5. `resumeKey` — 128 бит из `crypto.getRandomValues`, hex; хранится в
   `HumanParticipant` (`host/meta/player/`), выдаётся при
   `firstShotReady`. Ключ не логировать.

## 4.4. Клиент: супервизор сессии

Новый модуль `client/network/SessionSupervisor.js` (без DOM, тестируемый):

- Держит текущий транспорт (`attach(transport)`/`detach()`), один раз
  подписанный снаружи на `message` (проброс) — `main.js` больше не
  подписывается на конкретный транспорт.
- Состояния: `connecting` → `handshake` → `inGame` → (`reconnecting` |
  `migrating` — этап 7) → `inGame` | `closed`.
- `close` транспорта:
  - терминально (`closed` → нынешний `handleDisconnect`): политика-close
    (`policyClose.js`, коды из `TECH_INFORM_DATA`), пользователь ушёл сам,
    режимы `solo`/`dedicated`, состояние ещё не `inGame`, нет `resumeKey`;
  - иначе → `reconnecting`: оверлей «Reconnecting…», клавиши выключены,
    новый `WebRtcManager` к `roomId` с `resume: true`, после открытия
    каналов — `RESUME_REQUEST {gameId, resumeKey, token}`; повторы с
    backoff в пределах `lobbyConfig.session.reconnectWindowMs` (15000) →
    затем терминально.
- `RESUME_RESULT ok` → `clientCore.reset()` (этот же вызов делает
  обработчик `CLEAR`, `main.js:930`), дальше приходят `CLEAR` и полный кадр;
  состояние `inGame`, оверлей скрыт, клавиши включены,
  `controls.resendHeld()` (новый метод `components/model/Controls.js`: для
  каждой клавиши из `_pressedKeys` снова эмитит `down:<name>` — хост их
  отпустил при detach). Голосование, открытое у клиента, закрыть
  (`voteModel.complete()`): активные голоса хоста через переподключение не
  переживают.
- **Предсказание после возобновления — сброс, а не переигрывание.**
  Хост (тот же после провала, новый — после аварийной миграции этапа 7
  с откатом к точке) **никогда не получит** вводы, отправленные в
  оборванный транспорт: клиент слал `seq` 105–107, а в восстановленном
  состоянии `lastInputSeq` игрока, например, 95. Переигрывать локальную
  историю от 95 нельзя — предсказание уедет туда, куда сервер не придёт, и
  будет резкая коррекция. Правильно: `clientCore.reset()` очищает историю
  ввода предиктора и его «водяной знак» подтверждений, клиент продолжает
  нумерацию с текущего `inputSeq` (108, 109, …), а актуальное состояние
  клавиш передаёт `resendHeld()`. Проверить по `core/src/client/` (Rust,
  `Predictor`), что `reset()` действительно чистит историю и
  последний подтверждённый `seq`, и что предиктор не отбрасывает кадры, в
  которых подтверждённый `seq` (95) меньше уже виденного до обрыва; если
  нет — исправить в движке (без изменения ABI: поведение внутри
  существующего `reset()`; это изменение крейта → его CHANGELOG
  `### Fixed`, `npm run core:test`). Тест — в 4.6.
- Звук на время `reconnecting`/`migrating` глушится тем же путём, что при
  скрытой вкладке (`main.js:1273-1312`), после возобновления — включается
  (зацикленные звуки не должны гудеть на одной ноте всю паузу).
- `RESUME_RESULT !ok` → `reloadTo(formatRoomLink(gameId, roomId))` (этап 3):
  чистый вход в ту же комнату с полным рукопожатием.
- **Сторожок тишины**: в `inGame`, вне загрузки карты (между `MAP_DATA` и
  `FIRST_SHOT`), нет ни одного сообщения от хоста
  `lobbyConfig.session.hostSilenceMs` (3000; кадры идут ~30/с, `PING`
  раз в 3 с) → считать транспорт мёртвым (закрыть → `reconnecting`). Этап 7
  добавит сюда отчёт мастеру.
- `PS_FIRST_SHOT_DATA` в режиме возобновления: применить кадр, но не
  запускать повторно разовую инициализацию (найти в `main.js:752+`, что
  именно делает `runAutostart` и отправка `FIRST_SHOT_READY`; при
  `supervisor.resuming` — не слать `FIRST_SHOT_READY` и не звать
  автостарт).
- Повторный `CONFIG_DATA`/`AUTH_RESULT` в живой сессии — ошибка протокола:
  залогировать через `diagnostics` и `reloadTo(ссылка на комнату)`, но не
  строить второй `clientCore`/`Application` (сейчас это молча ломает
  страницу).
- Оверлей: элемент `#session-overlay` (`views/index.pug` + `style.css`,
  z-index по таблице «UI hierarchy»), тексты «Reconnecting…»,
  «Switching host…» (этап 7).

## 4.5. Рефакторинг `client/main.js`

- `let transport` (`:279`) → `supervisor`; `sending()` (`:1216`) →
  `supervisor.send(...)`; `connectToHost`/`connectAsHost`/`connectSolo`/
  `connectDedicated` отдают транспорт супервизору.
- `handleDisconnect` (`:1441-1504`) вызывается только из терминального
  `closed`. Перезагрузка — через `reloadTo` (этап 3).
- `resumeKey` хранится в памяти супервизора (обработчик `SESSION_DATA`).
- Хост-вкладка: её собственный клиент сидит на `LoopbackTransport`
  (`'local'`), он не рвётся; супервизор для него — сквозной.

## 4.6. Тесты

- Предиктор после `reset()`: cargo-тест в
  `packages/engine/core/src/client/` (рядом с существующими тестами
  предиктора; `npm run core:test`) — история предсказания была до
  `seq` 107, после `reset()` приходит кадр с подтверждённым `seq` 95 →
  кадр принят, переигрывания старых вводов нет, новые вводы с `seq` 108+
  предсказываются нормально.
- `tests/client/network/SessionSupervisor.test.js` — фейковые транспорты и
  сигналинг: терминальные/нетерминальные закрытия, переподключение с
  `resume`, `RESUME_RESULT` ok/!ok (мок `reloadTo`), сторожок тишины
  (фейковые часы), окно переподключения, игнор сообщений старого
  транспорта.
- `tests/client/network/WebRtcManager.test.js` — `destroy`, фильтр
  `roomId`/`epoch`, таймаут установления.
- `tests/host/portMachine.test.js` — resume-путь целиком (все ветки 4.3.4),
  таймаут `RESUME_REQUEST`, `LEAVE`, detach → grace → remove, «перехват»
  полуоткрытой сессии.
- `tests/host/HostGame.fixture.test.js` (или новый
  `HostGame.resume.test.js`) — detach отпускает клавиши, снимает с киков,
  слот занят; resume шлёт пакет входа.
- `tests/client/ControlsModel.test.js` — `resendHeld`.
- `tests/host/PlayerDataSync.test.js` — `attachToken`.

## 4.7. Документация

`docs/{en,ru}/network.md` — «Connection lifecycle» (detach/grace, RESUME,
LEAVE, новые порты в таблицах портов), `client.md` — супервизор, оверлей,
сторожок, `host.md` — PortMachine resume, detach, `configuration.md` —
`resumeGraceMs`, `resumeRequestTimeoutMs`, `webrtc.connectTimeoutMs`,
`session.reconnectWindowMs`, `session.hostSilenceMs`. `plugin-api.md` и
`docs/ai/06-snapshot-protocol.md` — список портов (новые номера).

## 4.8. CHANGELOG

`### Added`: session resume — a dropped WebRTC connection reconnects to the
room and resumes the player's place (ports `SESSION_DATA` 19,
`RESUME_RESULT` 20, `RESUME_REQUEST` 9, `LEAVE` 10; a disconnected player is
kept for `resumeGraceMs`). `### Changed`: a lost connection no longer
reloads the page immediately.

## Проверка

Автотесты зелёные. Вручную (два профиля): у гостя в DevTools → Network
отключить сеть на 5 с и включить — оверлей «Reconnecting…», затем игра
продолжается тем же танком (счёт, команда, позиция на месте); то же на 30
с — после `resumeGraceMs` участник удалён, гость перезаходит через ссылку
и проходит рукопожатие заново.

## Готово, когда

Проверки зелёные, доки en/ru синхронны, CHANGELOG обновлён, release impact
в отчёте.

## Итог исполнения (2026-10-02)

Уточнения относительно текста этапа:

- `SESSION_DATA` несёт `{ resumeKey, gameId }`: `RESUME_REQUEST` требует
  `gameId`, а наблюдатель свой id больше ниоткуда не узнаёт.
- Причины отказа — `unknown` | `auth` | `version`; отдельного `expired` нет
  (истёкшее место снято и неотличимо от неизвестного).
- Ник сверяется с `identityName` участника (ник стратегии до разведения
  дублей `#2`), а не с `participant.name`.
- `Controls.resendHeld()` берёт физически зажатые клавиши: смена набора в
  пакете входа сбрасывает `_pressedKeys`; вызывается по `SESSION_DATA`
  (последнее сообщение пакета).
- Фикс крейта не понадобился: движок не фильтрует кадры по `input_seq`,
  история ввода — у игры и чистится `reset()`; добавлен только cargo-тест.
- Бэкофф попыток: `session.reconnectBaseDelayMs`/`reconnectMaxDelayMs`
  (500…4000 мс). Указатель (`aim`) при detach не отпускается.
- `LEAVE` реализован на хосте; клиент начнёт слать его в этапе 8.
- `plugin-api.md` портов не перечисляет — не менялся.
- Ручная проверка (два профиля, отключение сети на 5 и 30 с) не
  выполнялась — за разработчиком.
