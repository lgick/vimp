# Кодревью коммита 93ba930 + план правок

## Контекст

Коммит `93ba930` («release», ветка `standalone-sdk`, **в `origin` не отправлен**)
закрывает Этапы 1–5 плана `plan/standalone-sdk/`: изоморфная порт-машина хоста,
стратегии идентичности, три режима загрузки клиента, публикуемый Standalone SDK,
dedicated-сервер на Node.js, деплой и документация. Этап 6 (репозиторий
`vimp-tanks`) ждёт публикации движка.

Ревью читало код целиком (не диффы) по всем десяти критериям. Итог: архитектурные
решения верны — порт-машина вынесена без изменения протокола, `lobby.js` — точный
перенос, `loadGamePackage` — точная экстракция, тесты зелёные
(**122 файла / 1198 тестов**, прогнано в ходе ревью). Но найдены **4 блокера** (два
из них ломают ровно ту функциональность, ради которой всё делалось, два — валят
процесс на проде), **4 значимых** и **6 мелких** проблем, а также **3 незакрытых
отклонения от плана**.

Цель этого плана — закрыть находки до публикации движка (публикация запускает
Этап 6, а push в `main` запускает деплой).

---

## Часть 1. Блокеры (до мержа и публикации)

### P1-1. Каркас интерфейса в контейнере SDK не работает: чёрный экран

**Симптом.** `startStandaloneGame({ container: document.getElementById('game') })`
— то есть путь из `docs/en/standalone.md` и из Задачи 6.1 — даёт чёрный экран.
Матч при этом идёт: хост тикает, кадры доходят, звук играет.

**Причина — два наложенных дефекта.**

1. Базовые правила страницы переехали из `packages/engine/index.html` в
   `src/client/style.css` (строки 4–34), а `main.js:1` импортирует этот файл, то
   есть в бандл репозитория игры уезжает и правило `body > * { display: none }`.
   Контейнер `#game` — прямой потомок `body`, а рекомендованное доками правило
   `#game { position: relative; width/height: 100% }` свойство `display` не
   объявляет, поэтому специфичность не спасает: **контейнер скрыт**.
2. Если скрытие контейнера снять «в лоб» (`#game { display: block }`), проявится
   второй дефект: `#stat`, `#auth`, `#game-informer`, `#tech-informer` **не имеют
   собственного `display: none`** — их начальную невидимость обеспечивало то же
   правило `body > *`. Внутри контейнера правило не действует, и все экраны
   показываются разом. Хуже всех `#tech-informer`: `position: absolute`,
   `width/height: 100%`, `background: #000`, `z-index: 9` — снова чёрный экран,
   теперь уже сверху идущего матча. `#auth` (`z-index: 8`, фон `#222`) в режиме
   `autoAuth` не скрывается никогда: `modules.auth` не создаётся вовсе, значит
   `AuthView.hide()` не вызывается.

Экраны показывают себя сами (`main.js:437` по `initIdList`, `Auth.js:131`,
`Stat.js:82`), и в этот список контейнер SDK не входит и входить не должен.

**Важный нюанс:** дефолт SDK (`container = document.body`) работает — там каркас
снова прямой потомок `body`. Ломается именно рекомендованный доками путь с
собственным контейнером.

**Почему не поймали тесты.** happy-dom не применяет CSS из `import './style.css'`
и не считает каскад; тест `gameShell.test.js` проверяет наличие элементов, а не
их видимость. Проверить это можно только в браузере (Этап 6) либо статикой.

**Решение** (движковое, чтобы репозиторий игры не мог ошибиться).

`src/client/style.css` — вместо одного правила три:

```css
/* Экраны движка не показываются разом: каждый показывает свой модуль
   (initIdList в main.js, AuthView.show, StatView.show, информеры). В
   прод-сборке они прямые потомки body, в standalone SDK — потомки контейнера
   игры, поэтому правило нужно в обеих формах. */
body > *,
.vimp-shell > * {
  display: none;
}

/* Контейнер SDK сам прямой потомок body — правило выше скрыло бы его целиком.
   Своё display (например flex) страница игры задаёт по id: специфичность id
   перебивает это правило. Контейнер, вложенный глубже первого уровня, страница
   обязана показать сама. */
body > .vimp-shell {
  display: revert;
}
```

`src/client/views/gameShell.js` — маркер ставит сам каркас:

