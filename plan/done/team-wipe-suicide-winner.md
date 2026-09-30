# План: `_checkTeamWipe` объявляет GAME OVER вместо победы команды при самоубийстве последнего игрока ✅ выполнен

Задача для репозитория движка `vimp` (`/Users/dmitry/Sites/my/vimp`). План самодостаточен.

- Источник: репорт из игры `vimp-tanks` (`/Users/dmitry/Sites/my/vimp-tanks`) — «если последний игрок в команде
  совершает самоубийство, игра объявляет GAME OVER, хотя в игре осталась команда с живыми игроками; воспроизводится
  при включённом `friendlyFire`». Отдельного файла плана в `vimp-tanks` нет — там правка не нужна, баг целиком в
  движке.
- Правила — `CLAUDE.md` этого репозитория (docs en+ru при функциональных изменениях, три `CHANGELOG.md`, тест,
  воспроизводящий баг, до правки, отчёт «Release impact», без `git commit`, без правки `version` и публикации).
  Развилки — с согласия пользователя, вопросы — на русском.

## Контекст

`packages/engine/src/host/meta/core/RoundManager.js`, `_checkTeamWipe(victimTeamId, killerTeamId)` (строки
676–751):

```js
// проверка на живых участников в команде (люди и scripted)
for (const participant of this._participants.getAll()) {
  if (participant.teamId === victimTeamId && this._game.isAlive(participant.gameId)) {
    return; // команда не уничтожена
  }
}
...
// если убийца из другой команды, фраг для команды-победителя
if (killerTeamId && killerTeamId !== victimTeamId) {
  this._stat.updateHead(killerTeamId, 'score', 1);
  winnerTeam = Object.keys(this._teams).find(key => this._teams[key] === killerTeamId);
}
...
if (winnerTeam) {
  // sendRoundEnd(socketId, winnerTeam) → клиент: "{team} WINS!"
} else {
  // sendRoundEnd(socketId) без аргумента → клиент: "GAME OVER!"
}
```

Функция верно определяет, что команда жертвы вымерла целиком (цикл по `_participants` + `_game.isAlive`). Но
победителя она выводит **не из того, у кого остались живые**, а из `killerTeamId` — команды убийцы конкретного
последнего фрага. При самоубийстве `killerId === victimId` (`reportKill`, вызывается с одинаковым id), значит
`killerTeamId === victimTeamId`, условие `killerTeamId !== victimTeamId` ложно, `winnerTeam` остаётся `null` — и
код уходит в ветку «нет победителя»: всем игрокам, включая выжившую команду, шлётся `defeat` +
`sendRoundEnd(socketId)` без `winnerTeam`.

Путь события подтверждён от Rust-ядра игры до движка:
`core/src/tanks.rs` (`CoreEvent::Death { victim, killer }`, killer заполнен всегда, включая суицид) →
`packages/engine/src/host/GameCoreAdapter.js` (`vimp.reportKill(victim, killer)`) → `RoundManager.reportKill` →
`_checkTeamWipe`.

**Почему видно именно при `friendlyFire: true`** (это особенность игры `vimp-tanks`, не движка): при
`friendlyFire: false` урон себе своим же оружием/бомбой там блокируется (`shooter_team == target_team` и
`!friendly_fire` → урон не проходит), путь к багу перекрыт. При `friendlyFire: true` урон проходит, `killer ===
victim`, событие долетает до `_checkTeamWipe` и багует. Экологическая смерть (например, падение с высоты) —
безусловный суицид независимо от `friendlyFire` и бьёт по тому же багу, `friendlyFire` тут не причина, а лишь
самый надёжный способ воспроизвести. Флаг `friendlyFire` нигде не используется в `RoundManager.js` — это
подтверждает, что баг не в передаче флага, а в самой логике определения победителя.

Тестов на этот случай нет: `tests/host/RoundManager.test.js`, `describe('RoundManager._checkTeamWipe', …)`
(строка 651) проверяет только `_checkTeamWipe(1, 2)` — команда 2 жива, объявлена победителем; сценарий
`_checkTeamWipe(1, 1)` (или `_checkTeamWipe(1, null)`, когда убийца уже вышел из игры) — с живыми участниками
команды 2 — не покрыт.

