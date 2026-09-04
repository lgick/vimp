use indexmap::IndexMap;
use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use crate::config::FieldValue;
use crate::physics::{deg_to_rad, encode_map_object, lerp, round2};

// параметры поверхности по умолчанию (дефолты planck/Box2D,
// с которыми сбалансировано ощущение управления). Публичные: клиентская
// реплика контактов (client::rigid_body::MAP_SURFACE) обязана брать те же
// значения, иначе предсказание тихо разъедется с хостом
pub const DEFAULT_FRICTION: f32 = 0.2;
pub const DEFAULT_RESTITUTION: f32 = 0.0;

// порог «тело покоится» для хвоста скоростей в снапшоте: ниже него
// скорость не стоит 12 байт на строку (Map.js REST_VELOCITY_EPSILON)
const REST_VELOCITY_EPSILON: f32 = 0.01;

/// Максимум поддерживаемых уровней: земля (0) и надземные 1..7. Потолок —
/// бюджет масок Rapier: уровню отведён свой бит, уровням достались биты
/// 0..7, бит 8 занят `STATIC_LEVEL_GROUP`.
pub const MAX_LEVELS: usize = 8;

// девятый уровень наехал бы битом на STATIC_LEVEL_GROUP и стал бы для
// маски неотличим от стены: расширять предел можно только вместе с
// переездом статической группы на свободный бит
const _: () = assert!(MAX_LEVELS <= 8);

/// Динамический объект карты (physicsDynamic из src/data/maps/*).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicObjectConfig {
    pub position: [f32; 2],
    pub angle: f32,
    pub width: f32,
    pub height: f32,
    pub density: f32,
    #[serde(default)]
    pub linear_damping: Option<f32>,
    #[serde(default)]
    pub angular_damping: Option<f32>,
    /// Уровень, на котором стоит тело (0 — земля).
    #[serde(default)]
    pub level: u8,
}

/// Описание НАДЗЕМНОГО уровня карты (level >= 1). Уровень 0 остаётся в
/// полях `map`/`physicsStatic`/`layers` — так карта старого формата
/// продолжает грузиться без единой правки.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapLevelConfig {
    /// Грид тайлов этого уровня; размерность обязана совпадать с `map`.
    /// Значение `0` — пустота (уровня здесь нет, видно нижний).
    pub map: Vec<Vec<i32>>,
    /// Тайлы, по которым МОЖНО ездить на этом уровне (плита моста).
    #[serde(default)]
    pub floor: Vec<i32>,
    /// Тайлы-стены этого уровня (перила): блокируют движение и луч.
    /// Тайл перил обычно входит и в `floor` — по нему нельзя ехать сквозь,
    /// но он часть плиты и экранирует луч снизу.
    #[serde(default)]
    pub walls: Vec<i32>,
    /// Рендер-слои этого грида (zIndex -> список тайлов). Клиентское поле,
    /// ядро его игнорирует.
    #[serde(default)]
    pub layers: IndexMap<String, Vec<i32>>,
    /// Визуальная высота рендер-слоя в уровнях: { "<ключ layers>": 0.6 }.
    /// Ядро её не использует — поле едет клиенту и живёт только в рендере,
    /// но проверяется здесь: опечатка в ключе слоя иначе даёт плоскую карту
    /// без единого сообщения.
    #[serde(default)]
    pub volumes: IndexMap<String, f32>,
}

/// Направление ПОДЪЁМА рампы (куда ехать, чтобы подняться).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RampDir {
    /// -y
    North,
    /// +y
    South,
    /// -x
    West,
    /// +x
    East,
}

impl RampDir {
    /// (ось: 0 = x, 1 = y; знак: +1 — подъём в сторону роста координаты).
    pub fn axis_sign(self) -> (u8, i8) {
        match self {
            RampDir::North => (1, -1),
            RampDir::South => (1, 1),
            RampDir::West => (0, -1),
            RampDir::East => (0, 1),
        }
    }
}

/// Рампа: тайл-переход между уровнями.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RampConfig {
    /// Индекс тайла в гриде уровня `from`.
    pub tile: i32,
    pub dir: RampDir,
    #[serde(default)]
    pub from: u8,
    #[serde(default = "default_ramp_to")]
    pub to: u8,
}

fn default_ramp_to() -> u8 {
    1
}

/// JSON карты (src/data/maps/*.js, экспортированный в .json).
/// Поля рендера (spriteSheet, layers) ядру не нужны и игнорируются.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapConfig {
    #[serde(default)]
    pub set_id: Option<String>,
    #[serde(default)]
    pub scale: Option<f32>,
    pub step: f32,
    pub map: Vec<Vec<i32>>,
    #[serde(default)]
    pub physics_static: Vec<i32>,
    #[serde(default)]
    pub physics_dynamic: Vec<DynamicObjectConfig>,
    /// [x, y, angleDeg] либо [x, y, angleDeg, level] — 4-й элемент
    /// необязателен: без него уровень выводится из геометрии
    /// (`GameMap::level_at`).
    #[serde(default)]
    pub respawns: IndexMap<String, Vec<Vec<f32>>>,
    /// Рендер-слои земли (zIndex -> список тайлов). Ядру не нужны, но
    /// нужны как область определения ключей `volumes`.
    #[serde(default)]
    pub layers: IndexMap<String, Vec<i32>>,
    /// Визуальная высота рендер-слоёв земли (см. `MapLevelConfig::volumes`).
    #[serde(default)]
    pub volumes: IndexMap<String, f32>,
    /// Надземные уровни: ключ — номер уровня строкой ("1"). Отсутствие поля
    /// = одноуровневая карта.
    #[serde(default)]
    pub levels: IndexMap<String, MapLevelConfig>,
    #[serde(default)]
    pub ramps: Vec<RampConfig>,
}

/// Проверки формы слоёных полей карты (`levels`/`ramps`). Вынесены из
/// `MapConfig::validate` отдельной функцией, потому что выполнять их обязаны
/// обе стороны: хост при загрузке карты и клиентская реплика, которой те же
/// поля приходят по сети в MAP_DATA. Косой грид уровня на клиенте не паникует
/// — он молча даёт геометрию, отличную от хостовой, и предсказание расходится
/// без единой строки в консоли: ровно та категория отказа, ради которой
/// валидатор и написан.
pub fn validate_levels(
    map: &[Vec<i32>],
    physics_static: &[i32],
    layers: &IndexMap<String, Vec<i32>>,
    volumes: &IndexMap<String, f32>,
    levels: &IndexMap<String, MapLevelConfig>,
    ramps: &[RampConfig],
) -> Result<(), String> {
    let rows = map.len();
    let level_count = levels.len() + 1;

    if !levels.is_empty() {
        if level_count > MAX_LEVELS {
            return Err(format!(
                "map levels: {level_count} levels, at most {MAX_LEVELS} supported"
            ));
        }

        let mut keys: Vec<u8> = Vec::with_capacity(levels.len());

        for key in levels.keys() {
            let level: u8 = key
                .parse()
                .map_err(|_| format!("map levels: key '{key}' is not a level number"))?;

            if level == 0 {
                return Err(
                    "map levels: level 0 lives in map/physicsStatic, not in levels".to_string(),
                );
            }

            keys.push(level);
        }

        keys.sort_unstable();

        for (index, &level) in keys.iter().enumerate() {
            if level as usize != index + 1 {
                return Err(format!(
                    "map levels: levels must run from 1 without gaps, got {level} at position {}",
                    index + 1
                ));
            }
        }
    }

    validate_volumes("0", layers, volumes)?;

    for (key, level) in levels {
        validate_volumes(key, &level.layers, &level.volumes)?;

        if level.map.len() != rows {
            return Err(format!(
                "map levels: level {key} grid has {} rows, map has {rows}",
                level.map.len()
            ));
        }

        for (y, row) in level.map.iter().enumerate() {
            let expected = map[y].len();

            if row.len() != expected {
                return Err(format!(
                    "map levels: level {key} row {y} has {} cells, map has {expected}",
                    row.len()
                ));
            }
        }

        for tile in &level.walls {
            if !level.floor.contains(tile) {
                return Err(format!(
                    "map levels: level {key} wall tile {tile} is not part of floor"
                ));
            }
        }
    }

    for (index, ramp) in ramps.iter().enumerate() {
        if ramp.from == ramp.to {
            return Err(format!("map ramps: ramp {index} goes from level {} to itself", ramp.from));
        }

        if (ramp.from as usize) >= level_count || (ramp.to as usize) >= level_count {
            return Err(format!(
                "map ramps: ramp {index} references level out of range (levels: {level_count})"
            ));
        }

        let grid = if ramp.from == 0 {
            Some(map)
        } else {
            levels.get(&ramp.from.to_string()).map(|level| level.map.as_slice())
        };

        let found = grid.is_some_and(|grid| {
            grid.iter().any(|row| row.contains(&ramp.tile))
        });

        if !found {
            return Err(format!(
                "map ramps: ramp {index} tile {} is missing from level {} grid",
                ramp.tile, ramp.from
            ));
        }

        // рампа, ведущая в пустоту: за верхним концом прогона обязана быть
        // поверхность уровня `to`. Иначе танк доезжает до вершины и в тот же
        // шаг срывается вниз — молча, потому что и подъём, и падение
        // штатные правила
        let grid = grid.unwrap_or(map);

        for (x, y) in ramp_run_exits(grid, ramp.tile, ramp.dir) {
            if !walkable(map, physics_static, levels, ramp.to, x, y) {
                return Err(format!(
                    "map ramps: ramp {index} run ends at ({x}, {y}), which is not \
                     walkable ground of level {}",
                    ramp.to
                ));
            }
        }

        // рампа через несколько уровней не имеет права прошивать плиту
        // промежуточного: танк на ней въехал бы внутрь чужого моста
        let low = ramp.from.min(ramp.to);
        let high = ramp.from.max(ramp.to);

        for level in (low + 1)..high {
            let Some(cfg) = levels.get(&level.to_string()) else {
                continue;
            };

            for (y, row) in grid.iter().enumerate() {
                for (x, tile) in row.iter().enumerate() {
                    if *tile != ramp.tile {
                        continue;
                    }

                    let over = cell_at(&cfg.map, x as i64, y as i64)
                        .is_some_and(|tile| cfg.floor.contains(&tile));

                    if over {
                        return Err(format!(
                            "map ramps: ramp {index} climbs {}->{} through level \
                             {level} floor at ({x}, {y})",
                            ramp.from, ramp.to
                        ));
                    }
                }
            }
        }
    }

    validate_level_edges(map, physics_static, levels)?;

    Ok(())
}

