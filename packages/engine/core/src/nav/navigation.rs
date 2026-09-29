use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::map::MapLevels;
use crate::nav::pathfinder::{self, Edge};
use crate::rng::Rng;

// коэффициент шага сетки
const COEF_GRID_STEP: f32 = 2.0;

/// Штраф ребра «спрыгнуть с обрыва» в единицах длины НА УРОВЕНЬ высоты:
/// бот выбирает прыжок, только если он экономит больше этого. Прыжок стоит
/// здоровья (fallDamage игры), и стоит тем дороже, чем выше падать.
const LEDGE_PENALTY: f32 = 1500.0;

/// Точка пути с уровнем: смена уровня между соседними точками означает
/// проезд по рампе или прыжок с обрыва.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PathPoint {
    pub pos: [f32; 2],
    pub level: u8,
}

/// Штрафная зона запроса: рёбра, середина которых внутри круга на этом
/// уровне, дороже на `cost_per_unit · (1 − d/radius)` за единицу длины.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PenaltyZone {
    pub level: u8,
    pub center: [f32; 2],
    pub radius: f32,
    pub cost_per_unit: f32,
}

/// Параметры поиска маршрута. `Default` — поведение `find_path_on`.
#[derive(Clone, Copy, Debug)]
pub struct PathQuery<'a> {
    /// Ширина корпуса, мировые единицы: ребро запрещено, если где-то на нём
    /// `fit < ceil(min_width / grid_step)`. 0 — без ограничения.
    pub min_width: f32,
    /// Желательный запас от стен, мировые единицы: ребро с `clearance`
    /// меньше него дороже (см. `narrow_cost`). 0 — без предпочтения.
    pub comfort_clearance: f32,
    /// Доля длины ребра, добавляемая при нулевом запасе (линейно до 0 при запасе ≥ comfort).
    pub narrow_cost: f32,
    /// Множитель штрафа обрыва `LEDGE_PENALTY · height`: 1 — как в графе,
    /// 0 — прыжок стоит только длину, `f32::INFINITY` — обрывы запрещены.
    pub ledge_cost_scale: f32,
    pub penalties: &'a [PenaltyZone],
}

impl Default for PathQuery<'_> {
    fn default() -> Self {
        Self {
            min_width: 0.0,
            comfort_clearance: 0.0,
            narrow_cost: 0.0,
            ledge_cost_scale: 1.0,
            penalties: &[],
        }
    }
}

/// Как бот ПРИХОДИТ в точку участка из предыдущей точки.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum LegKind {
    Walk,
    /// Подъём или спуск по рампе; `axis`/`sign` — как у `RampRun`.
    Ramp {
        axis: u8,
        sign: i8,
    },
    /// Прыжок с обрыва на `height` уровней вниз.
    Ledge {
        height: u8,
    },
}

/// Точка маршрута и способ, которым в неё приезжают.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct RouteLeg {
    pub point: PathPoint,
    pub kind: LegKind,
}

/// Маршрут `find_route`: участки по порядку и полная стоимость по правилам
/// запроса (длина плюс штрафы).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Route {
    pub legs: Vec<RouteLeg>,
    pub cost: f32,
}

/// Насыщение сетки `fit`: шире корпусов не бывает, а ДП дешевле.
const FIT_CAP: u8 = 15;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
enum EdgeKind {
    Walk,
    /// Ребро подножие → вершина прогона. `axis`/`sign` — как у `RampRun`.
    Ramp {
        axis: u8,
        sign: i8,
    },
    /// Спрыгнуть с обрыва: `height` — сколько уровней падать.
    Ledge {
        height: u8,
    },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct EdgeInfo {
    /// Минимум `fit` по клеткам ребра (линия Брезенхэма между узлами).
    fit: u8,
    /// Минимум `clear` по тем же клеткам.
    clear: u8,
    kind: EdgeKind,
}

impl EdgeInfo {
    // ребро без метаданных (граф из старого дампа до перегенерации):
    // ничего не запрещает и ничем не штрафует
    const OPEN: Self = Self {
        fit: FIT_CAP,
        clear: u8::MAX,
        kind: EdgeKind::Walk,
    };
}

/// Навигация ботов: сетка проходимости + граф с A*
/// (порт src/server/modules/bots/NavigationSystem.js).
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct NavigationSystem {
    /// Сетка проходимости уровня 0. Значения: 0 — свободно, 1 — стена
    /// (непроходима И непрозрачна для луча), 2 — клетка прогона рампы
    /// (непроходима, но луч сквозь неё идёт: боты видят друг друга через
    /// рампу и стреляют сквозь неё).
    nav_grid: Vec<Vec<u8>>,
    grid_step: f32,
    nodes: Vec<[f32; 2]>,
    edges: Vec<Vec<Edge>>,
    node_grid: HashMap<(i32, i32), Vec<usize>>,
    node_grid_cell_size: f32,
    /// Уровень каждого узла, параллелен `nodes`. Пусто у одноуровневого
    /// графа — тогда все узлы считаются уровнем 0.
    #[serde(default)]
    node_levels: Vec<u8>,
    /// Сетки проходимости надземных уровней (индекс 0 = уровень 1).
    /// `nav_grid` остаётся сеткой уровня 0; значения те же, включая 2.
    #[serde(default)]
    upper_grids: Vec<Vec<Vec<u8>>>,
    /// Число рёбер рамп и обрывов (отладочный дамп).
    #[serde(default)]
    ramp_edges: usize,
    #[serde(default)]
    ledge_edges: usize,
    /// Размер (в клетках) наибольшего свободного квадрата, содержащего клетку;
    /// 0 — клетка непроходима. Корпус шириной `w` проходит по клетке, только если
    /// `fit ≥ ceil(w / grid_step)`. Параллельна сеткам уровней, насыщается на 15.
    #[serde(default)]
    fit: Vec<Vec<Vec<u8>>>,
    /// Чебышёвское расстояние (в клетках) от клетки до ближайшей непроходимой
    /// клетки или края карты; 0 — клетка непроходима, 1 — стоит вплотную к стене.
    #[serde(default)]
    clear: Vec<Vec<Vec<u8>>>,
    /// Параллелен `edges`: `edge_info[i][k]` описывает `edges[i][k]`.
    #[serde(default)]
    edge_info: Vec<Vec<EdgeInfo>>,
}

impl NavigationSystem {
    /// Строит сетку проходимости и навигационный граф из данных карты
    /// (сетка тайлов + масштабированный step + список статичных тайлов).
    pub fn generate(grid: &[Vec<i32>], physics_static: &[i32], step: f32) -> Self {
        let mut nav = Self::default();

        if grid.is_empty() || step <= 0.0 {
            return nav;
        }

        nav.grid_step = step;
        nav.nav_grid = grid
            .iter()
            .map(|row| {
                row.iter()
                    .map(|tile| u8::from(physics_static.contains(tile)))
                    .collect()
            })
            .collect();

        let node_placement_step = step * COEF_GRID_STEP;
        let map_width = nav.nav_grid[0].len() as f32 * step;
        let map_height = nav.nav_grid.len() as f32 * step;

        // расстановка узлов в свободных местах
        let mut x = node_placement_step / 2.0;

        while x < map_width {
            let mut y = node_placement_step / 2.0;

            while y < map_height {
                if nav.is_walkable(x, y) {
                    nav.nodes.push([x, y]);
                }

                y += node_placement_step;
            }

            x += node_placement_step;
        }

        // соединение ближайших видимых узлов рёбрами
        let max_connection_dist_sq =
            node_placement_step * 1.5 * (node_placement_step * 1.5);

        nav.edges = vec![Vec::new(); nav.nodes.len()];

        for i in 0..nav.nodes.len() {
            for j in (i + 1)..nav.nodes.len() {
                let dx = nav.nodes[i][0] - nav.nodes[j][0];
                let dy = nav.nodes[i][1] - nav.nodes[j][1];
                let dist_sq = dx * dx + dy * dy;

                if dist_sq <= max_connection_dist_sq
                    && !nav.has_obstacle_between(nav.nodes[i], nav.nodes[j])
                {
                    let distance = dist_sq.sqrt();

                    nav.edges[i].push(Edge {
                        node: j,
                        weight: distance,
                    });
                    nav.edges[j].push(Edge {
                        node: i,
                        weight: distance,
                    });
                }
            }
        }

        // сетка для быстрого поиска ближайших узлов
        nav.node_grid_cell_size = node_placement_step;

        for (index, node) in nav.nodes.iter().enumerate() {
            let cx = (node[0] / nav.node_grid_cell_size).floor() as i32;
            let cy = (node[1] / nav.node_grid_cell_size).floor() as i32;

            nav.node_grid.entry((cx, cy)).or_default().push(index);
        }

        // сетки свободного места и метаданные рёбер — поверх готового графа
        nav.build_clearance();
        nav.annotate_edges(None);

        nav
    }

