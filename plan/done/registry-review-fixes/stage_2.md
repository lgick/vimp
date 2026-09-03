# Этап 2. Удаление игры: auth → мастер → лобби ✅ выполнен

**Задача заказчика № 1.** Находка F5 в [review.md](review.md).

## Решения заказчика (зафиксировано)

1. Удаление — **жёсткое**: строка `games` удаляется, и вместе с ней
   удаляются все данные игры по `game_id` (`ratings`, `rank_events`,
   `rank_periods`, `state_snapshots`, `states`). Причина: FK на `games`
   у этих таблиц нет, и осиротевшие строки «воскресли» бы при повторной
   заявке под тем же id.
2. Кто удаляет:
   - **админ** — любую игру в любом статусе (`pending`, `approved`,
     `rejected`, `disabled`);
   - **автор** — только свою и только в статусах `pending`, `rejected`,
     `disabled`. Опубликованную (`approved`) игру автор удалить не
     может: в неё прямо сейчас играют. Сначала админ снимает её с
     раздачи (`disabled`), потом удаление становится доступно.

## 2.1. auth-сервис: `UserRepository.deleteGame`

Файл: `packages/auth/src/UserRepository.js`, секция «РЕЕСТР ИГР», после
`moderateGame`.

```js
  /**
   * Удаление игры из реестра вместе со всеми её данными.
   *
   * Жёсткое, а не пометка: ни у одной из таблиц с `game_id` нет FK на
   * `games`, и оставленные строки вернулись бы вместе с игрой, заведённой
   * под тем же id.
   *
   * Транзакцией не обёрнуто (этот класс нигде не держит транзакции — тот
   * же уровень гарантий, что у `voidHosterContributions`), поэтому
   * порядок выбран так, чтобы прерывание на середине было безопасным:
   * сначала производные данные, строка `games` — последней. Повтор после
   * сбоя доделывает начатое, а игра до этого момента остаётся видимой.
   *
   * @param {string} id - Идентификатор игры.
   * @param {Object} actor - Кто удаляет.
   * @param {number} actor.userId - Идентификатор вызывающего.
   * @param {boolean} [actor.isAdmin] - Админская ли роль (из БД, не из токена).
   * @returns {Promise<Object>} Удалённая строка (проекция mapGame).
   * @throws {GameNotFoundError} Игры нет.
   * @throws {GameForbiddenError} Игра чужая, либо своя, но опубликованная.
   */
  async deleteGame(id, { userId, isAdmin = false }) {
    const game = await this.getGame(id);

    if (!game) {
      throw new GameNotFoundError(id);
    }

    if (!isAdmin) {
      if (game.authorUserId !== userId) {
        throw new GameForbiddenError(id);
      }

      // опубликованную игру раздают мастера, и в неё играют прямо
      // сейчас: снять её с раздачи — решение модератора, а не автора
      if (game.status === 'approved') {
        throw new GamePublishedError(id);
      }
    }

    for (const table of [
      'rank_periods',
      'rank_events',
      'state_snapshots',
      'states',
      'ratings',
    ]) {
      await this._db.query(`DELETE FROM ${table} WHERE game_id = $1`, [id]);
    }

    await this._db.query('DELETE FROM games WHERE id = $1', [id]);

    return game;
  }
```

Замечания исполнителю:

- имена таблиц подставляются из **литерального массива в коде**, не из
  входных данных — SQL-инъекции здесь нет, и это стоит отметить
  комментарием в одну строку;
- список таблиц сверить с миграциями: `ratings`, `states`
  (`001_init.sql`), `rank_events`, `state_snapshots`
  (`003_rank_ledger.sql`), `rank_periods`
  (`008_rank_period_aggregates.sql`). У `host_ratings`/`host_votes`
  колонки `game_id` нет — их не трогать;
- `game.authorUserId` — проверить, что проекция `mapGame` действительно
  отдаёт это поле под таким именем (см. `GAME_FIELDS`/`mapGame` в том же
  файле); если имя другое — использовать фактическое;
- новый класс ошибки рядом с `GameForbiddenError` (начало файла):

```js
export class GamePublishedError extends Error {
  constructor(id) {
    super(`game "${id}" is published`);
    this.name = 'GamePublishedError';
    this.gameId = id;
  }
}
```

## 2.2. auth-сервис: маршрут `DELETE /games/:id`

Файл: `packages/auth/src/main.js`, сразу после
`POST /games/:id/version` (до блока `/admin/games`). Импорт
`GamePublishedError` добавить к уже импортируемым классам ошибок.

