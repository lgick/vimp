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

/// Навигация ботов: сетка проходимости + граф с A*
/// (порт src/server/modules/bots/NavigationSystem.js).
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct NavigationSystem {
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
    /// `nav_grid` остаётся сеткой уровня 0.
    #[serde(default)]
    upper_grids: Vec<Vec<Vec<u8>>>,
    /// Число рёбер рамп и обрывов (отладочный дамп).
    #[serde(default)]
    ramp_edges: usize,
    #[serde(default)]
    ledge_edges: usize,
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

        nav
    }

    // рёбра рамп: подножие прогона на уровне `from` ↔ вершина на `to`
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

            let (Some(bottom), Some(top)) = (
                self.closest_visible_node_on(run.from, point(bottom_along)),
                self.closest_visible_node_on(run.to, point(top_along)),
            ) else {
                continue;
            };

            let weight = distance(self.nodes[bottom], self.nodes[top]);

            self.edges[bottom].push(Edge {
                node: top,
                weight,
            });
            self.edges[top].push(Edge {
                node: bottom,
                weight,
            });
            self.ramp_edges += 2;
        }
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
            let is_wall = y0 >= 0
                && x0 >= 0
                && grid
                    .get(y0 as usize)
                    .and_then(|row| row.get(x0 as usize))
                    .is_some_and(|&cell| cell == 1);

            if is_wall {
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
        if self.nodes.is_empty() {
            return None;
        }

        if !self.has_obstacle_between(start, end) {
            return Some(vec![end]);
        }

        let start_node = self.closest_visible_node(start)?;
        let end_node = self.closest_visible_node(end)?;

        if start_node == end_node {
            return None;
        }

        let path_indexes = pathfinder::find_path(start_node, end_node, &self.nodes, &self.edges)?;

        let mut path: Vec<[f32; 2]> = path_indexes
            .into_iter()
            .map(|index| self.nodes[index])
            .collect();

        path.push(end);

        Some(path)
    }

    /// Путь между точками с уровнями (мировые координаты) или None.
    pub fn find_path_on(&self, start: PathPoint, end: PathPoint) -> Option<Vec<PathPoint>> {
        if self.nodes.is_empty() {
            return None;
        }

        // прямая видимость возможна только внутри одного уровня: смена
        // уровня всегда едет по ребру рампы или обрыва
        if start.level == end.level
            && !self.has_obstacle_between_on(start.level, start.pos, end.pos)
        {
            return Some(vec![end]);
        }

        let start_node = self.closest_visible_node_on(start.level, start.pos)?;
        let end_node = self.closest_visible_node_on(end.level, end.pos)?;

        if start_node == end_node {
            return None;
        }

        let path_indexes = pathfinder::find_path(start_node, end_node, &self.nodes, &self.edges)?;

        let mut path: Vec<PathPoint> = path_indexes
            .into_iter()
            .map(|index| PathPoint {
                pos: self.nodes[index],
                level: self.node_level(index),
            })
            .collect();

        path.push(end);

        Some(path)
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

    /// Ближайший видимый узел к мировой позиции (поиск по 9 ячейкам).
    fn closest_visible_node(&self, position: [f32; 2]) -> Option<usize> {
        self.closest_visible_node_on(0, position)
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
}

// евклидова дистанция между узлами (вес ребра перехода)
fn distance(a: [f32; 2], b: [f32; 2]) -> f32 {
    (a[0] - b[0]).hypot(a[1] - b[1])
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

        MapLevels::build(&grid0, &[], &levels, &ramps, 10.0)
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

        MapLevels::build(&grid0, &[], &levels, &[], 10.0)
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
}