/// Высоты рендер-слоёв: ключ обязан быть ключом `layers` того же уровня,
/// значение — конечная высота в уровнях. Ядро высоты не использует, но
/// молчаливая опечатка в ключе даёт плоскую карту и час поисков в рендере.
fn validate_volumes(
    key: &str,
    layers: &IndexMap<String, Vec<i32>>,
    volumes: &IndexMap<String, f32>,
) -> Result<(), String> {
    for (layer, &height) in volumes {
        if !layers.contains_key(layer) {
            return Err(format!(
                "map levels: level {key} volumes names layer {layer}, which is not \
                 a render layer"
            ));
        }

        if !height.is_finite() || height <= 0.0 || height > MAX_LEVELS as f32 {
            return Err(format!(
                "map levels: level {key} volumes layer {layer} height {height} is \
                 not in (0, {MAX_LEVELS}]"
            ));
        }
    }

    Ok(())
}

/// Край плиты: клетка `floor` уровня N, у которой сосед — не плита и не
/// перила, это обрыв. Обрыв разрешён (падение — правило игры), но приземлиться
/// с него нужно на проходимую поверхность — ближайшую плиту снизу, а если её
/// нет, то на землю: за краем карты или в стене танк либо уезжает за карту
/// (стены нижнего уровня плите не преграда), либо приземляется внутри стены,
/// откуда его выталкивает рывком.
fn validate_level_edges(
    map: &[Vec<i32>],
    physics_static: &[i32],
    levels: &IndexMap<String, MapLevelConfig>,
) -> Result<(), String> {
    for (key, level) in levels {
        for (y, row) in level.map.iter().enumerate() {
            for (x, tile) in row.iter().enumerate() {
                // перила закрывают край сами; клетка вне плиты краем не бывает
                if !level.floor.contains(tile) || level.walls.contains(tile) {
                    continue;
                }

                for (dx, dy) in [(1_i64, 0_i64), (-1, 0), (0, 1), (0, -1)] {
                    let nx = x as i64 + dx;
                    let ny = y as i64 + dy;

                    let neighbour = cell_at(&level.map, nx, ny);

                    if neighbour.is_some_and(|tile| level.floor.contains(&tile)) {
                        continue;
                    }

                    // сосед вне плиты — обрыв: под ним обязана быть
                    // проходимая поверхность того уровня, на который тело
                    // приземлится (плита ниже этажом — законный обрыв)
                    let level: u8 = key.parse().unwrap_or(0);
                    let landing = config_landing_level(levels, level, nx, ny);

                    if walkable(map, physics_static, levels, landing, nx, ny) {
                        continue;
                    }

                    return Err(format!(
                        "map levels: level {key} floor cell ({x}, {y}) has an open \
                         edge at ({nx}, {ny}) with no walkable ground below — close \
                         it with a wall tile"
                    ));
                }
            }
        }
    }

    Ok(())
}

/// Уровень приземления по КОНФИГУ (у валидатора нет `MapLevels`): ближайший
/// уровень строго ниже `from` с полом в клетке, иначе земля. Копия правила
/// `MapLevels::landing_level` — обе стороны обязаны звать её на одних данных.
fn config_landing_level(
    levels: &IndexMap<String, MapLevelConfig>,
    from: u8,
    x: i64,
    y: i64,
) -> u8 {
    for level in (1..from).rev() {
        let Some(cfg) = levels.get(&level.to_string()) else {
            continue;
        };

        if cell_at(&cfg.map, x, y).is_some_and(|tile| cfg.floor.contains(&tile)) {
            return level;
        }
    }

    0
}

fn cell_at(grid: &[Vec<i32>], x: i64, y: i64) -> Option<i32> {
    if x < 0 || y < 0 {
        return None;
    }

    grid.get(y as usize)
        .and_then(|row| row.get(x as usize))
        .copied()
}

/// Земля уровня 0 проходима, если клетка есть в гриде и её тайл не объявлен
/// стеной (`physicsStatic`).
fn ground_walkable(map: &[Vec<i32>], physics_static: &[i32], x: i64, y: i64) -> bool {
    cell_at(map, x, y).is_some_and(|tile| !physics_static.contains(&tile))
}

/// Проходима ли клетка на уровне `level`: для земли — не стена, для
/// надземного уровня — плита без перил.
fn walkable(
    map: &[Vec<i32>],
    physics_static: &[i32],
    levels: &IndexMap<String, MapLevelConfig>,
    level: u8,
    x: i64,
    y: i64,
) -> bool {
    if level == 0 {
        return ground_walkable(map, physics_static, x, y);
    }

    let Some(cfg) = levels.get(&level.to_string()) else {
        return false;
    };

    cell_at(&cfg.map, x, y)
        .is_some_and(|tile| cfg.floor.contains(&tile) && !cfg.walls.contains(&tile))
}

/// Клетки, следующие за верхними концами прогонов рампы (прогон — непрерывная
/// линия одинаковых тайлов вдоль оси рампы, как в `MapLevels::build_runs`).
fn ramp_run_exits(grid: &[Vec<i32>], tile: i32, dir: RampDir) -> Vec<(i64, i64)> {
    let (axis, sign) = dir.axis_sign();
    let mut out = Vec::new();

    if axis == 1 {
        let cols = grid.iter().map(|row| row.len()).max().unwrap_or(0);

        for x in 0..cols {
            let mut y = 0;

            while y < grid.len() {
                if grid[y].get(x) != Some(&tile) {
                    y += 1;
                    continue;
                }

                let y0 = y;

                while y < grid.len() && grid[y].get(x) == Some(&tile) {
                    y += 1;
                }

                let exit = if sign > 0 { y as i64 } else { y0 as i64 - 1 };

                out.push((x as i64, exit));
            }
        }
    } else {
        for (y, row) in grid.iter().enumerate() {
            let mut x = 0;

            while x < row.len() {
                if row[x] != tile {
                    x += 1;
                    continue;
                }

                let x0 = x;

                while x < row.len() && row[x] == tile {
                    x += 1;
                }

                let exit = if sign > 0 { x as i64 } else { x0 as i64 - 1 };

                out.push((exit, y as i64));
            }
        }
    }

    out
}

impl MapConfig {
    /// Валидация слоёных полей. Любая из этих ошибок в рантайме молчит:
    /// карта с рассинхроном размерностей гридов даёт танк, проваливающийся
    /// в пустоту, и ни одной строки в консоли.
    pub fn validate(&self) -> Result<(), String> {
        let level_count = self.levels.len() + 1;

        validate_levels(
            &self.map,
            &self.physics_static,
            &self.layers,
            &self.volumes,
            &self.levels,
            &self.ramps,
        )?;

        for (team, points) in &self.respawns {
            for (index, point) in points.iter().enumerate() {
                if point.len() != 3 && point.len() != 4 {
                    return Err(format!(
                        "map respawns: {team}[{index}] has {} numbers, expected 3 or 4",
                        point.len()
                    ));
                }

                if point.len() == 4 && (point[3] as usize) >= level_count {
                    return Err(format!(
                        "map respawns: {team}[{index}] level {} is out of range (levels: {level_count})",
                        point[3]
                    ));
                }
            }
        }

        for (index, object) in self.physics_dynamic.iter().enumerate() {
            if (object.level as usize) >= level_count {
                return Err(format!(
                    "map physicsDynamic: object {index} level {} is out of range (levels: {level_count})",
                    object.level
                ));
            }
        }

        Ok(())
    }
}

