# Этап 5. Вкладка «Errors» в админке лобби ✅ выполнен

Репозиторий: `vimp`. Зависит от этапа 1 (админ-API auth-сервиса). Код:
прокси на мастере (`src/master/`, в npm не публикуется) и панель в клиенте
лобби (`src/client/`, `src/config/lobby.js` — **публикуются в npm**).

## Цель

Админ в лобби открывает панель «Errors», видит журнал (свежие сверху,
фильтр по статусу и игре, счётчик, версии, расшифрованный стек), помечает
запись `fixed` / `ignored` / снова `open` с заметкой. Dedicated-боксы
админки не имеют (нет OAuth) — журнал с них смотрится с любого лобби-мастера,
он общий.

## Что прочитать перед началом

- `packages/engine/src/master/adminAuth.js` — `required` кладёт
  `req.user` и `req.authToken` (Bearer вызывающего);
  `packages/engine/src/master/GameRegistryProxy.js` и
  `gameRoutes.js` → `adminList` (стр. ~321): образец «мастер перекладывает
  Bearer админа в auth и возвращает `status/json` как есть», функция
  `unavailable(res, err)` для отказа сети.
- `packages/engine/src/master/HostRatingProxy.js` — образец класса-прокси с
  `fetchImpl`.
- `packages/engine/src/master/lobby.js` стр. ~611–631 — регистрация
  `/admin/games*` с `adminAuth.required`.
- Панель реестра игр — образец MVC-тройки и разметки:
  `src/client/components/{model,view,controller}/Games.js`,
  `src/client/views/includes/games.pug`, кнопки в
  `src/client/views/includes/lobby.pug` (`#games-open-moderation`, видна
  только админу), блок `games` в `src/config/lobby.js` (все URL и id
  элементов — только в конфиге, модули их не хардкодят), стили в
  `src/client/style.css`; в `src/client/main.js` — где создаётся `games` и
  `games.setAdmin(lobbyAuthModel.getRole() === 'admin')` (стр. ~2289), как
  модель Games ходит в API с токеном (найти в `model/Games.js`).
- Тесты панели: `tests/client/GamesModel.test.js`, `GamesView.test.js`,
  `GamesCtrl.test.js`.

## Шаги

### 5.1. Прокси на мастере — `packages/engine/src/master/ClientReportsProxy.js`

```js
// Проксирует журнал клиентских ошибок central auth-сервиса под мастером
// (plan/client-reports, этап 5): Bearer админа перекладывается как есть,
// роль перепроверяет сам auth (requireAdmin читает её из БД)
export default class ClientReportsProxy {
  constructor(authServiceUrl, { fetchImpl = fetch } = {}) { … }
  list(token, { status, gameId, limit, offset }) { … } // GET /admin/client-reports?…
  setStatus(token, id, { status, note }) { … }        // PATCH /admin/client-reports/:id
}
```

- Параметры запроса собирать через `URLSearchParams`, пропуская
  `undefined`; `id` — `encodeURIComponent`.
- Возвращать `{ status, json }` (как `HostRatingProxy._request`).

Маршруты в `lobby.js` рядом с `/admin/games`:

```js
app.get('/admin/client-reports', adminAuth.required, clientReportsRoutes.list);
app.patch('/admin/client-reports/:id', adminAuth.required, clientReportsRoutes.setStatus);
```

Обработчики — в отдельном модуле `packages/engine/src/master/clientReportsRoutes.js`
(`createClientReportsRoutes({ proxy })` → `{ list, setStatus }`), чтобы
тестироваться без подъёма `lobby.js`: `list` пропускает в прокси только
`status`, `gameId`, `limit`, `offset` из `req.query`; `setStatus` — только
`status`, `note` из `req.body`; ответ auth отдаётся с его статусом и телом;
исключение сети → `502 { error: 'authUnavailable' }` (или та же функция
`unavailable`, если её можно импортировать из `gameRoutes.js` — вынести в
общий модуль, если нужно).

### 5.2. Конфиг панели — `packages/engine/src/config/lobby.js`

Новый блок рядом с `games` (по его образцу, с комментариями):

```js
// журнал клиентских ошибок (plan/client-reports, этап 5): только админ.
// URL и id элементов — здесь, как у панели реестра игр
clientReports: {
  urls: {
    list: '/admin/client-reports',
    setStatus: id => `/admin/client-reports/${encodeURIComponent(id)}`,
  },
  pageSize: 50,
  // графы: значения совпадают со статусами auth-сервиса, 'all' — без фильтра
  statuses: [
    { id: 'open', title: 'Open' },
    { id: 'fixed', title: 'Fixed' },
    { id: 'ignored', title: 'Ignored' },
    { id: 'all', title: 'All' },
  ],
  elems: {
    openBtnId: 'reports-open',
    panelId: 'reports-panel',
    closeBtnId: 'reports-close',
    filtersId: 'reports-filters',
    gameSelectId: 'reports-game',
    listId: 'reports-list',
    moreBtnId: 'reports-more',
    errorId: 'reports-error',
  },
},
```

(Имена ключей `elems` привести к тому, как устроен блок `games` — там может
быть другое соглашение; следовать ему.)

### 5.3. Разметка

- `src/client/views/includes/lobby.pug` — в `div.lobby-user-actions`
  кнопка `input#reports-open(type='button', value='Errors',
style='display:none')` рядом с `#games-open-moderation`.
- Новый `src/client/views/includes/reports.pug` (подключить там же, где
  `games.pug`), по образцу `games.pug`: `div#reports-panel(style='display:none')`
  → шапка (`h3` «Client errors», `input#reports-close` «Back to lobby»),
  графы `div#reports-filters`, `select#reports-game` (опция «All games» +
  игры каталога), `ul#reports-list`, `input#reports-more` «Load more»,
  `div#reports-error.form-error`. Подписи — по-английски, как всё лобби.

