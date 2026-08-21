# Этап 1. Хвост hot-буфера: флаг и граница разбора ✅ выполнен

**Репозиторий**: `vimp` (движок), рабочая директория `/Users/dmitry/Sites/my/vimp`.
**Объём**: M. **Зависимостей нет.**

## Что нужно знать без контекста

Клиентское ядро движка (Rust → wasm) каждый рендер-тик пишет плоский
`Float32Array` — **hot-буфер**. Раскладка:

```
[0] flags
[1] camera.x
[2] camera.y
[3] N — число записей группы Indexed8 (акторы), дальше N записей
    ... затем M — число записей группы IndexedNoNull8 (динамика карты), дальше M записей
    ... затем ХВОСТ: predicted-запись своего актора и/или строки тел,
        которые игра предсказывает сама
```

Каждая запись — `keyId, id, поля по схеме ключа` (ширина `2 + fields.length`).
Хвостовые записи кладутся в `game[key][id]` и тем самым **перекрывают**
интерполированную строку той же сущности.

Хвост появился в двух видах:

- `GameClientDef::render_overlay` — свой актор (был всегда);
- `GameClientDef::render_rows` — тела, которые игра предсказывает сама
  (динамика карты, чужие акторы в контакте); добавлено этапом 8a переноса.

## Проблема 1: флаг `HOT_HAS_PREDICTED` не покрывает `render_rows`

Флаги считаются в `packages/engine/core/src/client/game.rs`, метод
`ClientState::write_hot` (около строки 470). Сейчас:

```rust
    fn write_hot(
        &mut self,
        game: Option<&InterpolatedGame>,
        camera: Option<[f32; 2]>,
        overlay: Option<&RenderOverlay>,
        rows: &[PredictedRow],
    ) {
        self.hot.clear();

        let mut flags = 0u32;

        if game.is_some() {
            flags |= super::HOT_HAS_GAME;
        }

        if !self.frames_out.is_empty() {
            flags |= super::HOT_HAS_FRAMES;
        }

        if overlay.is_some() {
            flags |= super::HOT_HAS_PREDICTED;
        }
```

Аргумент `rows` при расчёте флагов не участвует, хотя строки из него
дописываются в конец буфера (внизу того же метода, цикл `for row in rows`).

Оба JS-потребителя разбирают буфер только под этим условием:

- `packages/engine/src/client/main.js:825`
- `packages/engine/src/devtools/VirtualClient.js:250`

```js
  if (flags & (HOT_FLAGS.GAME | HOT_FLAGS.PREDICTED)) {
    applyGameData(reconstructHot(hot, snapshotKeysById));
  }
```

Значит при `render_rows() != []`, но `overlay == None` и `game == None`
записи попадают в буфер и **молча отбрасываются**. Сегодня такое сочетание
недостижимо — но лишь по цепочке неявных совпадений: подсистемы
`MapDynamics`/`RemoteTanks` игры держат тела предсказанными только пока
шагает предиктор, а шагающий предиктор всегда отдаёт `render_overlay`. Нигде
не зафиксировано ни ассертом, ни тестом, ни комментарием.

### Правка 1.1 — `packages/engine/core/src/client/game.rs`

Заменить блок

```rust
        if overlay.is_some() {
            flags |= super::HOT_HAS_PREDICTED;
        }
```

на

```rust
        // флаг означает «за группами есть хвостовые записи»: predicted-хвост
        // своего актора и/или строки тел, которые игра предсказывает сама
        // (render_rows). Без строк в флаге JS-потребитель, гейтящий разбор
        // по HOT_HAS_GAME | HOT_HAS_PREDICTED, молча выбросил бы их
        if overlay.is_some() || !rows.is_empty() {
            flags |= super::HOT_HAS_PREDICTED;
        }
```

Новый бит заводить не нужно: протокол не расширяется, а флаг и так
используется обеими сторонами в смысле «в буфере есть хвост».

### Правка 1.2 — комментарии к флагу (два зеркала)

`packages/engine/core/src/client/mod.rs`, строки 16–20 — сейчас:

```rust
// флаги hot-буфера ([0]); зеркалятся в src/config/opcodes.js (HOT_FLAGS)
pub const HOT_HAS_GAME: u32 = 1;
pub const HOT_HAS_CAMERA: u32 = 2;
pub const HOT_HAS_PREDICTED: u32 = 4;
pub const HOT_HAS_FRAMES: u32 = 8;
```

Добавить над `HOT_HAS_PREDICTED` строку:

```rust
// «за группами есть хвостовые записи»: свой актор (render_overlay)
// и/или тела, предсказанные игрой (render_rows)
```

`packages/engine/src/config/opcodes.js`, блок `HOT_FLAGS` (строки ~29–36) —
тем же смыслом дополнить комментарий у `PREDICTED: 4`.

### Правка 1.3 — тест

`packages/engine/core/src/client/game.rs`, модуль `mod tests` (внизу файла).
Там уже есть фикстура `TestClient` с переключателями через `set_model`:
`"predicted"` включает `predicted_state`, `"rows"` включает `render_rows`
(три строки: корректная, с недостающим полем, с неизвестным `key_id` 200).
Есть тест `render_rows_follow_the_tail_and_keep_schema_width` — брать его за
образец (как строится состояние, как читается `hot`).