    /// Граф со слоями: узлы каждого уровня + рёбра переходов (рампы —
    /// двусторонние, обрывы — только сверху вниз).
    pub fn generate_layered(levels: &MapLevels, step: f32) -> Self {
        let mut nav = Self::default();
        let Some(grid0) = levels.grid(0) else {
            return nav;
        };

        if grid0.is_empty() || step <= 0.0 {
            return nav;
        }

        nav.grid_step = step;
        nav.nav_grid = grid0
            .iter()
            .map(|row| {
                row.iter()
                    .map(|tile| u8::from(levels.solid(0).contains(tile)))
                    .collect()
            })
            .collect();

        // надземный уровень проходим только по плите и только вне перил
        for level in 1..levels.level_count() as u8 {
            let Some(grid) = levels.grid(level) else {
                continue;
            };

            nav.upper_grids.push(
                grid.iter()
                    .map(|row| {
                        row.iter()
                            .map(|tile| {
                                u8::from(
                                    !levels.floor(level).contains(tile)
                                        || levels.solid(level).contains(tile),
                                )
                            })
                            .collect()
                    })
                    .collect(),
            );
        }

        // клетки прогонов рамп непроходимы для уровня, с которого начинается
        // подъём: на клин можно попасть только через ребро рампы
        // (`connect_ramps`), а не сойдя на него с любой стороны. Метка — 2,
        // а не 1: единица сделала бы рампу ещё и непрострельной
        nav.block_ramp_runs(levels);

        let node_placement_step = step * COEF_GRID_STEP;
        let map_width = nav.nav_grid[0].len() as f32 * step;
        let map_height = nav.nav_grid.len() as f32 * step;

        // расстановка узлов: уровни по очереди, внутри уровня — прежний
        // порядок обхода (x внешний, y внутренний)
        for level in 0..nav.level_count() as u8 {
            let mut x = node_placement_step / 2.0;

            while x < map_width {
                let mut y = node_placement_step / 2.0;

                while y < map_height {
                    if nav.is_walkable_on(level, x, y) {
                        nav.nodes.push([x, y]);
                        nav.node_levels.push(level);
                    }

                    y += node_placement_step;
                }

                x += node_placement_step;
            }
        }

        // рёбра внутри уровня
        let max_connection_dist_sq = node_placement_step * 1.5 * (node_placement_step * 1.5);

        nav.edges = vec![Vec::new(); nav.nodes.len()];

        for i in 0..nav.nodes.len() {
            for j in (i + 1)..nav.nodes.len() {
                if nav.node_levels[i] != nav.node_levels[j] {
                    continue;
                }

                let dx = nav.nodes[i][0] - nav.nodes[j][0];
                let dy = nav.nodes[i][1] - nav.nodes[j][1];
                let dist_sq = dx * dx + dy * dy;

                if dist_sq <= max_connection_dist_sq
                    && !nav.has_obstacle_between_on(nav.node_levels[i], nav.nodes[i], nav.nodes[j])
                {
                    let distance = dist_sq.sqrt();

                    nav.edges[i].push(Edge {
                        node: j,
                        weight: distance,
                    });
                    nav.edges[j].push(Edge {
                        node: i,
                        weight: distance,
                    });
                }
            }
        }

        // сетка для быстрого поиска ближайших узлов
        nav.node_grid_cell_size = node_placement_step;

        for (index, node) in nav.nodes.iter().enumerate() {
            let cx = (node[0] / nav.node_grid_cell_size).floor() as i32;
            let cy = (node[1] / nav.node_grid_cell_size).floor() as i32;

            nav.node_grid.entry((cx, cy)).or_default().push(index);
        }

        nav.connect_ramps(levels);
        nav.connect_ledges(levels);

        // сетки свободного места и метаданные рёбер — поверх готового графа
        nav.build_clearance();
        nav.annotate_edges(Some(levels));

        nav
    }

    // рёбра рамп: подножие прогона на уровне `from` ↔ вершина на `to`.
    // Обе точки — СОБСТВЕННЫЕ узлы прогона по центру его полосы, а не
    // ближайшие узлы общей сетки: шаг сетки кратен двум тайлам и её узел
    // легко ложится на борт прогона, где стоит страж (`create_ramp_guards`).
    // Бот шёл бы тогда ровно по борту и упирался бы в невидимую для графа
    // преграду.
    fn connect_ramps(&mut self, levels: &MapLevels) {
        let half = levels.tile_size() / 2.0;

        for run in levels.runs() {
            let cross = (run.cross_min + run.cross_max) / 2.0;
            // точки подключения берутся ЗА кромками прогона: подножие — на
            // земле перед рампой, вершина — уже на плите за ней; внутри
            // самого прогона плиты уровня `to` ещё нет, и узел там не виден
            let (bottom_along, top_along) = if run.sign > 0 {
                (run.min - half, run.max + half)
            } else {
                (run.max + half, run.min - half)
            };

            let point = |along: f32| {
                if run.axis == 0 {
                    [along, cross]
                } else {
                    [cross, along]
                }
            };

            let (foot_point, top_point) = (point(bottom_along), point(top_along));

            if !self.is_walkable_on(run.from, foot_point[0], foot_point[1])
                || !self.is_walkable_on(run.to, top_point[0], top_point[1])
            {
                continue;
            }

            // якоря ищутся ДО добавления новых узлов, иначе точка прогона
            // нашла бы саму себя
            let (Some(bottom), Some(top)) = (
                self.closest_visible_node_on(run.from, foot_point),
                self.closest_visible_node_on(run.to, top_point),
            ) else {
                continue;
            };

            let foot = self.add_node(run.from, foot_point);
            let peak = self.add_node(run.to, top_point);

            self.link(bottom, foot);
            self.link(foot, peak);
            self.link(peak, top);
            self.ramp_edges += 2;
        }
    }

    // узел графа сверх расставленных по сетке (точки прогонов рамп)
    fn add_node(&mut self, level: u8, pos: [f32; 2]) -> usize {
        let index = self.nodes.len();

        self.nodes.push(pos);
        self.node_levels.push(level);
        self.edges.push(Vec::new());

        if self.node_grid_cell_size > 0.0 {
            let cx = (pos[0] / self.node_grid_cell_size).floor() as i32;
            let cy = (pos[1] / self.node_grid_cell_size).floor() as i32;

            self.node_grid.entry((cx, cy)).or_default().push(index);
        }

        index
    }

    // двустороннее ребро по расстоянию между узлами
    fn link(&mut self, a: usize, b: usize) {
        let weight = distance(self.nodes[a], self.nodes[b]);

        self.edges[a].push(Edge { node: b, weight });
        self.edges[b].push(Edge { node: a, weight });
    }

    // рёбра обрывов: односторонние, только сверху вниз
    fn connect_ledges(&mut self, levels: &MapLevels) {
        let size = levels.tile_size();
        let half = size / 2.0;
        let rows = self.nav_grid.len();
        let cols = self.nav_grid.first().map(|row| row.len()).unwrap_or(0);
        let mut seen: HashSet<(usize, usize)> = HashSet::new();

        for level in 1..self.level_count() as u8 {
            for cy in 0..rows {
                for cx in 0..cols {
                    let x = cx as f32 * size + half;
                    let y = cy as f32 * size + half;

                    if !self.is_walkable_on(level, x, y) {
                        continue;
                    }

                    for (dx, dy) in [(1i64, 0i64), (-1, 0), (0, 1), (0, -1)] {
                        let nx = cx as i64 + dx;
                        let ny = cy as i64 + dy;

                        if nx < 0 || ny < 0 || nx >= cols as i64 || ny >= rows as i64 {
                            continue;
                        }

                        let wx = nx as f32 * size + half;
                        let wy = ny as f32 * size + half;

                        if levels.has_floor(level, wx, wy) {
                            continue;
                        }

                        // падают не обязательно на землю: под обрывом может
                        // быть плита этажом ниже
                        let landing = levels.landing_level(level, wx, wy);

                        let (Some(top), Some(bottom)) = (
                            self.closest_visible_node_on(level, [x, y]),
                            self.closest_visible_node_on(landing, [wx, wy]),
                        ) else {
                            continue;
                        };

                        if !seen.insert((top, bottom)) {
                            continue;
                        }

                        let height = (level - landing) as f32;

                        self.edges[top].push(Edge {
                            node: bottom,
                            weight: distance(self.nodes[top], self.nodes[bottom])
                                + LEDGE_PENALTY * height,
                        });
                        self.ledge_edges += 1;
                    }
                }
            }
        }
    }

    pub fn has_nodes(&self) -> bool {
        !self.nodes.is_empty()
    }

    // ***** отладочный дамп (crate::debug) ***** //

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn edge_count(&self) -> usize {
        self.edges.iter().map(|edges| edges.len()).sum()
    }

    pub fn grid_step(&self) -> f32 {
        self.grid_step
    }

    /// Случайный узел графа (цель патрулирования).
    pub fn random_node(&self, rng: &mut Rng) -> Option<[f32; 2]> {
        if self.nodes.is_empty() {
            return None;
        }

        let index = (rng.next_f32() * self.nodes.len() as f32).floor() as usize;

        self.nodes.get(index).copied()
    }

    /// Сетка проходимости уровня (0 — земля, N — надземный уровень).
    fn grid_of(&self, level: u8) -> Option<&Vec<Vec<u8>>> {
        if level == 0 {
            Some(&self.nav_grid)
        } else {
            self.upper_grids.get(level as usize - 1)
        }
    }

    /// Изменяемая сетка проходимости уровня.
    fn grid_of_mut(&mut self, level: u8) -> Option<&mut Vec<Vec<u8>>> {
        if level == 0 {
            Some(&mut self.nav_grid)
        } else {
            self.upper_grids.get_mut(level as usize - 1)
        }
    }

    /// Помечает клетки прогонов рамп непроходимыми (значение 2) в сетке
    /// уровня, с которого прогон начинается. Верхний уровень трогать не
    /// нужно: плиты уровня `high` в клетках прогона нет, и в `upper_grids`
    /// они и так непроходимы.
    fn block_ramp_runs(&mut self, levels: &MapLevels) {
        let tile = levels.tile_size();

        if tile <= 0.0 || levels.runs().is_empty() {
            return;
        }

        for cy in 0..self.nav_grid.len() {
            for cx in 0..self.nav_grid[cy].len() {
                let x = (cx as f32 + 0.5) * tile;
                let y = (cy as f32 + 0.5) * tile;

                let Some(sample) = levels.ramp_at(x, y) else {
                    continue;
                };

                let low = sample.from.min(sample.to);

                if let Some(cell) = self
                    .grid_of_mut(low)
                    .and_then(|grid| grid.get_mut(cy))
                    .and_then(|row| row.get_mut(cx))
                    && *cell == 0
                {
                    *cell = 2;
                }
            }
        }
    }

