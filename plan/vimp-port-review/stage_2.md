# Этап 2. Одна карта на обе клиентские подсистемы ✅ выполнен

**Репозиторий**: `vimp-tanks` (плагин), рабочая директория
`/Users/dmitry/Sites/my/vimp-tanks`.
**Объём**: M. **Зависимостей нет.**

## Что нужно знать без контекста

Клиентское ядро игры (Rust → wasm) получает карту одним JSON-сообщением
`MAP_DATA` и раздаёт её двум независимым подсистемам:

- **предсказание движения** — `core/src/client/predictor.rs` (`Predictor`):
  собирает контакты корпуса со сплошными тайлами (`collect_tile_contacts`);
- **предсказание выстрела** — `core/src/client/shot.rs` (`ShotPredictor`):
  трассирует луч по тем же тайлам (`ray_vs_grid`).

Обе читают одну и ту же тройку «сетка / солид-тайлы / размер тайла», описанную
типом `Grid` в `core/src/client/mod.rs`:

```rust
pub(crate) struct Grid {
    pub(crate) map: Vec<Vec<i32>>,
    pub(crate) solid_tiles: Vec<i32>,
    pub(crate) tile_size: f32,
}
```

и общим `ClientMapConfig` (там же), у которого в doc-комментарии прямо
записано: *«Общие для обеих клиентских подсистем: предсказание движения
(`predictor`) и предсказание выстрела (`shot`) обязаны видеть карту
одинаково»*.

## Проблема

Инвариант «одинаково» держится на двух независимых кусках кода.
`core/src/client/mod.rs`, `TanksClient::set_map` (строка ~320):

```rust
    /// Данные карты (MAP_DATA): стены предикта, мир raycast + сброс предикта.
    fn set_map(&mut self, map_json: &str) -> Result<(), String> {
        self.predictor.reset();
        self.reset_remote_tanks();
        self.predictor.set_map(map_json)?;
        self.shot.set_map(map_json)
    }
```

`Predictor::set_map` (`core/src/client/predictor.rs:308`):

```rust
    pub fn set_map(&mut self, map_json: &str) -> Result<(), String> {
        let cfg: super::ClientMapConfig =
            serde_json::from_str(map_json).map_err(|e| e.to_string())?;

        // геометрия динамики — целиком из этой карты (см. map_dynamics.rs:
        // сброса по CLEAR у неё намеренно нет)
        if let Some(dynamics) = self.map_dynamics_mut() {
            dynamics.set_map(&cfg);
        }

        self.grid = Some(Grid {
            map: cfg.map,
            solid_tiles: cfg.physics_static,
            tile_size: cfg.step * cfg.scale,
        });

        Ok(())
    }
```

`ShotPredictor::set_map` (`core/src/client/shot.rs:166`):

```rust
    pub fn set_map(&mut self, map_json: &str) -> Result<(), String> {
        let cfg: ClientMapConfig = serde_json::from_str(map_json).map_err(|e| e.to_string())?;

        self.grid = Some(Grid {
            map: cfg.map,
            solid_tiles: cfg.physics_static,
            tile_size: cfg.step * cfg.scale,
        });

        self.reset();
        Ok(())
    }
```

То есть один и тот же JSON разбирается **дважды**, и хранятся **две
независимые копии** сетки (`Vec<Vec<i32>>` всей карты плюс копия
`physicsStatic`) в полях `Predictor::grid` (`predictor.rs:142`) и
`ShotPredictor::grid` (`shot.rs:115`).

Цена по ресурсам небольшая — карта приходит раз в раунд. Проблема в другом:
достаточно правки в одном из двух `set_map` (другой масштаб тайла, другой
набор солид-тайлов, другой дефолт `scale`), чтобы луч и контакт стали видеть
разную карту. Ни один тест этого не поймает: тест
`ray_and_contact_agree_on_the_same_wall` живёт в движке и проверяет
согласованность **примитивов**, а не то, что подсистемы плагина получили одну
и ту же сетку.

## Правки

Ядро однопоточное (wasm), поэтому `Rc` достаточно — `Arc` не нужен.

### 2.1 — `core/src/client/mod.rs`

- добавить `use std::rc::Rc;`;
- `TanksClient::set_map` разбирает конфиг один раз, строит сетку и раздаёт:

```rust
    /// Данные карты (MAP_DATA): стены предикта, мир raycast + сброс предикта.
    /// Конфиг разбирается ОДИН раз: предсказание движения и предсказание
    /// выстрела обязаны видеть одну и ту же сетку, а не две одинаково
    /// построенные (см. doc-комментарий ClientMapConfig)
    fn set_map(&mut self, map_json: &str) -> Result<(), String> {
        let cfg: ClientMapConfig =
            serde_json::from_str(map_json).map_err(|e| e.to_string())?;
        let grid = Rc::new(Grid {
            map: cfg.map.clone(),
            solid_tiles: cfg.physics_static.clone(),
            tile_size: cfg.step * cfg.scale,
        });

        self.predictor.reset();
        self.reset_remote_tanks();
        self.predictor.set_map(&cfg, Rc::clone(&grid));
        self.shot.set_map(grid);

        Ok(())
    }
```