/// Битовая маска слоя для InteractionGroups: уровню `N` — бит `N`
/// (уровень 0 — GROUP_1, уровень 1 — GROUP_2, и так до `MAX_LEVELS`).
/// Тела за пределами реестра (не выставившие группы) остаются в
/// `Group::ALL` и поэтому продолжают взаимодействовать с уровнем 0 —
/// старые карты и старые игры не замечают появления слоёв.
pub fn level_group(level: u8) -> Group {
    // уровень вне `MAX_LEVELS` схлопывается в верхний молча: карта с
    // лишними слоями не проходит `validate`, поэтому сюда он попасть может
    // только из кода, и ловить это должен разработчик, а не игрок
    debug_assert!(
        (level as usize) < MAX_LEVELS,
        "level_group: level {level} is out of range (MAX_LEVELS: {MAX_LEVELS})"
    );

    // клампом, а не сдвигом как есть: в release `debug_assert!` выключен, а
    // сдвиг на 32 и больше в Rust — паника, то есть падение раунда вместо
    // одного тела не на своём уровне
    Group::from_bits_truncate(1u32 << (level as u32).min(MAX_LEVELS as u32 - 1))
}

/// Группа статики карты: её несут стены ВСЕХ уровней в дополнение к своей
/// `level_group`. Нужна телам, которым по правилам игры полагаются только
/// стены и ни одного динамического тела (падающий с обрыва танк): маска
/// `STATIC_LEVEL_GROUP` в одиночку видит стену любого уровня и не видит ни
/// танков, ни ящиков. Уровни занимают биты 0..7 (см. `MAX_LEVELS`),
/// поэтому статика берёт следующий за ними бит 8.
pub const STATIC_LEVEL_GROUP: Group = Group::GROUP_9;

/// Маска «я на уровне `level` и вижу только его».
pub fn level_interaction(level: u8) -> InteractionGroups {
    let group = level_group(level);

    InteractionGroups::new(group, group, InteractionTestMode::And)
}

/// Маска стены уровня `level`: своя группа уровня плюс `STATIC_LEVEL_GROUP`.
pub fn static_level_interaction(level: u8) -> InteractionGroups {
    let group = level_group(level) | STATIC_LEVEL_GROUP;

    InteractionGroups::new(group, group, InteractionTestMode::And)
}

/// Маска «я вижу все уровни из `mask`» (танк на рампе).
pub fn levels_interaction(mask: Group) -> InteractionGroups {
    InteractionGroups::new(mask, mask, InteractionTestMode::And)
}

/// Результат попадания точки на рампу.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RampSample {
    /// 0.0 у подножия прогона, 1.0 на его верхней кромке.
    pub progress: f32,
    pub from: u8,
    pub to: u8,
    /// Единичный вектор «в горку» в мировых координатах.
    pub dir: [f32; 2],
    /// Крутизна: уровней на мировую единицу вдоль `dir`, всегда > 0.
    /// Продольный уклон под курсом тела — `slope * dot(dir, heading)`.
    pub slope: f32,
    /// Индекс прогона в `MapLevels::runs` и его ось (0 = x, 1 = y). Нужны
    /// игре, чтобы отличить заход на прогон с торца от заезда сбоку:
    /// гейт сравнивает клетку входа с предыдущей клеткой тела вдоль оси.
    pub run: u16,
    pub axis: u8,
}

/// Прогон рампы: максимальная непрерывная линия тайлов одной рампы вдоль её
/// оси в одной строке (ось x) или колонке (ось y).
#[derive(Clone, Serialize, Deserialize)]
pub struct RampRun {
    /// 0 = x, 1 = y.
    pub axis: u8,
    /// +1 — подъём в сторону роста координаты.
    pub sign: i8,
    pub from: u8,
    pub to: u8,
    /// Границы прогона по своей оси в МИРОВЫХ (масштабированных) единицах.
    pub min: f32,
    pub max: f32,
    /// Границы прогона поперёк своей оси (нужны нав-графу, чтобы поставить
    /// узлы у подножия и на вершине по центру прогона).
    pub cross_min: f32,
    pub cross_max: f32,
}

/// Слоистая геометрия карты без физического мира: гриды уровней, списки
/// сплошных тайлов, прогоны рамп. Хост держит её внутри `GameMap`,
/// клиентская реплика игры строит из полей MAP_DATA — правила уровней у
/// обеих сторон читаются отсюда и только отсюда.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct MapLevels {
    /// Гриды по индексу уровня: [0] — земля, [1] — эстакада.
    grids: Vec<Vec<Vec<i32>>>,
    /// Тайлы-стены по уровням (для 0 — `physicsStatic`, для N — `walls`).
    solid: Vec<Vec<i32>>,
    /// Тайлы-пол по уровням (для 0 — пусто: земля есть везде внутри карты).
    floor: Vec<Vec<i32>>,
    runs: Vec<RampRun>,
    /// Параллелен `grids[0]`: индекс прогона рампы в клетке либо -1.
    run_cells: Vec<Vec<i16>>,
    /// Размер тайла в МИРОВЫХ единицах (step * scale).
    tile_size: f32,
}

/// Один прогон рампы: `from`..`to` — границы по своей оси в клетках,
/// `cross0`..`cross1` — поперёк; клетки, уже занятые прогоном, пропускаются
/// (первая объявленная рампа выигрывает — детерминированно). Свободная
/// функция, а не метод: `build_runs` держит грид уровня взаймы у того же
/// `MapLevels`, и метод по `&mut self` заставил бы клонировать грид.
#[allow(clippy::too_many_arguments)]
fn push_run(
    runs: &mut Vec<RampRun>,
    run_cells: &mut [Vec<i16>],
    tile_size: f32,
    ramp: &RampConfig,
    axis: u8,
    sign: i8,
    from: usize,
    to: usize,
    cross0: usize,
    cross1: usize,
) {
    if runs.len() >= i16::MAX as usize {
        return;
    }

    let index = runs.len() as i16;
    let mut claimed = false;

    for main in from..to {
        for cross in cross0..cross1 {
            let (x, y) = if axis == 1 { (cross, main) } else { (main, cross) };

            let Some(cell) = run_cells.get_mut(y).and_then(|row| row.get_mut(x)) else {
                continue;
            };

            if *cell < 0 {
                *cell = index;
                claimed = true;
            }
        }
    }

    if !claimed {
        return;
    }

    let size = tile_size;

    runs.push(RampRun {
        axis,
        sign,
        from: ramp.from,
        to: ramp.to,
        min: from as f32 * size,
        max: to as f32 * size,
        cross_min: cross0 as f32 * size,
        cross_max: cross1 as f32 * size,
    });
}

impl MapLevels {
    /// `grid0`/`solid0` — грид и стены уровня 0; `levels` — конфиги
    /// надземных уровней (ключ — номер строкой); `ramps` — конфиги рамп;
    /// `tile_size` — УЖЕ масштабированный размер тайла.
    pub fn build(
        grid0: &[Vec<i32>],
        solid0: &[i32],
        levels: &IndexMap<String, MapLevelConfig>,
        ramps: &[RampConfig],
        tile_size: f32,
    ) -> Self {
        let mut out = Self {
            grids: vec![grid0.to_vec()],
            solid: vec![solid0.to_vec()],
            floor: vec![Vec::new()],
            runs: Vec::new(),
            run_cells: grid0.iter().map(|row| vec![-1i16; row.len()]).collect(),
            tile_size,
        };

        // порядок уровней — по числовому ключу, а не по порядку в JSON:
        // индекс в `grids` обязан совпадать с номером уровня
        let mut ordered: Vec<(u8, &MapLevelConfig)> = levels
            .iter()
            .filter_map(|(key, level)| key.parse::<u8>().ok().map(|index| (index, level)))
            .collect();

        ordered.sort_by_key(|(index, _)| *index);

        for (index, level) in ordered {
            if index as usize != out.grids.len() {
                continue;
            }

            out.grids.push(level.map.clone());
            out.solid.push(level.walls.clone());
            out.floor.push(level.floor.clone());
        }

        out.build_runs(ramps);

        out
    }

    // прогоны рамп: непрерывные линии одинаковых тайлов вдоль оси рампы
    fn build_runs(&mut self, ramps: &[RampConfig]) {
        // заимствования разведены по полям: грид уровня читается на месте,
        // прогоны пишутся в свои поля — иначе пришлось бы клонировать грид
        // на каждую рампу
        let Self {
            grids,
            runs,
            run_cells,
            tile_size,
            ..
        } = self;

        for ramp in ramps {
            let (axis, sign) = ramp.dir.axis_sign();
            let Some(grid) = grids.get(ramp.from as usize) else {
                continue;
            };
            let rows = grid.len();

            if axis == 1 {
                let cols = grid.iter().map(|row| row.len()).max().unwrap_or(0);

                for x in 0..cols {
                    let mut y = 0;

                    while y < rows {
                        if grid[y].get(x) != Some(&ramp.tile) {
                            y += 1;
                            continue;
                        }

                        let y0 = y;

                        while y < rows && grid[y].get(x) == Some(&ramp.tile) {
                            y += 1;
                        }

                        push_run(
                            runs,
                            run_cells,
                            *tile_size,
                            ramp,
                            axis,
                            sign,
                            y0,
                            y,
                            x,
                            x + 1,
                        );
                    }
                }
            } else {
                for (y, row) in grid.iter().enumerate() {
                    let mut x = 0;

                    while x < row.len() {
                        if row[x] != ramp.tile {
                            x += 1;
                            continue;
                        }

                        let x0 = x;

                        while x < row.len() && row[x] == ramp.tile {
                            x += 1;
                        }

                        push_run(
                            runs,
                            run_cells,
                            *tile_size,
                            ramp,
                            axis,
                            sign,
                            x0,
                            x,
                            y,
                            y + 1,
                        );
                    }
                }
            }
        }
    }