    /// Проходима ли точка в мировых координатах (уровень 0).
    pub fn is_walkable(&self, x: f32, y: f32) -> bool {
        self.is_walkable_on(0, x, y)
    }

    /// Проходима ли точка на конкретном уровне.
    pub fn is_walkable_on(&self, level: u8, x: f32, y: f32) -> bool {
        let Some(grid) = self.grid_of(level) else {
            return false;
        };

        if grid.is_empty() || self.grid_step == 0.0 {
            return false;
        }

        let grid_x = (x / self.grid_step).floor();
        let grid_y = (y / self.grid_step).floor();

        if grid_x < 0.0 || grid_y < 0.0 {
            return false;
        }

        grid.get(grid_y as usize)
            .and_then(|row| row.get(grid_x as usize))
            .is_some_and(|&cell| cell == 0)
    }

    /// Быстрая линия видимости по сетке (алгоритм Брезенхэма):
    /// true — на пути есть препятствие.
    pub fn has_obstacle_between(&self, start: [f32; 2], end: [f32; 2]) -> bool {
        self.has_obstacle_between_on(0, start, end)
    }

    /// Линия видимости по сетке конкретного уровня.
    pub fn has_obstacle_between_on(&self, level: u8, start: [f32; 2], end: [f32; 2]) -> bool {
        let Some(grid) = self.grid_of(level) else {
            return true;
        };

        self.walk_line_cells(start, end, |x, y| {
            y >= 0
                && x >= 0
                && grid
                    .get(y as usize)
                    .and_then(|row| row.get(x as usize))
                    .is_some_and(|&cell| cell == 1)
        })
    }

    /// Обход клеток линии Брезенхэма от клетки `start` до клетки `end`.
    /// `f(x, y)` вернул true — обход остановлен, результат true.
    fn walk_line_cells(
        &self,
        start: [f32; 2],
        end: [f32; 2],
        mut f: impl FnMut(i64, i64) -> bool,
    ) -> bool {
        let mut x0 = (start[0] / self.grid_step).floor() as i64;
        let mut y0 = (start[1] / self.grid_step).floor() as i64;
        let x1 = (end[0] / self.grid_step).floor() as i64;
        let y1 = (end[1] / self.grid_step).floor() as i64;

        let dx = (x1 - x0).abs();
        let dy = -(y1 - y0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let sy = if y0 < y1 { 1 } else { -1 };
        let mut err = dx + dy;

        loop {
            if f(x0, y0) {
                return true;
            }

            if x0 == x1 && y0 == y1 {
                break;
            }

            let e2 = 2 * err;

            if e2 >= dy {
                err += dy;
                x0 += sx;
            }

            if e2 <= dx {
                err += dx;
                y0 += sy;
            }
        }

        false
    }

    /// Путь из точки в точку (мировые координаты) или None.
    pub fn find_path(&self, start: [f32; 2], end: [f32; 2]) -> Option<Vec<[f32; 2]>> {
        self.find_path_on(
            PathPoint {
                pos: start,
                level: 0,
            },
            PathPoint { pos: end, level: 0 },
        )
        .map(|path| path.into_iter().map(|point| point.pos).collect())
    }

    /// Путь между точками с уровнями (мировые координаты) или None.
    /// Тонкая обёртка над `find_route` с запросом по умолчанию.
    pub fn find_path_on(&self, start: PathPoint, end: PathPoint) -> Option<Vec<PathPoint>> {
        self.find_route(start, end, &PathQuery::default())
            .map(|route| route.legs.into_iter().map(|leg| leg.point).collect())
    }

    /// Маршрут между точками с уровнями по правилам запроса: ширина
    /// корпуса, запас от стен, цена прыжков, штрафные зоны. Участки несут
    /// способ проезда (пешком / рампа / обрыв), последний участок — `end`.
    pub fn find_route(&self, start: PathPoint, end: PathPoint, query: &PathQuery) -> Option<Route> {
        if self.nodes.is_empty() {
            return None;
        }

        // прямая видимость возможна только внутри одного уровня: смена
        // уровня всегда едет по ребру рампы или обрыва
        if start.level == end.level {
            let clear = if query.min_width > 0.0 {
                self.has_clear_corridor_on(start.level, start.pos, end.pos, query.min_width / 2.0)
            } else {
                !self.has_obstacle_between_on(start.level, start.pos, end.pos)
            };

            if clear {
                return Some(Route {
                    legs: vec![RouteLeg {
                        point: end,
                        kind: LegKind::Walk,
                    }],
                    cost: distance(start.pos, end.pos),
                });
            }
        }

        let cells = self.cells_for(query.min_width);
        let start_node = self.nearest_node_on(start.level, start.pos, cells)?;
        let end_node = self.nearest_node_on(end.level, end.pos, cells)?;

        // старт и финиш у одного узла: путь из одного узла, маршрут
        // «до узла и дальше к цели» (раньше здесь возвращался None)
        let (path, cost) = pathfinder::find_path_with(
            start_node,
            end_node,
            &self.nodes,
            &self.edges,
            |from, k, edge| self.edge_cost(query, from, k, edge),
        )?;

        let point = |index: usize| PathPoint {
            pos: self.nodes[index],
            level: self.node_level(index),
        };

        let mut legs = Vec::with_capacity(path.len() + 1);

        legs.push(RouteLeg {
            point: point(path[0]),
            kind: LegKind::Walk,
        });

        for pair in path.windows(2) {
            legs.push(RouteLeg {
                point: point(pair[1]),
                kind: self.leg_kind(query, pair[0], pair[1]),
            });
        }

        legs.push(RouteLeg {
            point: end,
            kind: LegKind::Walk,
        });

        let cost = cost
            + distance(start.pos, self.nodes[path[0]])
            + distance(self.nodes[path[path.len() - 1]], end.pos);

        Some(Route { legs, cost })
    }

    /// Случайный узел графа вместе с его уровнем (цель патрулирования).
    pub fn random_point(&self, rng: &mut Rng) -> Option<PathPoint> {
        if self.nodes.is_empty() {
            return None;
        }

        let index = (rng.next_f32() * self.nodes.len() as f32).floor() as usize;

        self.nodes.get(index).map(|&pos| PathPoint {
            pos,
            level: self.node_level(index),
        })
    }

    /// Уровень узла: у одноуровневого графа `node_levels` пуст — все узлы
    /// на земле.
    pub fn node_level(&self, index: usize) -> u8 {
        self.node_levels.get(index).copied().unwrap_or(0)
    }

    /// Число уровней графа, включая землю.
    pub fn level_count(&self) -> usize {
        self.upper_grids.len() + 1
    }

    /// Число узлов по уровням (отладочный дамп).
    pub fn nodes_by_level(&self) -> Vec<usize> {
        let mut counts = vec![0usize; self.level_count()];

        for index in 0..self.nodes.len() {
            let level = self.node_level(index) as usize;

            if let Some(count) = counts.get_mut(level) {
                *count += 1;
            }
        }

        counts
    }

    pub fn ramp_edge_count(&self) -> usize {
        self.ramp_edges
    }

    pub fn ledge_edge_count(&self) -> usize {
        self.ledge_edges
    }

    /// Ближайший видимый узел НУЖНОГО уровня.
    fn closest_visible_node_on(&self, level: u8, position: [f32; 2]) -> Option<usize> {
        if self.nodes.is_empty() || self.node_grid_cell_size == 0.0 {
            return None;
        }

        let center_cx = (position[0] / self.node_grid_cell_size).floor() as i32;
        let center_cy = (position[1] / self.node_grid_cell_size).floor() as i32;
        let mut candidates: Vec<usize> = Vec::new();

        for cy in (center_cy - 1)..=(center_cy + 1) {
            for cx in (center_cx - 1)..=(center_cx + 1) {
                if let Some(cell) = self.node_grid.get(&(cx, cy)) {
                    candidates.extend_from_slice(cell);
                }
            }
        }

        let mut closest: Option<usize> = None;
        let mut min_distance_sq = f32::INFINITY;

        for index in candidates {
            if self.node_level(index) != level {
                continue;
            }

            let node = self.nodes[index];

            if !self.has_obstacle_between_on(level, position, node) {
                let dx = position[0] - node[0];
                let dy = position[1] - node[1];
                let distance_sq = dx * dx + dy * dy;

                if distance_sq < min_distance_sq {
                    min_distance_sq = distance_sq;
                    closest = Some(index);
                }
            }
        }

        closest
    }

    // ***** свободное место под корпус ***** //

    /// Сетки `fit` и `clear` для каждого уровня. Построение графа от них не
    /// зависит: зовётся в самом конце `generate`/`generate_layered`.
    fn build_clearance(&mut self) {
        let mut fit = Vec::new();
        let mut clear = Vec::new();

        for level in 0..self.level_count() as u8 {
            let grid = self.grid_of(level).map(Vec::as_slice).unwrap_or(&[]);

            fit.push(fit_grid(grid));
            clear.push(clear_grid(grid));
        }

        self.fit = fit;
        self.clear = clear;
    }

    /// Метаданные рёбер (`edge_info`) отдельным проходом по готовому графу:
    /// тип ребра и минимумы `fit`/`clear` по его клеткам.
    fn annotate_edges(&mut self, levels: Option<&MapLevels>) {
        let mut edge_info = Vec::with_capacity(self.edges.len());

        for (from, edges) in self.edges.iter().enumerate() {
            let from_level = self.node_level(from);
            let list = edges
                .iter()
                .map(|edge| {
                    let to_level = self.node_level(edge.node);

                    if from_level == to_level {
                        return self.walk_edge_info(
                            from_level,
                            self.nodes[from],
                            self.nodes[edge.node],
                        );
                    }

                    if let Some((run, fit)) =
                        levels.and_then(|levels| self.ramp_of(levels, from, edge))
                    {
                        return EdgeInfo {
                            fit,
                            clear: (fit / 2).max(1),
                            kind: EdgeKind::Ramp {
                                axis: run.axis,
                                sign: run.sign,
                            },
                        };
                    }

                    // других межуровневых рёбер нет: обрыв, всегда сверху вниз
                    let [x, y] = self.nodes[from];

                    EdgeInfo {
                        fit: self.cell_of(&self.fit, from_level, x, y),
                        clear: self.cell_of(&self.clear, from_level, x, y),
                        kind: EdgeKind::Ledge {
                            height: from_level.saturating_sub(to_level),
                        },
                    }
                })
                .collect();

            edge_info.push(list);
        }

        self.edge_info = edge_info;
    }

    // ребро внутри уровня: минимумы сеток по клеткам его линии. Диагональный
    // шаг проходит между двумя боковыми клетками: там, где стены касаются
    // углами, щель нулевой ширины, поэтому шаг берёт лучшую из боковых —
    // обе закрыты → 0, одинокий угол сбоку лишь ограничивает ширину
    fn walk_edge_info(&self, level: u8, a: [f32; 2], b: [f32; 2]) -> EdgeInfo {
        let mut fit = FIT_CAP;
        let mut clear = u8::MAX;
        let mut previous: Option<(i64, i64)> = None;

        self.walk_line_cells(a, b, |x, y| {
            let mut step_fit = cell_at(&self.fit, level, x, y);
            let mut step_clear = cell_at(&self.clear, level, x, y);

            if let Some((px, py)) = previous
                && x != px
                && y != py
            {
                let side = |grids: &[Vec<Vec<u8>>]| {
                    cell_at(grids, level, x, py).max(cell_at(grids, level, px, y))
                };

                step_fit = step_fit.min(side(&self.fit));
                step_clear = step_clear.min(side(&self.clear));
            }

            fit = fit.min(step_fit);
            clear = clear.min(step_clear);
            previous = Some((x, y));
            false
        });

        EdgeInfo {
            fit,
            clear,
            kind: EdgeKind::Walk,
        }
    }

    // прогон, которому принадлежит межуровневое ребро, и `fit` его полосы.
    // Точки подножия и вершины — та же формула, что в `connect_ramps`.
    // Обрыв может лечь на те же узлы, что и рампа (узел вершины ближе всех
    // к кромке плиты над прогоном), поэтому ребро со штрафом обрыва рампой
    // не считается
    fn ramp_of<'l>(
        &self,
        levels: &'l MapLevels,
        from: usize,
        edge: &Edge,
    ) -> Option<(&'l crate::map::RampRun, u8)> {
        let (a, b) = (self.nodes[from], self.nodes[edge.node]);

        if edge.weight - distance(a, b) >= LEDGE_PENALTY / 2.0 {
            return None;
        }

        let (level_a, level_b) = (self.node_level(from), self.node_level(edge.node));
        let half = levels.tile_size() / 2.0;
        let near = |p: [f32; 2], q: [f32; 2]| distance(p, q) <= 0.5;

        levels
            .runs()
            .iter()
            .find(|run| {
                let (foot, top) = ramp_points(run, half);

                (level_a, level_b) == (run.from, run.to) && near(a, foot) && near(b, top)
                    || (level_a, level_b) == (run.to, run.from) && near(a, top) && near(b, foot)
            })
            .map(|run| {
                let cells = ((run.cross_max - run.cross_min) / self.grid_step).floor();

                (run, (cells as u8).clamp(1, FIT_CAP))
            })
    }

