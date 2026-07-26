//! 2D raycast-примитивы для клиентского предсказания выстрелов — порт
//! src/lib/raycast.js (срез 2.6): приближённая реплика авторитетного
//! world.cast_ray по данным, которые уже есть у клиента (тайловая сетка
//! стен, прямоугольники динамики карты и танков).

/// Повёрнутый прямоугольник (OBB) для slab-теста.
pub struct Box2 {
    pub x: f32,
    pub y: f32,
    pub angle: f32,
    pub half_w: f32,
    pub half_h: f32,
}

/// Луч против тайловой сетки стен (DDA-обход клеток).
/// Возвращает дистанцию до стены или None (промах в пределах range).
pub fn ray_vs_grid(
    origin: [f32; 2],
    dir: [f32; 2],
    range: f32,
    map: &[Vec<i32>],
    solid_tiles: &[i32],
    tile_size: f32,
) -> Option<f32> {
    let rows = map.len();
    let cols = map.first().map(|row| row.len()).unwrap_or(0);

    if rows == 0 || cols == 0 || solid_tiles.is_empty() {
        return None;
    }

    let is_solid = |cx: i64, cy: i64| {
        cy >= 0
            && (cy as usize) < rows
            && cx >= 0
            && (cx as usize) < cols
            && solid_tiles.contains(&map[cy as usize][cx as usize])
    };

    let mut cell_x = (origin[0] / tile_size).floor() as i64;
    let mut cell_y = (origin[1] / tile_size).floor() as i64;

    // старт внутри стены — попадание в упор
    if is_solid(cell_x, cell_y) {
        return Some(0.0);
    }

    let step_x: i64 = if dir[0] > 0.0 { 1 } else { -1 };
    let step_y: i64 = if dir[1] > 0.0 { 1 } else { -1 };

    // дистанция вдоль луча на пересечение одной клетки по каждой оси
    let delta_x = if dir[0] != 0.0 {
        (tile_size / dir[0]).abs()
    } else {
        f32::INFINITY
    };
    let delta_y = if dir[1] != 0.0 {
        (tile_size / dir[1]).abs()
    } else {
        f32::INFINITY
    };

    // дистанция вдоль луча до первой границы клетки по каждой оси
    let mut max_x = if dir[0] != 0.0 {
        let edge = if dir[0] > 0.0 {
            (cell_x + 1) as f32 * tile_size - origin[0]
        } else {
            origin[0] - cell_x as f32 * tile_size
        };

        edge / dir[0].abs()
    } else {
        f32::INFINITY
    };
    let mut max_y = if dir[1] != 0.0 {
        let edge = if dir[1] > 0.0 {
            (cell_y + 1) as f32 * tile_size - origin[1]
        } else {
            origin[1] - cell_y as f32 * tile_size
        };

        edge / dir[1].abs()
    } else {
        f32::INFINITY
    };

    let mut traveled = 0.0f32;

    while traveled <= range {
        if max_x < max_y {
            traveled = max_x;
            max_x += delta_x;
            cell_x += step_x;
        } else {
            traveled = max_y;
            max_y += delta_y;
            cell_y += step_y;
        }

        if traveled > range {
            return None;
        }

        if is_solid(cell_x, cell_y) {
            return Some(traveled);
        }
    }

    None
}

/// Луч против повёрнутого прямоугольника (slab-тест в локальном фрейме OBB).
/// Возвращает дистанцию до ближней грани или None (промах).
pub fn ray_vs_box(origin: [f32; 2], dir: [f32; 2], range: f32, b: &Box2) -> Option<f32> {
    // перевод луча в локальный фрейм бокса (поворот на −angle)
    let (sin, cos) = (-b.angle).sin_cos();
    let rel_x = origin[0] - b.x;
    let rel_y = origin[1] - b.y;

    let local_origin = [cos * rel_x - sin * rel_y, sin * rel_x + cos * rel_y];
    let local_dir = [cos * dir[0] - sin * dir[1], sin * dir[0] + cos * dir[1]];

    let mut t_min = 0.0f32;
    let mut t_max = range;

    // slab-тест по каждой оси AABB [-half, +half]
    let slabs = [
        (local_origin[0], local_dir[0], b.half_w),
        (local_origin[1], local_dir[1], b.half_h),
    ];

    for (o, d, half) in slabs {
        if d == 0.0 {
            if o < -half || o > half {
                return None;
            }

            continue;
        }

        let mut t1 = (-half - o) / d;
        let mut t2 = (half - o) / d;

        if t1 > t2 {
            std::mem::swap(&mut t1, &mut t2);
        }

        t_min = t_min.max(t1);
        t_max = t_max.min(t2);

        if t_min > t_max {
            return None;
        }
    }

    Some(t_min)
}

