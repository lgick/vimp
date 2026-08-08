# Этап 3 — баг 4: звук постановки бомбы срабатывает дважды

## Симптом

Ставишь бомбу — `bombHasBeenPlanted` слышен дважды: старт, обрыв через
~100–200 мс, повторный старт с начала.

## Трассировка

1. Нажатие огня → `onLocalAction` → `ClientCore.try_fire(now)`.
2. `ShotPredictor::try_fire`, ветка `WeaponKind::Explosive`
   (`vimp-tanks/core/src/client/shot.rs`): `local_bomb_seq += 1`, локальный
   id `L1`, запись в `pending_bombs`, возврат JSON
   `{"w2": {"L1": [x, y, 0, size, time, myGameId]}}`.
3. `applyGameData` → `GameCtrl.parse('Bomb', …)` → `GameModel.create` →
   `new Bomb(...)`; конструктор вызывает
   `registerSound('bombHasBeenPlanted')` → **проигрывание №1**.
4. Через `interpolation.delay` + RTT приходит авторитетный кадр с настоящей
   бомбой (id в base36, `ownerId` — поле 5).
5. `ShotPredictor::filter_frame_game`, ветка `Explosive`: находит строки, где
   `bomb[5] == my_id`, снимает `pending` и вписывает `null` под локальным id,
   оставляя авторитетную строку. Тест
   `filter_remaps_own_bomb_to_local_null` закрепляет это поведение.
6. Оба изменения попадают в **один** объект `game`, `GameCtrl.parse` идёт по
   нему `for…in`: `L1: null` → `remove` → `Bomb.destroy()` →
   `unregisterSound` → `_internalStop` **обрывает звучащий сэмпл**;
   `a1: [...]` → новый `Bomb` → `registerSound` → **проигрывание №2**.
7. Для `WeaponKind::Hitscan` ядро делает наоборот — выкидывает авторитетный
   дубль, оставляя локальный. Бомба — исключение, потому что долгоживущая:
   её надо удалить по авторитетному id.
8. Третий обрыв (не заявлен, но часть той же поломки): `w2.time = 300` мс —
   при детонации хост шлёт `w2: {a1: null}`, `Bomb.destroy()` снова обрывает
   звук, то есть сэмпл физически не может доиграть дольше 300 мс.
9. Дублирования по личному порту `SOUND_DATA` здесь нет:
   `bombHasBeenPlanted` отсутствует в `soundCues`.

## 4.1. Стабильный id сущности вместо «удалить и создать» (ядро плагина)

Завести в `ShotPredictor` карту алиасов
`bomb_aliases: HashMap<String, (String, f64)>` (авторитетный id → локальный id
+ время создания) и в `filter_frame_game`, ветка `Explosive`:

- при подтверждении своей бомбы **удалять авторитетную строку** из `bombs` и
  писать `bomb_aliases.insert(auth_id, (pending.local_id, local_now))` —
  вместо нынешнего `bombs.insert(local_id, Value::Null)`;
- проходом по ключам блока `w2` переименовывать в локальный id любую запись,
  чей ключ есть в `bomb_aliases` — это ловит и `null` при детонации; на
  `null` под алиасом выдать `null` под локальным ключом и снять алиас;
- `reset()` — чистить `bomb_aliases`;
- страховка от утечки, если `null` потерялся: подрезать алиасы по возрасту в
  `trim_pending` с запасом относительно `w2.time`.

Результат: `Bomb` создаётся один раз, живёт под локальным id до детонации,
звук регистрируется один раз, таймер не перезапускается, спрайт не «моргает».
Визуально бомба остаётся в предсказанной позиции — штатное поведение
предикта, ровно как у трассеров.

## 4.2. Одноразовый звук не должен обрываться смертью сущности

```js
// packages/engine/src/client/SoundManager.js
releaseSound(id) {
  const reg = this._registeredSounds.get(id);

  if (!reg) { return; }

  // луп обязан замолчать вместе с владельцем, one-shot — доиграть
  if (reg.loop && reg.activeSoundId !== null) {
    this._internalStop(reg.activeSoundId);
  }

  this._registeredSounds.delete(id);
}
```

Безопасно: `updateActiveSounds()` пропускает не-лупы, а обработчик
`once('end')` сам подчистит `_activeInstances`. `Bomb.destroy()` переводится с
`unregisterSound` на `releaseSound`; `Tank` остаётся на `unregisterSound`.

## Файлы

- `vimp-tanks/core/src/client/shot.rs`
- `packages/engine/src/client/SoundManager.js`
- `vimp-tanks/src/client/parts/Bomb.js`

## Тесты

- `tests/client/SoundManager.test.js` — `releaseSound` не глушит звучащий
  one-shot, но глушит луп.
- cargo плагина: переписать `filter_remaps_own_bomb_to_local_null` —
  авторитетная строка исчезает, `L1` не трогается; новый тест — последующий
  `{"w2": {"a1": null}}` доходит до клиента как `{"w2": {"L1": null}}`; тест
  на снятие алиаса по возрасту.
