use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Пространственная сетка для быстрого поиска соседей
/// (порт src/server/modules/bots/SpatialManager.js).
#[derive(Clone, Serialize, Deserialize)]
pub struct SpatialGrid {
    cell_size: f32,
    grid: HashMap<(i32, i32), Vec<SpatialEntity>>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct SpatialEntity {
    pub game_id: u32,
    pub team_id: u8,
    pub x: f32,
    pub y: f32,
}

impl SpatialGrid {
    pub fn new(cell_size: f32) -> Self {
        Self {
            cell_size,
            grid: HashMap::new(),
        }
    }

    pub fn clear(&mut self) {
        self.grid.clear();
    }

    fn cell_key(&self, x: f32, y: f32) -> (i32, i32) {
        (
            (x / self.cell_size).floor() as i32,
            (y / self.cell_size).floor() as i32,
        )
    }

    pub fn insert(&mut self, entity: SpatialEntity) {
        let key = self.cell_key(entity.x, entity.y);

        self.grid.entry(key).or_default().push(entity);
    }

    /// Все сущности в ячейке позиции и 8 соседних.
    pub fn query_nearby(&self, x: f32, y: f32) -> Vec<SpatialEntity> {
        let (center_cx, center_cy) = self.cell_key(x, y);
        let mut candidates = Vec::new();

        for cy in (center_cy - 1)..=(center_cy + 1) {
            for cx in (center_cx - 1)..=(center_cx + 1) {
                if let Some(cell) = self.grid.get(&(cx, cy)) {
                    candidates.extend_from_slice(cell);
                }
            }
        }

        candidates
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_returns_neighbours_only() {
        let mut grid = SpatialGrid::new(100.0);

        grid.insert(SpatialEntity {
            game_id: 1,
            team_id: 1,
            x: 50.0,
            y: 50.0,
        });
        grid.insert(SpatialEntity {
            game_id: 2,
            team_id: 2,
            x: 150.0,
            y: 50.0,
        });
        grid.insert(SpatialEntity {
            game_id: 3,
            team_id: 2,
            x: 950.0,
            y: 950.0,
        });

        let found = grid.query_nearby(60.0, 60.0);
        let ids: Vec<u32> = found.iter().map(|e| e.game_id).collect();

        assert!(ids.contains(&1));
        assert!(ids.contains(&2));
        assert!(!ids.contains(&3));
    }
}