    // значение сетки (`fit`/`clear`) в клетке мировой точки; за картой — 0
    fn cell_of(&self, grids: &[Vec<Vec<u8>>], level: u8, x: f32, y: f32) -> u8 {
        if self.grid_step <= 0.0 {
            return 0;
        }

        cell_at(
            grids,
            level,
            (x / self.grid_step).floor() as i64,
            (y / self.grid_step).floor() as i64,
        )
    }

    // сколько клеток `fit` нужно корпусу ширины `width`
    fn cells_for(&self, width: f32) -> u8 {
        if width <= 0.0 || self.grid_step <= 0.0 {
            return 1;
        }

        (width / self.grid_step).ceil().clamp(1.0, FIT_CAP as f32) as u8
    }

    // `fit` клетки, в которой стоит узел
    fn node_fit(&self, index: usize) -> u8 {
        let [x, y] = self.nodes[index];

        self.cell_of(&self.fit, self.node_level(index), x, y)
    }

    /// Свободное место вокруг точки: расстояние от центра её клетки до
    /// ближайшей непроходимой клетки, мировые единицы; 0 — клетка непроходима.
    pub fn clearance_on(&self, level: u8, x: f32, y: f32) -> f32 {
        clear_world(self.cell_of(&self.clear, level, x, y), self.grid_step)
    }

    /// Проходит ли по клетке точки корпус ширины `width` (мировые единицы).
    pub fn fits_on(&self, level: u8, x: f32, y: f32, width: f32) -> bool {
        self.cell_of(&self.fit, level, x, y) >= self.cells_for(width)
    }

    /// «Толстая» прямая видимость для езды: центральная линия и параллельные
    /// ей со смещениями `k · half_width / n` (`k = 1..=n`, шаг не больше клетки)
    /// в обе стороны проходят только по свободным клеткам (`cell == 0`). Клетки
    /// самих концов проверяются только на проходимость центральной линии.
    pub fn has_clear_corridor_on(
        &self,
        level: u8,
        start: [f32; 2],
        end: [f32; 2],
        half_width: f32,
    ) -> bool {
        let Some(grid) = self.grid_of(level) else {
            return false;
        };

        if self.grid_step <= 0.0 {
            return false;
        }

        let blocked = |x: i64, y: i64| !free_at(grid, x, y);

        if self.walk_line_cells(start, end, blocked) {
            return false;
        }

        let length = distance(start, end);

        if half_width <= 0.0 || length <= f32::EPSILON {
            return true;
        }

        let normal = [-(end[1] - start[1]) / length, (end[0] - start[0]) / length];
        // линии не реже чем через клетку: иначе колонна между центральной и
        // боковой линией осталась бы невидимой
        let lines = (half_width / self.grid_step).ceil().max(1.0) as u32;
        let cell = |p: [f32; 2]| {
            (
                (p[0] / self.grid_step).floor() as i64,
                (p[1] / self.grid_step).floor() as i64,
            )
        };

        for k in 1..=lines {
            let offset = half_width * k as f32 / lines as f32;

            for side in [offset, -offset] {
                let a = [start[0] + normal[0] * side, start[1] + normal[1] * side];
                let b = [end[0] + normal[0] * side, end[1] + normal[1] * side];
                let (cell_a, cell_b) = (cell(a), cell(b));

                if self.walk_line_cells(a, b, |x, y| {
                    (x, y) != cell_a && (x, y) != cell_b && blocked(x, y)
                }) {
                    return false;
                }
            }
        }

        true
    }

    /// Ближайший к точке центр свободной клетки уровня с `fits_on(width)` в
    /// радиусе `max_radius`; порядок обхода детерминирован (дистанция, затем y, x).
    pub fn nearest_walkable_on(
        &self,
        level: u8,
        pos: [f32; 2],
        width: f32,
        max_radius: f32,
    ) -> Option<[f32; 2]> {
        if self.grid_step <= 0.0 || max_radius.is_nan() || max_radius < 0.0 {
            return None;
        }

        let grid = self.grid_of(level)?;
        let cols = grid.iter().map(Vec::len).max().unwrap_or(0);
        let max_cells = grid.len().max(cols).saturating_sub(1) as i64;
        // обход не шире карты; к целым — только после ограничения, иначе
        // бесконечный радиус переполнил бы i64
        let reach = if max_radius.is_finite() {
            ((max_radius / self.grid_step).ceil() + 1.0).min(max_cells as f32) as i64
        } else {
            max_cells
        };
        let center_x = (pos[0] / self.grid_step).floor() as i64;
        let center_y = (pos[1] / self.grid_step).floor() as i64;
        let cells = self.cells_for(width);
        let mut best: Option<(f32, [f32; 2])> = None;

        // y внешний, x внутренний, сравнение строгое: при равной дистанции
        // остаётся клетка с меньшим y, затем с меньшим x
        for y in (center_y - reach)..=(center_y + reach) {
            for x in (center_x - reach)..=(center_x + reach) {
                let point = [
                    (x as f32 + 0.5) * self.grid_step,
                    (y as f32 + 0.5) * self.grid_step,
                ];
                let d = distance(pos, point);

                if d > max_radius || cell_at(&self.fit, level, x, y) < cells {
                    continue;
                }

                if best.is_none_or(|(best_d, _)| d < best_d) {
                    best = Some((d, point));
                }
            }
        }

        best.map(|(_, point)| point)
    }

    /// Случайный узел нужного уровня (или любого при `None`), у которого `fit`
    /// не меньше, чем нужно корпусу ширины `width`: до 16 попыток, потом `random_point`.
    pub fn random_point_where(
        &self,
        rng: &mut Rng,
        level: Option<u8>,
        width: f32,
    ) -> Option<PathPoint> {
        if self.nodes.is_empty() {
            return None;
        }

        let cells = self.cells_for(width);

        for _ in 0..16 {
            let index = ((rng.next_f32() * self.nodes.len() as f32).floor() as usize)
                .min(self.nodes.len() - 1);

            if level.is_some_and(|level| level != self.node_level(index))
                || self.node_fit(index) < cells
            {
                continue;
            }

            return Some(PathPoint {
                pos: self.nodes[index],
                level: self.node_level(index),
            });
        }

        self.random_point(rng)
    }