```js
// класс-маркер: правило `.vimp-shell > *` в style.css держит экраны скрытыми
// до того, как их покажет свой модуль. В прод-сборке контейнер — body, и
// правило совпадает с прежним `body > *`; в SDK это чужой div
export const SHELL_CLASS = 'vimp-shell';

export function ensureGameShell(container = document.body) {
  container.classList.add(SHELL_CLASS);
  buildNodes(SHELL, container, false);

  return container;
}
```

Правило `body > *` сохраняется, поэтому lobby-режим не меняется вовсе (в нём
класс попадает на `body`, где `.vimp-shell > *` тождественно `body > *`), и
FOUC до исполнения JS не появляется.

**Тесты** (`tests/client/gameShell.test.js`): каркас ставит `vimp-shell` на
переданный контейнер и на `body` при дефолтном вызове; ни один собранный экран не
получает инлайновый `display` (начальное состояние — только CSS).

**Документация:** в `docs/en|ru/client.md` абзац «…и его `display` задаёт
встраивающая страница» заменить на описание нового правила; в
`docs/en|ru/standalone.md` — требования к контейнеру и раздел
Troubleshooting; в `plan/standalone-sdk/stage_6.md` (Задача 6.1) — убрать
требование ставить `display` вручную.

### P1-2. Окно голосования в solo невидимо: `#vote` монтируется в `document.body`

**Симптом.** В standalone-режиме игрок не может ни сменить команду, ни
проголосовать за карту, ни кикнуть — окно голосования не появляется. Программные
`startupVotes` при этом работают (они уходят по порту, минуя UI), поэтому боты
появляются и дефект легко принять за «так и задумано».

**Причина.** `components/view/Vote.js:79` — `document.body.appendChild(vote)`
безусловно. В solo элемент оказывается вне контейнера SDK: его скрывает
`body > *` (см. P1-1), а `position: absolute` (`style.css:223`) считается от
initial containing block, а не от контейнера.

Это **пропуск в Этапе 2**: точка ветвления 5 закрыла канвасы (`ensureCanvas`), а
второй рантайм-элемент — `#vote`, о котором в Задаче 2.2 сказано отдельно
(«`#vote` не создаём: его делает `view/Vote.js` в рантайме») — точку монтирования
не получил.

**Решение.** `components/view/Vote.js`:

```js
constructor(model, elems, container = document.body) {
  if (voteView) {
    return voteView;
  }

  voteView = this;
  // окно создаётся в рантайме, поэтому точка монтирования приходит извне:
  // в solo это контейнер SDK, иначе body (см. main.js, точка ветвления 5)
  this._container = container;
  ...
}
```

и в `createVote` — `this._container.appendChild(vote)` вместо `document.body`.
`main.js` (`runModules`, ~строка 862): `new VoteView(voteModel, voteData.elems, gameContainer)`.
`removeVote` уже контейнеро-независим (`vote.parentElement.removeChild`).

**Тест** (новый `tests/client/vote.test.js` или в составе `gameShell.test.js`):
`createVote` кладёт `#vote` в переданный контейнер, `removeVote` его убирает;
дефолтный вызов по-прежнему монтирует в `body`.

**Документация:** `docs/en|ru/client.md` — в описании каркаса указать, что
`#vote` создаётся в рантайме **в контейнере загрузки**;
`plan/standalone-sdk/stage_2.md` — отметить пропуск и его закрытие.

### P1-3. Dedicated-сервер падает от одной сорванной сокет-связи

**Симптом.** Обрыв TCP у любого клиента (ECONNRESET, битый фрейм, kill вкладки в
неудачный момент) валит процесс целиком — вместе с матчем всех остальных.
Перезапуска нет (в контейнере — рестарт, эстафеты нет, матч потерян).

**Причина.** `src/dedicated/main.js:211-241` не вешает `ws.on('error')`. `ws`
эмитит `'error'` на самом сокете; слушателя нет → `uncaughtException`;
`process.on('uncaughtException')` в проекте нет нигде (проверено grep'ом по
`packages/engine/src` и `packages/auth/src`). В сигналинге такой слушатель есть
и снабжён комментарием (`src/master/SignalingServer.js:115`) — новая копия его
потеряла.

**Решение** (`src/dedicated/main.js`):

