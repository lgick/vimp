# Этап 4. Чистка: мёртвый экспорт, лишние аллокации, неверные комментарии

**Репозитории**: `vimp` и `vimp-tanks`.
**Объём**: S. **Зависит от этапов 1–3** (чтобы не переписывать одни и те же
комментарии дважды).

Этап собран из мелочей, каждая правится независимо. Поведение игры не
меняется ни в одном пункте.

## 4.1 — `map_dynamics_box`: экспорт WASM-ABI без потребителя

**Файл**: `vimp-tanks/core/src/lib.rs`, метод `ClientCore::map_dynamics_box`.

Метод отдаёт рендерный бокс тела динамики карты
(`[x, y, angle, halfW, halfH]`) и задокументирован в `docs/en/core.md:208` и
`docs/ru/core.md:208` как часть ABI. При этом его **никто не вызывает**:
сервис `mapDynamics` в `vimp-tanks/src/client/index.js` отдаёт наружу только
`toWorld` (поверх соседнего `map_dynamics_to_world`), тестов на метод нет.

Проверить перед правкой:

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
grep -rn "map_dynamics_box" src/ tests/ docs/
```

Решение — на выбор владельца кода, но выбрать надо явно:

- **удалить** метод и строку в обеих `core.md` (рекомендуется: неиспользуемая
  публичная поверхность ABI стоит места в бандле и поддержки при каждой
  правке формы бокса);
- **оставить** как заявленную часть ABI — тогда покрыть JS-тестом по образцу
  `tests/client/parts/effects/ShotEffectController.test.js` (там уже есть мок
  сервиса поверх `map_dynamics_to_world`) и сослаться на него из
  `docs/{en,ru}/configuration.md` рядом с `componentDependencies`.

Если удаляем — запись в `CHANGELOG.md` (`vimp-tanks`) под `### Removed`
(патч): неиспользуемый метод клиентского ABI убран.

## 4.2 — мёртвое присваивание в `PredictedSet::begin_reconcile`

**Файл**: `vimp-tanks/core/src/client/predicted_set.rs`.

```rust
    pub fn begin_reconcile(&mut self, entries: &[(String, ServerState)]) {
        let mut saved = IndexMap::new();

        self.reconcile_snapshots = None;   // ← мёртвая строка
        ...
        self.reconcile_snapshots = Some(saved);
    }
```

Поле безусловно перезаписывается в конце метода — первая строка не может ни
на что повлиять. Удалить. Тестов не требует, поведение не меняется.

## 4.3 — линейный поиск схемы на каждую строку каждого кадра

**Файл**: `vimp/packages/engine/core/src/client/game.rs`, `write_hot`, цикл
`for row in rows`:

```rust
            let Some(width) = self
                .cfg
                .snapshot
                .keys
                .values()
                .find(|schema| schema.id == row.key_id)
                .map(|schema| schema.fields.len())
            else {
                continue;
            };
```

`keys` — реестр ключей снапшота игры (порядка десяти), строк в хвосте — до
восемнадцати (12 ящиков динамики + 6 чужих танков), то есть до ~180 сравнений
на кадр рендер-тика. Немного, но легко убирается: построить обратный индекс
`id → ширина` один раз в `ClientState::new` (рядом с тем, как схема уже
кладётся в состояние) и читать из него.

Тип: `HashMap<u8, usize>` либо `[Option<u16>; 256]` — id ключа однобайтовый,
массив дешевле и без хеширования. Поведение при неизвестном `key_id` не
меняется: строка пропускается (`continue`), это уже покрыто тестом
`render_rows_follow_the_tail_and_keep_schema_width` (третья строка фикстуры
с `key_id: 200`).

Журнал: `vimp/packages/engine/core/CHANGELOG.md` — записи **не требует**
(внутренняя оптимизация без изменения контракта; по правилам репозитория
рефакторинг в журнал не идёт).

## 4.4 — аллокация ключа на каждый рассматриваемый ящик

**Файл**: `vimp-tanks/core/src/client/shot.rs`, `cast_ray`:

```rust
        if let Some(dynamics) = world.dynamics {
            for (key, obb) in dynamics.sim_boxes() {
                consider(
                    ray_vs_box(origin, dir, range, &obb),
                    RayTarget::Dynamic(key.to_string()),   // ← String на каждый ящик
                );
            }
        }
```

`key.to_string()` выполняется для **каждого** ящика карты, хотя ключ нужен
только победителю. Путь холодный (раз в выстрел), правка косметическая:
передавать в `consider` индекс/`&str` и материализовать `String` один раз
после выбора ближайшей цели. Делать только если это не усложняет `consider`
(там замыкание с захватом `closest`) — если усложняет, оставить и не трогать.

## 4.5 — комментарии, разошедшиеся с кодом

Три места, где комментарий описывает не то, что делает код.

**(а)** `vimp-tanks/src/config/client.js`, блок `componentDependencies`:

```js
      // геометрия динамики карты (рендерные боксы ящиков): эффект попадания
      // держит якорь на теле и каждый кадр спрашивает, где тело нарисовано.
```

`ShotEffectController` (`src/client/parts/effects/shot/ShotEffectController.js`)
читает якорь **один раз**, в момент запуска эффекта попадания, а дальше
осколки живут в мире. Переформулировать: «…спрашивает, где тело нарисовано, в
момент запуска эффекта». То же предложение продублировано в
`docs/en/configuration.md` и `docs/ru/configuration.md` — править все три
места одинаково.

**(б)** `vimp-tanks/core/src/client/predicted_set.rs`, `decay_error`:

```rust
    /// Экспоненциальное затухание ошибки (в точности как visual_error танка).
    pub fn decay_error(&mut self, elapsed: f64) {
        let decay = (1.0 - (elapsed / 1000.0) * ERROR_DECAY_RATE).max(0.0) as f32;
```

Формула линейная, а не экспоненциальная: при `elapsed >= 100 мс` (rate = 10)
ошибка обнуляется целиком. Поведение согласовано с `visual_error` своего
танка (`core/src/client/predictor.rs`, метод `update`) — это плюс, менять его
в рамках чистки **не нужно**. Поправить формулировку в обоих местах:
«линейное затухание за `1/ERROR_DECAY_RATE` секунды; на кадре длиннее 100 мс
ошибка снимается целиком».

Если захочется перейти на честную экспоненту
(`decay = (-(elapsed / 1000.0) * ERROR_DECAY_RATE).exp()`), это **отдельная
задача**: правка обязана коснуться обоих мест одновременно (расхождение между
своим танком и телами вокруг него видно как «танк догоняет, ящик прыгает») и
потребует пересмотра ожиданий в тестах
`visual_error_accumulates_decays_and_snaps` (`predictor.rs`) и в тестах
`predicted_set.rs`.

**(в)** `vimp-tanks/core/src/client/predictor.rs`, `resolve_world`:

```rust
        if self.frozen || (self.grid.is_none() && self.sets.is_empty()) {
            return;
        }
```

Проверка `self.frozen` недостижима: `update()` при заморозке до шага не
доходит. Код оставить (защита дешёвая и покрыта тестом
`freeze_disables_contacts_and_capture`), но пометить комментарием
«защитная: при `frozen` сюда не доходит `update`», иначе читатель ищет второй
путь вызова.

## Проверка

```bash
cd /Users/dmitry/Sites/my/vimp
npx eslint . && npm test && npm run core:test

cd /Users/dmitry/Sites/my/vimp-tanks
npx eslint . && npm test && npm run core:test && npm run sim:scenarios
```

## Критерий готовности

- [ ] по 4.1 принято явное решение (удалить/покрыть тестом), доки приведены
      в соответствие;
- [ ] мёртвая строка в `begin_reconcile` удалена;
- [ ] обратный индекс `id → ширина` в `write_hot`;
- [ ] комментарии (а), (б), (в) соответствуют коду, (а) исправлен во всех
      трёх местах (код + en + ru);
- [ ] все прогоны зелёные, поведение не изменилось.

**Влияние на релиз**: при удалении `map_dynamics_box` — плагин, `Removed`
(патч). Остальное журнала не требует.