    /// Узел уровня для входа в граф: кольца `r = 1..=4` ячеек `node_grid`
    /// вокруг точки. В кольце — ближайший видимый узел с `fit ≥ cells`, иначе
    /// ближайший видимый с любым `fit`. Не нашлось за 4 кольца — `None`:
    /// узел за стеной дал бы отрезок маршрута сквозь неё. Кольцо 1 (3×3) при
    /// `cells = 1` выбирает то же, что `closest_visible_node_on`.
    fn nearest_node_on(&self, level: u8, pos: [f32; 2], cells: u8) -> Option<usize> {
        if self.nodes.is_empty() || self.node_grid_cell_size == 0.0 {
            return None;
        }

        let center_cx = (pos[0] / self.node_grid_cell_size).floor() as i32;
        let center_cy = (pos[1] / self.node_grid_cell_size).floor() as i32;

        for r in 1..=4i32 {
            let mut fitting: Option<(f32, usize)> = None;
            let mut visible: Option<(f32, usize)> = None;

            for cy in (center_cy - r)..=(center_cy + r) {
                for cx in (center_cx - r)..=(center_cx + r) {
                    // внутренние кольца уже просмотрены
                    if r > 1 && (cx - center_cx).abs() < r && (cy - center_cy).abs() < r {
                        continue;
                    }

                    let Some(cell) = self.node_grid.get(&(cx, cy)) else {
                        continue;
                    };

                    for &index in cell {
                        if self.node_level(index) != level {
                            continue;
                        }

                        let node = self.nodes[index];
                        let dx = pos[0] - node[0];
                        let dy = pos[1] - node[1];
                        let distance_sq = dx * dx + dy * dy;
                        let closer = |best: Option<(f32, usize)>| {
                            best.is_none_or(|(best_sq, _)| distance_sq < best_sq)
                        };

                        if self.has_obstacle_between_on(level, pos, node) {
                            continue;
                        }

                        if closer(visible) {
                            visible = Some((distance_sq, index));
                        }

                        if self.node_fit(index) >= cells && closer(fitting) {
                            fitting = Some((distance_sq, index));
                        }
                    }
                }
            }

            if let Some((_, index)) = fitting.or(visible) {
                return Some(index);
            }
        }

        None
    }

    // стоимость ребра по правилам запроса; None — ребро запрещено. Всё, что
    // добавляется к длине, неотрицательно: эвристика A* остаётся допустимой
    fn edge_cost(&self, query: &PathQuery, from: usize, k: usize, edge: &Edge) -> Option<f32> {
        let info = self
            .edge_info
            .get(from)
            .and_then(|list| list.get(k))
            .copied()
            .unwrap_or(EdgeInfo::OPEN);

        if query.min_width > 0.0 && info.fit < self.cells_for(query.min_width) {
            return None;
        }

        let (a, b) = (self.nodes[from], self.nodes[edge.node]);
        let length = distance(a, b);
        let mut cost = length;

        if let EdgeKind::Ledge { height } = info.kind {
            if !query.ledge_cost_scale.is_finite() {
                return None;
            }

            cost += LEDGE_PENALTY * height as f32 * query.ledge_cost_scale.max(0.0);
        }

        if query.comfort_clearance > 0.0 {
            let clear = clear_world(info.clear, self.grid_step);

            if clear < query.comfort_clearance {
                cost += length * query.narrow_cost.max(0.0) * (query.comfort_clearance - clear)
                    / query.comfort_clearance;
            }
        }

        let (from_level, to_level) = (self.node_level(from), self.node_level(edge.node));
        let middle = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];

        for zone in query.penalties {
            if (zone.level != from_level && zone.level != to_level) || zone.radius <= 0.0 {
                continue;
            }

            let d = distance(middle, zone.center);

            if d < zone.radius {
                cost += length * zone.cost_per_unit.max(0.0) * (1.0 - d / zone.radius);
            }
        }

        Some(cost)
    }

    // способ проезда `a → b`: из параллельных рёбер (рампа и обрыв могут
    // лечь на одну пару узлов) берётся самое дешёвое разрешённое — то, что
    // выбрал A*
    fn leg_kind(&self, query: &PathQuery, a: usize, b: usize) -> LegKind {
        let mut best: Option<(f32, EdgeKind)> = None;

        for (k, edge) in self.edges[a].iter().enumerate() {
            if edge.node != b {
                continue;
            }

            let Some(cost) = self.edge_cost(query, a, k, edge) else {
                continue;
            };

            if best.is_none_or(|(best_cost, _)| cost < best_cost) {
                let kind = self
                    .edge_info
                    .get(a)
                    .and_then(|list| list.get(k))
                    .map_or(EdgeKind::Walk, |info| info.kind);

                best = Some((cost, kind));
            }
        }

        match best.map_or(EdgeKind::Walk, |(_, kind)| kind) {
            EdgeKind::Walk => LegKind::Walk,
            EdgeKind::Ramp { axis, sign } => LegKind::Ramp { axis, sign },
            EdgeKind::Ledge { height } => LegKind::Ledge { height },
        }
    }
}

// евклидова дистанция между узлами (вес ребра перехода)
fn distance(a: [f32; 2], b: [f32; 2]) -> f32 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

// точки подножия и вершины прогона — формула `connect_ramps`
fn ramp_points(run: &crate::map::RampRun, half: f32) -> ([f32; 2], [f32; 2]) {
    let cross = (run.cross_min + run.cross_max) / 2.0;
    let (bottom_along, top_along) = if run.sign > 0 {
        (run.min - half, run.max + half)
    } else {
        (run.max + half, run.min - half)
    };
    let point = |along: f32| {
        if run.axis == 0 {
            [along, cross]
        } else {
            [cross, along]
        }
    };

    (point(bottom_along), point(top_along))
}

// значение сетки уровня в клетке; за картой и без сетки — 0
fn cell_at(grids: &[Vec<Vec<u8>>], level: u8, x: i64, y: i64) -> u8 {
    if x < 0 || y < 0 {
        return 0;
    }

    grids
        .get(level as usize)
        .and_then(|grid| grid.get(y as usize))
        .and_then(|row| row.get(x as usize))
        .copied()
        .unwrap_or(0)
}

// `clear` в мировых единицах: от центра клетки до ближайшей непроходимой
fn clear_world(clear: u8, step: f32) -> f32 {
    if clear == 0 {
        0.0
    } else {
        (clear as f32 - 0.5) * step
    }
}

// свободна ли клетка сетки проходимости (за краем — нет)
fn free_at(grid: &[Vec<u8>], x: i64, y: i64) -> bool {
    x >= 0
        && y >= 0
        && grid
            .get(y as usize)
            .and_then(|row| row.get(x as usize))
            .is_some_and(|&cell| cell == 0)
}

// сетка `clear`: два прохода chamfer-преобразования с метрикой Чебышёва.
// Непроходимая клетка и соседи за краем карты дают 0
fn clear_grid(grid: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let mut d: Vec<Vec<u8>> = grid
        .iter()
        .enumerate()
        .map(|(y, row)| {
            (0..row.len())
                .map(|x| {
                    if free_at(grid, x as i64, y as i64) {
                        u8::MAX
                    } else {
                        0
                    }
                })
                .collect()
        })
        .collect();
    let at = |d: &Vec<Vec<u8>>, x: i64, y: i64| cell_at(std::slice::from_ref(d), 0, x, y);

    for y in 0..d.len() {
        for x in 0..d[y].len() {
            let (xi, yi) = (x as i64, y as i64);
            let near = [(-1, 0), (0, -1), (-1, -1), (1, -1)]
                .iter()
                .map(|&(dx, dy)| at(&d, xi + dx, yi + dy))
                .min()
                .unwrap_or(0);

            d[y][x] = d[y][x].min(near.saturating_add(1));
        }
    }

    for y in (0..d.len()).rev() {
        for x in (0..d[y].len()).rev() {
            let (xi, yi) = (x as i64, y as i64);
            let near = [(1, 0), (0, 1), (1, 1), (-1, 1)]
                .iter()
                .map(|&(dx, dy)| at(&d, xi + dx, yi + dy))
                .min()
                .unwrap_or(0);

            d[y][x] = d[y][x].min(near.saturating_add(1));
        }
    }

    d
}

// сетка `fit`: ДП «наибольший свободный квадрат с нижним правым углом в
// клетке», затем каждой клетке — максимум по квадратам, которые её содержат
fn fit_grid(grid: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let mut corner: Vec<Vec<u8>> = grid.iter().map(|row| vec![0; row.len()]).collect();

    for y in 0..grid.len() {
        for x in 0..grid[y].len() {
            if !free_at(grid, x as i64, y as i64) {
                continue;
            }

            let side = if x > 0 && y > 0 {
                let up = corner[y - 1].get(x).copied().unwrap_or(0);
                let up_left = corner[y - 1].get(x - 1).copied().unwrap_or(0);

                up.min(corner[y][x - 1]).min(up_left)
            } else {
                0
            };

            corner[y][x] = side.saturating_add(1).min(FIT_CAP);
        }
    }

    let mut fit: Vec<Vec<u8>> = grid.iter().map(|row| vec![0; row.len()]).collect();

    for (y, row) in corner.iter().enumerate() {
        for (x, &side) in row.iter().enumerate() {
            let k = side as usize;

            for yy in (y + 1 - k)..=y {
                for xx in (x + 1 - k)..=x {
                    if let Some(cell) = fit.get_mut(yy).and_then(|row| row.get_mut(xx)) {
                        *cell = (*cell).max(k as u8);
                    }
                }
            }
        }
    }

    fit
}