```js
  wss.on('connection', (ws, req) => {
    // ws эмитит 'error' на самом сокете (ECONNRESET, битый фрейм). Без
    // слушателя это uncaughtException, то есть один сорванный клиент убивает
    // матч всех остальных — тот же слушатель стоит в сигналинге
    ws.on('error', err =>
      console.error('[dedicated] socket error:', err.message),
    );

    const requestOrigin = req.headers.origin;
    ...
  });

  wss.on('error', err =>
    console.error('[dedicated] ws server error:', err.message),
  );
```

Слушатель ставится **до** проверки origin — иначе ошибка на отбитом соединении
остаётся неперехваченной.

**Тест** (`tests/dedicated/dedicatedServer.test.js`): дойти клиентом до
`FIRST_SHOT_DATA`, оборвать соединение грубо (`client.ws._socket.destroy()`),
затем убедиться, что сервер жив — `GET /config` отвечает 200 и второй клиент
проходит хендшейк.

### P1-4. Remote DoS: длинный заголовок `Origin` валит процесс

**Симптом.** Любой аноним без авторизации гасит сервер одним запросом:
`Origin` длиной больше ~80 байт → `RangeError` → `uncaughtException` → процесс
мёртв. Касается **и нового dedicated-сервера, и работающего прод-мастера**.

**Причина.** `src/dedicated/main.js:223` и `src/master/SignalingServer.js:75`:

```js
ws.close(4001, JSON.stringify(err));
```

`err` — строка `Blocked connection from invalid origin: <origin>` (41 байт +
origin), `JSON.stringify` добавляет кавычки. Лимит причины закрытия в WebSocket —
123 байта, и `ws` его проверяет броском: `node_modules/ws/lib/sender.js:197-199`
(`RangeError: The message must not be greater than 123 bytes`). Бросок происходит
внутри колбэка `process.nextTick` в `createOriginValidator`, перехватить его
некому.

В мастере это дефект, существовавший до коммита; коммит скопировал его в новый
контур. Правим оба места.

**Решение.**

```js
  checkOrigin(requestOrigin, err => {
    if (err) {
      console.warn(err);
      // причина close ограничена 123 байтами (ws бросает RangeError, а он
      // здесь никем не перехватывается): полный текст уходит в лог, клиенту —
      // короткий маркер
      ws.close(4001, 'invalidOrigin');
      return;
    }
    ...
```

**Тесты:** в `tests/dedicated/dedicatedServer.test.js` — соединение с
`origin: 'http://' + 'a'.repeat(200)` закрывается, сервер жив; в тестах
сигналинга — то же для `SignalingServer`.

**Журнал:** `src/master/` вне `files` пакета, но CLAUDE.md относит эндпоинты
мастера к журналу движка, а находка — эксплуатируемая на проде. Добавить в
`packages/engine/CHANGELOG.md` раздел `### Security` (уровень релиза не меняет,
`[Unreleased]` уже minor по `### Added`).

---

## Часть 2. Значимые находки (до прода dedicated / публикации SDK)

### P2-1. SDK: `playerName` без `playerModel` ломает авто-вход

**Симптом.** `startStandaloneGame({ playerName: 'Tanker' })` без `playerModel`
(параметр документирован как необязательный) вместо матча даёт экран
`Authorization rejected: [{"name":"model","error":"Property is missing"}]`.

**Причина.** `src/standalone/index.js:76-78` собирает
`{ name: playerName, model: playerModel, ...auth }`, то есть при незаданной
модели в объекте появляется `model: undefined`. Дальше `main.js:381`:
`{ ...defaultsFrom(params), ...boot.autoAuth }` — `undefined` **перекрывает**
дефолт схемы, а `JSON.stringify` ключ с `undefined` выбрасывает вовсе, поэтому до
хоста поле не доходит и `validateAuth` (`src/lib/validators.js:30`) отвечает
`Property is missing`. Формы, куда вернуть ошибку, в этом режиме нет.

**Почему не поймал тест.** Заглушка `main.js` в
`tests/standalone/startStandaloneGame.test.js:83` отправляет `boot.autoAuth`
как есть, без слоя `defaultsFrom(params)` — то есть расходится с настоящим
клиентом ровно в том месте, где живёт дефект.

**Решение** (`src/standalone/index.js`):

```js
    autoAuth: playerName
      ? pruneUndefined({ name: playerName, model: playerModel, ...auth })
      : null,
```

