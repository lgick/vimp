use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::nav::pathfinder::{self, Edge};
use crate::rng::Rng;

// коэффициент шага сетки
const COEF_GRID_STEP: f32 = 2.0;

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

    pub fn has_nodes(&self) -> bool {
        !self.nodes.is_empty()
    }

    /// Случайный узел графа (цель патрулирования).
    pub fn random_node(&self, rng: &mut Rng) -> Option<[f32; 2]> {
        if self.nodes.is_empty() {
            return None;
        }

        let index = (rng.next_f32() * self.nodes.len() as f32).floor() as usize;

        self.nodes.get(index).copied()
    }

    /// Проходима ли точка в мировых координатах.
    pub fn is_walkable(&self, x: f32, y: f32) -> bool {
        if self.nav_grid.is_empty() || self.grid_step == 0.0 {
            return false;
        }

        let grid_x = (x / self.grid_step).floor();
        let grid_y = (y / self.grid_step).floor();

        if grid_x < 0.0 || grid_y < 0.0 {
            return false;
        }

        self.nav_grid
            .get(grid_y as usize)
            .and_then(|row| row.get(grid_x as usize))
            .is_some_and(|&cell| cell == 0)
    }

    /// Быстрая линия видимости по сетке (алгоритм Брезенхэма):
    /// true — на пути есть препятствие.
    pub fn has_obstacle_between(&self, start: [f32; 2], end: [f32; 2]) -> bool {
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
                && self
                    .nav_grid
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

    /// Ближайший видимый узел к мировой позиции (поиск по 9 ячейкам).
    fn closest_visible_node(&self, position: [f32; 2]) -> Option<usize> {
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
            let node = self.nodes[index];

            if !self.has_obstacle_between(position, node) {
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

#[cfg(test)]
mod tests {
    use super::*;

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