    /// Есть ли надземные уровни (2.5D-режим).
    pub fn is_layered(&self) -> bool {
        self.grids.len() > 1
    }

    /// Число уровней, включая землю (1 у обычной карты).
    pub fn level_count(&self) -> usize {
        self.grids.len().max(1)
    }

    pub fn tile_size(&self) -> f32 {
        self.tile_size
    }

    pub fn grid(&self, level: u8) -> Option<&Vec<Vec<i32>>> {
        self.grids.get(level as usize)
    }

    pub fn solid(&self, level: u8) -> &[i32] {
        self.solid.get(level as usize).map_or(&[], |list| list)
    }

    pub fn floor(&self, level: u8) -> &[i32] {
        self.floor.get(level as usize).map_or(&[], |list| list)
    }

    pub fn runs(&self) -> &[RampRun] {
        &self.runs
    }

    /// (колонка, строка) по мировой точке; None вне карты.
    pub fn cell_at(&self, x: f32, y: f32) -> Option<(usize, usize)> {
        if self.tile_size <= 0.0 || x < 0.0 || y < 0.0 {
            return None;
        }

        let cx = (x / self.tile_size).floor() as usize;
        let cy = (y / self.tile_size).floor() as usize;
        let row = self.grids.first()?.get(cy)?;

        if cx >= row.len() { None } else { Some((cx, cy)) }
    }

    /// Есть ли пол уровня `level` в точке. Для уровня 0 — true везде внутри
    /// карты (под мостом земля никуда не девается).
    pub fn has_floor(&self, level: u8, x: f32, y: f32) -> bool {
        let Some((cx, cy)) = self.cell_at(x, y) else {
            return false;
        };

        if level == 0 {
            return true;
        }

        let Some(grid) = self.grid(level) else {
            return false;
        };
        let Some(&tile) = grid.get(cy).and_then(|row| row.get(cx)) else {
            return false;
        };

        self.floor(level).contains(&tile)
    }

    /// Стена уровня `level` в точке.
    pub fn is_solid(&self, level: u8, x: f32, y: f32) -> bool {
        let Some((cx, cy)) = self.cell_at(x, y) else {
            return false;
        };
        let Some(grid) = self.grid(level) else {
            return false;
        };
        let Some(&tile) = grid.get(cy).and_then(|row| row.get(cx)) else {
            return false;
        };

        self.solid(level).contains(&tile)
    }

    /// Наивысший уровень, у которого есть пол в точке. Спавн без явного
    /// уровня приземляется сюда.
    pub fn level_at(&self, x: f32, y: f32) -> u8 {
        let mut level = 0;

        for candidate in (1..self.level_count() as u8).rev() {
            if self.has_floor(candidate, x, y) {
                level = candidate;
                break;
            }
        }

        level
    }

    /// Уровень, на который приземлится тело, сорвавшееся с `from` в точке
    /// (x, y): ближайший уровень строго ниже `from`, у которого в этой
    /// клетке есть пол. 0, если такого нет — земля есть везде внутри карты.
    pub fn landing_level(&self, from: u8, x: f32, y: f32) -> u8 {
        for level in (1..from).rev() {
            if self.has_floor(level, x, y) {
                return level;
            }
        }

        0
    }

    /// Рампа под точкой.
    pub fn ramp_at(&self, x: f32, y: f32) -> Option<RampSample> {
        let (cx, cy) = self.cell_at(x, y)?;
        let index = *self.run_cells.get(cy)?.get(cx)?;

        if index < 0 {
            return None;
        }

        let run = &self.runs[index as usize];
        let value = if run.axis == 0 { x } else { y };
        let span = run.max - run.min;
        let raw = if span <= 0.0 { 0.0 } else { (value - run.min) / span };
        let progress = if run.sign > 0 { raw } else { 1.0 - raw };
        let rise = (run.to as f32 - run.from as f32).abs();
        let sign = run.sign as f32;

        Some(RampSample {
            progress: progress.clamp(0.0, 1.0),
            from: run.from,
            to: run.to,
            dir: if run.axis == 0 { [sign, 0.0] } else { [0.0, sign] },
            slope: rise / span.max(f32::EPSILON),
            run: index as u16,
            axis: run.axis,
        })
    }
}

/// Геометрия падения — одна траектория на всю экосистему. Игра добавляет
/// поверх свои правила (блокировка ввода, урон), но саму траекторию обязана
/// брать здесь: иначе ящик и танк падают по-разному, и расходятся они молча.
#[derive(Clone, Copy, Debug)]
pub struct FallModel {
    /// Секунды на уровень высоты: падение с уровня 3 втрое дольше падения
    /// с уровня 1.
    pub time_per_level: f32,
}

/// Дефолт падения (`EngineConfig::map_fall_time`).
pub const DEFAULT_FALL_TIME: f32 = 0.35;

impl Default for FallModel {
    fn default() -> Self {
        Self {
            time_per_level: DEFAULT_FALL_TIME,
        }
    }
}

impl FallModel {
    /// Длительность падения на высоту `height` уровней.
    pub fn duration(&self, height: f32) -> f32 {
        height.abs() * self.time_per_level.max(0.0)
    }

    /// Высота через `elapsed` секунд после срыва с `from` на `to`.
    pub fn z_at(&self, from: f32, to: f32, elapsed: f32) -> f32 {
        let duration = self.duration(from - to);
        let t = if duration <= 0.0 {
            1.0
        } else {
            (elapsed / duration).clamp(0.0, 1.0)
        };

        lerp(from, to, t)
    }

    /// Обратная к `z_at`: сколько уже длится падение, если высота `z`.
    /// Клиентская реплика восстанавливает ею фазу падения из авторитетного
    /// кадра, в котором есть только `z`.
    pub fn elapsed_at(&self, from: f32, to: f32, z: f32) -> f32 {
        let span = from - to;
        let duration = self.duration(span);

        if duration <= 0.0 || span == 0.0 {
            return 0.0;
        }

        let t = ((from - z) / span).clamp(0.0, 1.0);

        t * duration
    }
}

/// Состояние уровня одного тела карты: где оно стоит и падает ли.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct BodyLevelState {
    /// Уровень опоры; во время падения — уровень, с которого сорвались.
    pub level: u8,
    /// Непрерывная высота 0.0..N для визуала.
    pub z: f32,
    /// Some((to, elapsed)) — падение на уровень `to`.
    pub falling: Option<(u8, f32)>,
}

impl BodyLevelState {
    /// Тело стоит на уровне `level`.
    pub fn grounded(level: u8) -> Self {
        Self {
            level,
            z: level as f32,
            falling: None,
        }
    }
}

/// Что случилось с телом за шаг правил уровня.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyLevelEvent {
    None,
    Landed,
}

/// Маска тела: в падении — только статика (стены есть, тел нет), на опоре —
/// свой уровень.
pub fn body_collision_mask(state: &BodyLevelState) -> Group {
    if state.falling.is_some() {
        STATIC_LEVEL_GROUP
    } else {
        level_group(state.level)
    }
}

/// Шаг правил уровня для ОДНОГО тела карты. Свободная функция, а не метод
/// `GameMap`: её зовёт и хост (через `GameMap::step_dynamic_levels`), и
/// клиентская реплика игры для предсказанных тел — иначе ящик у зрителя
/// падает не туда, куда на хосте.
///
/// Правило: тело, под которым не осталось пола своего уровня, срывается на
/// `landing_level`; пока падает — `z` идёт `from -> to` по `FallModel`.
/// Рампы телам недоступны — их толкают, а не ведут: на клетке рампы тело
/// сохраняет свой уровень.
pub fn step_body_level(
    state: &mut BodyLevelState,
    x: f32,
    y: f32,
    levels: &MapLevels,
    fall: &FallModel,
    dt: f32,
) -> BodyLevelEvent {
    if let Some((to, elapsed)) = state.falling {
        let elapsed = elapsed + dt;
        let from = state.level as f32;
        let target = to as f32;

        if elapsed >= fall.duration(from - target) {
            *state = BodyLevelState::grounded(to);

            return BodyLevelEvent::Landed;
        }

        state.falling = Some((to, elapsed));
        state.z = fall.z_at(from, target, elapsed);

        return BodyLevelEvent::None;
    }

    if state.level == 0 || levels.has_floor(state.level, x, y) {
        return BodyLevelEvent::None;
    }

    // клетка рампы — не обрыв: рампа принадлежит уровню `from`, пола уровня
    // тела на ней нет, но сталкивать тело вниз она не должна
    if levels.ramp_at(x, y).is_some() {
        return BodyLevelEvent::None;
    }

    state.falling = Some((levels.landing_level(state.level, x, y), 0.0));

    BodyLevelEvent::None
}