Новый тест:

```rust
    #[test]
    fn game_rows_alone_still_raise_the_tail_flag() {
        // строки игры без predicted-состояния своего актора: флаг обязан
        // подняться, иначе JS-потребитель не станет разбирать буфер
    }
```

Сценарий: `make_state()`, `set_active(true)`, `set_model("rows")` (это НЕ
включает `report_state`, значит `render_overlay` вернёт `None`), прогнать
рендер-тик как в соседних тестах и проверить
`flags & HOT_HAS_PREDICTED != 0`, а также что записи присутствуют в буфере.

## Проблема 2: разбор хвоста без проверки границ

`packages/engine/src/lib/reconstructHot.js`. Раньше хвост читался ровно один
раз по флагу; этап 8a заменил это на чтение до конца буфера:

```js
  while (i < hot.length) {
    readRecord();
  }
```

`readRecord` не проверяет, помещается ли запись целиком:

```js
  const readRecord = () => {
    const spec = snapshotKeysById[hot[i]];

    if (!spec) {
      throw new Error(`hot buffer: unknown snapshot key id ${hot[i]}`);
    }

    const { key, kind, width } = spec;
    const id = kind === 'indexedNoNull8' ? `d${hot[i + 1]}` : hot[i + 1];

    (game[key] ??= {})[id] = Array.from(hot.subarray(i + 2, i + width));
    i += width;
  };
```

При усечённой последней записи `subarray` тихо вернёт короткую строку, части
получат `undefined` при чтении по индексу, а `i` уедет за длину буфера.
Ловит это только devtools-инвариант `consumed === hot.length`
(`packages/engine/src/devtools/invariants.js`), которого в проде нет.

### Правка 1.4 — `packages/engine/src/lib/reconstructHot.js`

В `readRecord` перед чтением полей добавить:

```js
    // запись должна помещаться целиком: усечённая тихо дала бы строку
    // с недостающими полями, а обход уехал бы за конец буфера
    if (i + width > hot.length) {
      throw new Error(
        `hot buffer: record of key id ${hot[i]} needs ${width} floats, ` +
          `${hot.length - i} left`,
      );
    }
```

Место — сразу после деструктуризации `const { key, kind, width } = spec;`.

### Правка 1.5 — тест

`packages/engine/tests/lib/reconstructHot.test.js` (файл уже существует, там
есть кейс на чтение хвоста до конца буфера — добавлен этапом 8a). Новый кейс:
буфер, обрезанный на середине хвостовой записи, → `expect(() => …).toThrow()`
с проверкой текста (`/needs \d+ floats/`).

## Документация

Правило репозитория: `docs/en/` канонична, `docs/ru/` — точное зеркало;
функциональная правка обновляет обе страницы в одном изменении.

Страница — `client.md` (раздел про рендер-тик и hot-буфер): en около строки
598, ru около строки 168. Там уже описано, что буфер несёт «predicted-записи
игры последними: сначала свой актор (`render_overlay`), затем тела, которые
игра предсказывает сама (`render_rows`)». Дописать одно предложение: флаг
`PREDICTED` поднимается при любом из двух хвостов, и разбор буфера
потребителем гейтится именно им.

## Журнал

`packages/engine/CHANGELOG.md`, секция `## [Unreleased]`, подзаголовок
`### Fixed` (создать, если его там нет — сейчас секция пустая). Уровень
релиза задаётся именно подзаголовком: `Fixed` = патч.

Две записи (на английском, Keep a Changelog):

1. Флаг `PREDICTED` hot-буфера теперь поднимается и когда игра отдала только
   свои предсказанные строки (`render_rows`) без predicted-записи локального
   актора: раньше такой буфер клиент не разбирал вовсе.
2. Разбор hot-буфера отвергает усечённую хвостовую запись с внятной ошибкой
   вместо тихой строки с недостающими полями.

Версии в `package.json` не трогать — релиз за разработчиком (`npm run release`).

## Проверка

```bash
cd /Users/dmitry/Sites/my/vimp
npx eslint . && npm test
npm run core:test
```

Ожидание: оба прогона зелёные, новые тесты падают на коде без правок
(проверить через `git stash` — это условие «тест ловит регрессию»).

## Критерий готовности

- [x] `write_hot` поднимает `HOT_HAS_PREDICTED` при непустом `rows`;
- [x] комментарии к флагу синхронны в `mod.rs` и `opcodes.js`;
- [x] `readRecord` отвергает усечённую запись;
- [x] два новых теста (Rust + Vitest), оба ловят регрессию;
- [x] `docs/en/client.md` и `docs/ru/client.md` обновлены одинаково;
- [x] две записи в `packages/engine/CHANGELOG.md` → `[Unreleased] / Fixed`;
- [x] `npx eslint .`, `npm test`, `npm run core:test` — зелёные.

**Влияние на релиз**: затронуты и крейт `vimp-engine-core`
(`packages/engine/core/`), и npm-пакет `vimp-engine`
(`packages/engine/src/lib/`) — патч обоих. `ENGINE_API_VERSION` и
`SNAPSHOT_FORMAT_VERSION` не меняются; игровому репозиторию достаточно
пересборки на новом крейте.
