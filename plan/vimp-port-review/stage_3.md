# Этап 3. `MapDynamics`: явный id тела вместо позиции в множестве

**Репозиторий**: `vimp-tanks` (плагин), рабочая директория
`/Users/dmitry/Sites/my/vimp-tanks`.
**Объём**: S. **Зависимостей нет.**

## Что нужно знать без контекста

`core/src/client/map_dynamics.rs` — подсистема предсказания динамических
объектов карты (ящики, которые танк толкает). Тела лежат в
`IndexMap<String, PredictedBody>` внутри общего `PredictedSet`, ключ строится
функцией из того же файла:

```rust
/// Ключ тела в множестве: индекс объекта в `physicsDynamic` — та же форма,
/// в которой динамику именует рендер игры (`d0`, `d1`, ...).
fn body_key(index: usize) -> String {
    format!("d{index}")
}
```

Ключи создаются в `MapDynamics::set_map` перечислением объектов карты:

```rust
        for (index, item) in cfg.physics_dynamic.iter().enumerate() {
            ...
            self.set.bodies_mut().insert(body_key(index), body);
        }
```

## Проблема

В одном модуле уживаются **два способа адресации** одного и того же тела:

- `update` и `snapshot_bodies` ходят **по ключу**:
  `let key = body_key(row.id as usize); self.set.bodies_mut().get_mut(&key)`;
- `render_data` и `promote_at` берут **позицию** в `IndexMap`:

```rust
    fn render_data(&self) -> Vec<PredictedRow> {
        ...
        self.set
            .bodies()
            .values()
            .enumerate()
            .filter(|(_, body)| body.is_predicted())
            .map(|(index, body)| {
                ...
                PredictedRow {
                    key_id,
                    id: index as u32,     // ← позиция выдаётся за id строки
                    fields: vec![origin[0], origin[1], render.angle],
                }
            })
            .collect()
    }
```

Совпадение «позиция == числовой суффикс ключа» — неявный инвариант, который
держится ровно до тех пор, пока `set_map` вставляет тела строго по порядку и
ни одно тело никогда не удаляется. Нарушится он **тихо**: в hot-буфер уйдёт
рендер-строка с чужим `id`, и ящик A будет нарисован в координатах ящика B.
На экране это «ящик прыгает», в логах — ничего.

Риск не гипотетический: соседняя подсистема `remote_tanks.rs` тела как раз
удаляет (`retain` в `update`), то есть в этом же слое уже есть множество с
дырами, и следующий, кто скопирует шаблон, получит смещение id.

## Правки

### 3.1 — хранить индекс явно

В `core/src/client/map_dynamics.rs` завести рядом с множеством соответствие
«ключ → индекс объекта в `physicsDynamic`». Простейший вариант — поле
структуры `MapDynamics`:

```rust
pub struct MapDynamics {
    set: PredictedSet,
    // индекс объекта в physicsDynamic по позиции вставки: render_data
    // обязан отдавать id строки, а не позицию тела в множестве
    indices: Vec<u32>,
    ...
}
```

заполняемое в `set_map` рядом с `insert` (и очищаемое вместе с телами:
`self.indices.clear()` там же, где `self.set.bodies_mut().clear()`).

Альтернатива без нового поля — разобрать суффикс ключа
(`key.strip_prefix('d').and_then(|s| s.parse().ok())`) прямо в `render_data`;
она короче, но платит парсингом строки на каждое тело каждый кадр. Выбрать
вариант с `Vec<u32>`.

### 3.2 — `render_data` берёт id из индекса

Итерировать с позицией, но `id` брать из `self.indices[position]`, а не из
`enumerate()`. Плюс страховка в debug-сборке:

```rust
                debug_assert_eq!(*key, body_key(id as usize));
```

(для этого итерировать `.iter().enumerate()`, а не `.values().enumerate()`).

### 3.3 — `promote_at` оставить как есть

`promote_at(index, …)` работает через `bodies_mut().get_index_mut(index)` и
вызывается из `capture`, который сам же и собрал позиции — там позиция
корректна по построению. Трогать не нужно; достаточно, чтобы позиция больше
не притворялась id.

## Тест

`core/src/client/map_dynamics.rs`, модуль `mod tests` (в файле уже есть
фикстуры `snapshot_config()` и построение карты — брать за образец).

Новый тест: карта с тремя динамическими объектами, затем ручное удаление
среднего тела из множества (`set_mut().bodies_mut().shift_remove("d1")`),
затем перевод оставшихся в предсказание и вызов `render_data` →
`id` равны `0` и `2`, а не `0` и `1`.

Тест обязан падать на коде без правки (проверить `git stash`).

## Документация

Правки в доке не требуется: контракт «строка динамики адресуется индексом
объекта в `physicsDynamic`» уже описан в `docs/{en,ru}/core.md`. Если при
работе выяснится, что описание отсутствует — добавить одно предложение в обе
страницы одновременно.

## Журнал

`CHANGELOG.md` (`vimp-tanks`), `## [Unreleased]` → `### Fixed`. Запись на
английском: строка рендера динамики карты адресуется индексом объекта карты,
а не позицией тела в предсказанном множестве — раньше эти два числа
совпадали лишь по построению.

## Проверка

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
npm run core:test
npx eslint . && npm test
npm run sim:scenarios
```

## Критерий готовности

- [ ] `render_data` не использует `enumerate()` как источник `id`;
- [ ] индекс объекта хранится явно и очищается вместе с телами;
- [ ] `debug_assert` связывает ключ и id;
- [ ] тест с дырой в множестве добавлен и ловит регрессию;
- [ ] запись в `CHANGELOG.md` → `[Unreleased] / Fixed`;
- [ ] `cargo test --workspace`, `npx eslint .`, `npm test`,
      `npm run sim:scenarios` — зелёные.

**Влияние на релиз**: только плагин (`@vimp-games/tanks`), патч.
