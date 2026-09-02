# Этап 4. Админ-API мастера и интерфейс лобби ✅ выполнен

**Область:** `packages/engine/src/master/`, `packages/engine/src/client/`,
`packages/engine/src/config/lobby.js`, `tests/master/`, `tests/client/`.

**Цель:** разработчик подаёт заявку и следит за её статусом, админ модерирует
и играет в черновик — всё из лобби, без правки конфигов и без рестартов.

## Что нужно знать перед началом

- На мастере **нет ни одной авторизующей middleware**: Bearer-токен просто
  перекладывается в auth (`forwardPlayerData`, `lobby.js:264-289`). Подпись
  мастер проверяет только на WebSocket-пути
  (`SignalingServer._verifyToken`, `:477-490`, через `JwksProxy` +
  `verifyIdentityToken` из `src/lib/jwt.js:46`).
- Интерфейс лобби — один SPA: разметка на pug (`src/client/views/`),
  логика — триплетами MVC (`components/model|view|controller/`), все id
  элементов и URL-ы вынесены в `src/config/lobby.js` (`elems`, `create`).
  Модель не трогает DOM, view не ходит в сеть.
- Токен лежит в `localStorage` под ключом из
  `config/authClient.js:22` (`vimpAuthToken`); `LobbyAuth` декодирует payload
  без проверки подписи (`model/LobbyAuth.js:134-160`) — этого достаточно,
  чтобы решить, показывать ли вкладку.
- Формы валидируются общим `src/client/lib/formBuilder.js`
  (`collectFormErrors`, `renderFormErrors`), ошибки рисуются строками внутри
  контейнера ошибок формы. Новые формы обязаны идти этим же путём.
- Селектор игр заполняет `populateGameSelect()` (`client/main.js:1998-2022`),
  переключение игры делает `createGameActivator`
  (`client/lib/gameActivator.js`), каталог живёт в `gamesById`.

## 4.1 `packages/engine/src/master/adminAuth.js` (новый)

Express-middleware поверх уже существующих кирпичей:

```js
/**
 * @param {JwksProxy} jwksProxy
 * @param {string} issuer
 * @returns {{ required: Function, optional: Function }}
 */
export function createAdminAuth(jwksProxy, issuer)
```

- Снимает `Bearer` из заголовка `authorization`, верифицирует через
  `verifyIdentityToken(token, { jwks: await jwksProxy.get(), issuer })` —
  ровно как `SignalingServer._verifyToken`.
- Кладёт `req.user = { id: Number(payload.sub), nick: payload.nick,
  role: payload.role ?? 'user' }`.
- `required` — без токена `401 {error:'unauthorized'}`, без роли
  `admin`/`superadmin` — `403 {error:'forbidden'}`.
- `optional` — просто заполняет `req.user`, если токен валиден, и всегда
  зовёт `next()` (для `GET /servers`, где админ видит скрытые комнаты).

**Почему здесь достаточно клейма из токена.** Всё, что мастер делает под этой
проверкой сам, — читает списки и скачивает пакет из npm; это не запись и не
приносит вреда даже при 4-часовой протухшей роли. **Любая запись** уходит в
auth, где `requireAdmin` перечитывает роль из БД (Этап 1, §1.5). Разделение
намеренное, в комментарии к модулю его зафиксировать.

## 4.2 Роуты мастера (`lobby.js`)

| Метод | Путь | Доступ | Действие |
| --- | --- | --- | --- |
| `GET` | `/games/mine` | `optional`+токен | прокси `GET /games/mine` auth |
| `POST` | `/games/submit` | `required`(любой авторизованный) | валидация пакета → прокси `POST /games` |
| `POST` | `/games/mine/:id/version` | авторизованный | валидация версии → прокси `POST /games/:id/version` |
| `GET` | `/admin/games` | админ | прокси `GET /admin/games` + локальное состояние каждой игры |
| `GET` | `/admin/games/manifest.json` | админ | манифесты застейдженных версий (`catalog.stagedManifests()`) |
| `POST` | `/admin/games/:id/stage` | админ | `store.inspect` → `catalog.upsert({active:false})`; ответ — вердикт + манифест |
| `PATCH` | `/admin/games/:id` | админ | прокси `PATCH /admin/games/:id` → сразу `gameSync.run()` |
| `GET` | `/admin/games/:id/versions` | админ | `npmRegistry.listVersions` — какие версии есть в npm |