### 5.4. MVC-тройка `ClientReports`

Файлы `src/client/components/model/ClientReports.js`,
`view/ClientReports.js`, `controller/ClientReports.js` — повторить
устройство `Games` (publisher, привязка к `elems`, способ получения токена).

Модель:

- состояние: `status` (по умолчанию `'open'`), `gameId` (`null`), `items`,
  `total`, `offset`, `loading`, `error`;
- `load({ reset })` → `GET list?status&gameId&limit=pageSize&offset` с
  `authorization: Bearer <token>`; `reset` — очистить список; ответ
  `{ reports, total }` дописывается к `items`;
- `setStatus(id, status, note)` → `PATCH` → заменить запись в `items`
  ответом `{ report }`; если запись больше не подходит под текущую графу
  (например, «Open» → `fixed`) — убрать её из списка и уменьшить `total`;
- ошибки сети/401/403/5xx — в `error` (текст для `#reports-error`), без
  исключений наружу.

Представление:

- строка списка (свёрнутая): `lastSeen` (относительное время: «5 min ago»
  — если в лобби уже есть форматтер, взять его, `src/lib/formatters.js`),
  `×count`, `kind/source`, `code ?? message` (обрезать до 120 символов),
  `gameId@gameVersion`, `engine <engineVersion>`, `box`, статус;
- по клику — развёрнутая часть: полный `message`, `stack` в `<pre>` (моно,
  прокрутка по горизонтали, `max-height` с прокруткой), `details` —
  `JSON.stringify(details, null, 2)` в `<pre>`, `userAgent`, `firstSeen`,
  `fingerprint` (первые 12 символов), заметка и кто/когда менял статус;
  поле заметки + кнопки «Mark fixed», «Ignore», «Reopen» (показывать только
  допустимые для текущего статуса);
- **Безопасность (обязательно):** все поля отчёта — данные злоумышленника
  (любой браузер может прислать любую строку). Выводить **только через
  `textContent`** / `document.createTextNode`, никогда через `innerHTML`,
  шаблонные строки в разметку или `insertAdjacentHTML`. Это проверяется
  тестом (см. ниже).
- графы — кнопки из `config.statuses`, активная выделена; смена графы или
  игры — `load({ reset: true })`; «Load more» виден, пока `items.length <
total`.

Контроллер: `setAdmin(isAdmin)` — показать/скрыть `#reports-open`
(вызвать рядом с `games.setAdmin(...)` в `main.js`, стр. ~2289);
открытие панели прячет лобби так же, как это делает панель Games (найти в
`view/Games.js` `show()` и повторить механику), закрытие — возвращает.

### 5.5. Стили — `src/client/style.css`

Классы для списка/строки/развёрнутой части/`<pre>` — по образцу
`.games-list`/`.games-filters`, без новых цветов вне существующей палитры
(взять переменные, которыми пользуется панель Games).

## Тесты

- `tests/master/ClientReportsProxy.test.js` — URL и заголовки (`Bearer`),
  пропуск `undefined` в query, `encodeURIComponent(id)`, `{ status, json }`
  из ответа.
- `tests/master/clientReportsRoutes.test.js` — фильтрация полей query/body,
  проброс статуса auth (200/400/403/404), сеть упала → 502.
- `tests/client/ClientReportsModel.test.js` — загрузка страницы и «ещё»,
  смена графы сбрасывает список, `setStatus` убирает запись из «Open»,
  ошибки → `error`.
- `tests/client/ClientReportsView.test.js` — **XSS**: отчёт с `message:
'<img src=x onerror=alert(1)>'` и таким же `stack`/`details` →
  в DOM нет элемента `img`, текст виден буквально; кнопки статуса по
  статусу записи; «Load more» скрыт при `items.length === total`.
- `tests/client/ClientReportsCtrl.test.js` — `setAdmin(false)` прячет
  кнопку, `setAdmin(true)` показывает.

## Документация (en + ru)

- `master.md` — маршруты `GET/PATCH /admin/client-reports` (прокси,
  `adminAuth.required`, роль перепроверяет auth).
- `client.md` — панель «Errors»: кто видит, что показывает, статусы и
  правило «повтор не переоткрывает; новая версия — новая запись».
- `auth.md` — ссылка на панель из раздела «Client reports».

## Журнал

`packages/engine/CHANGELOG.md`, `## [Unreleased]` → `### Added`:

- Lobby admin panel «Errors»: the client error log with filters, stack
  traces and `open` / `fixed` / `ignored` statuses
  (`GET/PATCH /admin/client-reports` on the master, proxied to the auth
  service).

## Проверка

```bash
npx eslint .
npm test --silent
```

Ручная: лобби локально (этапы 1–3 подняты), войти админом (`VIMP_ADMIN_NICKS`

- dev-вход), в журнале есть записи (вызвать ошибку в DevTools, как в
  `stage_3.md`) → кнопка «Errors» видна только админу; список, фильтры,
  развёрнутый стек; «Mark fixed» убирает запись из «Open» и показывает её в
  «Fixed»; повтор той же ошибки увеличивает `count` у записи в «Fixed», в
  «Open» она не возвращается. Под обычным игроком кнопки нет, прямой
  `GET /admin/client-reports` → 401/403.

## Готово, когда

- панель работает у админа и скрыта у остальных; вывод только через
  `textContent` (тест XSS зелёный);
- тесты, линт, документация, журнал — готовы;
- этот файл и строка в `README.md` помечены «✅ выполнен»; в отчёте —
  release impact: `vimp-engine` minor (`src/client`, `src/config/lobby.js`).