/// Карта в мире: порт физической части src/server/parts/Map.js +
/// масштабирование из RoundManager.createMap (scaleMapData).
#[derive(Serialize, Deserialize)]
pub struct GameMap {
    pub set_id: String,
    /// Размер тайла после масштабирования.
    pub step: f32,
    /// Сетка тайлов (немасштабируемая) — источник нав-сетки ботов.
    pub grid: Vec<Vec<i32>>,
    pub physics_static: Vec<i32>,
    /// Респауны по командам (масштабированные) — [x, y, angle°] либо
    /// [x, y, angle°, level].
    pub respawns: IndexMap<String, Vec<Vec<f32>>>,
    /// Слоистая геометрия (одноуровневая у карты без `levels`).
    levels: MapLevels,
    static_bodies: Vec<RigidBodyHandle>,
    /// Уровень каждого статического тела, параллелен `static_bodies`.
    static_levels: Vec<u8>,
    dynamic_bodies: Vec<RigidBodyHandle>,
    /// Состояние уровня каждого динамического тела, параллелен
    /// `dynamic_bodies`: тело карты живёт по тем же правилам уровня, что и
    /// танк, — сорвавшись с плиты, оно падает, а не висит в воздухе.
    dynamic_states: Vec<BodyLevelState>,
}

impl GameMap {
    /// Создаёт тела карты в мире. `default_scale`/`default_set_id` —
    /// значения конфига, перекрываемые полями самой карты.
    pub fn create(
        world: &mut PhysicsWorld,
        cfg: &MapConfig,
        default_scale: f32,
        default_set_id: &str,
    ) -> Self {
        let scale = cfg.scale.unwrap_or(default_scale);
        let step = cfg.step * scale;
        let levels = MapLevels::build(
            &cfg.map,
            &cfg.physics_static,
            &cfg.levels,
            &cfg.ramps,
            step,
        );

        let mut map = Self {
            set_id: cfg
                .set_id
                .clone()
                .unwrap_or_else(|| default_set_id.to_string()),
            step,
            grid: cfg.map.clone(),
            physics_static: cfg.physics_static.clone(),
            respawns: cfg
                .respawns
                .iter()
                .map(|(team, arr)| {
                    (
                        team.clone(),
                        arr.iter()
                            .map(|point| {
                                let mut out = point.clone();

                                if out.len() >= 2 {
                                    out[0] *= scale;
                                    out[1] *= scale;
                                }

                                out
                            })
                            .collect(),
                    )
                })
                .collect(),
            levels,
            static_bodies: Vec::new(),
            static_levels: Vec::new(),
            dynamic_bodies: Vec::new(),
            dynamic_states: Vec::new(),
        };

        map.create_static(world);
        map.create_dynamic(world, &cfg.physics_dynamic, scale);

        map
    }

    /// Статические стены (Map.createStatic) — по уровням, в порядке 0, 1, …
    /// Внутри уровня обход прежний (строки сверху вниз, колонки слева
    /// направо), поэтому у одноуровневой карты порядок вставки тел
    /// не меняется вовсе.
    fn create_static(&mut self, world: &mut PhysicsWorld) {
        for level in 0..self.levels.level_count() as u8 {
            let Some(grid) = self.levels.grid(level) else {
                continue;
            };
            let solid = self.levels.solid(level).to_vec();

            let mut work: Vec<Vec<Option<i32>>> = grid
                .iter()
                .map(|row| row.iter().map(|&tile| Some(tile)).collect())
                .collect();

            for y in 0..work.len() {
                for x in 0..work[y].len() {
                    let is_static = work[y][x].is_some_and(|tile| solid.contains(&tile));

                    if is_static {
                        let (width, height) =
                            search_static_block(&mut work, &solid, self.step, y, x);
                        let pos_x = x as f32 * self.step + width / 2.0;
                        let pos_y = y as f32 * self.step + height / 2.0;

                        let body = world.insert_body(
                            RigidBodyBuilder::fixed().translation(Vector::new(pos_x, pos_y)),
                        );

                        world.insert_collider(
                            ColliderBuilder::cuboid(width / 2.0, height / 2.0)
                                .friction(DEFAULT_FRICTION)
                                .restitution(DEFAULT_RESTITUTION)
                                .collision_groups(static_level_interaction(level)),
                            Some(body),
                        );

                        self.static_bodies.push(body);
                        self.static_levels.push(level);
                    }
                }
            }
        }
    }

    /// Динамические элементы (Map.createDynamic).
    fn create_dynamic(
        &mut self,
        world: &mut PhysicsWorld,
        dynamics: &[DynamicObjectConfig],
        scale: f32,
    ) {
        for data in dynamics {
            let pos_x = data.position[0] * scale;
            let pos_y = data.position[1] * scale;
            let width = data.width * scale;
            let height = data.height * scale;

            let body = world.insert_body(
                RigidBodyBuilder::dynamic()
                    .translation(Vector::new(pos_x, pos_y))
                    .rotation(deg_to_rad(data.angle))
                    .linear_damping(data.linear_damping.unwrap_or(0.0))
                    .angular_damping(data.angular_damping.unwrap_or(0.01))
                    // предиктивные контакты на толщину ящика — та же причина,
                    // что и у танка: дефолтная дистанция предсказания Rapier
                    // рассчитана на метры и на порядки меньше пути тела за шаг
                    .soft_ccd_prediction(width.min(height))
                    .user_data(encode_map_object()),
            );

            // коллайдер со смещённым центром (позиция тела — угол объекта)
            world.insert_collider(
                ColliderBuilder::cuboid(width / 2.0, height / 2.0)
                    .translation(Vector::new(width / 2.0, height / 2.0))
                    .density(data.density)
                    .friction(DEFAULT_FRICTION)
                    .restitution(DEFAULT_RESTITUTION)
                    .collision_groups(level_interaction(data.level)),
                Some(body),
            );

            self.dynamic_bodies.push(body);
            self.dynamic_states.push(BodyLevelState::grounded(data.level));
        }
    }

    // ***** слоистая геометрия ***** //

    pub fn levels(&self) -> &MapLevels {
        &self.levels
    }

    pub fn is_layered(&self) -> bool {
        self.levels.is_layered()
    }

    pub fn level_count(&self) -> usize {
        self.levels.level_count()
    }

    pub fn level_at(&self, x: f32, y: f32) -> u8 {
        self.levels.level_at(x, y)
    }

    pub fn has_floor(&self, level: u8, x: f32, y: f32) -> bool {
        self.levels.has_floor(level, x, y)
    }

    pub fn ramp_at(&self, x: f32, y: f32) -> Option<RampSample> {
        self.levels.ramp_at(x, y)
    }

    /// Уровень динамического тела по его индексу в блоке снапшота.
    pub fn dynamic_level(&self, index: usize) -> u8 {
        self.dynamic_states.get(index).map_or(0, |state| state.level)
    }

    /// Состояние уровня динамического тела (уровень, высота, фаза падения).
    pub fn dynamic_level_state(&self, index: usize) -> BodyLevelState {
        self.dynamic_states
            .get(index)
            .copied()
            .unwrap_or(BodyLevelState::grounded(0))
    }

    /// Шаг правил уровня для всех тел карты: срыв с обрыва, падение, смена
    /// маски по приземлении. Зовёт её движок (`EngineSim::step_fixed`) до
    /// шага мира — у игры нет мутабельного доступа к карте (`SimCtx.map`).
    pub fn step_dynamic_levels(&mut self, world: &mut PhysicsWorld, fall: &FallModel, dt: f32) {
        if !self.levels.is_layered() {
            return;
        }

        for (index, &handle) in self.dynamic_bodies.iter().enumerate() {
            let Some(state) = self.dynamic_states.get_mut(index) else {
                continue;
            };
            let Some(&collider) = world
                .bodies
                .get(handle)
                .and_then(|body| body.colliders().first())
            else {
                continue;
            };
            // позиция тела — угол объекта, а не центр: клетку под телом
            // спрашиваем у коллайдера, он стоит по центру
            let pos = world.colliders[collider].translation();
            let before = body_collision_mask(state);

            step_body_level(state, pos.x, pos.y, &self.levels, fall, dt);

            let after = body_collision_mask(state);

            if after != before && let Some(collider) = world.colliders.get_mut(collider) {
                collider.set_collision_groups(levels_interaction(after));
            }
        }
    }

    /// Уровни статических тел (отладочный дамп).
    pub fn static_levels(&self) -> &[u8] {
        &self.static_levels
    }

    /// Уровни динамических тел (отладочный дамп).
    pub fn dynamic_levels(&self) -> Vec<u8> {
        self.dynamic_states.iter().map(|state| state.level).collect()
    }

    // ***** отладочный дамп (crate::debug) ***** //

    pub fn static_body_count(&self) -> usize {
        self.static_bodies.len()
    }

    pub fn dynamic_body_count(&self) -> usize {
        self.dynamic_bodies.len()
    }

    /// Удаляет все тела карты из мира (Map.destroyMap).
    pub fn destroy(&mut self, world: &mut PhysicsWorld) {
        for handle in self.static_bodies.drain(..) {
            world.remove_body(handle);
        }

        for handle in self.dynamic_bodies.drain(..) {
            world.remove_body(handle);
        }

        self.static_levels.clear();
        self.dynamic_states.clear();
    }

