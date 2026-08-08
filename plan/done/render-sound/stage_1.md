# Этап 1 — баги 1+2, движковая часть

## Баг 1: танк остаётся на полотне после смены карты

### Трассировка

1. `RoundManager.createMap()`
   (`packages/engine/src/host/meta/core/RoundManager.js`) чистит мир, шлёт
   **полный** `CLEAR` без `setIdList`, переводит человека в наблюдатели и
   отправляет карту. **`sendKeySet(…, 0)` не отправляется** — в отличие от
   штатного `_setSpectatorFromActivePlayer` → `sendSpectatorDefaultShot`.
   KEYSET 0 доедет только внутри `sendFirstShot`, то есть **после**
   `MAP_READY`.
2. Клиент по `PS_CLEAR` (`src/client/main.js`) удаляет все сущности,
   вызывает `clientCore.reset()` и `soundManager.reset()`.
3. `ClientState::reset()` (`packages/engine/core/src/client/game.rs`) не
   сбрасывает `my_game_id`; `TanksClient::reset()` не сбрасывает
   `my_tank_meta`; `Predictor::reset()` не трогает `has_state`.
4. Следствие: `render_overlay()` продолжает возвращать `Some`, `write_hot`
   выставляет `HOT_HAS_PREDICTED`, `renderTick` → `GameCtrl.parse('Tank', …)`
   → ветка **create** → танк снова на полотне.
5. Пришедший позже KEYSET 0 выключает оверлей, но созданную сущность уже
   никто не удалит: в мире хоста такого танка нет, null-маркер не придёт,
   `CLEAR` прошёл. Призрак остаётся до конца сессии.

### 1.A. Хост шлёт keyset наблюдателя при смене карты

В `RoundManager.createMap()`, в цикле по `getHumans()`, **перед** `sendClear`
вызвать `this._socketManager.sendSpectatorDefaultShot(user.socketId)` — тот
же вызов, что делает `_setSpectatorFromActivePlayer`. Порядок важен: к
моменту очистки полотна предикт уже выключен, окно для призрака закрыто на
источнике. Побочно делает правдой `docs/en/network.md` («keyset отправляется
точно на смену статуса спектатор↔игрок») и убирает рассинхрон панели.

### 1.C. Движок обнуляет свою идентичность

`ClientState::reset()` (`packages/engine/core/src/client/game.rs`) —
добавить `self.my_game_id = None;`. Значение восстановится из первого же
player-блока; у наблюдателя player-блока нет, значит и предсказанной
сущности не будет.

## Баг 2b: «стал игроком — звук пропал» (корень, движок)

`_startRound()` шлёт **частичный** CLEAR со списком из
`remove_players_and_shots`, но `soundManager.reset()` вызывается в **обеих**
ветках обработчика и стирает `_registeredSounds` целиком. Уцелевший `Tank`
остаётся с висячим `this._soundId`: `_initSounds()` рано выходит, а
`update()` умеет только `updateSoundData()`, который для отсутствующей
регистрации молча ничего не делает. Звук двигателя не вернётся никогда.

### 2.1. Новая семантика `SoundManager.reset()`

«Остановить всё звучащее и сбросить слушателя», не уничтожая реестр.
Владение регистрацией остаётся у сущности — она снимает её в `destroy()`.

```js
// packages/engine/src/client/SoundManager.js
reset() {
  Howler.stop();
  this._activeInstances.clear();

  // регистрации переживают reset: их владельцы — сущности, которые
  // снимут их сами в destroy(); зависшие id воспроизведения обнуляем,
  // чтобы луп перезапустился, а недоигравший one-shot был подобран
  // _cleanupUnplayedOneShots()
  for (const reg of this._registeredSounds.values()) {
    reg.activeSoundId = null;
  }

  this._listenerX = 0;
  this._listenerY = 0;
}
```

Почему безопасно и достаточно:

- при **полном** CLEAR все сущности уничтожены и уже вызвали
  `unregisterSound` → реестр и так пуст;
- при **частичном** CLEAR уцелевшие лупы перезапустит ближайший
  `processAudibility()`, потому что `activeSoundId === null`;
- недоигравшие one-shot'ы соберёт `_cleanupUnplayedOneShots()` на том же
  кадре;
- сирот не появляется: единственный путь удаления регистрации — `destroy()`
  сущности.

## Файлы

- `packages/engine/src/host/meta/core/RoundManager.js`
- `packages/engine/src/client/SoundManager.js`
- `packages/engine/core/src/client/game.rs`

## Тесты

- `tests/client/SoundManager.test.js` — `reset()` сохраняет регистрации и
  обнуляет `activeSoundId`; луп перезапускается ближайшим
  `processAudibility()`.
- `tests/host/…RoundManager…` — `createMap()` шлёт keyset наблюдателя
  каждому человеку **до** `sendClear`.
- cargo: `ClientState::reset()` обнуляет `my_game_id`.
