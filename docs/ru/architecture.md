# Архитектура

VIMP — **P2P**-движок для многопользовательских 2D-игр реального времени.
**Хост авторитетен**: вся физика (Rapier 2D в Rust-ядре, WASM) и правила
игры считаются в Web Worker'е вкладки создателя комнаты; клиенты рендерят
мир (PixiJS) и маскируют сетевую задержку интерполяцией и предсказанием.
Мастер-сервер (Node.js) игровой логики не несёт: лобби, сигналинг WebRTC,
каталог карт, рейтинг серверов (соц-анти-чит, `/like`·`/unlike`).

```
┌──────────────────┐  сигнальный WS (SDP/ICE, ping, голос) ┌──────────────────┐
│  Мастер-сервер   │ ◄───────────────────────────────────► │      Клиент      │
│ Node.js: лобби,  │                                       │ PixiJS + Howler  │
│ GET /servers,    │ ◄───────────┐                         │ интерполяция     │
│ каталог карт     │             │ register_host,          │ (−100 мс),       │
└──────────────────┘             │ heartbeat               │ prediction       │
                                 │                         └────────┬─────────┘
                        ┌────────┴─────────┐   WebRTC DataChannels  │
                        │  Вкладка хоста   │  meta (reliable): JSON │
                        │ Worker: ядро+мета│  [port, payload] + со- │
                        │ симуляция ~120 Гц│  бытийные кадры        │
                        │ снапшоты 30/сек  │ ◄──────────────────────┘
                        └──────────────────┘  state (unreliable):
                                              позиционные кадры (5);
                                              ввод "seq:action:name"
```

## Структура репозитория

Этот репозиторий содержит **только движок** — игра (сейчас танки) вынесена в
отдельно публикуемый, динамически загружаемый пакет-плагин, который живёт в
своём собственном репозитории (например, `vimp-tanks`) и ставится сюда как
`@vimp/tanks` в `node_modules/`; движок никогда не импортирует её статически
(граница закреплена ESLint-правилом `no-restricted-imports`). Структуру
самой игры см. в [vimp-tanks/docs/ru/architecture.md](https://github.com/lgick/vimp-tanks/blob/main/docs/ru/architecture.md).

```
packages/engine/ — @vimp/engine: движок-приложение (npm workspace)
  index.html / vite.config.js — Vite-root движка
  public/        — статика (звуки, favicon)
  src/
    master/      — мастер-сервер (точка входа): реестр комнат, REST,
                   сигналинг, каталог карт (docs/master.md)
    host/        — браузерный хост (docs/host.md)
      host.worker.js — Web Worker: WASM-ядро + мета + порт-машина + цикл ~120 Гц
      HostGame.js — host-фасад: wiring мета-модулей, core-driven тик
      GameCoreAdapter.js — поверхность физики/ботов/упаковки поверх GameCore
      meta/      — JS-мета Worker'а: core/ (RoundManager, CommandProcessor,
                   VoteCoordinator), modules/ (Panel, Stat, Vote, chat/,
                   TimerManager, RTTManager), player/ (Participant/Human/Bot +
                   ParticipantManager), SocketManager
    client/      — браузерный клиент
      main.js    — диспетчер портов, лобби/роли, инициализация модулей, рендер-цикл
      network/   — SignalingClient, WebRtcManager (offerer), HostController,
                   LoopbackTransport, HostConnectionManager (answerer)
      components/ — MVC-тройки (Auth, Lobby, CanvasManager, Controls, Game,
                   Chat, Panel, Stat, Vote)
      providers/ — BakingProvider (пекари приходят из ClientPlugin игры),
                   DependencyProvider
      SoundManager.js / InputListener.js
    config/      — конфиги движка (hostDefaults, clientDefaults, wsports,
                   opcodes, lobby, master)
    lib/         — общие утилиты: Publisher, factory, math, validators,
                   sanitizers, security, config, clientCoreConfig, …
  core/          — vimp-engine-core (Rust rlib): физика, кодек снапшотов,
                   интерполяция, распаковка кадров, ABI-макросы (docs/core.md)
tests/           — Vitest-проекты: engine-node, engine-client,
                   integration (tests/host/HostGame.test.js + tests/core,
                   пропускается без собранного/подключённого WASM-ядра игры)
scripts/         — вспомогательные скрипты (экспорт карт в JSON и т.п.)
.github/         — CI/CD (test.yml, deploy.yml) и скрипты развертывания
```

`packages/engine/src/config/` и `packages/engine/src/lib/` — **shared-слой**:
импортируются мастером (Node.js), Worker'ом хоста и клиентом (Vite-бандл).
Благодаря этому кодек снапшота, математика, валидаторы и логика мерджа
гарантированно совпадают на всех сторонах; свои данные (модели, оружие,
карты) игра-плагин поставляет через контракт плагина — см.
[plugin-api.md](plugin-api.md).

Проект изначально строился вокруг авторитетного WS-сервера; текущая
P2P-архитектура (браузерный хост + мастер-сервер) — результат завершённой
миграции, легаси-сервер полностью демонтирован. Сама игра (в этом репозитории
раньше — `games/tanks/`) позже была вынесена в отдельный репозиторий по
границе контракта плагина, описанной ниже.

## Вкладка хоста

Авторитетная часть матча живёт в Web Worker'е (его таймеры не троттлятся в
фоновой вкладке), `RTCPeerConnection` — в главном потоке (в Worker их создать
нельзя), который работает роутером пакетов. Хост-игрок играет в той же вкладке
через postMessage-loopback. Такое разделение позволяет заменять Worker без
разрыва P2P — на этом построена **эстафета Worker'ов**: при деплое
комната на границе раунда переезжает на новый worker-бандл мастера с переносом
участников и счёта. Детали — [host.md](host.md), раздел «Эстафета Worker'ов».