#[cfg(test)]
mod tests {
    use super::*;

    // сетка 5×5 со стеной (1) в колонке 3; тайл 10 юнитов
    fn wall_grid() -> Vec<Vec<i32>> {
        let mut grid = vec![vec![0; 5]; 5];

        for row in &mut grid {
            row[3] = 1;
        }

        grid
    }

    #[test]
    fn grid_ray_hits_wall_to_the_right() {
        let grid = wall_grid();
        // старт в центре тайла (1,1), луч вправо: стена начинается на x=30
        let hit = ray_vs_grid([15.0, 15.0], [1.0, 0.0], 100.0, &grid, &[1], 10.0);

        assert_eq!(hit, Some(15.0));
    }

    #[test]
    fn grid_ray_misses_within_range() {
        let grid = wall_grid();
        let hit = ray_vs_grid([15.0, 15.0], [1.0, 0.0], 10.0, &grid, &[1], 10.0);

        assert_eq!(hit, None);
    }

    #[test]
    fn grid_ray_away_from_wall_misses() {
        let grid = wall_grid();
        let hit = ray_vs_grid([15.0, 15.0], [-1.0, 0.0], 100.0, &grid, &[1], 10.0);

        assert_eq!(hit, None);
    }

    #[test]
    fn grid_start_inside_wall_hits_at_zero() {
        let grid = wall_grid();
        let hit = ray_vs_grid([35.0, 15.0], [1.0, 0.0], 100.0, &grid, &[1], 10.0);

        assert_eq!(hit, Some(0.0));
    }

    #[test]
    fn grid_diagonal_and_vertical_rays() {
        let mut grid = vec![vec![0; 5]; 5];

        grid[3] = vec![1; 5]; // стена — строка 3 (y от 30)

        let dir = [std::f32::consts::FRAC_1_SQRT_2, std::f32::consts::FRAC_1_SQRT_2];
        let diagonal = ray_vs_grid([5.0, 5.0], dir, 100.0, &grid, &[1], 10.0).unwrap();

        // до y=30 по диагонали: 25/sin(45°) ≈ 35.36
        assert!((diagonal - 25.0 * std::f32::consts::SQRT_2).abs() < 0.01);

        let vertical = ray_vs_grid([5.0, 5.0], [0.0, 1.0], 100.0, &grid, &[1], 10.0);

        assert_eq!(vertical, Some(25.0));
    }

    #[test]
    fn grid_without_solid_tiles_never_hits() {
        let grid = wall_grid();
        let hit = ray_vs_grid([15.0, 15.0], [1.0, 0.0], 100.0, &grid, &[], 10.0);

        assert_eq!(hit, None);
    }

    #[test]
    fn box_head_on_hit() {
        let b = Box2 {
            x: 50.0,
            y: 0.0,
            angle: 0.0,
            half_w: 10.0,
            half_h: 5.0,
        };
        let hit = ray_vs_box([0.0, 0.0], [1.0, 0.0], 100.0, &b);

        assert_eq!(hit, Some(40.0));
    }

    #[test]
    fn box_miss_and_out_of_range() {
        let b = Box2 {
            x: 50.0,
            y: 20.0,
            angle: 0.0,
            half_w: 10.0,
            half_h: 5.0,
        };

        assert_eq!(ray_vs_box([0.0, 0.0], [1.0, 0.0], 100.0, &b), None);

        let near = Box2 { y: 0.0, ..b };

        assert_eq!(ray_vs_box([0.0, 0.0], [1.0, 0.0], 30.0, &near), None);
    }

    #[test]
    fn box_start_inside_hits_at_zero() {
        let b = Box2 {
            x: 0.0,
            y: 0.0,
            angle: 0.0,
            half_w: 10.0,
            half_h: 10.0,
        };

        assert_eq!(ray_vs_box([0.0, 0.0], [1.0, 0.0], 100.0, &b), Some(0.0));
    }

    #[test]
    fn box_rotation_changes_hit_distance() {
        // бокс 20×2, повёрнутый на 90°: по лучу видна узкая грань
        let b = Box2 {
            x: 50.0,
            y: 0.0,
            angle: std::f32::consts::FRAC_PI_2,
            half_w: 10.0,
            half_h: 1.0,
        };
        let hit = ray_vs_box([0.0, 0.0], [1.0, 0.0], 100.0, &b).unwrap();

        assert!((hit - 49.0).abs() < 0.001);
    }

    #[test]
    fn box_behind_ray_misses() {
        let b = Box2 {
            x: -50.0,
            y: 0.0,
            angle: 0.0,
            half_w: 10.0,
            half_h: 5.0,
        };

        assert_eq!(ray_vs_box([0.0, 0.0], [1.0, 0.0], 100.0, &b), None);
    }
}
