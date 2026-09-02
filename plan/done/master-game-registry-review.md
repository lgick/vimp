# Кодревью: master-game-registry (коммит 57c989c)

Проверено: 91 файл, +8927/−360. `npx eslint .` — чисто, `npm test --silent` —
174 файла / 2047 тестов зелено (перепроверено на текущем дереве).

Разбор по критериям задания — в конце файла. Ниже находки в порядке
серьёзности; у каждой: где, что происходит, почему это проблема, как чинить.

**Статус находок**: ✅ выполнен — исправлены все 13 находок (включая
подпункты 13.1–13.9). `npx eslint .` чисто, `npm test --silent` — 174 файла /
2075 тестов зелено. Коммит не делался: изменения в рабочем дереве.

| № | Уровень | Область | Суть |
| --- | --- | --- | --- |
| [1](#1) ✅ | 🔴 высокий | безопасность | обход каталога через `id` в `POST /games/submit` |
| [2](#2) ✅ | 🔴 высокий | работоспособность | `GameSync._prune` удаляет с диска версию, которую админ поставил на тест |
| [3](#3) ✅ | 🟠 средний | работоспособность | `POST /games` без обязательных полей отвечает 500 |
| [4](#4) ✅ | 🟠 средний | безопасность | заявка качает до 64 МБ из npm без лимитера на мастере |
| [5](#5) ✅ | 🟠 средний | работоспособность | `await gameSync.run()` до `listen` — старт мастера зависит от npm |
| [6](#6) ✅ | 🟠 средний | работоспособность | `maxGameScore` принимается без диапазона → вечный повтор flush хостом |
| [7](#7) ✅ | 🟠 средний | производительность | `GameSync` перечитывает все карты всех игр каждые 60 с |
| [8](#8) ✅ | 🟠 средний | масштабируемость | `run()` без защиты от повторного входа, прокси реестра без таймаута |
| [9](#9) ✅ | 🟠 средний | документированность | `docs/ru/master.md` не обновлён (нарушено правило CLAUDE.md) |
| [10](#10) ✅ | 🟡 низкий | работоспособность | `isStaged` прячет честные комнаты при совпавшем хеше бандла |
| [11](#11) ✅ | 🟡 низкий | безопасность | публичный `GET /games` отдаёт `moderatorNote` и `authorUserId` |
| [12](#12) ✅ | 🟡 низкий | корректность | `compareVersions` ломается на `+build` |
| [13](#13) ✅ | 🟡 низкий | прочее | мелочи: утечка `staticByDir`, 500 на битом URL, TOCTOU лимита, дубли |

---

<a id="1"></a>
## 1. ✅ выполнен — 🔴 Обход каталога через `id` в `POST /games/submit`

**Где**: `packages/engine/src/master/gameRoutes.js:73-80` →
`packages/engine/src/master/GameStore.js:246-251`; роут объявлен в
`packages/engine/src/master/lobby.js:569`.

**Что происходит**. Обработчик заявки принимает `id` как есть:

```js
const { id, packageName, version, title = null, repoUrl = null } = req.body || {};

if (typeof id !== 'string' || typeof packageName !== 'string') {
  res.status(400).json({ error: 'badRequest' });
  return;
}

const verdict = await store.inspect(id, packageName, version);
```

Единственная проверка — `typeof === 'string'`. Дальше `id` без изменений
доезжает до `GameStore._stage`:

```js
const stagingDir = path.join(this._dir, gameId, STAGING, randomBytes(4).toString('hex'));
```

`path.join` схлопывает `..`, поэтому:

```
id = "../../../../tmp/pwn"  →  /tmp/pwn/.staging/deadbeef
id = "a/../../b"            →  /var/vimp/b/.staging/deadbeef
```

Проверено на месте (`node -e "path.join('/var/vimp/games', id, '.staging', 'deadbeef')"`).

**Почему это проблема**. Любой **авторизованный** пользователь (роль не нужна,
роут стоит под `adminAuth.authenticated`) заставляет мастер:

- создать каталоги в произвольной точке ФС (контейнер идёт от root — в
  `Dockerfile` нет `USER`);
- распаковать туда `dist/` любого опубликованного им в npm пакета, то есть
  положить файлы с произвольными именами и содержимым;
- забить диск вне тома `vimp-games` (том с квотой, корень контейнера — нет).

Запись файлов ограничена подкаталогом `<путь>/.staging/<8 hex>/`, то есть
перезаписать существующий файл по фиксированному пути нельзя, а `node-tar`
корректно не выпускает записи за `cwd` (`unpack.js`, «path escaped extraction
target»). Но выбор самого `<путь>` — за атакующим, и это уже произвольная
запись за пределы предназначенного корня.

Важно: проверка `manifest.id === id` в `gamePackageCheck` **не спасает** — она
выполняется уже после `mkdir` + скачивания + распаковки. Ответ будет 400, а
побочный эффект останется.

**Как чинить**. Три слоя, нужны все три.

1. Валидация на входе роута. Завести общий модуль
   `packages/engine/src/master/gameRefs.js` (движковый аналог
   `config.games.*Pattern` auth-сервиса — импортировать из `packages/auth`
   нельзя, это отдельный workspace без рантайм-зависимости):

```js
// packages/engine/src/master/gameRefs.js
// Форматы ссылок на игру. Дублируют packages/auth/src/config/auth.js:games —
// пакеты разные, общей зависимости между ними нет. Значения обязаны
// совпадать: id — сегмент URL раздачи И имя каталога на диске, version —
// сегмент URL И имя подкаталога версии
export const GAME_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
export const GAME_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;
export const PACKAGE_NAME_PATTERN =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

// id мастера, занятые роутами реестра: игра с таким id перекрыла бы их
export const RESERVED_GAME_IDS = new Set(['mine', 'submit', 'manifest']);
```

   и в `gameRoutes.submit`:

```js
if (
  !GAME_ID_PATTERN.test(id ?? '') ||
  RESERVED_GAME_IDS.has(id) ||
  !PACKAGE_NAME_PATTERN.test(packageName ?? '') ||
  (version !== undefined && version !== 'latest' && !GAME_VERSION_PATTERN.test(version))
) {
  res.status(400).json({ error: 'badRequest' });
  return;
}
```

2. Защита в самом `GameStore` — она обязана держаться независимо от того, кто
   и откуда его позвал (тот же принцип, что уже применён к конструктору с
   `W_OK`):

```js
// GameStore.js
function assertSegment(value, what) {
  if (typeof value !== 'string' || value === '' || value !== path.basename(value)) {
    throw new Error(`GameStore: недопустимый ${what} "${value}"`);
  }
}

distDir(gameId, version) {
  assertSegment(gameId, 'идентификатор игры');
  assertSegment(version, 'версия');

  return path.join(this._dir, gameId, version);
}
```

   `path.basename()` отбрасывает всё с разделителем и `..`; проверка ставится
   и в `_stage`, и в `distDir`, и в `listLocalVersions`. Бросок здесь
   допустим: это ошибка вызывающего, а не отказ сети, и она обязана быть
   видна — но в `_stage` он уже накрыт общим `try/catch`, поэтому наружу
   уедет обычный вердикт `{ok: false}`.

3. Тест на каждый слой: `tests/master/lobbyGamesRoutes.test.js` — `id` с
   `../` даёт 400 и `store.inspect` **не зовётся**;
   `tests/master/GameStore.test.js` — `ensure`/`inspect` с таким id не создают
   ничего вне корня.

**Заодно**: `packageName` из тела уходит в
`npmRegistry.fetchPackument` → `${registryUrl}/${packageName.replace('/', '%2F')}`.
`replace` без флага `g` меняет только первый `/`, а нормализацию пути делает
уже `fetch`. С валидным `PACKAGE_NAME_PATTERN` это безвредно, но кодировать
правильнее целиком: `packageName.split('/').map(encodeURIComponent).join('%2F')`.

---

<a id="2"></a>
## 2. ✅ выполнен — 🔴 `GameSync._prune` удаляет версию, которую админ поставил на тест

**Где**: `packages/engine/src/master/GameSync.js:136-149`.

```js
async _prune(games) {
  const keep = new Map();

  for (const game of games) {                       // games — ТОЛЬКО одобренные
    if (!this._localGameIds.has(game.id)) {
      keep.set(game.id, new Set([game.version]));
    }
  }

  for (const { id, version } of this._catalog.stagedManifests()) {
    if (version && keep.has(id) && keep.get(id).size < this._keepVersions) {
      keep.get(id).add(version);
    }
  }
  ...
}
```

`games` — ответ `GET /games` auth-сервиса, то есть `status = 'approved' AND
version IS NOT NULL` (`UserRepository.listApprovedGames`). Условие
`keep.has(id)` во втором цикле означает: застейдженная версия сохраняется
только у игры, которая **уже одобрена**.

**Что ломается**. Основной сценарий модерации — «пришла заявка на новую игру,
админ жмёт „Тест“, играет, потом „Одобрить“»:

1. игра в статусе `pending`, в `GET /games` её нет;
2. `POST /admin/games/:id/stage` качает пакет и кладёт запись в каталог
   (`gameRoutes.js:183-199`);
3. в течение `refreshInterval` (60 с) срабатывает таймер `GameSync` —
   `keep` не содержит этой игры вовсе → `GameStore.prune` попадает в ветку
   `wanted = new Set()` и сносит **все** версии игры вместе с её каталогом
   (`GameStore.js:202-212`);
4. запись в `GameCatalog` остаётся, но её `distDir` теперь указывает в
   никуда: `/games/<id>/<version>/*` начинает отдавать 404 прямо посреди
   тестового матча.

Тот же эффект, но быстрее, даёт `PATCH /admin/games/:id` с любым статусом,
кроме `approved` (`gameRoutes.moderate` зовёт `sync.run()` немедленно) —
например «Отклонить» после теста.

У уже одобренной игры с новой `pending_version` проблемы нет: `keep` содержит
её id, `size (1) < keepVersions (2)`, версия добавляется.

**Как чинить**. Источником `keep` должен быть каталог, а не список одобренных:
на диске обязано лежать ровно то, на что каталог ссылается.

```js
async _prune(games) {
  const keep = new Map();
  const add = (id, version) => {
    if (!version || this._localGameIds.has(id)) {
      return;
    }

    if (!keep.has(id)) {
      keep.set(id, new Set());
    }

    if (keep.get(id).size < this._keepVersions) {
      keep.get(id).add(version);
    }
  };

  // раздаваемая версия каждой игры реестра — первым приоритетом: место в
  // пределах keepVersions она занимает раньше черновиков
  for (const game of games) {
    add(game.id, game.version);
  }

  // застейдженные версии — включая игры, которых в одобренном каталоге нет
  // вовсе (заявка на новую игру, которую админ прямо сейчас тестирует)
  for (const { id, version } of this._catalog.stagedManifests()) {
    add(id, version);
  }

  try {
    await this._store.prune(keep);
  } catch (err) {
    console.warn(`GameSync: prune failed (${err.message})`);
  }
}
```

**Тест** (`tests/master/GameSync.test.js`, рядом с уже имеющимся «prune
получает активные версии и застейдженные в пределах keepVersions»):

> застейдженная версия игры, которой нет в одобренном каталоге, остаётся в
> `keep` — стаб `catalog.stagedManifests()` возвращает `{id: 'new-game',
> version: '1.0.0'}`, `registry.list()` этой игры не отдаёт, ожидание:
> `store.prune` получил `Map { 'new-game' => Set { '1.0.0' } }`.

**Смежное**: `GameStore.prune` сносит и каталог игры целиком
(`GameStore.js:209`), поэтому дырка бьёт сразу по всему. После правки стоит
дополнительно защитить каталог от повисшего `distDir` — например, в
`GameSync.run` перед `prune` снимать из каталога записи, чьих директорий на
диске нет (`store.has`), чтобы каталог и диск не расходились ни в одну
сторону.

---

<a id="3"></a>
## 3. ✅ выполнен — 🟠 `POST /games` без обязательных полей отвечает 500

**Где**: `packages/auth/src/main.js:352-375` (`gameInputError`) и `:377`.

```js
function gameInputError({ id, packageName, version, title, repoUrl }) {
  if (id !== undefined && !isValidGameId(id, config.games)) {
    return 'invalidGameId';
  }
  if (packageName !== undefined && !isValidPackageName(packageName, config.games)) {
    return 'invalidPackageName';
  }
  if (version !== undefined && !isValidGameVersion(version, config.games)) {
    return 'invalidVersion';
  }
  ...
}
```

Охрана `!== undefined` написана под частичное обновление, но `POST /games`
использует эту же функцию как проверку **создания**, где `id`, `packageName`
и `version` обязательны. Тело `{}` проходит валидацию целиком, дальше:

```js
await userRepo.createGame({ id: undefined, packageName: undefined, ... });
```

`node-postgres` превращает `undefined` в `NULL`, INSERT падает на
`NOT NULL`/PK (код `23502`), `catch` ловит только `23505` и делает `throw err`.
Своего обработчика ошибок в `packages/auth/src/main.js` нет — отвечает
дефолтный обработчик Express 5, то есть **500** вместо 400 плюс запись в лог
на каждый кривой запрос.

**Как чинить**. Разделить «поле не пришло» и «поле кривое»:

```js
// обязательные поля заявки: gameInputError проверяет ФОРМАТ, а требование
// присутствия принадлежит конкретному роуту (PATCH-у модерации те же поля
// не обязательны)
const REQUIRED_ON_CREATE = ['id', 'packageName', 'version'];

app.post('/games', requireAuth, byIp(gamesLimiter), async (req, res) => {
  const { id, packageName, title = null, repoUrl = null, version } = req.body || {};
  const body = { id, packageName, version };
  const missing = REQUIRED_ON_CREATE.find(field => body[field] === undefined);

  if (missing) {
    res.status(400).json({ error: 'badRequest', field: missing });
    return;
  }

  const error = gameInputError({ id, packageName, version, title, repoUrl });
  ...
});
```

**Тест**: интеграционных тестов на `main.js` в пакете нет (осознанно, см.
`plan/done/master-game-registry/stage_1.md`, §1.6), поэтому логику проверки
обязательности стоит вынести чистой функцией в `lib/validators.js`
(`missingGameField(body)`) и покрыть её в `tests/auth/validators.test.js`.

**Заодно**: в `packages/auth/src/main.js` вообще нет `app.use((err, req, res,
next) => …)`. Дефолтный обработчик Express в проде отдаёт «Internal Server
Error» без стека, так что утечки нет, но и единого журналирования отказов БД
нет тоже — а `requireAdmin:169` (`next(err)`) на него уже рассчитывает. Стоит
добавить финальный обработчик с `console.error` и `{error: 'internal'}`.

---

<a id="4"></a>
## 4. ✅ выполнен — 🟠 Заявка качает до 64 МБ из npm без лимитера на мастере

**Где**: `packages/engine/src/master/lobby.js:569-570`,
`gameRoutes.js:80` и `:120`.

`POST /games/submit` и `POST /games/mine/:id/version` вызывают
`store.inspect(...)` — это поход в npm registry за пакументом и скачивание
тарболла до `maxTarballBytes` (64 МБ по умолчанию) с распаковкой на диск.
Лимитер `gamesLimiter` (5/мин) стоит **в auth-сервисе**, то есть **после**
скачивания: до auth запрос доходит только с успешным вердиктом.

Любой авторизованный пользователь в цикле шлёт `submit` с именем крупного
публичного пакета и получает: исходящий трафик мастера, распаковку в
`.staging`, нагрузку на event loop от синхронных `fs`-вызовов
`gamePackageCheck`. Роль не нужна.

**Как чинить**. У мастера уже есть свой `RateLimiter`
(`packages/engine/src/lib/rateLimiter.js`, используется для `pingRateLimit` и
`playerDataLimiter`) — применить его к обоим роутам, ключ — `req.user.id`
(пользователь, а не IP: заявка уже требует авторизации):

```js
// lobby.js, рядом с playerDataLimiter
// заявка стоит мастеру похода в npm и распаковки архива, поэтому лимит
// стоит ДО скачивания, а не в auth-сервисе за ним
const gameSubmitLimiter = new RateLimiter({ limit: 5, windowMs: 60000 });

const limitSubmits = (req, res, next) => {
  if (!gameSubmitLimiter.consume(`u${req.user.id}`)) {
    res.status(429).json({ error: 'tooManyRequests' });
    return;
  }

  next();
};

app.post('/games/submit', adminAuth.authenticated, limitSubmits, gameRoutes.submit);
app.post('/games/mine/:id/version', adminAuth.authenticated, limitSubmits, gameRoutes.requestVersion);
```

Плюс проверка формата из находки 1 — она отсекает мусор до сети.

**Смежное (архив-бомба)**: `npmRegistry.extractDist` при превышении лимита
ставит `limitError` и возвращает `false` из фильтра, но поток продолжает
разжиматься до конца. 64 МБ архива с коэффициентом сжатия 1000:1 — это
десятки гигабайт работы zlib (пул потоков, не главный цикл, но время и CPU).
Дешёвая страховка — прервать разбор:

```js
const parser = tarExtract({ ... });

// поток рвётся сразу, а не дочитывается до конца: 64 МБ архива с высоким
// коэффициентом сжатия — это десятки гигабайт разжатия впустую
const source = Readable.from(buffer);

const filter = (entryPath, entry) => {
  ...
  if (maxBytes && bytes > maxBytes) {
    limitError = `распакованное содержимое больше ${maxBytes} байт`;
    source.destroy();

    return false;
  }
  ...
};
```

(`pipeline` тогда отклонится, и `_stage` вернёт вердикт с текстом отказа —
поведение снаружи не меняется, поэтому существующие тесты лимитов остаются
валидными; проверить, что сообщение по-прежнему про лимит, а не про
`ERR_STREAM_PREMATURE_CLOSE` — иначе `limitError` нужно предпочитать ошибке
потока в `catch`.)

---

<a id="5"></a>
## 5. ✅ выполнен — 🟠 `await gameSync.run()` до `listen` — старт мастера зависит от npm

**Где**: `packages/engine/src/master/lobby.js:177`.

```js
// первый проход до listen: мастер стартует уже с каталогом. Его отказ старту
// не мешает — каталог тогда пуст (или остаётся локальным), а следующий цикл
// таймера подхватит реестр, когда тот вернётся
await gameSync.run();
```

Комментарий верен про **отказ**, но не про **медленный ответ**. `run()`
последовательно (в `for … of` с `await`) вызывает `store.ensure` на каждую
игру каталога; у каждой — до двух сетевых запросов с
`timeout = master:gameStore:timeout` (30 с). Десять игр в худшем случае это
до ~10 минут, в течение которых процесс **не слушает порт**: `server.listen`
стоит ниже. Для деплоя это выглядит как зависший контейнер (`restart: always`
+ отсутствие healthcheck → перезапуск и повторный круг), для разработчика —
как молча висящий `npm run dev` при недоступном npm.

**Как чинить**. Разделить «первый проход» и «готовность принимать запросы».
Минимальная правка — общий дедлайн на стартовый проход:

```js
// стартовый проход не должен задерживать listen дольше своего дедлайна:
// каталог пополнится следующим тиком таймера, а мастер обязан начать
// отвечать (в т.ч. на healthcheck) в предсказуемое время
const FIRST_SYNC_DEADLINE = 15000;

await Promise.race([
  gameSync.run(),
  new Promise(resolve => setTimeout(resolve, FIRST_SYNC_DEADLINE).unref?.()),
]);
```

Вариант чище (и его же стоит взять, если появится healthcheck): не ждать
вовсе — `gameSync.run()` без `await`, а `gameSync.start()` перенести туда же,
оставив `listen` первым действием. Тогда лобби до первого прохода отдаёт
пустой каталог — это уже штатное состояние (`console.warn('-> Games loaded:
none…')`).

Дополнительно: `GameSync.run()` внутри цикла по играм ходит в сеть
последовательно. При десятке игр это N×(время скачивания). Для стартового
прохода имеет смысл `Promise.allSettled` с небольшим пределом
параллельности — но только после защиты из находки 8, иначе параллельные
`ensure` начнут гоняться друг с другом.

---

<a id="6"></a>
## 6. ✅ выполнен — 🟠 `maxGameScore` принимается без диапазона

**Где**: `packages/auth/src/main.js:479`.

```js
if (maxGameScore !== undefined && maxGameScore !== null && !Number.isInteger(maxGameScore)) {
  res.status(400).json({ error: 'badRequest' });
  return;
}
```

Проверяется только целостность числа. Значение едет в `games.max_game_score`,
оттуда `GameSync` кладёт его в `GameCatalog`, а `lobby.js:maxGameScoreOf`
клампит им `best`/`points` в `PUT /auth/rank`.

**Почему это проблема**. В `packages/auth/src/config/auth.js` рядом с
`rank.maxPoints` стоит развёрнутое предупреждение — цитата из кода:

> Эта пара СВЯЗАНА с клампом мастера … мастер режет по своему потолку и шлёт
> сюда, и если сюда приходит то, что здесь отклоняется, хост уходит в вечный
> повтор отклонённого тела.

Админ, поставивший игре `maxGameScore = 1000000` (или отрицательное число),
получает ровно этот сценарий: мастер пропускает результат, auth отклоняет его
`isValidGameResult`, хост повторяет flush бесконечно. Инвариант, который
конфиг описывает словами, кодом нигде не защищён.

**Как чинить**. Валидировать по собственным пределам auth-сервиса, там же, где
они объявлены:

```js
// потолок игры не может превышать последнюю линию обороны самого auth:
// иначе мастер пропустит результат, который здесь будет отклонён, и хост
// уйдёт в вечный повтор flush (см. config/auth.js:rank.maxPoints)
const MERGED_GAMES_PER_WINDOW = 20;

if (
  maxGameScore !== undefined && maxGameScore !== null &&
  (!Number.isInteger(maxGameScore) ||
    maxGameScore < 1 ||
    maxGameScore > config.rank.maxGameScore ||
    maxGameScore * MERGED_GAMES_PER_WINDOW > config.rank.maxPoints)
) {
  res.status(400).json({ error: 'invalidMaxGameScore' });
  return;
}
```

Вынести условие чистой функцией `isValidMaxGameScore(value, config.rank)` в
`lib/validators.js` и покрыть в `tests/auth/validators.test.js`: граница,
ноль, отрицательное, превышение `maxPoints`.

Проверить заодно `MERGED_GAMES_PER_WINDOW` — константа названа в комментарии
конфига как «окно склейки движка (20)»; если она живёт в коде движка, в
комментарии к валидатору нужна ссылка на файл, чтобы связь не потерялась.

---

<a id="7"></a>
## 7. ✅ выполнен — 🟠 `GameSync` перечитывает все карты всех игр каждые 60 с

**Где**: `packages/engine/src/master/GameSync.js:104-117` +
`packages/engine/src/master/GameCatalog.js:152-168`.

`run()` вызывает `catalog.upsert(...)` для **каждой** игры на **каждом**
проходе, безусловно. Каждый `upsert` синхронно делает:

- `checkPluginCompatibility(manifest)`;
- `new MapCatalog(this._readMaps(path.join(distDir, 'maps')))` —
  `readdirSync` + `readFileSync` + `JSON.parse` **каждого файла карты**;
- `rebaseManifest` (копия манифеста) и `_rebuild()` —
  `JSON.stringify` всего каталога.

Плюс `GameStore.ensure` на уже скачанной версии повторно гоняет
`checkGamePackage`: ещё один `readFileSync` манифеста и `existsSync` на каждый
entry и каждую карту.

При десяти играх по десятку карт это порядка двух-трёх сотен синхронных
файловых операций в минуту **в главном потоке** мастера, который в это же
время обслуживает сигнальный WebSocket. Направление явно заявлено на рост до
сотни игр (ЭТАП 2 плана) — там это уже тысячи операций в минуту.

**Как чинить**. Проход обязан быть no-op, когда ничего не изменилось. Самое
дешёвое — сравнить то, что уже стоит в каталоге:

```js
// GameCatalog
/**
 * @param {string} id - Идентификатор игры.
 * @param {string|null} version - npm-версия.
 * @returns {boolean} Стоит ли эта версия в каталоге раздаваемой.
 */
hasActive(id, version) {
  return this._active.get(id) === version && this._entries.has(this._key(id, version));
}
```

```js
// GameSync.run(), после успешного ensure
if (this._catalog.hasActive(game.id, result.version)) {
  this._owned.add(game.id);
  this._errors.delete(game.id);
  continue;                       // каталог уже описывает ровно это состояние
}

this._catalog.upsert({ ... });
```

Симметрично в `GameStore.ensure` (`GameStore.js:76-81`) повторная проверка
уже лежащей версии тоже идёт каждый проход. Она названа в комментарии
«бесплатной защитой от порчи тома», но бесплатной не является; разумный
компромисс — проверять раз в N проходов или по `mtime` каталога версии.

**Тест**: в `tests/master/GameSync.test.js` — «повторный проход без изменений
в реестре не трогает каталог» (шпион на `catalog.upsert`, два вызова `run()`,
ожидание: ровно один `upsert`).

---

<a id="8"></a>
## 8. ✅ выполнен — 🟠 `run()` без защиты от повторного входа, прокси реестра без таймаута

**Где**: `packages/engine/src/master/GameSync.js:54,171-181`,
`packages/engine/src/master/GameRegistryProxy.js:14-29`,
`packages/engine/src/master/gameRoutes.js:220`.

Два связанных недосмотра:

1. `start()` заводит `setInterval`, который зовёт `run()` **не дожидаясь**
   предыдущего прохода. Проход при десятке игр и медленном npm легко
   переживает 60-секундный интервал. Плюс `gameRoutes.moderate` вызывает
   `await sync.run()` прямо в обработчике `PATCH`, то есть параллельно
   таймерному. Итог: одновременные `ensure` одной игры (двойное скачивание —
   гонка `rename` обработана, но трафик и распаковка удваиваются) и
   `prune`, работающий по `keep`, посчитанному другим проходом.
2. `GameRegistryProxy._request` вызывает `fetch` **без `AbortSignal`**.
   `npmRegistry` таймаут принимает и использует (`fetchPackument`,
   `downloadTarball`), а поход в auth — нет. Зависший ответ auth-сервиса
   держит проход бесконечно, а таймер тем временем заводит следующие.

**Как чинить**.

```js
// GameSync
async run() {
  // проход не пересекается сам с собой: PATCH модерации зовёт run() поверх
  // таймерного прохода, а медленный npm легко переживает intervalMs
  if (this._running) {
    return this._running;
  }

  this._running = this._run().finally(() => {
    this._running = null;
  });

  return this._running;
}

async _run() { /* прежнее тело */ }
```

(Возврат того же промиса, а не немедленный выход, важен для
`gameRoutes.moderate`: админ должен дождаться завершения синхронизации, а не
получить ответ раньше, чем каталог обновился.)

```js
// GameRegistryProxy
constructor(authServiceUrl, { fetchImpl = fetch, timeout = 15000 } = {}) {
  this._url = authServiceUrl;
  this._fetch = fetchImpl;
  this._timeout = timeout;
}

async _request(path, token, { method = 'GET', body } = {}) {
  const res = await this._fetch(`${this._url}${path}`, {
    method,
    // зависший auth не должен держать проход синхронизации бесконечно —
    // тот же приём, что у npmRegistry
    signal: this._timeout ? AbortSignal.timeout(this._timeout) : undefined,
    ...
  });
  ...
}
```

**Тесты**: `GameSync.test.js` — два одновременных `run()` дают один поход в
реестр; `GameRegistryProxy.test.js` — `signal` передан (проверяется на стабе
`fetchImpl`, как уже сделано с заголовками).

---

<a id="9"></a>
## 9. ✅ выполнен — 🟠 `docs/ru/master.md` не обновлён

**Где**: `docs/ru/master.md`.

Правило репозитория (`CLAUDE.md` → Documentation): «`docs/en/` is canonical,
`docs/ru/` mirrors it exactly … any functional change updates both matching
pages in the same change», причём `src/master/` явно отнесён к `master.md`.

Факт по коммиту:

| Страница | было en/ru | стало en/ru |
| --- | --- | --- |
| `master.md` | 434 / 409 | 518 / **409** |
| `configuration.md` | 504 / 276 | 528 / 289 |
| `deployment.md` | 504 / 381 | 527 / 401 |

В `docs/en/master.md` добавлены три раздела: `GET /games/:id/:version/…`,
«Versioned URL space», «Registry routes (submission and moderation)».
В `docs/ru/master.md` изменены ровно две строки — предложение про
наблюдаемость и абзац про тесты. Не описаны: версионное URL-пространство,
`mapsBase`, роуты `/games/mine`, `/games/submit`, `/admin/games*`, скрытые
тестовые комнаты; таблица модулей (`docs/ru/master.md:27`) не знает про
`GameStore`, `GameSync`, `GameRegistryProxy`, `gameRoutes`, `adminAuth`,
`gamePackageCheck`, `npmRegistry`, `rebaseManifest`.

`configuration.md` и `deployment.md` обновлены пропорционально — там
`VIMP_GAMES_DIR`, `gameStore`, `VIMP_ADMIN_NICKS` присутствуют; претензия
только к `master.md`.

**Как чинить**: перенести три новых раздела `docs/en/master.md` в
`docs/ru/master.md` и дополнить таблицу модулей восемью новыми файлами.
Изменений в коде не требуется.

---

<a id="10"></a>
## 10. ✅ выполнен — 🟡 `isStaged` прячет честные комнаты при совпавшем хеше бандла

**Где**: `packages/engine/src/master/GameCatalog.js:230-248`.

```js
if (entry.version !== activeVersion && entry.manifest.version === manifestVersion) {
  return true;
}
```

`manifest.version` — хеш бандла (client‖host‖wasm), а `entry.version` —
npm-версия. Две **разные** npm-версии могут иметь **одинаковый** хеш бандла:
публикация с правкой только `package.json`, README или метаданных кода не
меняет. Тогда при живой застейдженной записи любая комната на одобренной
версии получает `hidden = true` (`SignalingServer.js:226`) и пропадает из
`GET /servers` для всех, кроме админов.

Вероятность невысока, диагностика — тяжёлая («комнаты есть, но их не видно»).

**Как чинить**: считать комнату тестовой, только если её хеш бандла
**не совпадает** с активной версией:

```js
isStaged(id, manifestVersion) {
  if (!manifestVersion) {
    return false;
  }

  // хеш активной сборки важнее: одна и та же сборка может быть
  // опубликована под двумя npm-версиями (правка только package.json), и
  // тогда комната игрока обязана остаться видимой
  if (this._resolve(id)?.manifest.version === manifestVersion) {
    return false;
  }

  ... // прежний цикл
}
```

**Смежное**: `hidden` вычисляется один раз при `register_host` и больше не
пересматривается. После одобрения версии тестовая комната админа остаётся
скрытой до перерегистрации. Лечится там же — вычислением `hidden` в момент
выдачи `GET /servers` (`HostRegistry.getList`) вместо момента регистрации,
либо явным пересчётом в `GameSync` после смены активной версии. Для текущего
масштаба допустимо оставить как есть, но стоит зафиксировать комментарием.

---

<a id="11"></a>
## 11. ✅ выполнен — 🟡 Публичный `GET /games` отдаёт `moderatorNote` и `authorUserId`

**Где**: `packages/auth/src/main.js:339-341`,
`packages/auth/src/UserRepository.js` (`mapGame`, `listApprovedGames`).

`GET /games` — публичный роут (комментарий: «Публичный, как и /leaderboard»),
auth-сервис выставлен наружу отдельным доменом. `mapGame` отдаёт строку
целиком, включая `moderatorNote` (внутренняя переписка модерации),
`authorUserId` (внутренний id БД), `moderatorNick`, `pendingVersion` и
`maxGameScore` (параметр доверия — знание его точного значения помогает
подбирать накрутку).

Мастеру для каталога нужны ровно `id`, `packageName`, `version`, `repoUrl`,
`title`, `maxGameScore`, `authorNick`.

**Как чинить**: отдельная проекция для публичного списка, а не общий `mapGame`:

```js
// UserRepository
// публичная форма строки: реестр читает и мастер, и любой прохожий, поэтому
// наружу едет только то, что нужно каталогу и футеру лобби
function mapPublicGame(row) {
  return {
    id: row.id,
    packageName: row.package_name,
    title: row.title,
    repoUrl: row.repo_url,
    authorNick: row.author_nick ?? null,
    version: row.version,
    maxGameScore: row.max_game_score,
  };
}
```

и `listApprovedGames()` → `rows.map(mapPublicGame)`. `listGamesByAuthor` и
`listAllGames` остаются на полном `mapGame`.

Проверить, что `GameSync` и `gameRoutes` не читают у строк `/games` ничего
сверх этого списка (сейчас читаются `id`, `packageName`, `version`, `repoUrl`,
`maxGameScore`, `pendingVersion` — последний только в
`gameRoutes.stage`, а он ходит в `listAll`, не в `list`; проверить явно).

---

<a id="12"></a>
## 12. ✅ выполнен — 🟡 `compareVersions` ломается на `+build`

**Где**: `packages/engine/src/master/npmRegistry.js:312-343`.

```js
const [core, pre = ''] = String(value).split('-', 2);
const nums = core.split('.').map(Number);
```

- Метаданные сборки (`1.0.0+build.7`) не отделяются: `core` остаётся
  `"1.0.0+build.7"`, `Number("0+build.7")` → `NaN`, компаратор возвращает
  `NaN`, и `Array.prototype.sort` получает недопустимое значение — порядок
  становится неопределённым. `versionPattern` auth-сервиса такие версии
  **разрешает** (`(?:[-+][0-9A-Za-z.-]+)*`).
- `split('-', 2)` теряет хвост пререлиза: `1.0.0-alpha-1` и `1.0.0-alpha-2`
  сравниваются как равные.

Последствие ограничено: `listVersions` питает только индикатор «есть версия
новее» в панели модерации (`GET /admin/games/:id/versions`). Но именно по нему
админ решает, что публиковать.

**Как чинить**:

```js
const parse = value => {
  // build-метаданные (+…) в сравнении не участвуют вовсе (semver §10),
  // пререлиз отделяется по ПЕРВОМУ дефису и дальше сравнивается целиком
  const withoutBuild = String(value).split('+', 1)[0];
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? '' : withoutBuild.slice(dash + 1);

  return { nums: core.split('.').map(n => Number(n) || 0), pre };
};
```

**Тест** в `tests/master/npmRegistry.test.js`: `['1.0.0+b', '1.0.0',
'1.0.0-alpha-2', '1.0.0-alpha-1', '1.10.0', '1.9.0']` → ожидаемый порядок.

---

<a id="13"></a>
## 13. ✅ выполнен — 🟡 Мелочи

Каждая по отдельности не стоит правки, вместе — список на один проход.

**13.1 `staticByDir` растёт неограниченно** (`lobby.js:700-706`). Инстанс
`express.static` кэшируется по директории и не снимается никогда: каждая
скачанная за время жизни процесса версия оставляет запись навсегда. Утечка
медленная (объект middleware на версию), но при частых обновлениях каталога
накапливается. Чистить в `GameSync` после `prune` (`staticByDir.delete(dir)`
для удалённых) либо ограничить размер.

**13.2 `decodeURIComponent` может бросить** (`lobby.js:714-715`). Запрос
`/games/%ZZ/x.js` даёт `URIError` → Express 5 отдаёт **500** вместо 404.
Обернуть в `try/catch` с `next()`.

**13.3 TOCTOU лимита заявок** (`UserRepository.createGame`). `COUNT(*)`
считается отдельным запросом до `INSERT`; параллельные заявки могут
превысить `maxPerUser`. Лечится проверкой внутри `INSERT … SELECT … WHERE
(SELECT COUNT(*) …) < $n`. Практический вред мал (лимит 20 против лимитера
5/мин), но это гонка.

**13.4 `title` и `repoUrl` собираются, валидируются и нигде не показываются**
(`view/Games.js:118-155`, `_adminItem`). Оба поля есть в форме заявки, едут в
БД, но списки «Мои игры» и «Модерация» печатают только `id — packageName`.
Либо показывать (`title` в заголовке строки, `repoUrl` ссылкой — тогда
проверить, что ссылка ставится через `textContent`/`element.href` с уже
валидированным протоколом), либо убрать поля из формы.

**13.5 Дублирование и хрупкий разбор ключа.** `VERSION_PATTERN` объявлен
дважды (`packages/auth/src/config/auth.js:138`, `lobby.js:590`) — между
пакетами это оправдано, но внутри движка после находки 1 обе константы должны
жить в одном `gameRefs.js` и импортироваться в `lobby.js` и `gameRoutes.js`.
Отдельно: `key.slice(0, key.lastIndexOf('@'))` повторяется в `GameCatalog`
трижды (`:198`, `:238`, `:258`) и молча ломается на id с `@`. Проще хранить
`id` в самой записи (`this._entries.set(key, { id, version, … })`) и убрать
разбор ключа целиком.

**13.6 Зарезервированные id.** Игра с id `mine` или `submit` перекрывается
роутами реестра (`/games/mine`, `/games/submit` объявлены раньше статики).
Запретить их списком (см. `RESERVED_GAME_IDS` в находке 1) — и на мастере,
и в auth при `createGame`.

**13.7 Админ не может обновить чужую игру через мастер.**
`gameRoutes.requestVersion` ищет игру в `registry.mine(...)`, то есть только
среди своих; auth при этом разрешает это админу
(`requestGameVersion(…, {isAdmin})`, `main.js:411`). Ветка админа на мастере
недостижима. Либо использовать `listAll` при админской роли, либо убрать
`isAdmin` из auth как мёртвый путь.

**13.8 `VIMP_ADMIN_NICKS` перезаписывается каждым деплоем**
(`.github/workflows/deploy.yml:141-147`). Строка пишется безусловно, поэтому
незаданная переменная репозитория означает `VIMP_ADMIN_NICKS=` → при
следующем входе `syncRole` разжалует всех суперадминов. Это следствие
осознанного решения («список из окружения — источник истины»), но стоит
защититься: не переписывать строку, если `VIMP_ADMIN_NICKS` пуст, и сказать
об этом в `docs/*/deployment.md`.

**13.9 `adminAuth`: формулировка комментария неточна**
(`adminAuth.js:11-13`). «Всё, что мастер делает под этой проверкой сам, —
читает списки и качает пакет … это не запись» — `POST /admin/games/:id/stage`
пишет на диск и меняет `GameCatalog`, а результат раздаётся всем по
`/games/<id>/<version>/*`. Разжалованный админ в пределах 4 часов жизни токена
может стейджить версии и занимать место на томе. Само решение (не ходить в БД
за ролью на каждый чтение-роут) разумно, но `stage` — единственный
изменяющий состояние мастера роут, и его стоит либо назвать в комментарии
честно, либо проверять роль в auth (лишний поход `GET /admin/games` там уже
делается — `findGame(() => registry.listAll(token))` вернёт 403 разжалованному
админу, то есть защита фактически есть; тогда достаточно поправить
комментарий).

---

## Что сделано хорошо

Отмечаю явно, чтобы при правках это не потерялось:

- **Отказ от исполнения кода игры на мастере.** `gamePackageCheck` —
  структурная проверка без `import()`; `vimp-contract`/`vimp-sim` оставлены
  разработчику. Решение и его обоснование зафиксированы в комментарии модуля.
- **Целостность тарболла проверяется обязательно** (`verifyDigest`), причём
  «нет ни `integrity`, ни `shasum`» — это отказ, а не молчаливый пропуск.
- **Разделение «нет пакета» (404 → `null`) и «реестр не ответил» (throw)** —
  тот же инвариант, что в `scripts/release/registry.js`; без него сетевой сбой
  читался бы как «версии не существует».
- **Атомарный переезд `.staging` → раздача одним `rename`** и обработка гонки
  двух `ensure` через `has()` после неудачного `rename`.
- **`ensure`/`inspect` не бросают наружу**, бросает только конструктор и
  только про право записи, с указанием пути и имени переменной окружения.
- **Роль на записи перечитывается из БД** (`requireAdmin`), а клейм в токене
  честно назван подсказкой клиенту.
- **`maxGameScore` берётся из реестра, а не из манифеста** — игра не может
  завысить себе потолок.
- **`syncRole` через `CASE`** не гасит роль, назначенную из БД, что оставляет
  место будущему `moderator` без новой миграции.
- **Весь вывод во view через `textContent`** — XSS-поверхности нет, хотя
  данные (ники, замечания модератора, тексты ошибок пакета) пользовательские.
- **Приоритет `localGames` над реестром** реализован с однократным логом на
  игру, а не на каждый проход.
- **`surface.json`** дополнен (`manifestFields: version`), ничего не удалено.
- **Тесты**: 42 новых на хранилище/реестр, стабы вместо сети, тарболлы
  собираются в памяти — фикстуры-бинарники в репозиторий не попали.

---

## По критериям задания

| Критерий | Оценка | Комментарий |
| --- | --- | --- |
| Читаемость | хорошо | имена и структура ровные, комментарии объясняют «почему»; хрупкие места — разбор ключа каталога (13.5) |
| Работоспособность | **есть дефекты** | находки 2, 3, 5, 10 |
| Тестируемость | отлично | везде инъекция `fetchImpl`/зависимостей, обработчики отделены от `lobby.js` ради тестов |
| Поддерживаемость | хорошо | границы пакетов соблюдены; мешает дублирование шаблонов (13.5) |
| Безопасность | **есть дефекты** | находки 1, 4, 11; база (integrity, отказ от исполнения кода, tar-фильтр) выбрана верно |
| Производительность | **есть дефекты** | находки 7, 5; синхронный I/O в горячем цикле |
| Масштабируемость | средне | находки 7, 8; заявленный ЭТАП 2 (100 игр) в текущем виде не выдержит |
| Отсутствие дублирования | хорошо | осознанные дубли между пакетами объяснены; внутри движка — 13.5 |
| Документированность | **нарушено правило** | находка 9 (`docs/ru/master.md`) |
| Стандартизация | отлично | стиль, JSDoc, changelog-заголовки и `surface.json` — по правилам репозитория |

## Порядок исправления

1. Находки 1 и 2 — до любого деплоя (первая открывает запись в ФС, вторая
   ломает основной сценарий модерации).
2. Находки 3–6 — одним заходом, все локальные.
3. Находки 7, 8 — до роста каталога.
4. Находка 9 — обязательна по правилу репозитория, кода не касается.
5. Находки 10–13 — накопительно.

Изменений в `packages/engine/contract/surface.json` ни одна правка не требует;
уровень релиза (`minor` по `### ⚠️ Breaking` в `[Unreleased]`) не меняется —
все правки попадают в существующие секции `Fixed`/`Security` **до** релиза,
то есть отдельного заголовка не добавляют.