    /// Краткие данные динамических элементов (Map.getDynamicMapData):
    /// индекс → [x, y, angle] (как поля строки блока), значения скруглены
    /// до 2 знаков.
    ///
    /// При `with_levels` в голову строки добавляются `z` и `level`
    /// (позиции 3 и 4) — контракт схемы блока: игра, объявившая эти два
    /// поля, получает слоёную строку, игра со старой схемой — прежние три
    /// поля. Место в ГОЛОВЕ, а не в хвосте, обязательно: отсутствующий
    /// хвост распаковывается нулями, и покоящийся ящик на мосту у зрителя
    /// «упал» бы на землю.
    ///
    /// При `with_velocities` движущееся тело отдаёт ещё и хвост
    /// [vx, vy, angvel] (кадр v4, `optionalFrom` в схеме блока): клиент
    /// предсказывает динамику карты рядом со своим танком, а оценка скорости
    /// конечной разностью между кадрами 30 Гц сильнее всего врёт именно в
    /// момент удара. Покоящееся тело хвост не шлёт.
    pub fn dynamic_map_data(
        &self,
        world: &PhysicsWorld,
        with_levels: bool,
        with_velocities: bool,
    ) -> Vec<(u8, Vec<FieldValue>)> {
        self.dynamic_bodies
            .iter()
            .enumerate()
            .filter_map(|(index, &handle)| {
                world.bodies.get(handle).map(|body| {
                    let pos = body.translation();

                    let mut fields = vec![
                        FieldValue::F32(round2(pos.x)),
                        FieldValue::F32(round2(pos.y)),
                        FieldValue::F32(round2(body.rotation().angle())),
                    ];

                    if with_levels {
                        let state = self.dynamic_level_state(index);

                        fields.push(FieldValue::F32(round2(state.z)));
                        fields.push(FieldValue::U8(state.level));
                    }

                    if with_velocities {
                        let linvel = body.linvel();
                        let angvel = body.angvel();
                        let resting = body.is_sleeping()
                            || (linvel.x.hypot(linvel.y) < REST_VELOCITY_EPSILON
                                && angvel.abs() < REST_VELOCITY_EPSILON);

                        if !resting {
                            fields.push(FieldValue::F32(round2(linvel.x)));
                            fields.push(FieldValue::F32(round2(linvel.y)));
                            fields.push(FieldValue::F32(round2(angvel)));
                        }
                    }

                    (index as u8, fields)
                })
            })
            .collect()
    }
}