```js
// незаданное поле — это «взять дефолт схемы», а не «отправить undefined»:
// JSON.stringify ключ с undefined выбрасывает, и хост отвечает
// 'Property is missing' (main.js накрывает autoAuth поверх дефолтов схемы)
function pruneUndefined(source) {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  );
}
```

**Тесты:** в `tests/standalone/startStandaloneGame.test.js` — вызов без
`playerModel` даёт `getBootConfig().autoAuth` без ключа `model`, и хендшейк
доходит до участника (модель берётся из дефолта схемы фикстуры); заглушку
привести к `main.js` — `{ ...defaultsFrom(params), ...boot.autoAuth }` — чтобы
она больше не прятала расхождения.

### P2-2. `HostGame.destroy()`: двойная синхронизация профиля и гонка на выходе

**Симптом (будущий, но заложенный сейчас).** `destroy()` разрешается **раньше**,
чем уходят финальные запросы профилей, а `dedicated.close()` сразу за ним делает
`process.exit(0)` — данные теряются. Плюс каждый участник синхронизируется дважды
конкурентно, и вторая отправка везёт ту же накопленную дельту рейтинга (двойной
зачёт).

**Причина** (`src/host/HostGame.js:602-623`): `flushAll()` запускается, но не
ожидается, после чего цикл `removeUser` для каждого участника стартует ещё один
`flush` (`HostGame.js:858`). `PlayerDataSync.flush` вычитает дельту только после
успеха (`PlayerDataSync.js:158-166`), поэтому параллельный второй вызов читает
ещё не уменьшенное `pendingRankDelta`. Сегодня оба контура (`solo`, `dedicated`)
работают на `offlinePlayerData()`, поэтому вреда нет — дефект проявится ровно
тогда, когда у dedicated появится центральная идентичность.

**Решение** (`src/host/HostGame.js`):

```js
  async destroy() {
    this._timerManager.stopGameTimers();
    this._timerManager.stopIdleCheckTimer();
    this._timerManager.stopAllVoteTimers();
    this._timerManager.stopAllBlockedVoteTimers();

    // flushAll до снятия участников: removeUser чистит запись PlayerDataSync.
    // Ждём здесь же — иначе removeUser стартует второй flush с той же
    // накопленной дельтой (двойной зачёт рейтинга), а destroy разрешился бы
    // раньше, чем эти запросы уйдут
    await this._playerDataSync.flushAll();

    for (const user of this._participants.getAll()) {
      // запись уже синхронизирована — финальный flush внутри removeUser
      // не нужен и был бы повтором
      this._playerDataSync.removeUser(user.gameId);
      this.removeUser(user.gameId);
    }
  }
```

**Тест** (`tests/host/HostGame.fixture.test.js:129`): считающий `playerDataFetch`
— ровно один PUT rank и один PUT state на участника, и к моменту разрешения
`destroy()` новых запросов не остаётся.

### P2-3. Публичный WebSocket dedicated-сервера не защищён от простого абьюза

Три отсутствующих ограничения. По отдельности мелочи, вместе — открытая
поверхность 24/7-процесса, у которого нет ни лобби-гейта, ни OAuth, ни
супервизора.

1. **`maxPayload` не задан** → дефолт `ws` 100 МиБ. Один текстовый кадр на 100 МБ
   проходит через `data.toString()` и `JSON.parse` — пик памяти на клиента.
   Легитимный кадр клиента — строка чата, клавиши, голос: килобайты.
2. **Нет таймаута хендшейка.** Соединение, не дошедшее до участника, живёт
   вечно, слота в комнате не занимает (`isFull` считает `getHumans()`), но держит
   файловый дескриптор и память — тривиальный slowloris.
3. **Нет ограничения частоты сообщений.** Участник может лить `KEYS_DATA`,
   `CHAT_DATA`, `VOTE_DATA` со скоростью сокета; чат ещё и веерно рассылается
   всем. В P2P хостом была вкладка игрока (вред самому себе), на публичном
   сервере это усилитель.

**Решение** (`src/dedicated/main.js`; политику держим в адаптере, а не в
`PortMachine` — автомат должен остаться изоморфным и без политики):