```
Вкладка хоста
├─ Главный поток (client + router)
│   ├─ client (main.js)          — рендер, prediction, звук (обычный клиент)
│   ├─ HostController            — спавнит Worker, мост Worker↔транспорт
│   ├─ LoopbackTransport         — транспорт хоста-игрока поверх postMessage
│   └─ HostConnectionManager     — WebRTC-answerer удалённых клиентов + бэкпрешер
└─ Web Worker (host.worker.js)   — авторитетная симуляция ~120 Гц
    ├─ GameCore (WASM, из игры-плагина, напр. @vimp/tanks/core) — физика, игровые сущности, боты
    ├─ GameCoreAdapter           — поверхность физики/ботов/упаковки поверх ядра
    └─ HostGame-фасад + мета      — RoundManager, ParticipantManager, Chat, Vote,
                                    Stat, Panel, TimerManager… (packages/engine/src/host/meta/)
```

**`HostGame`** — фасад: связывает модули, ведёт жизненный цикл соединений и
делегирует тик. Дерево владения:

```
HostGame (фасад/wiring + core-driven тик)
 ├─ ParticipantManager   — единый реестр игроков и ботов (источник истины)
 ├─ RoundManager         — раунды, team wipe, смена карты, spectator↔active
 ├─ CommandProcessor     — чат-команды (/name, /bot, /nr, /timeleft, /mapname)
 ├─ VoteCoordinator      — создание/кулдаун/сброс голосований
 ├─ GameCoreAdapter      — ядро: физика, игровые сущности, боты, packBody/packFrame
 ├─ Cold path: Panel, Stat, Chat, Vote (JSON, по изменению)
 ├─ TimerManager         — все таймеры  /  RTTManager — пинги и кики
 └─ scripted-модуль игры (напр. bot-менеджер, из плагина; ИИ — в ядре)
```

**Граница ядра — симуляция, а не мета**: в ядре физика, игровые сущности,
боты и упаковка бинарных кадров; игровое состояние (напр. здоровье/боезапас)
тоже живёт в ядре, панель — проекция его событий (стандартный словарь
`take_events()`: panelSet/panelActive/death/shake/custom).
Мета (чат, голосования, статистика, раунды, реестр участников, auth) — JS в
Worker'е.

### Игровой цикл

`TimerManager` вызывает `onShotTick` с частотой ~120 Гц (`timers.timeStep`). За тик:

1. `GameCoreAdapter.updateData(dt)` — шаг ядра (физика + боты) + дренаж событий
   в мету (panel/reportKill/shake);
2. `SnapshotThrottle` — каждый `networkSendRate`-й тик (4 → **30 снапшотов/сек**)
   кадр отправляется, иначе тик завершён;
3. `packBody` (в ядре) — broadcast-часть кадра пакуется **один раз**;
4. для каждого готового пользователя: `packFrame` (камера + player-блок
   играющего) → бинарная отправка (порт 5; события → канал `meta`, чистые
   позиции → `state`) + мета (panel/stat/chat/vote) своими JSON-каналами
   **только при изменении**.

### Жизненный цикл соединения

```
лобби → выбор комнаты → сигналинг (offer/answer/ICE) → каналы meta+state
  → CONFIG → auth → createUser (спектатор) → sendMap → mapReady
  → firstShotReady → участие в игровом цикле
  → removeUser при отключении (или кик: idle / RTT; хост-игрок не кикается)
```