#[cfg(test)]
mod tests {
    use indexmap::IndexMap;

    use super::*;

    use crate::map::MapLevels;

    // карта 6×6: стены по периметру
    fn walled_grid() -> Vec<Vec<i32>> {
        vec![
            vec![1, 1, 1, 1, 1, 1],
            vec![1, 0, 0, 0, 0, 1],
            vec![1, 0, 0, 0, 0, 1],
            vec![1, 0, 0, 0, 0, 1],
            vec![1, 0, 0, 0, 0, 1],
            vec![1, 1, 1, 1, 1, 1],
        ]
    }

    // карта 8×8, тайл 10: земля свободна, плита уровня 1 — правая половина
    // (колонки 4..8), одна клетка рампы на земле ведёт под плиту
    fn layered(with_ramp: bool) -> MapLevels {
        use crate::map::{MapLevelConfig, RampConfig, RampDir};

        let mut grid0 = vec![vec![0; 8]; 8];

        if with_ramp {
            grid0[4][3] = 3;
        }

        let grid1: Vec<Vec<i32>> = (0..8)
            .map(|_| (0..8).map(|x| if x >= 4 { 9 } else { 0 }).collect())
            .collect();

        let mut levels = IndexMap::new();

        levels.insert(
            "1".to_string(),
            MapLevelConfig {
                map: grid1,
                floor: vec![9],
                walls: vec![],
                layers: IndexMap::new(),
                volumes: IndexMap::new(),
            },
        );

        let ramps = if with_ramp {
            vec![RampConfig {
                tile: 3,
                dir: RampDir::East,
                from: 0,
                to: 1,
            }]
        } else {
            vec![]
        };

        MapLevels::build(&grid0, &[], &levels, &ramps, 10.0, None)
    }

    #[test]
    fn layered_graph_places_nodes_on_both_levels() {
        let nav = NavigationSystem::generate_layered(&layered(true), 10.0);
        let counts = nav.nodes_by_level();

        assert_eq!(nav.level_count(), 2);
        assert!(counts[0] > 0 && counts[1] > 0, "{counts:?}");
        assert_eq!(nav.node_levels.len(), nav.node_count());
    }

    #[test]
    fn upper_level_nodes_only_on_floor() {
        let nav = NavigationSystem::generate_layered(&layered(true), 10.0);

        for index in 0..nav.node_count() {
            if nav.node_level(index) == 1 {
                assert!(nav.nodes[index][0] >= 40.0, "{:?}", nav.nodes[index]);
            }
        }
    }

    #[test]
    fn ramp_edge_connects_levels() {
        let nav = NavigationSystem::generate_layered(&layered(true), 10.0);

        assert!(nav.ramp_edge_count() > 0);

        let path = nav
            .find_path_on(
                PathPoint {
                    pos: [15.0, 15.0],
                    level: 0,
                },
                PathPoint {
                    pos: [75.0, 45.0],
                    level: 1,
                },
            )
            .expect("путь через рампу не найден");

        assert!(path.iter().any(|point| point.level == 1));
        assert!(path.iter().any(|point| point.level == 0));
    }

    #[test]
    fn ramp_run_cells_are_not_walkable_but_stay_transparent() {
        let nav = NavigationSystem::generate_layered(&layered(true), 10.0);
        // клетка рампы — (колонка 3, строка 4), тайл 10
        let (x, y) = (35.0, 45.0);

        assert!(!nav.is_walkable_on(0, x, y));
        // луч сквозь прогон идёт: боты видят друг друга через рампу
        assert!(!nav.has_obstacle_between_on(0, [15.0, 45.0], [55.0, 45.0]));
    }

    #[test]
    fn ramp_edge_runs_through_the_middle_of_the_run() {
        let levels = layered(true);
        let nav = NavigationSystem::generate_layered(&levels, 10.0);
        let run = &levels.runs()[0];
        let cross = (run.cross_min + run.cross_max) / 2.0;

        // у прогона свои узлы по центру полосы: подножие перед кромкой и
        // вершина за ней. Узел общей сетки (шаг — два тайла) лёг бы на борт
        // прогона, где стоит страж, и бот шёл бы вплотную к нему
        let path = nav
            .find_path_on(
                PathPoint {
                    pos: [15.0, 15.0],
                    level: 0,
                },
                PathPoint {
                    pos: [75.0, 45.0],
                    level: 1,
                },
            )
            .expect("путь через рампу не найден");

        assert!(
            path.iter()
                .any(|point| point.level == 0 && point.pos[1] == cross),
            "{path:?}"
        );
        assert!(
            path.iter()
                .any(|point| point.level == 1 && point.pos[1] == cross),
            "{path:?}"
        );
    }

    #[test]
    fn no_path_between_levels_without_ramp() {
        let nav = NavigationSystem::generate_layered(&layered(false), 10.0);

        assert_eq!(nav.ramp_edge_count(), 0);
        assert!(
            nav.find_path_on(
                PathPoint {
                    pos: [15.0, 15.0],
                    level: 0,
                },
                PathPoint {
                    pos: [75.0, 45.0],
                    level: 1,
                },
            )
            .is_none()
        );
    }

    #[test]
    fn ledge_edge_is_one_way() {
        let nav = NavigationSystem::generate_layered(&layered(false), 10.0);

        assert!(nav.ledge_edge_count() > 0);
        // сверху вниз — по ребру обрыва
        assert!(
            nav.find_path_on(
                PathPoint {
                    pos: [75.0, 45.0],
                    level: 1,
                },
                PathPoint {
                    pos: [15.0, 15.0],
                    level: 0,
                },
            )
            .is_some()
        );
        // снизу вверх через тот же обрыв — нет
        assert!(
            nav.find_path_on(
                PathPoint {
                    pos: [15.0, 15.0],
                    level: 0,
                },
                PathPoint {
                    pos: [75.0, 45.0],
                    level: 1,
                },
            )
            .is_none()
        );
    }

    // две плиты друг над другом: уровень 1 занимает колонки `l1..8`,
    // уровень 2 — `l2..8`. Меняя границы, получаем обрыв уровня 2 то на
    // плиту уровня 1, то сразу на землю
    fn stacked(l1: usize, l2: usize) -> MapLevels {
        use crate::map::MapLevelConfig;

        let grid0 = vec![vec![0; 8]; 8];
        let mut levels = IndexMap::new();

        for (level, from, tile) in [(1u8, l1, 9), (2, l2, 7)] {
            levels.insert(
                level.to_string(),
                MapLevelConfig {
                    map: (0..8)
                        .map(|_| (0..8).map(|x| if x >= from { tile } else { 0 }).collect())
                        .collect(),
                    floor: vec![tile],
                    walls: vec![],
                    layers: IndexMap::new(),
                    volumes: IndexMap::new(),
                },
            );
        }

        MapLevels::build(&grid0, &[], &levels, &[], 10.0, None)
    }

    // штрафы рёбер-обрывов, начинающихся на уровне `level`: вес минус
    // геометрическая длина
    fn ledge_penalties(nav: &NavigationSystem, level: u8) -> Vec<(u8, f32)> {
        let mut out = Vec::new();

        for (index, edges) in nav.edges.iter().enumerate() {
            if nav.node_level(index) != level {
                continue;
            }

            for edge in edges {
                let to = nav.node_level(edge.node);

                if to >= level {
                    continue;
                }

                out.push((to, edge.weight - distance(nav.nodes[index], nav.nodes[edge.node])));
            }
        }

        out
    }

    #[test]
    fn ledge_edge_lands_on_the_slab_below() {
        let nav = NavigationSystem::generate_layered(&stacked(3, 5), 10.0);
        let penalties = ledge_penalties(&nav, 2);

        assert!(!penalties.is_empty(), "обрывов уровня 2 не построено");

        for (to, penalty) in penalties {
            // под обрывом уровня 2 лежит плита уровня 1, а не земля
            assert_eq!(to, 1);
            assert!((penalty - LEDGE_PENALTY).abs() < 1.0, "{penalty}");
        }
    }

    #[test]
    fn ledge_penalty_grows_with_height() {
        // плита уровня 2 нависает над голой землёй: падать вдвое выше
        let nav = NavigationSystem::generate_layered(&stacked(6, 4), 10.0);
        let penalties = ledge_penalties(&nav, 2);

        assert!(!penalties.is_empty(), "обрывов уровня 2 не построено");

        for (to, penalty) in penalties {
            assert_eq!(to, 0);
            assert!((penalty - 2.0 * LEDGE_PENALTY).abs() < 1.0, "{penalty}");
        }
    }

    #[test]
    fn legacy_generate_unchanged() {
        let nav = NavigationSystem::generate(&walled_grid(), &[1], 10.0);

        // одноуровневый граф не заводит слоёв и совпадает с прежним выводом
        assert_eq!(nav.level_count(), 1);
        assert!(nav.node_levels.is_empty());
        assert_eq!(nav.node_count(), 4);
        assert_eq!(nav.edge_count(), 12);
        assert_eq!(nav.ramp_edge_count(), 0);
        assert_eq!(nav.ledge_edge_count(), 0);
    }

    #[test]
    fn walkable_inside_not_on_walls() {
        let nav = NavigationSystem::generate(&walled_grid(), &[1], 10.0);

        assert!(nav.is_walkable(25.0, 25.0));
        assert!(!nav.is_walkable(5.0, 5.0)); // стена
        assert!(!nav.is_walkable(-5.0, 25.0)); // за пределами
    }