```js
// кадр клиента — чат-строка, клавиши, голос: килобайты. Дефолт ws (100 МиБ)
// на публичном сервере — просто пик памяти по запросу
const MAX_PAYLOAD = 64 * 1024;

// клиент шлёт до ~60 кадров/с на пике (клавиши + pong); 300/с ловит флуд,
// не задевая игру
const MESSAGE_LIMIT = { limit: 300, windowMs: 1000 };

// соединение, не дошедшее до участника, слота не занимает, но держит сокет
const HANDSHAKE_TIMEOUT = 30000;
```

```js
  const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: MAX_PAYLOAD });
  const messageLimiter = new RateLimiter(MESSAGE_LIMIT);
  const limiterSweep = setInterval(() => messageLimiter.sweep(), 60000);

  limiterSweep.unref();
```

в обработчике соединения:

```js
      const guard = setTimeout(() => {
        if (!portMachine.hasParticipant(socketId)) {
          ws.close(4008, 'handshakeTimeout');
        }
      }, HANDSHAKE_TIMEOUT);

      guard.unref();

      ws.on('message', data => {
        // молча отбрасываем: кик за неактивность и потерянные ping — забота
        // HostGame, здесь только защита от флуда
        if (messageLimiter.consume(socketId)) {
          portMachine.message(socketId, data.toString());
        }
      });

      ws.on('close', () => {
        clearTimeout(guard);
        sockets.delete(socketId);
        portMachine.disconnect(socketId);
      });
```

и `clearInterval(limiterSweep)` в `close()`. `RateLimiter` уже есть
(`src/lib/rateLimiter.js`, `consume`/`sweep`), мастер использует его для ping.
`PortMachine` получает один геттер:

```js
  /**
   * @param {string} socketId
   * @returns {boolean} Дошёл ли клиент до созданного участника матча.
   */
  hasParticipant(socketId) {
    return this._clients.get(socketId)?.gameId !== undefined;
  }
```

**Тесты:** `tests/dedicated/dedicatedServer.test.js` — кадр больше `maxPayload`
закрывает только своё соединение (сервер жив); `tests/host/portMachine.test.js` —
`hasParticipant` до и после `AUTH_RESPONSE`. Таймаут хендшейка проверять
реальным ожиданием не стоит — достаточно юнита на `hasParticipant`.

**Документация:** `docs/en|ru/dedicated.md`, раздел про игровой WebSocket — три
новых лимита с числами.

### P2-4. `InlineHostBridge`: `destroy()` до `ready` оставляет живой хост во вкладке

**Симптом.** `stop()`, вызванный до готовности хоста, возвращает разрешённый
промис, а хост поднимается уже после teardown и остаётся в вкладке с игровым
циклом ~120 Гц навсегда. `open()`/`send()` до `ready` падают сырым
`TypeError: Cannot read properties of null`.

**Причина** (`src/client/network/InlineHostBridge.js:74-100`): `destroy()` читает
`this._runtime`, который до завершения `_init` равен `null`, и промис `ready` не
ожидает. Сегодня путь труднодостижим (`connectSolo` ждёт `ready`, а
`startStandaloneGame` разрешается только после импорта `main.js`), но модуль
публикуется как часть SDK.

**Решение:**

```js
  async _init(room, { hostPlugin, onMapChange }) {
    const runtime = await createHostRuntime(room, { ... });

    // stop() успел прийти раньше готовности: поднятый хост нужно погасить
    // здесь, иначе его таймеры останутся во вкладке навсегда
    if (this._destroyed) {
      await runtime.host.destroy();
      return;
    }

    this._runtime = runtime;
    this._portMachine = new PortMachine({ ... });
  }

  destroy() {
    this._destroyed = true;
    this._clients.clear();

    // ready может быть ещё в полёте — без ожидания хост поднялся бы уже
    // после teardown
    return this.ready
      .catch(() => {})
      .then(() => this._runtime?.host.destroy());
  }
```

плюс `this._destroyed = false` в конструкторе и внятный отказ в `open()`/`send()`
при `!this._portMachine` (`throw new Error('InlineHostBridge: await ready before open()')`).

**Тест** (`tests/client/network/InlineHostBridge.test.js`): `destroy()` сразу
после конструктора — `ready` разрешается, второй `destroy()` безопасен, таймеры
хоста сняты (проверяется через `inspectHost`/отсутствие тиков на фейковых
таймерах).

---

## Часть 3. Мелкие находки