Выход хоста = смерть комнаты (host-migration нет): клиенты возвращаются в
лобби. Детали протокола и портов — [network.md](network.md).

## Клиентская сторона

Клиент строится вокруг трёх механизмов сглаживания сети; все три живут в клиентском ядре — WASM-классе `ClientCore` того же Rust-бинаря (подробно — [client.md](client.md), ABI — [core.md](core.md#clientcore--клиентский-режим-ядра)):

- **Интерполяция** (`packages/engine/core/src/client/interpolator.rs`): кадры буферизуются, мир рендерится в прошлом (`serverNow − 100 мс`); события выдаются ровно один раз, позиции интерполируются.
- **Предсказание** (ядро игры-плагина, напр. `core/src/client/predictor.rs` в `vimp-tanks`): своя сущность симулируется репликой авторитетной модели движения (формулы общие с ядром игры); хост подтверждает ввод (`lastInputSeq`), reconciliation переигрывает неподтверждённые вводы, расхождение плавно затухает.
- **Клиентский спавн снарядов** (ядро игры-плагина, напр. `core/src/client/shot.rs` в `vimp-tanks`): выстрел виден и слышен мгновенно, дубли от хоста подавляются по id автора.

JS-оболочка читает результат рендер-тика плоским Float32-буфером zero-copy из памяти WASM (горячие позиции) и JSON-строкой (редкие событийные кадры), применяя его прежним parse-конвейером.

Рендеринг — MVC-компоненты + PixiJS-сущности `parts/` на двух полотнах (`vimp`, `radar`), процедурные текстуры запекаются при старте.

## ADR: движок — приложение, игра — динамический плагин

**Статус: принято, миграция завершена.** Движок и референсная игра (танки)
теперь живут в отдельных репозиториях, связанных только рантайм-контрактом
плагина, описанным в [plugin-api.md](plugin-api.md). Полная летопись этапов
миграции — в `plan/done/` этого репозитория, включая
`plan/done/repo-split/`.

**Решение.** Проект разделяется на **движок** — приложение, деплоящееся
один раз (мастер, P2P-транспорт, Worker-инфраструктура и эстафета,
мета-*механизмы*, MVC-каркас клиента, рендер/звук-инфраструктура,
Rust-каркас), — и **игру** — динамический плагин (JS-бандлы client/host,
WASM-бинарь, ассеты), загружаемый по манифесту с мастера. Композиция: этот
репозиторий публикует `@vimp/engine` (npm) и `vimp-engine-core` (Rust rlib
crate); репозиторий игры (например, `vimp-tanks`) публикует `@vimp/tanks`,
устанавливаемый здесь как обычная `node_modules`-зависимость, и свой crate
`vimp-tanks-core` (cdylib + wasm-bindgen-обёртки), зависящий от
`vimp-engine-core` и связанный через трейты со статической
мономорфизацией. Мета-модули (Panel/Stat/Chat/Vote/Timer/RTT/Participant/
Round/CommandProcessor) остаются движковыми, но **вся их параметризация —
из конфига игры**. Ботов в движке нет — только нейтральное понятие
«скриптовый участник».

**Обоснование.** На движке могут работать другие игры; один мастер может
обслуживать несколько игр; репозиторий игры может выпускаться в своём
темпе. Динамический плагин (а не build-time зависимость) позволяет
деплоить движок один раз, а играм версионироваться независимо
(`codeVersion` составной, расхождение запускает эстафету Worker'ов).

Историческую построчную разметку «что уехало в движок, а что — в игру» во
время миграции см. в `plan/done/` в истории git этого репозитория — здесь
она больше не воспроизводится, так как оба дерева с тех пор развиваются
независимо.

## Ключевые инварианты

- **Источник истины по портам** — `packages/engine/src/config/wsports.js`; по версии бинарного формата — `packages/engine/src/config/opcodes.js`; по snapshot-ключам — собственная схема игры, поставляемая через `HostPlugin.gameConfig.snapshot` (см. [plugin-api.md](plugin-api.md)).
- **Паритет реплики движения**: авторитетное движение и реплика клиентского предикта обязаны делить формулы тика — это забота репозитория игры (например, `core/src/motion.rs` и cargo-тесты `client::predictor::parity` в `vimp-tanks`); движок предоставляет только общую машинерию `Predictor<G>`/интерполяции.
- **Единое числовое пространство id** для людей и scripted-участников (ботов); различение — `isScripted`/`isNetworked`. Ядро оперирует числовыми id, мета ключует строками — приведение на границе `GameCoreAdapter`.
- Все отправки клиенту — только через `SocketManager`.

---

[← Предыдущая: Локальная настройка](getting-started.md) · [Следующая: Мастер-сервер →](master.md)
