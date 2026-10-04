# Этап 11. Тесты эстафеты в `../vimp-tanks` под формат v4 ✅ выполнен

Находка: **F14** ([review.md](review.md), раздел F14).
Уровень: 🟡 качество. Критерии: тестируемость, поддерживаемость.

Репозиторий этапа — **`/Users/dmitry/Sites/my/vimp-tanks`** (движок
подключён в `node_modules/vimp-engine` симлинком на
`../../vimp/packages/engine`). Правила — `CLAUDE.md` этого репозитория.

## Проблема

`tests/host/HostGame.test.js` (блок `describe.skipIf(!coreAvailable)("HostGame: эстафета Worker'ов (5.2)")`,
строка 275 и далее) — 6 красных тестов:

- `requestHandoff отдаёт мету на границе раунда и останавливает игру`
- `новый HostGame восстанавливает участников, счёт и seq из меты`
- `completeHandoff кикает не переподключившихся и стартует раунд`
- `несовместимая версия меты валит init …`
- `чужой gameId в мете валит init …`
- `карта, ушедшая из каталога, валит init с внятной ошибкой`

Причина — изменения движка в этой же задаче (этап 5), а не «давний
разрыв», как записано в отчёте этапа 7c:

1. `HostGame.requestHandoff` (`packages/engine/src/host/HostGame.js:869-875`)
   теперь отдаёт мету **асинхронно** — после `_flushBeforeHandoff()`.
   Фикстура `collectHandoffFixture` (строки 283-316) читает `meta`
   синхронно сразу после `initiateNewRound()` и получает `null`.
2. Формат меты — v4 (`HANDOFF_VERSION = 4`, `HostGame.js:29`,
   `_collectHandoff` → `_collectState('boundary')`, строки 944-955,
   1142-1243): участники в `meta.participants.humans` /
   `meta.participants.scripted` / `meta.participants.dropped`, карта —
   `meta.map.name` и `meta.map.data`, остаток карты —
   `meta.timers.mapTimeLeft`, токены — `meta.localTokens`. Тесты ждут v3
   (`meta.version === 3`, `meta.humans`, `meta.scripted`,
   `meta.currentMap`, `meta.mapTimeLeft`).
3. v4 везёт JSON карты в мете, поэтому карта, ушедшая из каталога,
   больше не валит восстановление (`HostGame.js:1284-1289`:
   `meta.map?.data ?? this._maps[mapName]`).

CI игры станет красным, как только tanks перейдёт на новый движок.

## Решение

### 11.1 Фикстура ждёт мету

```js
const metaPromise = new Promise(resolve => host.requestHandoff(resolve));

// граница раунда — единая воронка initiateNewRound
host._roundManager.initiateNewRound();

const meta = await metaPromise;
```

Если в блоке включены фейковые таймеры — `flushAll` без токенов
разрешается сразу, но гонка в `_flushBeforeHandoff` использует
`clock.setTimeout`; при необходимости `await vi.runAllTimersAsync()`.

### 11.2 Ожидания под v4

- `meta.version === 4`, `meta.kind === 'boundary'`, `meta.mode === 'soft'`;
- `meta.gameId === 'tanks'`, `meta.seq === host._seq`;
- `meta.map.name === host._roundManager.currentMap`, `meta.map.data`
  определён;
- `meta.timers.mapTimeLeft > 0`;
- `meta.participants.humans` — `socketId` `['s1', 's2']` (boundary
  переносит `socketId`), `p3` нет среди humans и есть в
  `meta.participants.dropped`; `meta.participants.scripted` длины 1;
- `meta.localTokens` — объект.
- В тесте `completeHandoff …`: `botId = meta.participants.scripted[0].gameId`,
  сравнение остатка карты — с `meta.timers.mapTimeLeft`.

### 11.3 Отказы восстановления

- «несовместимая версия» — `meta.version = 999` → `rejects.toThrow(/handoff version/)` (как есть);
- «чужой gameId» — `meta.gameId = 'snakes'` → `rejects.toThrow(/game mismatch/)`
  (сверить текст с `HostGame._assertSameGame`);
- «карта, ушедшая из каталога» — разделить на два теста:
  1. карты нет в каталоге, но она есть в мете (`meta.map.data`) →
     восстановление **проходит** и поднимает именно её (новое поведение
     v4);
  2. карты нет ни в каталоге, ни в мете (`meta.map.data = null`,
     `meta.map.name = 'no-such-map'`) → `rejects.toThrow(/handoff map missing/)`.

Тесты v3-пути здесь не нужны: совместимость v3 проверяют тесты движка
(`/Users/dmitry/Sites/my/vimp/tests/host/`).

### 11.4 Исправить запись об ошибочной причине

- `/Users/dmitry/Sites/my/vimp/plan/host-migration/stage_7.md`: в итоге
  7c, где сказано, что 6 тестов tanks красные «независимо от задачи»,
  дописать строку: причина — асинхронный `requestHandoff` и формат v4
  (этап 5), исправлено в `plan/host-migration-review/stage_11.md`.

## Проверки (в `../vimp-tanks`)

`npx prettier --write tests/host/HostGame.test.js`, `npx eslint .`,
`npx vitest run --reporter=dot` — все тесты зелёные (сейчас 6 из 1191
красные).

## CHANGELOG

Тесты — не запись. `CHANGELOG.md` tanks не трогать.

## Критерии готовности

- `npx vitest run` в `../vimp-tanks` — 0 красных.
- Release impact: публикуемый код tanks не меняется.