```js
// DELETE /games/:id — удаление игры из реестра. Один маршрут на обе
// роли: право решает не путь, а роль из БД (тот же приём, что у
// POST /games/:id/version). Админ удаляет любую игру, автор — свою и
// только не раздаваемую
app.delete('/games/:id', requireAuth, byIp(gamesLimiter), async (req, res) => {
  try {
    const isAdmin = await isAdminUser(req.user.id);
    const game = await userRepo.deleteGame(req.params.id, {
      userId: req.user.id,
      isAdmin,
    });

    res.json({ game: isAdmin ? game : forAuthor(game) });
  } catch (err) {
    if (err instanceof GameNotFoundError) {
      res.status(404).json({ error: 'unknownGame' });
      return;
    }

    if (err instanceof GamePublishedError) {
      res.status(409).json({ error: 'gamePublished' });
      return;
    }

    if (err instanceof GameForbiddenError) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    throw err;
  }
});
```

Порядок `catch`-веток важен: `GamePublishedError` проверяется до
`GameForbiddenError`, если решено наследовать первый от второго (не
обязательно; проще сделать оба независимыми от `Error`).

## 2.3. Мастер: прокси и роут

**`packages/engine/src/master/GameRegistryProxy.js`** — рядом с
`moderate`:

```js
  // удаление игры из реестра (право решает auth по роли из БД)
  remove(token, id) {
    return this._request(`/games/${encodeURIComponent(id)}`, token, {
      method: 'DELETE',
    });
  }
```

**`packages/engine/src/master/gameRoutes.js`** — новый обработчик рядом
с `moderate`:

```js
    // DELETE /games/mine/:id — удаление игры. Право проверяет auth
    // (админ — любую, автор — свою неопубликованную), мастер лишь
    // убирает за собой: запись каталога снимается сразу, а файлы версий
    // выметает ближайший prune внутри sync.run()
    async remove(req, res) {
      try {
        const { status, json } = await registry.remove(req.authToken, req.params.id);

        if (status === 200) {
          // remove(id) без версии снимает ВСЕ записи игры, включая
          // застейдженные админом черновики: их не убирает больше никто
          catalog.remove(req.params.id);
          await sync.run();
        }

        res.status(status).json(json);
      } catch (err) {
        unavailable(res, err);
      }
    },
```

**`packages/engine/src/master/lobby.js`** — регистрация рядом с
`POST /games/mine/:id/version` (около строки 614):

```js
// удаление игры: тот же лимитер, что у заявки — роут дёргает auth и
// синхронизацию каталога. Роль здесь не проверяется (`authenticated`, не
// `required`): игру удаляет и её автор, а решает auth по роли из БД
app.delete('/games/mine/:id', adminAuth.authenticated, limitSubmits, gameRoutes.remove);
```

Путь `/games/mine/:id` выбран намеренно: он уже занят реестром
(`/games/mine/:id/version`), не пересекается с версионным пространством
`/games/:id/:version/...` и объявлен до статики `/games`.

## 2.4. Клиент лобби

**`packages/engine/src/config/lobby.js`**, блок `games.urls` — рядом с
`version`:

```js
      // удаление игры: и «My games» (автор), и «Moderation» (админ)
      // ходят одним URL — право решает auth
      remove: id => `/games/mine/${encodeURIComponent(id)}`,
```

**`components/model/Games.js`** — новый метод рядом с `requestVersion`:

```js
  // удаление игры. scope решает, чей список перечитать: карточка автора
  // и очередь модерации показывают разные проекции одной строки
  async remove(id, scope = 'mine') {
    const { ok, json } = await this._request(this._config.urls.remove(id), {
      method: 'DELETE',
    });

    if (!ok) {
      this._fail(scope, json);
      return;
    }

    if (scope === 'admin') {
      await this.loadAdmin();
      return;
    }

    await this.loadMine();
  }
```

**`components/view/Games.js`**:

1. В `ERROR_MESSAGES` добавить код, который теперь может приехать:

```js
  gamePublished: 'Published game — ask an admin to disable it first',
```

2. Общая кнопка удаления с подтверждением в два нажатия (модальных
   `confirm()` в лобби нет ни одного, и заводить их не нужно):

```js
  // Удаление необратимо и уносит рейтинги игры, поэтому кнопка требует
  // второго нажатия: первое переводит её в «Confirm delete», второе
  // публикует событие. Уход мышью/повторная отрисовка списка возвращают
  // её в исходное состояние — незавершённое подтверждение не переживает
  // перерисовку
  _deleteButton(onConfirm) {
    const btn = this._button('Delete', () => {
      if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.value = 'Confirm delete';
        btn.classList.add('games-delete-armed');
        return;
      }

      onConfirm();
    });

    btn.className = 'games-delete-btn';

    return btn;
  }
```

