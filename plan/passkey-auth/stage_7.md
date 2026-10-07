# Этап 7. Смена ника в играх убрана: движок, шаблон, tanks, snakes, процессные docs/ai

Не зависит от этапов 1–6 (можно делать в любой момент после этапа 0).
Правило разработчика: «Ник нельзя поменять в играх. Убрать из игр
возможность сменить ник». Ник игрока — только из личности (identity-JWT в
лобби; поле формы в standalone/dedicated), меняется только в лобби
участником с passkey (этап 3/6).

## Контекст (проверено по коду 2026-10-07)

- Движок своих чат-команд не имеет (`packages/engine/src/host/meta/core/CommandProcessor.js`):
  команды регистрирует игра (`HostPlugin.chatCommands`), обработчик
  получает контекст меты `ctx` с `roundManager`.
- `packages/engine/src/host/meta/core/RoundManager.js` `changeName(gameId, name)`
  (~526): `isValidName` → `participants.checkName` → `user.name = …`,
  `this._game.changeName` (хук ядра, у `GameCoreAdapter` — пустой), строка
  stat, системное сообщение `NAME_CHANGED` (`n:1`) или `NAME_INVALID`
  (`n:0`), `socketManager.sendName`. Метода нет в
  `contract/surface.json`, но опубликованные игры его зовут.
- Игры:
  - `../vimp-tanks/src/host/metaCommands.js` (~23–29): `/name` →
    `ctx.roundManager.changeName(gameId, args.join(' '))`;
    `../vimp-tanks/src/host/index.js` (~63, комментарий);
    `../vimp-tanks/src/config/auth.js` (~37: подсказка формы
    `{ keys: '/name <name>', text: 'change nickname' }`);
    тесты `tests/host/hostPlugin.test.js` (~36), `tests/host/metaCommands.test.js`
    (~15–31); доки `docs/{en,ru}/gameplay.md` (~61, строка таблицы команд);
    `CHANGELOG.md` (`## [Unreleased]` пуст).
  - `../vimp-snakes/src/host/metaCommands.js` (~19–25);
    `src/host/botCommand.js` (~17, комментарий со списком команд);
    тесты `tests/host/hostPlugin.test.js` (~54, ~348, ~362–367); доки
    `docs/{en,ru}/gameplay.md` (~240/~248); `CHANGELOG.md`.
  - Шаблон `packages/create-vimp-game/templates/default/src/host/metaCommands.js`
    (~18–23), `src/host/spawnCommand.js` (~7, комментарий).
- Документация движка: `docs/{en,ru}/host.md` (~607 — `changeName` в
  списке методов RoundManager; ~632 — «former engine commands `/name`,
  …»), `docs/{en,ru}/plugin-api.md` (~671 — строка CommandProcessor со
  списком `/name`), `docs/{en,ru}/plugin-api.md` (чат-команды `/name`), `docs/ai/questionnaire.md`
  («обычный минимум команд»).
- Тесты движка: `tests/host/RoundManager.test.js` (`describe('RoundManager.changeName')`,
  ~990), `tests/host/CommandProcessor.test.js` (~15, ~58 — проверка, что
  `ctx.roundManager.changeName` — функция).

## 7.1 Движок

1. `RoundManager.changeName(gameId, name)` → **пустой метод** (сигнатуру
   сохранить) с комментарием: ник меняется только в лобби (passkey-auth),
   метод оставлен, чтобы `/name` уже опубликованных игр не бросал
   `TypeError` в обработчике команды; ничего не делает и ничего не шлёт.
   Убрать ставшие неиспользуемыми импорты (`isValidName`, если больше не
   нужен в файле).
2. `ParticipantManager.checkName` и `SocketManager.sendName` — проверить
   поиском, остались ли у них вызовы: `checkName` нужен для уникальности
   отображаемых имён в гостевом контуре (standalone/dedicated, ник из
   формы) — не трогать, если используется при входе; `sendName` без
   вызовов удалить только если он не входит в `surface.json` и клиент его
   не ждёт (иначе оставить).
3. Коды `n:0`/`n:1` (`NAME_INVALID`/`NAME_CHANGED`) остаются в реестре
   (`host/meta/modules/chat/systemMessages.js`) и в резерве правила B8:
   номера кодов не переиспользуются; комментарий «больше не шлются
   движком».