Чтобы обойтись без `clone()` полей карты, можно вынести построение `Grid` в
`impl ClientMapConfig { fn grid(&self) -> Grid }` либо строить `Grid` из
`cfg` до передачи `&cfg` (порядок: сначала `grid`, потом `dynamics.set_map`,
которому нужны только `physics_dynamic`/`scale`). Выбрать вариант без лишних
копий сетки — это единственное «дорогое» поле.

### 2.2 — `core/src/client/predictor.rs`

- поле `grid: Option<Grid>` → `grid: Option<Rc<Grid>>` (строка 142);
- сигнатура: `pub fn set_map(&mut self, cfg: &super::ClientMapConfig, grid: Rc<Grid>)`
  — без `Result`, разбор JSON уехал наверх;
- тело: `if let Some(dynamics) = self.map_dynamics_mut() { dynamics.set_map(cfg); }`
  и `self.grid = Some(grid);`;
- места чтения (`resolve_world`, строки ~702 и ~713) правок не требуют —
  `Rc<Grid>` разыменовывается прозрачно;
- обновить тесты модуля: `p.set_map(&wall_grid()).unwrap();`
  (строки ~1277 и ~1294) — теперь надо разобрать `wall_grid()` в
  `ClientMapConfig` и построить `Rc<Grid>`. Проще всего завести в
  `mod tests` хелпер `fn apply_map(p: &mut Predictor, json: &str)`, который
  повторяет то, что делает `TanksClient::set_map`.

### 2.3 — `core/src/client/shot.rs`

- поле `grid: Option<Grid>` → `grid: Option<Rc<Grid>>` (строка 115);
- сигнатура: `pub fn set_map(&mut self, grid: Rc<Grid>)` — без `Result` и без
  разбора JSON; тело: `self.grid = Some(grid); self.reset();`;
- **важно**: `reset()` внутри `set_map` сохранить — на нём держится очистка
  локальных выстрелов при смене карты;
- места чтения (`cast_ray`, строки ~626–634) правок не требуют;
- обновить тесты модуля, которые звали `set_map` со строкой JSON (около
  строки 870 и далее) — тем же хелпером, что и в 2.2.

### 2.4 — импорт `ClientMapConfig` в `shot.rs`

После правки `shot.rs` тип `ClientMapConfig` там может стать не нужен — если
так, убрать импорт, иначе `cargo` даст warning (сборка репозитория warning'и
не терпит).

## Тест

Новый тест в `core/src/client/mod.rs`, модуль `mod tests`: одна карта,
поданная через `TanksClient::set_map`, попадает в обе подсистемы **одним
объектом**. Реализация — на выбор:

- если завести `pub(crate)` геттеры `Predictor::grid()` / `ShotPredictor::grid()`,
  проверять `Rc::ptr_eq(a, b)` — самый прямой вариант и ровно то утверждение,
  которое защищает инвариант;
- либо поведенчески: одна и та же клетка стены отвергает и контакт корпуса,
  и луч выстрела (дороже, зато без расширения видимости).

Рекомендуется первый: утверждение «сетка одна» проверяется буквально.

## Документация

Правило репозитория: `docs/en/` канонична, `docs/ru/` — точное зеркало,
обе страницы правятся в одном изменении.

Страница — `docs/{en,ru}/core.md`, раздел про клиентскую половину ядра (там
описаны предиктор и предсказание выстрела). Одно предложение: сетка стен
строится один раз на `MAP_DATA` и разделяется обеими подсистемами (`Rc`),
поэтому «луч и контакт видят одну карту» — свойство конструкции, а не
совпадение двух разборов.

## Журнал

`CHANGELOG.md` репозитория `vimp-tanks`, секция `## [Unreleased]`,
подзаголовок `### Fixed` (уровень релиза задаётся подзаголовком; `Fixed` =
патч). Одна запись на английском: разбор `MAP_DATA` на клиенте выполняется
один раз, предсказание движения и предсказание выстрела разделяют одну сетку
стен вместо двух построенных по отдельности.

Версии в `package.json` / `core/Cargo.toml` не трогать.

## Проверка

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
npm run core:test          # cargo test --workspace
npx eslint . && npm test
npm run sim:scenarios
```

Ожидание: всё зелёное; поведение не изменилось (правка чисто структурная —
если какой-то сценарий поехал, значит две копии сетки уже расходились, и это
надо разобрать отдельно, а не «подогнать»).

## Критерий готовности

- [x] `MAP_DATA` разбирается ровно в одном месте (`TanksClient::set_map`);
- [x] `Predictor` и `ShotPredictor` держат `Option<Rc<Grid>>` и получают её
      извне;
- [x] тест утверждает, что сетка у обеих подсистем одна;
- [x] `docs/en/core.md` и `docs/ru/core.md` обновлены одинаково;
- [x] запись в `CHANGELOG.md` → `[Unreleased] / Fixed`;
- [x] `cargo test --workspace`, `npx eslint .`, `npm test`,
      `npm run sim:scenarios` — зелёные, без warning'ов компилятора.

**Влияние на релиз**: затронут только код плагина (`@vimp-games/tanks`),
патч. Движок не задет.