    #[test]
    fn line_of_sight_blocked_by_wall() {
        let grid = vec![
            vec![0, 0, 0],
            vec![0, 1, 0],
            vec![0, 0, 0],
        ];
        let nav = NavigationSystem::generate(&grid, &[1], 10.0);

        // через центр (стена)
        assert!(nav.has_obstacle_between([5.0, 5.0], [25.0, 25.0]));
        // вдоль свободного края
        assert!(!nav.has_obstacle_between([5.0, 5.0], [25.0, 5.0]));
    }

    #[test]
    fn direct_path_when_visible() {
        let nav = NavigationSystem::generate(&walled_grid(), &[1], 10.0);
        let path = nav.find_path([15.0, 15.0], [45.0, 45.0]).unwrap();

        assert_eq!(path, vec![[45.0, 45.0]]);
    }

    fn at(x: f32, y: f32, level: u8) -> PathPoint {
        PathPoint { pos: [x, y], level }
    }

    // сетка из строк: '#' — стена, '.' — свободно
    fn ascii(rows: &[&str]) -> Vec<Vec<i32>> {
        rows.iter()
            .map(|row| row.chars().map(|c| i32::from(c == '#')).collect())
            .collect()
    }

    // 10×10 в стенах: коридор шириной 1 клетка (строка 2) и 2 клетки (строки 5–6)
    fn corridors() -> NavigationSystem {
        let grid = ascii(&[
            "##########",
            "##########",
            "#........#",
            "##########",
            "##########",
            "#........#",
            "#........#",
            "##########",
            "##########",
            "##########",
        ]);

        NavigationSystem::generate(&grid, &[1], 10.0)
    }

    // стена в колонке 4 с двумя проёмами: узкий (строка 3) и широкий (строки 8–10)
    fn gapped_wall() -> NavigationSystem {
        let grid = ascii(&[
            "....#.....",
            "....#.....",
            "....#.....",
            "..........",
            "....#.....",
            "....#.....",
            "....#.....",
            "....#.....",
            "..........",
            "..........",
            "..........",
            "....#.....",
        ]);

        NavigationSystem::generate(&grid, &[1], 10.0)
    }

    #[test]
    fn clearance_grows_away_from_walls() {
        let nav = NavigationSystem::generate(&walled_grid(), &[1], 10.0);

        // клетка (1, 1) вплотную к стене, (2, 2) — через одну
        assert_eq!(nav.clearance_on(0, 15.0, 15.0), 5.0);
        assert_eq!(nav.clearance_on(0, 25.0, 25.0), 15.0);
        assert_eq!(nav.clearance_on(0, 5.0, 5.0), 0.0);
    }

    #[test]
    fn fit_distinguishes_one_and_two_cell_corridors() {
        let nav = corridors();

        assert!(nav.fits_on(0, 55.0, 25.0, 1.0));
        assert!(!nav.fits_on(0, 55.0, 25.0, 15.0));
        assert!(nav.fits_on(0, 55.0, 55.0, 15.0));
        assert!(nav.fits_on(0, 55.0, 65.0, 15.0));
        assert!(!nav.fits_on(0, 55.0, 55.0, 25.0));
    }

    #[test]
    fn upper_level_edges_count_as_blocked() {
        let nav = NavigationSystem::generate_layered(&layered(false), 10.0);

        // клетка (4, 4) плиты: слева (колонка 3) пола уровня 1 нет
        assert_eq!(nav.clearance_on(1, 45.0, 45.0), 5.0);
        assert_eq!(nav.clearance_on(1, 35.0, 45.0), 0.0);
    }

    #[test]
    fn edge_info_is_parallel_to_edges() {
        let graphs = [
            NavigationSystem::generate_layered(&layered(true), 10.0),
            NavigationSystem::generate_layered(&stacked(3, 5), 10.0),
            NavigationSystem::generate(&walled_grid(), &[1], 10.0),
        ];

        for nav in graphs {
            assert_eq!(nav.edges.len(), nav.edge_info.len());

            let mut ramps = 0;
            let mut ledges = 0;

            for (edges, info) in nav.edges.iter().zip(&nav.edge_info) {
                assert_eq!(edges.len(), info.len());

                for info in info {
                    match info.kind {
                        EdgeKind::Ramp { .. } => ramps += 1,
                        EdgeKind::Ledge { .. } => ledges += 1,
                        EdgeKind::Walk => {}
                    }
                }
            }

            // `ramp_edge_count` считает межуровневое ребро рампы в обе
            // стороны (+2 на прогон), как и направленные рёбра `Ramp` здесь
            assert_eq!(ramps, nav.ramp_edge_count());
            assert_eq!(ledges, nav.ledge_edge_count());
        }
    }

    #[test]
    fn route_respects_min_width() {
        let nav = gapped_wall();
        let (start, end) = (at(15.0, 15.0, 0), at(85.0, 15.0, 0));
        let through = |route: &Route, rows: std::ops::Range<f32>| {
            route.legs.iter().any(|leg| {
                (40.0..=50.0).contains(&leg.point.pos[0]) && rows.contains(&leg.point.pos[1])
            })
        };

        let thin = nav.find_route(start, end, &PathQuery::default()).unwrap();
        let wide = nav
            .find_route(
                start,
                end,
                &PathQuery {
                    min_width: 15.0,
                    ..PathQuery::default()
                },
            )
            .unwrap();

        assert!(through(&thin, 30.0..40.0), "{thin:?}");
        assert!(through(&wide, 80.0..110.0), "{wide:?}");
        assert!(!through(&wide, 30.0..40.0), "{wide:?}");
    }

    #[test]
    fn narrow_cost_prefers_the_middle() {
        // зал 16×16 с колонной 2×2 посередине пути
        let mut grid = vec![vec![0; 16]; 16];

        for row in grid.iter_mut().skip(6).take(2) {
            row[6] = 1;
            row[7] = 1;
        }

        let nav = NavigationSystem::generate(&grid, &[1], 10.0);
        let query = PathQuery {
            comfort_clearance: 20.0,
            narrow_cost: 2.0,
            ..PathQuery::default()
        };
        let route = nav
            .find_route(at(35.0, 75.0, 0), at(125.0, 75.0, 0), &query)
            .unwrap();
        let min_clearance = route
            .legs
            .iter()
            .map(|leg| nav.clearance_on(0, leg.point.pos[0], leg.point.pos[1]))
            .fold(f32::INFINITY, f32::min);

        assert!(min_clearance >= 15.0, "{min_clearance} {route:?}");
    }

    #[test]
    fn penalty_zone_causes_detour() {
        let nav = gapped_wall();
        let (start, end) = (at(15.0, 15.0, 0), at(85.0, 15.0, 0));
        let zones = [PenaltyZone {
            level: 0,
            center: [45.0, 35.0],
            radius: 20.0,
            cost_per_unit: 10.0,
        }];
        let plain = nav.find_route(start, end, &PathQuery::default()).unwrap();
        let avoiding = nav
            .find_route(
                start,
                end,
                &PathQuery {
                    penalties: &zones,
                    ..PathQuery::default()
                },
            )
            .unwrap();

        assert!(
            plain
                .legs
                .iter()
                .any(|leg| distance(leg.point.pos, zones[0].center) < 20.0),
            "{plain:?}"
        );
        assert!(
            avoiding
                .legs
                .iter()
                .all(|leg| distance(leg.point.pos, zones[0].center) >= 20.0),
            "{avoiding:?}"
        );
        assert!(avoiding.cost > plain.cost);
    }

    fn has_ledge(route: &Route) -> bool {
        route
            .legs
            .iter()
            .any(|leg| matches!(leg.kind, LegKind::Ledge { .. }))
    }

    #[test]
    fn ledge_cost_scale_controls_jumps() {
        let query = |scale: f32| PathQuery {
            ledge_cost_scale: scale,
            ..PathQuery::default()
        };

        // рамп нет: без обрывов с плиты не спуститься вовсе
        let nav = NavigationSystem::generate_layered(&stacked(3, 5), 10.0);
        let (top, ground) = (at(75.0, 15.0, 2), at(5.0, 75.0, 0));

        assert!(nav.find_route(top, ground, &query(f32::INFINITY)).is_none());
        assert!(has_ledge(
            &nav.find_route(top, ground, &query(0.0)).unwrap()
        ));

        // с рампой запрет обрывов уводит на неё, а бесплатный прыжок короче
        let nav = NavigationSystem::generate_layered(&layered(true), 10.0);
        let (slab, ground) = (at(75.0, 15.0, 1), at(15.0, 15.0, 0));
        let safe = nav.find_route(slab, ground, &query(f32::INFINITY)).unwrap();
        let free = nav.find_route(slab, ground, &query(0.0)).unwrap();

        assert!(!has_ledge(&safe), "{safe:?}");
        assert!(
            safe.legs
                .iter()
                .any(|leg| matches!(leg.kind, LegKind::Ramp { .. }))
        );
        assert!(has_ledge(&free), "{free:?}");
        assert!(free.cost < safe.cost);
    }

    #[test]
    fn route_marks_ramp_and_ledge_legs() {
        let levels = layered(true);
        let run = &levels.runs()[0];
        let nav = NavigationSystem::generate_layered(&levels, 10.0);
        let up = nav
            .find_route(at(15.0, 15.0, 0), at(75.0, 45.0, 1), &PathQuery::default())
            .unwrap();

        assert!(
            up.legs.iter().any(|leg| leg.kind
                == LegKind::Ramp {
                    axis: run.axis,
                    sign: run.sign,
                }
                && leg.point.level == 1),
            "{up:?}"
        );

        let nav = NavigationSystem::generate_layered(&layered(false), 10.0);
        let down = nav
            .find_route(at(75.0, 45.0, 1), at(15.0, 15.0, 0), &PathQuery::default())
            .unwrap();

        assert!(
            down.legs
                .iter()
                .any(|leg| leg.kind == LegKind::Ledge { height: 1 } && leg.point.level == 0),
            "{down:?}"
        );
    }

