Для реализации этой задачи подготовлен подробный пошаговый план изменений для всех слоев архитектуры проекта.

**Статус: реализовано целиком** (2026-08-02). Расхождения этого черновика с
фактическим кодом (нет колонки `voided` в `ratings`, нужен новый индекс,
`forwardPlayerData` требует Bearer и не подходит для публичного
`/leaderboard`, fetch на клиенте живёт в `main.js`, а не в модели, и т.д.)
учтены и описаны в финальном плане, по которому шла реализация — см. историю
диалога/итоговый summary. Ниже — статус по шагам исходного черновика.

---

### Архитектурная схема движения данных

```
[Браузер Клиента]
   │
   ├───(REST)───► [Master Server (PlayerDataProxy)]
   │                 │
   │              (REST)
   │                 ▼
   └────────────► [Central Auth (Express / DB SQL)]
```

---

### Шаг 1: Доработки Центрального Сервиса Авторизации (`packages/auth/`) ✅ выполнен

В рамках этого шага добавляется поддержка вычисления лидерборда и нахождения текущей позиции пользователя в базе данных PostgreSQL.

#### 1.1. Доработка `packages/auth/src/UserRepository.js`

Добавить два метода для работы с БД:

- **`getLeaderboard(gameId, limit)`**:
  - **SQL-запрос**:
    ```sql
    SELECT u.nick, r.rank
    FROM ratings r
    JOIN users u ON r.user_id = u.id
    WHERE r.game_id = $1 AND r.voided = false
    ORDER BY r.rank DESC
    LIMIT $2;
    ```
- **`getPlacement(userId, gameId)`**:
  - **SQL-запрос** (для определения порядкового места пользователя по его рейтингу относительно других участников той же игры):
    ```sql
    SELECT
      (SELECT COUNT(*) + 1 FROM ratings WHERE game_id = $1 AND rank > current_user_rating.rank AND voided = false) as placement,
      (SELECT COUNT(*) FROM ratings WHERE game_id = $1 AND voided = false) as total,
      current_user_rating.rank as rank
    FROM (
      SELECT COALESCE(rank, 0) as rank
      FROM ratings
      WHERE user_id = $2 AND game_id = $1
    ) as current_user_rating;
    ```
  - _Примечание_: Если записи пользователя в этой игре еще нет, возвращать дефолтные значения (`placement: total`, `rank: 0`).

#### 1.2. Доработка роутера в `packages/auth/src/main.js`

Зарегистрировать новые эндпоинты:

- **`GET /leaderboard`** (Публичный):
  - Параметры запроса: `game` (строка), `limit` (число, по умолчанию 10).
  - Вызывает `UserRepository.getLeaderboard(gameId, limit)` и возвращает JSON-ответ `{ leaderboard, total }`.
- **`GET /placement`** (Защищенный, требует Bearer JWT):
  - Использует middleware `requireAuth`.
  - Параметры запроса: `game` (строка).
  - Читает `userId` из расшифрованного токена (`req.user.sub`), вызывает `UserRepository.getPlacement(userId, gameId)` и возвращает JSON `{ placement, total, rank }`.

---

### Шаг 2: Доработки Мастер-Сервера (`packages/engine/src/master/`) ✅ выполнен

Мастер-сервер должен безопасно проксировать запросы клиента на сервер авторизации.

#### 2.1. Доработка `packages/engine/src/master/PlayerDataProxy.js`

Добавить методы-обработчики:

- `getLeaderboard(req, res)`: отправляет `GET` запрос к Auth на эндпоинт `/leaderboard` с пробросом параметров `game` и `limit`.
- `getPlacement(req, res)`: отправляет `GET` запрос к Auth на `/placement` с пробросом заголовка `Authorization: Bearer <token>` и параметра `game`.

#### 2.2. Регистрация эндпоинтов в `packages/engine/src/master/main.js`

- Зарегистрировать пути:
  - `GET /auth/leaderboard` $\rightarrow$ `playerDataProxy.getLeaderboard`
  - `GET /auth/placement` $\rightarrow$ `playerDataProxy.getPlacement`
- Добавить валидацию параметра `game` перед проксированием: он должен строго соответствовать списку зарегистрированных в `GameCatalog` идентификаторов (`gameCatalog.ids`), защищая пространство имен БД от некорректных записей.

---

### Шаг 3: Верстка и Стилизация Клиента (`packages/engine/src/client/`) ✅ выполнен

Перевод верстки лобби на двухколоночный сплит-интерфейс и внедрение системных (неоформленных) элементов управления.

#### 3.1. Обновление шаблона лобби (`packages/engine/src/client/views/includes/lobby.pug` или аналогичного)

Переписать структуру `#lobby`:

- Обернуть всё содержимое в сетку `.lobby-grid`.
- **Левая панель (`#lobby-setup-panel.card`)**:
  - Оставить внутри заголовок `VIMP`, блок профиля `#lobby-user`, кнопку `#lobby-user-logout`.
  - Добавить селектор выбора игры `#lobby-game` (сделать его видимым).
  - Убедиться, что все инпуты (`#lobby-name`, `#lobby-fields input`) и селекты не имеют пользовательских CSS-классов оформления, делающих их кастомными. Они должны рендериться браузером по умолчанию.