### Правила

- **Валидация до записи.** `POST /games/submit` и
  `POST /games/mine/:id/version` сначала зовут `store.inspect(...)`; при
  `ok: false` возвращают `400 { errors: [...] }` и **в auth не ходят** —
  разработчик получает список проблем сразу, а реестр не засоряется
  заведомо нерабочими заявками.
- **Прямой вызов auth в обход мастера безвреден** и его не нужно закрывать:
  такая запись получает статус `pending`, а мастер перепроверяет пакет при
  каждом скачивании (`GameStore.ensure`), поэтому неотвалидированный код в
  раздачу не попадает. Записать это соображение комментарием.
- `PATCH` со `status: 'approved'` завершается немедленным `gameSync.run()`,
  чтобы админ увидел игру в лобби сразу; остальные мастера подтянут её в
  течение `refreshInterval`.
- «Локальное состояние» в `GET /admin/games` — `{ downloaded: bool,
  stagedVersion: string|null, lastError: string|null }` из `GameStore` и
  каталога. Это то, чем панель отличается от голого списка из БД.
- `GET /servers` (`lobby.js:229`) получает `adminAuth.optional` и передаёт
  `{ includeHidden: req.user?.role === 'admin' || req.user?.role === 'superadmin' }`
  в `registry.getList`.

## 4.3 Разметка

Новый `packages/engine/src/client/views/includes/games.pug`, подключить в
`src/client/views/index.pug` рядом с `lobby`:

```
#games-panel(style='display:none')
  .card#games-mine
    h3 Мои игры
    ul#games-mine-list
    form#games-submit-form
      // поля: id, npm-пакет, версия, ссылка на репозиторий, название
      #games-submit-error
      input#games-submit(type='submit' value='Отправить на модерацию')
  .card#games-moderation(style='display:none')
    h3 Модерация
    .games-filters   // Ожидают / Опубликованы / Отклонены / Отключены
    ul#games-admin-list
    #games-admin-error
```

Кнопки входа в панель — в уже существующий бейдж пользователя
(`lobby.pug:9-38`, `#lobby-user`): «Мои игры» (всем авторизованным) и
«Модерация» (только при админской роли).

Карточка игры в списке модерации показывает: `id`, npm-пакет, автора (ник),
текущую версию, `pending_version`, статус, дату заявки, доступную в npm
версию (из `GET /admin/games/:id/versions`) и кнопки: **Тест**,
**Одобрить**, **Отклонить** (с полем причины), **Отключить**, **Обновить
версию**.

## 4.4 Триплет MVC

`src/client/components/model/Games.js`, `view/Games.js`,
`controller/Games.js` — по образцу `Lobby`/`LobbyAuth`:

- **Model** — состояние (`mine`, `all`, активный фильтр, версии из npm) и
  `fetch` к роутам мастера с Bearer из `LobbyAuth.getToken()`. Никакого DOM.
  Наружу — события `mine-changed`, `admin-changed`, `staged`, `error`.
- **View** — только DOM: отрисовка списков, показ/скрытие панели, рендер
  ошибок через `renderFormErrors` из `formBuilder.js`. Наружу — события
  `submit`, `stage`, `approve`, `reject`, `disable`, `update-version`,
  `filter`.
- **Controller** — связывает их, как `controller/Lobby.js`.