/// Жадный поиск прямоугольного блока стен (Map.searchStaticBlock).
/// Обработанные ячейки затираются в рабочей копии сетки. Список сплошных
/// тайлов свой у каждого уровня, поэтому функция свободная, а не метод.
fn search_static_block(
    work: &mut [Vec<Option<i32>>],
    solid: &[i32],
    step: f32,
    y0: usize,
    x0: usize,
) -> (f32, f32) {
    let mut x = x0;
    let mut w_counter = 0;
    let mut h_counter = 1;

    // ширина блока
    while x < work[y0].len() && work[y0][x].is_some_and(|tile| solid.contains(&tile)) {
        work[y0][x] = None;
        x += 1;
        w_counter += 1;
    }

    let len_x = x;
    let len_y = work.len();

    // высота блока
    for y in (y0 + 1)..len_y {
        let mut empty_tile = false;
        let mut x = x0;

        while x < len_x {
            if x < work[y].len() && work[y][x].is_some_and(|tile| solid.contains(&tile)) {
                x += 1;
            } else {
                empty_tile = true;
                break;
            }
        }

        if empty_tile {
            break;
        }

        h_counter += 1;

        for cell in work[y][x0..len_x].iter_mut() {
            *cell = None;
        }
    }

    (w_counter as f32 * step, h_counter as f32 * step)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIME_STEP: f32 = 1.0 / 120.0;

    // сплошная стена в верхнем ряду (5 тайлов по 20) и один ящик 20×20 под ней
    fn map_config() -> MapConfig {
        serde_json::from_value(serde_json::json!({
            "step": 20.0,
            "map": [[1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]],
            "physicsStatic": [1],
            "physicsDynamic": [{
                "position": [40.0, 60.0],
                "angle": 0.0,
                "width": 20.0,
                "height": 20.0,
                "density": 1.0
            }]
        }))
        .unwrap()
    }

    fn make_world() -> PhysicsWorld {
        let mut world = PhysicsWorld::new();

        world.gravity = Vector::ZERO;
        world.integration_parameters.dt = TIME_STEP;

        world
    }

    // глубина самого глубокого перекрытия за прогон: ящик разгоняется в стену
    fn max_penetration(world: &mut PhysicsWorld, body: RigidBodyHandle) -> f32 {
        let mut depth: f32 = 0.0;

        // ~17 юнитов за шаг — на порядки больше дефолтных 0.002 и сравнимо
        // с толщиной ящика: без предсказания контакт рождается уже внутри
        world.bodies[body].set_linvel(Vector::new(0.0, -2000.0), true);

        for _ in 0..120 {
            world.step();

            for pair in world.contact_pairs() {
                for manifold in &pair.manifolds {
                    for point in &manifold.points {
                        depth = depth.max(-point.dist);
                    }
                }
            }
        }

        depth
    }

    // карта 3×3: стена уровня 0 в углу, плита уровня 1 в центре строки 1,
    // перила — правый тайл плиты
    fn layered_config() -> MapConfig {
        serde_json::from_value(serde_json::json!({
            "step": 20.0,
            "map": [[1, 0, 0], [0, 0, 0], [0, 0, 0]],
            "physicsStatic": [1],
            "levels": {
                "1": {
                    "map": [[0, 0, 0], [0, 5, 6], [0, 0, 0]],
                    "floor": [5, 6],
                    "walls": [6]
                }
            }
        }))
        .unwrap()
    }

    // вертикальная рампа 1×3 в колонке 0
    fn ramp_config(dir: &str) -> MapConfig {
        serde_json::from_value(serde_json::json!({
            "step": 20.0,
            "map": [[7, 0, 0], [7, 0, 0], [7, 0, 0]],
            "physicsStatic": [],
            "levels": {
                "1": { "map": [[0, 0, 0], [0, 0, 0], [0, 0, 0]], "floor": [] }
            },
            "ramps": [{ "tile": 7, "dir": dir }]
        }))
        .unwrap()
    }

    fn collision_groups(world: &PhysicsWorld, body: RigidBodyHandle) -> InteractionGroups {
        let handle = world.bodies[body].colliders()[0];

        world.colliders[handle].collision_groups()
    }

    #[test]
    fn legacy_map_has_no_levels() {
        let mut world = make_world();
        let map = GameMap::create(&mut world, &map_config(), 1.0, "set");

        assert!(!map.is_layered());
        assert_eq!(map.level_count(), 1);
        // стена 5×1 схлопывается в одно тело, как и до появления слоёв
        assert_eq!(map.static_body_count(), 1);
        assert_eq!(
            world.bodies[map.static_bodies[0]].translation(),
            Vector::new(50.0, 10.0)
        );
    }

    #[test]
    fn layered_map_builds_static_per_level() {
        let mut world = make_world();
        let map = GameMap::create(&mut world, &layered_config(), 1.0, "set");

        assert!(map.is_layered());
        assert_eq!(map.static_body_count(), 2);
        assert_eq!(map.static_levels(), &[0, 1]);
        // стена несёт свою группу уровня И группу статики: падающий танк
        // (маска STATIC_LEVEL_GROUP) обязан задевать стены обоих уровней
        assert_eq!(
            collision_groups(&world, map.static_bodies[0]).memberships,
            Group::GROUP_1 | STATIC_LEVEL_GROUP
        );
        assert_eq!(
            collision_groups(&world, map.static_bodies[1]).memberships,
            Group::GROUP_2 | STATIC_LEVEL_GROUP
        );
    }

    #[test]
    fn static_group_sees_walls_but_no_bodies() {
        let falling = InteractionGroups::new(
            STATIC_LEVEL_GROUP,
            STATIC_LEVEL_GROUP,
            InteractionTestMode::And,
        );

        // стены обоих уровней падающий задевает
        assert!(falling.test(static_level_interaction(0)));
        assert!(falling.test(static_level_interaction(1)));
        // тела (танки, ящики) — нет
        assert!(!falling.test(level_interaction(0)));
        assert!(!falling.test(level_interaction(1)));
    }

    #[test]
    fn dynamic_body_carries_level_group() {
        let mut cfg = layered_config();

        cfg.physics_dynamic = vec![DynamicObjectConfig {
            position: [20.0, 20.0],
            angle: 0.0,
            width: 20.0,
            height: 20.0,
            density: 1.0,
            linear_damping: None,
            angular_damping: None,
            level: 1,
        }];

        let mut world = make_world();
        let map = GameMap::create(&mut world, &cfg, 1.0, "set");

        assert_eq!(map.dynamic_level(0), 1);
        assert_eq!(
            collision_groups(&world, map.dynamic_bodies[0]).memberships,
            Group::GROUP_2
        );
    }

    #[test]
    fn has_floor_reports_slab_and_ground() {
        let mut world = make_world();
        let map = GameMap::create(&mut world, &layered_config(), 1.0, "set");

        assert!(map.has_floor(0, 10.0, 10.0));
        assert!(!map.has_floor(0, -5.0, 10.0));
        assert!(!map.has_floor(0, 70.0, 10.0));

        assert!(map.has_floor(1, 30.0, 30.0));
        assert!(map.has_floor(1, 50.0, 30.0));
        assert!(!map.has_floor(1, 10.0, 10.0));
    }

    #[test]
    fn level_at_picks_highest_floor() {
        let mut world = make_world();
        let map = GameMap::create(&mut world, &layered_config(), 1.0, "set");

        assert_eq!(map.level_at(30.0, 30.0), 1);
        assert_eq!(map.level_at(10.0, 30.0), 0);
    }

    #[test]
    fn ramp_progress_runs_from_bottom_to_top() {
        let mut world = make_world();
        let north = GameMap::create(&mut world, &ramp_config("north"), 1.0, "set");

        // подъём на север: подножие внизу (y = 60), вершина вверху (y = 0)
        assert!(north.ramp_at(10.0, 59.0).unwrap().progress < 0.05);
        assert!(north.ramp_at(10.0, 1.0).unwrap().progress > 0.95);
        assert!((north.ramp_at(10.0, 30.0).unwrap().progress - 0.5).abs() < 0.01);
        assert_eq!(north.ramp_at(10.0, 30.0).unwrap().to, 1);
        assert!(north.ramp_at(30.0, 30.0).is_none());

        let mut world = make_world();
        let south = GameMap::create(&mut world, &ramp_config("south"), 1.0, "set");

        assert!(south.ramp_at(10.0, 1.0).unwrap().progress < 0.05);
        assert!(south.ramp_at(10.0, 59.0).unwrap().progress > 0.95);
    }

    #[test]
    fn ramp_runs_are_split_per_line() {
        let mut cfg = ramp_config("north");

        // тот же тайл рампы в двух соседних колонках
        for row in &mut cfg.map {
            row[1] = 7;
        }

        let mut world = make_world();
        let map = GameMap::create(&mut world, &cfg, 1.0, "set");
        let runs = map.levels().runs();

        assert_eq!(runs.len(), 2);
        assert_eq!((runs[0].min, runs[0].max), (0.0, 60.0));
        assert_eq!((runs[1].min, runs[1].max), (0.0, 60.0));
        assert_ne!(runs[0].cross_min, runs[1].cross_min);
    }

    #[test]
    fn respawn_accepts_three_and_four_numbers() {
        let cfg: MapConfig = serde_json::from_value(serde_json::json!({
            "step": 20.0,
            "map": [[0, 0], [0, 0]],
            "levels": { "1": { "map": [[0, 0], [0, 0]], "floor": [] } },
            "respawns": { "team1": [[10.0, 20.0, 0.0], [30.0, 40.0, 90.0, 1.0]] }
        }))
        .unwrap();

        cfg.validate().unwrap();

        let mut world = make_world();
        let map = GameMap::create(&mut world, &cfg, 2.0, "set");
        let points = &map.respawns["team1"];

        assert_eq!(points[0], vec![20.0, 40.0, 0.0]);
        assert_eq!(points[1], vec![60.0, 80.0, 90.0, 1.0]);
    }

    #[test]
    fn validate_rejects_mismatched_level_grid() {
        let mut cfg = layered_config();

        cfg.levels["1"].map.pop();

        let error = cfg.validate().unwrap_err();

        assert!(error.contains("rows"), "{error}");
    }

    #[test]
    fn validate_rejects_railing_outside_floor() {
        let mut cfg = layered_config();

        cfg.levels["1"].floor = vec![5];

        let error = cfg.validate().unwrap_err();

        assert!(error.contains("floor"), "{error}");
    }

    #[test]
    fn validate_rejects_unknown_ramp_tile() {
        let mut cfg = ramp_config("north");

        cfg.ramps[0].tile = 99;

        let error = cfg.validate().unwrap_err();

        assert!(error.contains("missing"), "{error}");
    }

    // Общий с JS-правилом E4 корпус кейсов: одна и та же карта и один и тот
    // же ожидаемый фрагмент сообщения. Тексты у двух реализаций разные,
    // фрагмент — то, о чём они договорились; разойдётся одна из них —
    // покраснеет здесь, а не молча на живой карте.
    #[test]
    fn shared_layered_fixtures() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../contract/fixtures/layered");

        let mut checked = 0;

        for entry in std::fs::read_dir(&dir).expect("fixtures dir") {
            let path = entry.unwrap().path();

            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }

            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            let doc: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
                    .unwrap_or_else(|e| panic!("{name}: {e}"));

            let cfg: MapConfig = serde_json::from_value(doc["map"].clone())
                .unwrap_or_else(|e| panic!("{name}: {e}"));

            let result = cfg.validate();

            match doc.get("expect").and_then(|v| v.as_str()) {
                None => assert!(result.is_ok(), "{name}: {result:?}"),
                Some(fragment) => {
                    let error = result.expect_err(&format!("{name}: expected an error"));

                    assert!(error.contains(fragment), "{name}: got {error}");
                }
            }

            checked += 1;
        }

        assert!(checked > 1, "корпус фикстур не прочитан: {checked}");
    }

    #[test]
    fn validate_rejects_level_out_of_range() {
        let cfg: MapConfig = serde_json::from_value(serde_json::json!({
            "step": 20.0,
            "map": [[0, 0], [0, 0]],
            "respawns": { "team1": [[10.0, 20.0, 0.0, 5.0]] }
        }))
        .unwrap();

        let error = cfg.validate().unwrap_err();

        assert!(error.contains("out of range"), "{error}");
    }

    // карта 4×4 из трёх плит друг над другом: у каждой пол в клетке (1, 1)
    fn stacked_config(levels: u8) -> MapConfig {
        let mut cfg = serde_json::json!({
            "step": 20.0,
            "map": [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
            "physicsStatic": [],
            "levels": {}
        });

        for level in 1..=levels {
            let mut grid = vec![vec![0; 4]; 4];

            grid[1][1] = 5;

            cfg["levels"][level.to_string()] = serde_json::json!({
                "map": grid,
                "floor": [5]
            });
        }

        serde_json::from_value(cfg).unwrap()
    }

    // земля со стеной в клетке (2, 1); плита уровня 1 накрывает (1, 1) и
    // (2, 1), плита уровня 2 стоит только над (1, 1)
    fn slab_over_slab_config() -> MapConfig {
        serde_json::from_value(serde_json::json!({
            "step": 20.0,
            "map": [[0, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
            "physicsStatic": [1],
            "levels": {
                "1": {
                    "map": [[0, 0, 0, 0], [0, 5, 5, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
                    "floor": [5]
                },
                "2": {
                    "map": [[0, 0, 0, 0], [0, 6, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
                    "floor": [6]
                }
            }
        }))
        .unwrap()
    }

    // рампа с земли на уровень 2: прогон из клеток (1, 2) и (2, 2),
    // выход — клетка (3, 2) плиты уровня 2. `through_slab` кладёт плиту
    // уровня 1 ровно на клетки прогона
    fn long_ramp_config(through_slab: bool) -> MapConfig {
        let mut level1 = vec![vec![0; 5]; 5];

        if through_slab {
            level1[2][1] = 8;
            level1[2][2] = 8;
        }

        let mut level2 = vec![vec![0; 5]; 5];

        level2[2][3] = 6;

        let mut grid = vec![vec![0; 5]; 5];

        grid[2][1] = 7;
        grid[2][2] = 7;

        serde_json::from_value(serde_json::json!({
            "step": 20.0,
            "map": grid,
            "physicsStatic": [],
            "levels": {
                "1": { "map": level1, "floor": [8] },
                "2": { "map": level2, "floor": [6] }
            },
            "ramps": [{ "tile": 7, "dir": "east", "from": 0, "to": 2 }]
        }))
        .unwrap()
    }

    fn as_f32(value: &FieldValue) -> f32 {
        match *value {
            FieldValue::F32(v) => v,
            FieldValue::U8(v) => v as f32,
            FieldValue::U16(v) => v as f32,
            FieldValue::U32(v) => v as f32,
        }
    }

    #[test]
    fn level_group_gives_one_bit_per_level() {
        let mut seen = Group::empty();

        for level in 0..MAX_LEVELS as u8 {
            let group = level_group(level);

            assert_eq!(group.bits().count_ones(), 1, "level {level}: {group:?}");
            assert!(!seen.contains(group), "level {level} повторил чужой бит");
            assert!(
                !group.intersects(STATIC_LEVEL_GROUP),
                "level {level} наехал на группу статики"
            );

            seen |= group;
        }

        // значения уровней 0 и 1 — прежние: на них собраны все карты и все
        // ожидания уже написанных тестов
        assert_eq!(level_group(0), Group::GROUP_1);
        assert_eq!(level_group(1), Group::GROUP_2);
    }

    #[test]
    fn validate_accepts_three_levels_and_rejects_a_gap() {
        stacked_config(3).validate().unwrap();

        let mut cfg = stacked_config(3);

        cfg.levels.shift_remove("2");

        let error = cfg.validate().unwrap_err();

        assert!(error.contains("without gaps"), "{error}");
    }

    #[test]
    fn validate_rejects_more_levels_than_supported() {
        let error = stacked_config(MAX_LEVELS as u8).validate().unwrap_err();

        assert!(error.contains("at most"), "{error}");
    }

    #[test]
    fn landing_level_picks_nearest_slab_below() {
        let mut world = make_world();
        let map = GameMap::create(&mut world, &slab_over_slab_config(), 1.0, "set");
        let levels = map.levels();

        // под клеткой (2, 1) плита уровня 1
        assert_eq!(levels.landing_level(2, 50.0, 30.0), 1);
        // над клеткой (0, 0) нет ничего, кроме земли
        assert_eq!(levels.landing_level(2, 10.0, 10.0), 0);
        assert_eq!(levels.landing_level(1, 50.0, 30.0), 0);
    }

    #[test]
    fn open_edge_over_a_slab_is_valid() {
        // край плиты уровня 2 выходит на плиту уровня 1, под которой стена
        // земли: до появления `landing_level` это была ошибка «нет земли»
        slab_over_slab_config().validate().unwrap();
    }

    #[test]
    fn ramp_may_climb_two_levels_but_not_through_a_slab() {
        long_ramp_config(false).validate().unwrap();

        let error = long_ramp_config(true).validate().unwrap_err();

        assert!(error.contains("through level 1 floor"), "{error}");
    }

    #[test]
    fn ramp_sample_reports_slope_and_direction() {
        let mut world = make_world();
        // прогон из трёх клеток по 20 юнитов, подъём на один уровень
        let north = GameMap::create(&mut world, &ramp_config("north"), 1.0, "set");
        let sample = north.ramp_at(10.0, 30.0).unwrap();

        assert_eq!(sample.dir, [0.0, -1.0]);
        assert_eq!(sample.axis, 1);
        assert_eq!(sample.run, 0);
        assert!((sample.slope - 1.0 / 60.0).abs() < 1e-6, "{}", sample.slope);

        // тот же подъём втрое короче — втрое круче
        let mut cfg = ramp_config("north");

        cfg.map[1][0] = 0;
        cfg.map[2][0] = 0;

        let mut world = make_world();
        let short = GameMap::create(&mut world, &cfg, 1.0, "set");
        let steep = short.ramp_at(10.0, 10.0).unwrap();

        assert!(steep.slope > sample.slope * 2.9, "{}", steep.slope);

        let mut world = make_world();
        let east = GameMap::create(&mut world, &long_ramp_config(false), 1.0, "set");
        let east = east.ramp_at(30.0, 50.0).unwrap();

        assert_eq!(east.dir, [1.0, 0.0]);
        assert_eq!(east.axis, 0);
        // подъём на два уровня по двум клеткам — вдвое круче подъёма на один
        assert!((east.slope - 2.0 / 40.0).abs() < 1e-6, "{}", east.slope);
    }

    #[test]
    fn fall_model_duration_grows_with_height() {
        let fall = FallModel::default();

        assert!(fall.duration(3.0) > fall.duration(1.0));
        assert_eq!(fall.duration(2.0), 2.0 * fall.duration(1.0));
        assert_eq!(fall.duration(-2.0), fall.duration(2.0));
    }

    #[test]
    fn fall_model_elapsed_is_inverse_of_z() {
        let fall = FallModel::default();

        for (from, to) in [(1.0_f32, 0.0_f32), (3.0, 1.0), (2.0, 0.0)] {
            for step in 0..=10 {
                let elapsed = fall.duration(from - to) * step as f32 / 10.0;
                let z = fall.z_at(from, to, elapsed);

                assert!(
                    (fall.elapsed_at(from, to, z) - elapsed).abs() < 1e-4,
                    "{from}->{to} на {elapsed}: z {z}"
                );
            }
        }

        // мгновенное падение (нулевая высота) фазы не имеет
        assert_eq!(fall.elapsed_at(1.0, 1.0, 1.0), 0.0);
    }

    #[test]
    fn body_off_the_slab_falls_to_the_landing_level() {
        let mut world = make_world();
        let map = GameMap::create(&mut world, &slab_over_slab_config(), 1.0, "set");
        let levels = map.levels();
        let fall = FallModel::default();
        let mut state = BodyLevelState::grounded(2);

        // клетка (2, 1): плиты уровня 2 нет, под ней плита уровня 1
        step_body_level(&mut state, 50.0, 30.0, levels, &fall, 0.1);

        assert_eq!(state.falling.map(|(to, _)| to), Some(1));
        assert_eq!(body_collision_mask(&state), STATIC_LEVEL_GROUP);

        let mut landed = false;

        for _ in 0..100 {
            if step_body_level(&mut state, 50.0, 30.0, levels, &fall, 0.1)
                == BodyLevelEvent::Landed
            {
                landed = true;
                break;
            }

            assert!(state.z < 2.0 && state.z > 1.0, "{}", state.z);
        }

        assert!(landed, "тело не приземлилось");
        assert_eq!(state.level, 1);
        assert_eq!(state.z, 1.0);
        assert_eq!(body_collision_mask(&state), level_group(1));
    }

    #[test]
    fn body_on_the_slab_and_on_a_ramp_stays_put() {
        let mut world = make_world();
        let map = GameMap::create(&mut world, &slab_over_slab_config(), 1.0, "set");
        let fall = FallModel::default();
        let mut state = BodyLevelState::grounded(2);

        // в глубине плиты уровня 2
        step_body_level(&mut state, 30.0, 30.0, map.levels(), &fall, 0.1);

        assert_eq!(state, BodyLevelState::grounded(2));

        // на клетке рампы тело сохраняет свой уровень: рампы телам
        // недоступны, их толкают, а не ведут
        let mut world = make_world();
        let ramp = GameMap::create(&mut world, &long_ramp_config(false), 1.0, "set");
        let mut state = BodyLevelState::grounded(1);

        step_body_level(&mut state, 30.0, 50.0, ramp.levels(), &fall, 0.1);

        assert_eq!(state, BodyLevelState::grounded(1));
    }

    #[test]
    fn step_dynamic_levels_moves_the_body_group() {
        let mut cfg = slab_over_slab_config();

        // ящик 10×10 центром в клетке (0, 1): плиты уровня 1 под ним нет
        cfg.physics_dynamic = vec![DynamicObjectConfig {
            position: [5.0, 25.0],
            angle: 0.0,
            width: 10.0,
            height: 10.0,
            density: 1.0,
            linear_damping: None,
            angular_damping: None,
            level: 1,
        }];

        let mut world = make_world();
        let mut map = GameMap::create(&mut world, &cfg, 1.0, "set");
        let fall = FallModel::default();

        map.step_dynamic_levels(&mut world, &fall, 0.05);

        assert!(map.dynamic_level_state(0).falling.is_some());
        assert_eq!(
            collision_groups(&world, map.dynamic_bodies[0]).memberships,
            STATIC_LEVEL_GROUP
        );

        for _ in 0..100 {
            map.step_dynamic_levels(&mut world, &fall, 0.05);
        }

        assert_eq!(map.dynamic_level(0), 0);
        assert_eq!(map.dynamic_level_state(0).z, 0.0);
        assert_eq!(
            collision_groups(&world, map.dynamic_bodies[0]).memberships,
            Group::GROUP_1
        );
    }

    #[test]
    fn dynamic_map_data_writes_levels_only_for_the_new_schema() {
        let mut cfg = layered_config();

        cfg.physics_dynamic = vec![DynamicObjectConfig {
            position: [20.0, 20.0],
            angle: 0.0,
            width: 20.0,
            height: 20.0,
            density: 1.0,
            linear_damping: None,
            angular_damping: None,
            level: 1,
        }];

        let mut world = make_world();
        let map = GameMap::create(&mut world, &cfg, 1.0, "set");

        let rows = map.dynamic_map_data(&world, true, true);
        let (index, fields) = &rows[0];

        // покоящееся тело хвоста скоростей не шлёт, но z/level в голове есть
        assert_eq!(*index, 0);
        assert_eq!(fields.len(), 5);
        assert_eq!(as_f32(&fields[3]), 1.0);
        assert_eq!(as_f32(&fields[4]), 1.0);

        // игра со старой схемой получает прежние три поля
        let rows = map.dynamic_map_data(&world, false, true);

        assert_eq!(rows[0].1.len(), 3);
    }

    #[test]
    fn dynamic_body_gets_soft_ccd_prediction_of_thickness() {
        let mut world = make_world();
        let map = GameMap::create(&mut world, &map_config(), 1.0, "set");

        let prediction = world.bodies[map.dynamic_bodies[0]].soft_ccd_prediction();

        // без предсказания контакт рождается уже по факту перекрытия: за шаг
        // 1/120 тело проходит на порядки больше дефолтных 0.002 юнита
        assert_eq!(prediction, 20.0);
    }

    #[test]
    fn soft_ccd_prediction_keeps_penetration_shallow() {
        let mut world = make_world();
        let map = GameMap::create(&mut world, &map_config(), 1.0, "set");
        let handle = map.dynamic_bodies[0];

        let predicted = max_penetration(&mut world, handle);

        let mut plain_world = make_world();
        let plain_map = GameMap::create(&mut plain_world, &map_config(), 1.0, "set");
        let plain_handle = plain_map.dynamic_bodies[0];

        plain_world.bodies[plain_handle].set_soft_ccd_prediction(0.0);

        let plain = max_penetration(&mut plain_world, plain_handle);

        assert!(
            plain > 5.0,
            "без предсказания ожидалось глубокое перекрытие, получено {plain}"
        );
        assert!(predicted < 2.0, "с предсказанием перекрытие {predicted}");
    }
}