    #[test]
    fn route_when_start_and_end_share_a_node() {
        // узлы стоят только в клетках с нечётными координатами; стены во
        // всех таких, кроме (3, 3), и в (2, 2), разделяющей старт и финиш
        let grid = ascii(&[
            "......", //
            ".#.#.#", "..#...", ".#...#", "......", ".#.#.#",
        ]);
        let nav = NavigationSystem::generate(&grid, &[1], 10.0);
        let (start, end) = (at(15.0, 25.0, 0), at(35.0, 25.0, 0));

        assert_eq!(nav.node_count(), 1);
        assert!(nav.has_obstacle_between(start.pos, end.pos));

        let route = nav.find_route(start, end, &PathQuery::default()).unwrap();

        assert_eq!(route.legs.len(), 2);
        assert_eq!(route.legs[0].point.pos, [30.0, 30.0]);
        assert_eq!(route.legs[1].point, end);
        assert!(nav.find_path(start.pos, end.pos).is_some());
    }

    #[test]
    fn nearest_node_looks_beyond_3x3() {
        // точка (65, 65) в кармане: все узлы ячеек 3×3 вокруг неё стоят в
        // стенах, ближайшие видимые — во втором кольце. Финиш — за стеной
        let grid = ascii(&[
            "............",
            "............",
            "............",
            "............",
            "............",
            ".....#.#.#..",
            "............",
            ".....#.#.#..",
            "............",
            ".....#.#.#..",
            "#########...",
            "............",
        ]);
        let nav = NavigationSystem::generate(&grid, &[1], 10.0);
        let (start, end) = (at(65.0, 65.0, 0), at(15.0, 115.0, 0));

        assert!(nav.closest_visible_node_on(0, start.pos).is_none());
        assert!(nav.has_obstacle_between(start.pos, end.pos));
        assert!(nav.find_route(start, end, &PathQuery::default()).is_some());
    }

    #[test]
    fn find_path_on_keeps_legacy_results() {
        // ожидания сняты со старого `find_path_on` до перехода на `find_route`
        let mut wall = vec![vec![0; 10]; 10];

        for row in wall.iter_mut().take(8) {
            row[5] = 1;
        }

        let cases = [
            (
                NavigationSystem::generate_layered(&layered(true), 10.0),
                at(15.0, 15.0, 0),
                at(75.0, 45.0, 1),
                vec![
                    at(10.0, 10.0, 0),
                    at(30.0, 30.0, 0),
                    at(30.0, 50.0, 0),
                    at(25.0, 45.0, 0),
                    at(45.0, 45.0, 1),
                    at(50.0, 50.0, 1),
                    at(70.0, 50.0, 1),
                    at(75.0, 45.0, 1),
                ],
            ),
            (
                NavigationSystem::generate_layered(&layered(false), 10.0),
                at(75.0, 45.0, 1),
                at(15.0, 15.0, 0),
                vec![
                    at(70.0, 50.0, 1),
                    at(50.0, 30.0, 1),
                    at(30.0, 30.0, 0),
                    at(10.0, 10.0, 0),
                    at(15.0, 15.0, 0),
                ],
            ),
            (
                NavigationSystem::generate_layered(&stacked(3, 5), 10.0),
                at(75.0, 15.0, 2),
                at(5.0, 75.0, 0),
                vec![
                    at(70.0, 10.0, 2),
                    at(50.0, 30.0, 2),
                    at(50.0, 30.0, 1),
                    at(30.0, 50.0, 1),
                    at(30.0, 50.0, 0),
                    at(10.0, 70.0, 0),
                    at(5.0, 75.0, 0),
                ],
            ),
            (
                NavigationSystem::generate(&wall, &[1], 10.0),
                at(15.0, 15.0, 0),
                at(85.0, 15.0, 0),
                vec![
                    at(10.0, 10.0, 0),
                    at(30.0, 30.0, 0),
                    at(30.0, 50.0, 0),
                    at(30.0, 70.0, 0),
                    at(50.0, 90.0, 0),
                    at(70.0, 70.0, 0),
                    at(70.0, 50.0, 0),
                    at(70.0, 30.0, 0),
                    at(90.0, 10.0, 0),
                    at(85.0, 15.0, 0),
                ],
            ),
        ];

        for (nav, start, end, expected) in cases {
            assert_eq!(nav.find_path_on(start, end), Some(expected));
        }
    }

    #[test]
    fn route_is_deterministic() {
        let nav = NavigationSystem::generate_layered(&layered(true), 10.0);
        let zones = [PenaltyZone {
            level: 0,
            center: [30.0, 30.0],
            radius: 15.0,
            cost_per_unit: 2.0,
        }];
        let query = PathQuery {
            min_width: 8.0,
            comfort_clearance: 10.0,
            narrow_cost: 1.0,
            ledge_cost_scale: 0.5,
            penalties: &zones,
        };
        let (start, end) = (at(15.0, 75.0, 0), at(75.0, 15.0, 1));

        assert_eq!(
            nav.find_route(start, end, &query),
            nav.find_route(start, end, &query)
        );
    }

    #[test]
    fn nearest_walkable_respects_width() {
        let nav = corridors();
        let point = nav
            .nearest_walkable_on(0, [55.0, 25.0], 15.0, 50.0)
            .unwrap();

        assert_eq!(point, [55.0, 55.0]);
        assert_eq!(
            nav.nearest_walkable_on(0, [55.0, 25.0], 0.0, 50.0),
            Some([55.0, 25.0])
        );
        assert!(
            nav.nearest_walkable_on(0, [55.0, 25.0], 15.0, 20.0)
                .is_none()
        );
    }

    #[test]
    fn corridor_check_catches_corners() {
        // линия по строке 1 проходит вплотную к углу стены (3, 2)
        let grid = ascii(&[
            "......", //
            "......", "...#..", "......", "......", "......",
        ]);
        let nav = NavigationSystem::generate(&grid, &[1], 10.0);
        let (start, end) = ([5.0, 17.0], [55.0, 17.0]);

        assert!(!nav.has_obstacle_between(start, end));
        assert!(nav.has_clear_corridor_on(0, start, end, 0.0));
        assert!(!nav.has_clear_corridor_on(0, start, end, 4.0));
    }

    #[test]
    fn random_point_where_honours_level_and_width() {
        let nav = NavigationSystem::generate_layered(&layered(true), 10.0);
        let mut rng = Rng::new(3);

        for _ in 0..20 {
            let point = nav.random_point_where(&mut rng, Some(1), 15.0).unwrap();

            assert_eq!(point.level, 1);
            assert!(
                nav.fits_on(1, point.pos[0], point.pos[1], 15.0),
                "{point:?}"
            );
        }
    }

    #[test]
    fn diagonal_corner_gap_is_impassable() {
        // блоки стен касаются углами в точке (20, 20): карман в левом
        // верхнем углу выходит наружу только диагональным ребром
        // (10, 10) → (30, 30) через точку касания
        let grid = ascii(&[
            "..##......", //
            "..##......",
            "##........",
            "##........",
            "..........",
            "..........",
            "..........",
            "..........",
        ]);
        let nav = NavigationSystem::generate(&grid, &[1], 10.0);
        let (start, end) = (at(5.0, 5.0, 0), at(15.0, 55.0, 0));

        assert!(nav.has_obstacle_between(start.pos, end.pos));

        // тонкий корпус проходит, как и раньше
        let thin = nav.find_route(start, end, &PathQuery::default()).unwrap();

        assert!(
            thin.legs.iter().any(|leg| leg.point.pos == [30.0, 30.0]),
            "{thin:?}"
        );

        // щель нулевой ширины: обхода нет
        let query = PathQuery {
            min_width: 5.0,
            ..PathQuery::default()
        };

        assert_eq!(nav.find_route(start, end, &query), None);
    }

    #[test]
    fn corridor_check_sees_a_pillar_between_lines() {
        // ось — строка 2 (y = 25), колонна (5, 4) начинается в 1.5·step от оси
        let mut grid = vec![vec![0; 10]; 10];

        grid[4][5] = 1;

        let nav = NavigationSystem::generate(&grid, &[1], 10.0);
        let (start, end) = ([5.0, 25.0], [95.0, 25.0]);

        assert!(!nav.has_clear_corridor_on(0, start, end, 25.0));
        assert!(nav.has_clear_corridor_on(0, start, end, 10.0));
    }

    #[test]
    fn route_is_none_without_a_visible_node() {
        // клетка (4, 4) замурована со всех восьми сторон, узлов в ней нет
        let grid = ascii(&[
            "..........", //
            "..........",
            "..........",
            "...###....",
            "...#.#....",
            "...###....",
            "..........",
            "..........",
            "..........",
            "..........",
        ]);
        let nav = NavigationSystem::generate(&grid, &[1], 10.0);
        let (start, end) = (at(45.0, 45.0, 0), at(85.0, 85.0, 0));

        assert!(nav.nearest_node_on(0, start.pos, 1).is_none());
        assert_eq!(nav.find_route(start, end, &PathQuery::default()), None);
    }

    #[test]
    fn nearest_walkable_accepts_infinite_radius() {
        let nav = corridors();
        let whole_map = nav.nearest_walkable_on(0, [55.0, 25.0], 15.0, 200.0);

        assert_eq!(whole_map, Some([55.0, 55.0]));
        assert_eq!(
            nav.nearest_walkable_on(0, [55.0, 25.0], 15.0, f32::INFINITY),
            whole_map
        );
        assert_eq!(
            nav.nearest_walkable_on(0, [55.0, 25.0], 15.0, 1e30),
            whole_map
        );
        assert_eq!(
            nav.nearest_walkable_on(0, [55.0, 25.0], 15.0, f32::NAN),
            None
        );
    }
}