`src/config/lobby.js` — новый блок `games: { elems: {...}, urls: {...} }`
со всеми id и путями (правило репозитория: id элементов не хардкодятся в
модулях).

## 4.5 Роль на клиенте

`src/client/components/model/LobbyAuth.js` — `getRole()`, читающий `role` из
уже декодируемого payload (`_setIdentity`, `:134-160`); отсутствие поля →
`'user'`. `main.js` по нему показывает кнопку «Модерация».

## 4.6 Тестовый прогон черновика

Чтобы админ мог сыграть в застейдженную версию, её манифест должен попасть в
клиентский каталог. В `client/main.js` (рядом с `gamesById` и
`populateGameSelect`, `~:1951-2022`) добавить:

```js
/**
 * Кладёт манифест застейдженной (не одобренной) версии в каталог вкладки —
 * так админ может поднять по нему комнату, не трогая каталог игроков.
 * @param {Object} manifest
 */
function registerGameManifest(manifest) { /* gamesById.set + populateGameSelect */ }
```

- В селекторе такая игра помечается суффиксом «(тест)».
- Дальше всё работает существующим путём: `createGameActivator` грузит
  ClientPlugin по `entries.client`, `connectAsHost` поднимает комнату,
  `register_host` уносит `gameVersion` черновика, мастер помечает комнату
  скрытой (Этап 3, §3.5).
- **Предпосылка из Этапа 3, §3.8.2:** кэш `gameActivator` ключуется
  `${gameId}@${manifest.version}`. Без этого админ, сыгравший в черновик и
  затем зашедший в обычную комнату той же игры, получит из кэша плагин
  черновика. Если Этап 3 по какой-то причине выполнялся без этой правки — она
  обязана быть сделана здесь.

## 4.7 Стили

`src/client/style.css` — новая секция после `/*lobby*/`, в тех же классах
(`.card`, `.form-row`, `.lobby-card`), без новых цветовых переменных.

## 4.8 Тесты

- `tests/master/adminAuth.test.js` — реальный RSA-подписанный JWKS (так уже
  устроен `SignalingServer.test.js`): валидный админский токен, токен без
  роли → 403, протухший → 401, отсутствие заголовка → 401, `optional`
  пропускает без токена.
- `tests/master/lobbyGamesRoutes.test.js` (или дописать в существующие
  master-тесты) — `POST /games/submit` при `ok:false` не ходит в auth;
  `PATCH /admin/games/:id` дёргает `gameSync.run()`; `GET /servers` с
  админским токеном отдаёт скрытые комнаты, без токена — нет.
- `tests/client/GamesModel.test.js` — состояние и запросы на стабе `fetch`.
- `tests/client/GamesView.test.js` (happy-dom) — рендер списков, фильтры,
  рендер ошибок.
- `tests/client/GamesCtrl.test.js` — проброс событий.
- `tests/client/LobbyAuthModel.test.js` — `getRole()` для токена с ролью, без
  роли и для протухшего.

## Критерии готовности

1. `npx eslint . && npm test -- --silent` — зелено.
2. Под админским аккаунтом в лобби видны обе кнопки; под обычным — только
   «Мои игры».
3. Заявка на несуществующий npm-пакет даёт в форме внятный список ошибок, и в
   `games` строка не появляется.
4. Заявка на реальный пакет создаёт строку `pending`, разработчик видит её в
   «Моих играх».
5. «Тест» скачивает версию, игра появляется в селекторе с «(тест)», комната по
   ней поднимается и **не видна** в списке серверов из вкладки без админского
   токена, но видна из вкладки другого админа.
6. «Одобрить» → игра сразу в `GET /games/manifest.json` и в лобби у обычного
   игрока (без перезапуска мастера).
7. «Отклонить» с причиной → разработчик видит статус и текст.
8. Админ сыграл в черновик `tanks`, затем зашёл в комнату на одобренной
   версии — загрузился плагин **одобренной** версии (проверка правки кэша
   `gameActivator`).