3. В `renderMine` — кнопка после «Update version»:

```js
      item.appendChild(
        this._deleteButton(() => this.publisher.emit('delete', { id: game.id, scope: 'mine' })),
      );
```

4. В `_adminItem` — кнопка последней, после «npm versions»:

```js
    item.appendChild(
      this._deleteButton(() => this.publisher.emit('delete', { id: game.id, scope: 'admin' })),
    );
```

**`components/controller/Games.js`**:

```js
    vp.on('delete', 'remove', this);
```

```js
  remove({ id, scope }) {
    this._model.remove(id, scope);
  }
```

**Стиль.** В `packages/engine/src/client/style.css` (там же, где
`games-*`-классы) добавить `.games-delete-btn` и
`.games-delete-armed` — второе состояние обязано отличаться визуально
(например, красная рамка/фон). Скопировать подход у существующих
`games-filter-btn`/`.active`.

## 2.5. Тесты

**`tests/auth/games.test.js`** (дописать в существующий файл, describe
«удаление игры») — `UserRepository` с db-стабом, как в
`tests/auth/UserRepository.test.js`:

- админ удаляет `approved` — успех, `DELETE` ушёл по всем пяти таблицам
  и по `games`, порядок: `games` последней;
- автор удаляет свою `pending` — успех;
- автор удаляет свою `approved` — `GamePublishedError`, ни одного
  `DELETE`;
- не автор и не админ — `GameForbiddenError`, ни одного `DELETE`;
- игры нет — `GameNotFoundError`.

**`tests/master/GameRegistryProxy.test.js`** — `remove()` шлёт `DELETE`
на `/games/<encodeURIComponent(id)>` с `Bearer`-заголовком.

**`tests/master/lobbyGamesRoutes.test.js`** — по образцу тестов
`moderate`:

- 200 от реестра → `catalog.remove` вызван с id (без версии) и
  `sync.run` вызван; ответ 200;
- 403 от реестра → ни `catalog.remove`, ни `sync.run` не вызывались,
  код и тело проброшены как есть;
- отказ сети (`registry.remove` бросает) → 502 `authServiceUnavailable`
  (общий `unavailable`).

**`tests/client/GamesModel.test.js`** — `remove('tanks')` шлёт `DELETE`
по `urls.remove`, на успехе перечитывает `mine`; со `scope: 'admin'` —
`admin`; на отказе публикует `error` с нужным scope.

**`tests/client/GamesView.test.js`** — первое нажатие «Delete» не
публикует событие и меняет подпись на «Confirm delete»; второе публикует
`delete` с `{id, scope}`; кнопка есть и в карточке «My games», и в
карточке модерации.

**`tests/client/GamesCtrl.test.js`** — событие `delete` доезжает до
`model.remove` с теми же аргументами.

## 2.6. Документация и changelog

- `docs/en/auth.md` и `docs/ru/auth.md`: маршрут `DELETE /games/:id` —
  кто имеет право, коды ответов (`200`, `403 forbidden`,
  `409 gamePublished`, `404 unknownGame`), и что удаление уносит все
  данные игры по `game_id` (перечислить таблицы). Отметить, что FK на
  `games` у них нет и именно поэтому чистка явная.
- `docs/en/master.md` и `docs/ru/master.md`: маршрут мастера
  `DELETE /games/mine/:id`, его middleware, снятие записи каталога и
  немедленный `sync.run()`; кнопка «Delete» в обеих карточках панели и
  подтверждение в два нажатия.
- `packages/engine/CHANGELOG.md` → `## [Unreleased]` → `### Added`
  (уровень **minor**): удаление игры из лобби. Текст — по-английски, в
  стиле соседних записей: что появилось, кто может, что происходит с
  данными, и что опубликованную игру автор удалить не может.

## 2.7. Ручная проверка

1. `npm run dev`, войти неадминским ником, завести заявку на игру →
   «My games» → «Delete» → «Confirm delete» → заявка исчезла.
2. Войти админом, в «Moderation» одобрить игру; под автором «Delete»
   отвечает «Published game — ask an admin to disable it first».
3. Под админом удалить ту же одобренную игру → она исчезла из очереди,
   из селектора игр лобби и из `/games/manifest.json`; каталог мастера
   перестроен без перезапуска.
4. Проверить БД: `SELECT count(*) FROM ratings WHERE game_id = '<id>'`
   → 0.