- **Правая панель (`#lobby-browser-panel.card`)**:
  - Добавить блок переключения вкладок `.lobby-tabs-header` с кнопками `#btn-show-servers` (активна по умолчанию) и `#btn-show-leaderboard`.
  - Создать контейнер `#lobby-servers-content` (виден по умолчанию): вложить туда поисковую строку `#lobby-search` и список `#lobby-list`.
  - Создать контейнер `#lobby-leaderboard-content` (скрыт по умолчанию): вложить туда элементы заголовка `#leaderboard-title`, счетчик `#leaderboard-total-players`, список `<ol id="lobby-leaderboard-list">` и нижнюю плашку `#lobby-my-placement` для вывода позиции текущего юзера.

#### 3.2. Обновление CSS (`packages/engine/src/client/style.css` или аналогичный файл стилей)

- **Сетка и адаптивность**:
  - Описать `.lobby-grid` как Flex-контейнер (`flex-direction: row; gap: 20px; align-items: flex-start;`).
  - Добавить медиа-запрос `@media (max-width: 800px)` для перестроения `.lobby-grid` в `flex-direction: column`.
- **Отказ от кастомного стиля полей**:
  - Удалить или переопределить стили для `.field-text`, `.field-select` и чекбоксов на левой панели создания сервера, чтобы вернуть им стандартное, квадратное («beveled/boxy») отображение браузера по умолчанию (белый фон, черные границы `#767676`, стандартный вид системной кнопки select).
- **Вкладки (Tabs)**:
  - Добавить стили для `.lobby-tab-btn`. Активный класс `.active` должен иметь белое подчеркивание (`border-bottom: 2px solid #fff`).
- **Рейтинги**:
  - Элементы списка `#lobby-leaderboard-list li` должны иметь цвет фона `#363636`, рамку `1px solid #444`, шрифт `monospace` и одинаковый серый цвет текста для всех строчек (включая топ-3).
  - Аналогично оформить плашку `#lobby-my-placement` без использования ярких желтых рамок и шрифтов — серый цвет текста и подложка должны полностью совпадать со списком.

---

### Шаг 4: Разработка Клиентской MVC-логики лобби (`packages/engine/src/client/components/`) ✅ выполнен

Обновление модели, контроллера и представления для реализации переключения вкладок, фильтрации и подгрузки рейтингов.

#### 4.1. Обновление Модели (`LobbyModel.js`)

- Добавить состояние:
  - `leaderboard` (массив топ-игроков);
  - `totalPlayers` (число участников);
  - `myPlacement` (позиция текущего игрока, объект `{ placement, rank }`).
- Добавить методы запросов:
  - `fetchLeaderboard(gameId)`: выполняет `fetch` к `/auth/leaderboard?game=${gameId}` и сохраняет результат в состояние.
  - `fetchPlacement(gameId)`: выполняет `fetch` к `/auth/placement?game=${gameId}` с авторизационным Bearer-токеном, сохраненным в `LobbyAuthModel`.
- Оповещать подписчиков через `Publisher` о получении данных событиями (например, `leaderboard-updated`).

#### 4.2. Обновление Представления (`LobbyView.js`)

- **Инициализация**:
  - Навесить слушатели событий клика на `#btn-show-servers` и `#btn-show-leaderboard`.
- **Управление вкладками**:
  - При клике на вкладки переключать классы `.active` и отображение блоков (`#lobby-servers-content` $\rightarrow$ `display: block/none`, `#lobby-leaderboard-content` $\rightarrow$ `display: none/block`).
- **Вывод серверов (Обновление формата)**:
  - Переписать рендер карточек серверов в методе отрисовки списка:
    - Название сервера рендерить как: `${server.gameId}/${server.name}`.
    - Подстроку информации рендерить как: `${server.mapName} · ${server.currentPlayers}/${server.maxPlayers} · ${server.region || 'unknown'}`.
- **Отрисовка Leaderboard**:
  - Подписаться на событие `leaderboard-updated` модели.
  - При вызове: очищать список `#lobby-leaderboard-list` и наполнять его элементами `<li>` из ТОП-10 в моноширинном сером стиле.
  - Заполнять `#lobby-my-placement` данными из `myPlacement` в аналогичном сером формате.

#### 4.3. Обновление Контроллера (`LobbyController.js`)

- **Событие смены игры**:
  - Навесить слушатель `change` на `#lobby-game`.
  - При смене игры:
    1. Запустить стандартную регенерацию полей настройки `#lobby-fields` с помощью `formBuilder.js`.
    2. Вызвать в модели `fetchLeaderboard` и `fetchPlacement` для новой игры.
- **Поисковый запрос**:
  - При вводе текста в `#lobby-search` проверять наличие символа `/` (например, `tanks/`).
  - Реализовать фильтрацию списка серверов: если строка поиска содержит слеш, подстрока до слеша сопоставляется с `gameId` сервера, а подстрока после слеша — с его именем `name`. При несовпадении полностью удалять элемент из DOM-дерева списка.
- **Сортировка списка серверов по умолчанию**:
  - В случае отсутствия поискового запроса, список серверов на клиенте должен сортироваться по пингу (по возрастанию), а при равенстве пинга — по значению рейтинга хоста `rating` (по убыванию).
