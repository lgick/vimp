# Этап 3. `#games-mine` и `#games-moderation` — разные страницы ✅ выполнен

**Задача заказчика № 2.** Находка F4 в [review.md](review.md).

## Что не так

`packages/engine/src/client/components/view/Games.js:139-143`:

```js
  show(moderation = false) {
    this._panel.style.display = 'flex';
    this._lobby.style.display = 'none';
    this._moderation.style.display = moderation ? 'block' : 'none';
  }
```

Скрывается/показывается только карточка модерации. Карточка
`#games-mine` (`views/includes/games.pug`) видима всегда, поэтому
«Moderation» открывается вместе с формой заявки и списком своих игр.

**Препятствие.** Кнопка «Back to lobby» (`#games-close`) лежит внутри
`#games-mine`, в её `div.games-head`. Просто скрыть карточку нельзя —
панель останется без выхода.

## 3.1. Разметка: шапка на уровне панели

`packages/engine/src/client/views/includes/games.pug`. Привести к виду
(комментарии — обязательная часть правки, стиль файла):

```pug
div#games-panel(style='display:none')
  div.lobby-column
    //- Шапка панели, а не карточки: карточки «My games» и «Moderation»
    //- показываются по одной (панель — это две разные страницы), и
    //- кнопка выхода в лобби обязана пережить переключение между ними
    div.games-head
      h3#games-title.lobby-section-title= 'My games'
      input#games-close(type='button', value='Back to lobby')

    div.card#games-mine
      ul#games-mine-list.games-list
      //- Заявка спрашивает только пакет и версию: id, title и репозиторий
      //- мастер читает из самого пакета и показывает предпросмотром
      form#games-submit-form
        …без изменений…

    div.card#games-moderation(style='display:none')
      div#games-filters.games-filters
      ul#games-admin-list.games-list
      div#games-admin-error.form-error
```

Изменения по пунктам:

- `div.games-head` с `#games-close` поднят из `#games-mine` на уровень
  колонки;
- заголовок стал общим (`#games-title`) и меняет текст при
  переключении: `My games` / `Moderation`;
- из `#games-moderation` убран собственный `h3` (заголовок теперь один);
- сам `#games-mine` больше не содержит `games-head`.

## 3.2. Конфиг

`packages/engine/src/config/lobby.js`, `games.elems` — добавить два id
рядом с `moderationId` (правило репозитория: модули не хардкодят id):

```js
      // карточки панели показываются по одной; заголовок общий
      mineId: 'games-mine',
      titleId: 'games-title',
```

## 3.3. Представление

`components/view/Games.js`:

1. В конструкторе, рядом с `this._moderation`:

```js
    this._mine = document.getElementById(elems.mineId);
    this._title = document.getElementById(elems.titleId);
```

2. `show` переписать:

```js
  // Панель — две страницы, а не одна: «My games» и «Moderation»
  // показываются по одной. Общая шапка (заголовок и «Back to lobby»)
  // живёт над карточками и переживает переключение
  show(moderation = false) {
    this._panel.style.display = 'flex';
    this._lobby.style.display = 'none';
    this._mine.style.display = moderation ? 'none' : 'block';
    this._moderation.style.display = moderation ? 'block' : 'none';
    this._title.textContent = moderation ? 'Moderation' : 'My games';
  }
```

`hide()` не трогать.

## 3.4. Контроллер

`components/controller/Games.js`, `openModeration` — убрать
`this._model.loadMine()`: карточка «My games» в этом режиме не видна, а
запрос к мастеру за её данными делается зря.

```js
  openModeration() {
    this._view.show(true);
    this._model.loadAdmin();
  }
```

## 3.5. Переключение между страницами (рекомендуется) ✅ сделано

Сейчас, чтобы перейти из «Moderation» в «My games», админ обязан выйти в
лобби. Добавить в шапку панели кнопку-переключатель, видимую только
админу:

- в `games.pug`, в `div.games-head` перед `#games-close`:
  `input#games-switch(type='button', value='Moderation', style='display:none')`;
- в конфиг: `switchBtnId: 'games-switch'`;
- в `GamesView`: `setAdmin(isAdmin)` показывает/прячет и её;
  `onclick` публикует `open-moderation` либо `open-mine` в зависимости
  от текущей страницы, а `show()` переписывает её подпись на
  противоположную страницу (`Moderation` ↔ `My games`).

Если исполнитель решит этот пункт пропустить — отметить это в файле
этапа явной строкой, чтобы не потерялось.

## 3.6. Тесты

`tests/client/GamesView.test.js` — разметку в тесте привести к новой
(шапка вне карточек) и добавить случаи:

- `show(false)`: `#games-mine` видима, `#games-moderation` скрыта,
  заголовок `My games`;
- `show(true)`: наоборот, заголовок `Moderation`;
- `#games-close` доступна в обоих режимах, `hide()` возвращает лобби;
- (если сделан п. 3.5) переключатель виден только после
  `setAdmin(true)` и публикует нужное событие.

`tests/client/GamesCtrl.test.js` — `openModeration` больше не зовёт
`loadMine`, зовёт `loadAdmin`; `openMine` зовёт `loadMine`.

## 3.7. Документация и changelog

- `docs/en/master.md`, `docs/ru/master.md` — в описании панели реестра:
  «My games» и «Moderation» — две страницы одной панели, показываются по
  одной, шапка с выходом в лобби общая.
- `packages/engine/CHANGELOG.md` → `### Fixed` (**patch**): открытая
  «Moderation» больше не показывает вместе с собой форму заявки и список
  своих игр.

## 3.8. Ручная проверка

`npm run dev`, войти админским ником: «My games» — одна карточка;
«Moderation» — только очередь модерации; «Back to lobby» работает на
обеих; неадминский пользователь кнопки «Moderation» по-прежнему не
видит.