## Решение

Определять победителя по тому, у какой команды остались живые участники, а не по команде убийцы. Убийца
по-прежнему решает только начисление фрага/очков (`score`), не победителя раунда.

В существующем цикле по `_participants.getAll()` (который уже проверяет, вымерла ли `victimTeamId`) заодно
собрать множество команд (кроме `victimTeamId` и `this._spectatorId`), у которых есть хотя бы один живой участник:

```js
const aliveTeamIds = new Set();

for (const participant of this._participants.getAll()) {
  if (!this._game.isAlive(participant.gameId)) {
    continue;
  }
  if (participant.teamId === victimTeamId) {
    return; // команда не уничтожена — прежнее поведение
  }
  if (participant.teamId !== this._spectatorId) {
    aliveTeamIds.add(participant.teamId);
  }
}
```

Дальше:

- `aliveTeamIds.size === 1` → это и есть `winnerTeam` (её id — единственный элемент множества), независимо от
  `killerTeamId`. Начисление фрага/очков за конкретное убийство (`killerTeamId && killerTeamId !== victimTeamId` →
  `score + 1`) — отдельная, не связанная с победителем, ветка; при суициде (`killerTeamId === victimTeamId` или
  `killerTeamId === null`) очков не начислять, как и сейчас.
- `aliveTeamIds.size === 0` → ничья без победителя, поведение как сейчас (`sendRoundEnd` без аргумента).
- `aliveTeamIds.size > 1` → актуально только для игр с 3+ командами (`vimp-tanks` — 2 команды + наблюдатели, так
  что этот случай там не встречается): раунд не должен завершаться, пока не осталась ровно одна команда — вернуться
  до `this._isRoundEnding = true`, не трогая статистику вайпа.

Отвергнуто: чинить только конкретно ветку суицида (`if (victimId === killerId)` где-то в `reportKill`) — не
покрывает второй существующий путь в тот же баг, `_checkTeamWipe(victimTeamId, null)`, когда убийца уже вышел из
игры (`reportKill`, строка 640) и живая команда есть.

## Шаги

1. Тест, который падает сейчас, в `tests/host/RoundManager.test.js`, рядом с `describe('RoundManager._checkTeamWipe', …)`
   (строка 651): два участника разных команд, у выжившей команды `isAlive` возвращает `true`,
   `rm._checkTeamWipe(1, 1)` (суицид — `killerTeamId === victimTeamId`) → сейчас `sendRoundEnd` вызывается без
   второго аргумента для всех, включая выжившего; ожидается `sendRoundEnd('sb', 'blue')` (выжившая команда —
   победитель) и `sendSoundCue('sb', 'victory')`. Второй кейс — `rm._checkTeamWipe(1, null)` (убийца вышел из
   игры) с тем же ожиданием.
2. `RoundManager.js`, `_checkTeamWipe` — реализовать решение выше.
3. Документация: `docs/en/host.md` и `docs/ru/host.md` (если там описано определение победителя/окончания раунда —
   поправить пример/формулировку), `docs/en/publishing.md` не трогать (не relevant). Если раздел про итог раунда
   отсутствует в `host.md` — новый абзац не добавлять сверх необходимого, только поправить неверное, если было
   описано.
4. `packages/engine/CHANGELOG.md`, `## [Unreleased]` → `### Fixed` — «Team-wipe winner is now derived from which
   team still has survivors, not from the last kill's attacker — a suicide (or a killer who already left) by the
   last player of a team no longer reports a plain game-over when the other team is still alive».
5. Отчёт «Release impact» при сдаче: правка в `packages/engine/core/` не нужна (чистый JS, `packages/engine/src/host/`),
   т.е. только npm-пакет `vimp-engine` (patch по `### Fixed`), крейт `vimp-engine-core` не затронут — игре
   (`vimp-tanks`) достаточно поднять зависимость `vimp-engine` в `package.json` после релиза, без изменений в
   `core/Cargo.toml`.
6. Проверки: `npx eslint .`, `npm test -- --silent` (упомянутый файл + полный прогон).