| # | Находка | Решение |
| --- | --- | --- |
| P3-1 | Пустая dedicated-комната крутит симуляцию ~120 Гц вечно: `RoundManager.createMap()` → `startGameTimers()` вызывается в конструкторе `HostGame`, и матч без игроков жжёт ядро CPU круглосуточно | На этом шаге — измерить и **задокументировать** в `docs/en|ru/dedicated.md` (раздел ограничений). Пауза на пустой комнате (`stopGameTimers()` при уходе последнего сокета, `resumeGameTimers(mapTimeLeft)` + `initiateNewRound()` на первом входе) — отдельный пункт после мержа: семантика таймеров раунда/карты требует своего разбора |
| P3-2 | `/config` отдаёт `wsPath`, а клиент его не читает: `boot.js:normalize` строит URL из константы `DEDICATED_WS_PATH` | `wsUrl: raw.wsUrl \|\| defaultDedicatedWsUrl(raw.wsPath)` и `function defaultDedicatedWsUrl(wsPath = DEDICATED_WS_PATH)`; тест в `tests/client/boot.test.js` на нестандартный `wsPath` |
| P3-3 | Лишний последовательный round-trip на каждом старте лобби: `await resolveBootConfig()` (`GET /config`) стоит **перед** `fetchGamesManifest` | Пустить параллельно: `const injected = getBootConfig(); const manifestPromise = injected ? null : fetchGamesManifest(...); const boot = injected ?? await resolveBootConfig();` — дальше `gamesManifest = await manifestPromise` в существующем `try` |
| P3-4 | Гостевое поле ника рендерится **после** игровых полей формы: `_authParams = [...authSchema.params, ...identity.params]` (`PortMachine.js:45`) | Поменять порядок на `[...identity.params, ...authSchema.params]`; в `portMachine.test.js:78` ожидание становится `['name', 'model']` |
| P3-5 | Открытый вопрос Этапа 1 (заглушка `Player_xxxx` недостижима, т.к. `validateAuth` отбивает невалидный ник раньше `resolve`) | **Оставить как есть**: молчаливая подмена ника хуже явной ошибки формы, поле объявлено `required`. Заглушка остаётся страховкой для стратегий без поля формы — это уже написано в JSDoc. Зафиксировать решение в `stage_1.md` и закрыть отклонение. Отдельно: `String(socketId).slice(0, 4)` на UUID даёт 4 hex-символа (65 536 вариантов) — если путь когда-нибудь станет достижимым, поднять до 6 |
| P3-6 | Косметика: пустая строка внутри списка `### Added` в `CHANGELOG.md` (перед пунктом про dedicated); в `CLAUDE.md` абзац Architecture стал одной длинной строкой в отличие от остального файла; `npm run dedicated` не попал в блок Commands `CLAUDE.md` | Три однострочные правки; `npm run release` парсит заголовки, а не пункты, поэтому релиз не задет |

---

## Часть 4. Отклонения от плана

| Отклонение | Статус | Что делаем |
| --- | --- | --- |
| **Этап 1**: тест «невалидный ник → `Player_xxxx`» недостижим | заявлено, решение не принято | P3-5: оставляем валидатор, фиксируем решение в `stage_1.md` |
| **Этап 2**: `tests/client/network/LoopbackTransport.test.js` не создан (транспорт уже покрыт в `tests/host/`) | заявлено, обосновано, отмечено в `stage_2.md` | ничего |
| **Этап 2, задача 2.2**: перенос `body > *` в `style.css` выполнен буквально, следствие для каркаса внутри контейнера не отработано | **не заявлено** | P1-1; дописать разбор в `stage_2.md` |
| **Этап 2, задача 2.5 п.5**: точку монтирования получили канвасы, но не `#vote` (второй рантайм-элемент, упомянутый в 2.2) | **не заявлено** | P1-2; дописать в `stage_2.md` |
| **Этап 3**: настоящий `main.js` в happy-dom не поднимается, клиент подменён заглушкой | заявлено, обосновано | заглушка разошлась с `main.js` и спрятала P2-1 → привести её к `main.js` (см. P2-1) |
| **Этап 3**: `_style.css` не удалён, исключён через `"!src/client/_*"` | заявлено, решение владельца | ничего; поведение подтверждено тестом `packageSurface` и `npm pack --dry-run` |
| **Этап 5**: `docker build` не прогнан (docker недоступен) | заявлено | **обязательный пункт приёмки**: коммит в `origin` не отправлен, а push в `main` запускает деплой (`.github/workflows/deploy.yml`, `docker/build-push-action`). Прогнать `docker build -t vimp-test .` до мержа: runner-стадия теперь копирует `src/host` и `src/dedicated`, `npm ci --omit=dev` тянет `howler` |
| **README, критерии 3 и 4**: браузерный smoke dedicated (вход без лобби и OAuth) и регресс-smoke лобби с WebRTC | не проводились (был только node-смоук и автотесты) | после P1-правок — ручной прогон обоих контуров, см. «Верификация» |