4. Тесты: `tests/host/RoundManager.test.js` — `changeName` ничего не
   меняет (имя, stat, сообщения, `sendName` не вызваны);
   `tests/host/CommandProcessor.test.js` — проверка, что метод
   существует, остаётся.

## 7.2 Шаблон скаффолдера

1. `templates/default/src/host/metaCommands.js`: удалить команду `/name`
   (и её комментарий); `src/host/spawnCommand.js` — убрать `/name` из
   перечня в комментарии.
2. Поиск по `templates/default` (`/name`, `changeName`, `nickname`) — в
   тестах шаблона, `README.md.tpl`, `CLAUDE.md.tpl`, подсказках формы —
   убрать упоминания.
3. `npm run test:scaffold` — зелёный.
4. `packages/create-vimp-game/CHANGELOG.md` → `## [Unreleased]` →
   `### Removed`: «The generated game has no `/name` chat command — a
   player's nick comes from the lobby identity and is changed only in the
   lobby.»

## 7.3 `../vimp-tanks` и `../vimp-snakes`

Другие репозитории: прочитать их `CLAUDE.md` и следовать их правилам
(тесты, доки en/ru, changelog, форматирование). Коммитов не делать.

1. Удалить `/name` из `src/host/metaCommands.js`; поправить комментарии
   со списками команд (`tanks src/host/index.js`, `snakes
src/host/botCommand.js`); в tanks — строку подсказки формы
   `src/config/auth.js` (`'/name <name>'`).
2. Тесты: удалить проверки `/name`; где тест перечисляет команды — убрать
   `'/name'` из ожидаемого списка.
3. Доки: строки `/name` в `docs/{en,ru}/gameplay.md` удалить; если в
   gameplay.md есть раздел «engine features this game does not use» — не
   добавлять (это не отказ игры, а правило платформы).
4. `CHANGELOG.md` каждой игры → `## [Unreleased]` → `### Removed`:
   «The `/name` chat command — the nick comes from the lobby identity.»
5. Прогон тестов и линта игры по её `CLAUDE.md`.

Старые релизы игр продолжают работать с новым движком: их `/name`
вызывает пустой `changeName` — ник не меняется.

## 7.4 Документация движка (en и ru одинаково) и docs/ai

- `docs/{en,ru}/host.md`: в списке методов RoundManager — `changeName`
  помечен «no-op since passkey-auth: the nick comes from the identity and
  changes only in the lobby»; в абзаце о бывших движковых командах —
  убрать `/name`.
- `docs/{en,ru}/plugin-api.md`: строка CommandProcessor — убрать `/name`
  из примеров; одна фраза: игра не должна давать менять ник.
- `docs/{en,ru}/plugin-api.md` (чат-команды `/name`, `CommandProcessor`): убрать `/name`
  (`ctx.roundManager.changeName`) из рекомендуемых команд; добавить
  правило: «Do not offer a nick change — the nick comes from the player's
  identity; `ctx.roundManager.changeName` is a no-op.»
- `docs/ai/questionnaire.md` («обычный минимум команд»): убрать `/name` из «обычного
  минимума» и примера.
- `docs/{en,ru}/pitfalls.md` — строка в чек-лист: «no `/name` or other nick
  change command».

## 7.5 CHANGELOG движка — `packages/engine/CHANGELOG.md`, `## [Unreleased]`

`### Changed`: «In-game nick change is disabled: `RoundManager.changeName`
(the `ctx.roundManager.changeName` of chat commands) does nothing, so a
published game's `/name` no longer renames a player; the nick comes from
the identity and is changed only in the lobby.»

## Проверки

Движок: prettier, eslint, `npx vitest run --reporter=dot`,
`npm run test:scaffold`. Игры — по их `CLAUDE.md` (тесты, линт).

## Критерии готовности

- `/name` нет ни в шаблоне, ни в tanks, ни в snakes; `changeName` движка
  — пустой; доки и docs/ai не предлагают смену ника.
- Release impact: npm `vimp-engine` — `### Changed` (в составе
  minor-релиза плана); `create-vimp-game` — `### Removed` (patch, выпускать
  после движка); `../vimp-tanks`, `../vimp-snakes` — `### Removed`, релиз
  игр по их правилам (не обязателен для работы: старый `/name` безвреден).
