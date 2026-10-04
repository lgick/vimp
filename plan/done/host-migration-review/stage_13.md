# Этап 13. Чистка: мёртвый код, хрупкий тест, мелочи ✅ выполнен

Находки: **F17**, **F19** (часть) ([review.md](review.md), разделы F17,
F19). Уровень: 🟡 качество. Критерии: поддерживаемость, отсутствие
дублирования, стандартизация, тестируемость.

Делать после функциональных этапов 1–12 (они могут начать использовать
что-то из списка — перед удалением перепроверить `grep`).

## 13.1 Мёртвый и «только для тестов» код

Перед удалением каждого — `grep -rn "<имя>" packages/engine/src tests`.
Если в `packages/engine/src` использований нет:

| Где                                                               | Что                                | Действие                                                                                        |
| ----------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/engine/src/client/lib/hostVoteCommand.js`               | `shouldInterceptChangeHost`        | удалить и его тест в `tests/client/lib/hostVoteCommand.test.js`                                 |
| `packages/engine/src/host/HostGame.js:1138-1140`                  | `collectCheckpoint`                | удалить (тестов нет)                                                                            |
| `packages/engine/src/client/network/HostController.js:139-141`    | `get preloaded`, поле `_preloaded` | удалить; тесты переписать на колбэк `onPreloaded`                                               |
| `packages/engine/src/client/network/HostConnectionManager.js:210` | `memberIdOf`                       | удалить, если этап 4 его не использует (там нужен `connectedMemberIds`); тесты — на новый метод |
| `packages/engine/src/client/network/StandbySender.js:76-78`       | `get successorMemberId`            | удалить; тесты — через `setSuccessor` и `peerConnectionOf`                                      |

`HostGame.isRestorePending` и `restoreMode` — оставить: это публичные
геттеры состояния, ими пользуются тесты и отладка.

## 13.2 Защита «перезагрузка только через `reloadPage`» без чтения исходника

Сейчас — тест, который читает `client/main.js` и ищет регэкспом прямые
`reloadTo(` / `location.reload(` (`tests/client/lib/hostUnloadGuard.test.js:124-146`).

1. Новый модуль `packages/engine/src/client/lib/pageReload.js`:
   ```js
   import { reloadTo } from './roomLink.js';

   /**
    * Программная перезагрузка страницы: сначала guard.exit() — иначе
    * pagehide принял бы её за закрытие вкладки и объявил уход.
    * @param {Object} deps
    * @param {Function} deps.getGuard - () → HostUnloadGuard | null.
    * @param {Function} [deps.reloadToHash] - (hashPart) — тесты.
    * @param {Function} [deps.reloadSame] - () — тесты.
    * @returns {Function} (hashPart?) => void
    */
   export function createPageReload({ getGuard, reloadToHash = reloadTo, reloadSame = () => window.location.reload() }) { … }
   ```
2. `client/main.js`: `const reloadPage = createPageReload({ getGuard: () => unloadGuard });`
   — функцию `reloadPage` (строки 1782-1790) удалить; импорт `reloadTo`
   из `roomLink.js` убрать.
3. `eslint.config.js`. В flat config опции правила из последнего
   подходящего блока **заменяют** предыдущие, поэтому:
   - в существующий блок `files: ['packages/engine/**/*.js']`
     (`no-restricted-imports`, строки ~214-230) добавить в `patterns`
     второй элемент
     `{ group: ['**/roomLink.js'], importNames: ['reloadTo'], message: 'перезагрузка только через client/lib/pageReload.js' }`;
   - новый блок `files: ['packages/engine/src/client/**/*.js']`,
     `ignores: ['packages/engine/src/client/lib/pageReload.js']`, правило
     `no-restricted-properties`:
     `[{ object: 'location', property: 'reload', message: 'перезагрузка только через client/lib/pageReload.js' }]`;
   - новый блок `files: ['packages/engine/src/client/lib/pageReload.js']`
     с `no-restricted-imports`, где остаётся только паттерн
     `@vimp-games/*` (без запрета `reloadTo`).
     Проверить: `npx eslint .` зелёный; временная правка в `main.js`
     (`location.reload()` или импорт `reloadTo`) даёт ошибку — откатить.
4. Удалить регэксп-тест из `tests/client/lib/hostUnloadGuard.test.js`;
   добавить `tests/client/lib/pageReload.test.js`: `exit()` вызывается до
   перезагрузки, с hash и без, без guard (solo/dedicated).
5. **Согласовано после ревью (2026-10-04):** `no-restricted-properties`
   с `object: 'location'` не видит `window.location.reload()`. Селектор
   `MemberExpression[object.property.name="location"][property.name="reload"]`
   добавлен в существующий блок `no-restricted-syntax` для
   `packages/engine/src/**` (отдельный блок заменил бы его селекторы ABI).
   Два законных вызова — `reloadTo` в `roomLink.js` и `reloadSame` в
   `pageReload.js` — помечены `eslint-disable-next-line` с причиной.

## 13.3 Мелочи оформления

- `packages/engine/src/master/MigrationCoordinator.js:31-40`: шапка
  класса — разнести склеенную строку («…передача становится аварийной
  миграцией. Отдельно от SignalingServer, чтобы не раздувать его:
  сигналинг…») по ширине файла.
- `npx prettier --write` по изменённым файлам.

## CHANGELOG

Нет: рефакторинг и тесты — не записи.

## Критерии готовности

- В `packages/engine/src` нет кода, вызываемого только тестами (из
  таблицы 13.1).
- `npx eslint .` ловит прямой `location.reload()` в клиентском коде
  (проверить временной правкой и откатить).
- Prettier, eslint, vitest — зелёные. Release impact: npm `vimp-engine`,
  без записи в changelog.