---

## Часть 5. Порядок работ

Правки складываются в новый файл `plan/standalone-sdk/review.md` (строка `R` в
таблице этапов `plan/standalone-sdk/README.md`, между 5 и 6 — Этап 6 зависит от
публикации, а публикация от этих правок). Отметки «✅ выполнен» ставятся по
пунктам.

1. **Шаг R1 — блокеры клиента (P1-1, P1-2).**
   `src/client/style.css`, `src/client/views/gameShell.js`,
   `src/client/components/view/Vote.js`, `src/client/main.js` (передача
   `gameContainer` в `VoteView`); тесты `gameShell`/`vote`; доки
   `client.md` + `standalone.md` (en+ru); `stage_2.md`, `stage_6.md`.
2. **Шаг R2 — блокеры сервера (P1-3, P1-4).**
   `src/dedicated/main.js`, `src/master/SignalingServer.js`; тесты
   `dedicatedServer` + сигналинга; `CHANGELOG.md` → `### Security`.
3. **Шаг R3 — значимые (P2-1…P2-4).**
   `src/standalone/index.js`, `src/host/HostGame.js`, `src/dedicated/main.js`,
   `src/host/PortMachine.js` (`hasParticipant`),
   `src/client/network/InlineHostBridge.js`; тесты по каждому пункту; доки
   `dedicated.md` (лимиты).
4. **Шаг R4 — мелкие (P3-1…P3-6).** Одна пачка, тесты только для P3-2 и P3-4.
5. **Шаг R5 — сборка и smoke.** `docker build`, ручные прогоны, отметки в
   `plan/standalone-sdk/README.md`.

Уровень релиза не меняется: `[Unreleased]` остаётся **minor** (`### Added`);
добавляется `### Security` (patch-уровень, minor его перекрывает). Крейт
`vimp-engine-core` не затрагивается, `ENGINE_API_VERSION` не меняется. Поле
`version` не правим — публикует разработчик через `npm run release`.

---

## Верификация

Автоматика (после каждого шага):

```bash
npx eslint . && npm test          # ожидание: 122+ файла, все зелёные
npm run sim:check                 # 9 инвариантов хоста без регресса
npm run build:app                 # прод-бандл + совпадение CSP-хэша importmap
docker build -t vimp-test .       # runner-стадия видит src/host и src/dedicated
```

Ручные прогоны (то, что автотесты в принципе не покрывают):

1. **Standalone (главная проверка P1-1/P1-2).** В `vimp-tanks` через `npm link`:
   `npm run core:build && npm run dev`. Ожидание: видны панель и канвас, форма
   не висит поверх матча, чёрного оверлея нет; `Tab` показывает и скрывает
   таблицу; голосование сменой команды открывается **внутри** `#game` (проверить
   в инспекторе, что `#vote` — потомок контейнера, а не `body`); боты появляются
   без `BOT_PLAYERS_ONLY`.
2. **Dedicated в браузере** (критерий 3 README, ещё не выполнялся):
   `VIMP_DEDICATED_GAME=tanks npm run dedicated`, зайти браузером — вход без
   лобби и OAuth, форма с ником, матч идёт; закрыть вкладку и зайти снова —
   симуляция жива. Отдельно: отправить соединение с `Origin` длиной 200 байт
   (`websocat`/`curl -H`) и убедиться, что процесс жив (P1-4); грубо оборвать
   соединение и убедиться в том же (P1-3).
3. **Регресс лобби** (критерий 4 README): `npm run dev`, создать комнату,
   подключиться вторым клиентом по WebRTC, сменить карту голосованием — поведение
   без изменений (`body > *` сохранено, класс `vimp-shell` попадает на `body`).
4. **Solo при отключённом WebRTC** (заявленное свойство Этапа 2): Firefox с
   `media.peerconnection.enabled = false` — standalone стартует.
