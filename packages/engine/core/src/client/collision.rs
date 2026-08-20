//! 2D-примитивы столкновений для клиентского предсказания — порт
//! src/lib/collision.js (срез tank-battle 2026-08): «угол объекта» → центр,
//! OBB против OBB (SAT), сбор контактов OBB с тайловой сеткой стен.
//! Геометрия берётся тем же `Box2` и той же тайловой сеткой, что и
//! `client::raycast`, — предсказание движения и предсказание выстрела обязаны
//! видеть карту одинаково. Разрешение собранных контактов — в
//! `client::rigid_body`.

use super::raycast::Box2;

/// Ширина контактного пятна как доля габарита тела. Одиночная опорная вершина
/// при почти плоском контакте даёт автоколебание: импульс перекидывает корпус
/// через положение «заподлицо», опорным становится противоположный угол грани,
/// и так каждый шаг. Поэтому вершины грани смешиваются с непрерывным весом:
/// при контакте заподлицо точка контакта — середина грани (плеча нет, тело
/// успокаивается), при явно косом ударе вес второй вершины падает до нуля и
/// остаётся честный угловой контакт с полным плечом разворота.
const CONTACT_MANIFOLD_RATIO: f32 = 0.15;

/// Контакт двух OBB: минимальный вектор выталкивания (нормаль направлена от
/// центра `a` к центру `b`), глубина проникновения и мировая точка контакта.
#[derive(Clone, Copy, Debug)]
pub struct Contact {
    pub nx: f32,
    pub ny: f32,
    pub depth: f32,
    pub cx: f32,
    pub cy: f32,
}

/// Контакт со сплошной клеткой сетки: нормаль направлена от OBB к клетке,
/// `tile_x`/`tile_y` — центр задетой клетки (плечо статики).
#[derive(Clone, Copy, Debug)]
pub struct TileContact {
    pub contact: Contact,
    pub tile_x: f32,
    pub tile_y: f32,
}

/// Переводит «угол объекта» (позиция тела Rapier для динамики карты —
/// см. `map::GameMap::create_dynamic`) в центр бокса: коллайдер хоста смещён
/// от тела на (half_w, half_h) в локальном (повёрнутом) фрейме объекта.
pub fn box_center_from_origin(x: f32, y: f32, angle: f32, half_w: f32, half_h: f32) -> [f32; 2] {
    let (sin, cos) = angle.sin_cos();

    [
        x + cos * half_w - sin * half_h,
        y + sin * half_w + cos * half_h,
    ]
}

// мировые углы OBB (порядок не важен — используются только для проекции)
fn obb_corners(b: &Box2) -> [[f32; 2]; 4] {
    let (sin, cos) = b.angle.sin_cos();
    let mut corners = [[0.0f32; 2]; 4];
    let mut i = 0;

    for sx in [-1.0f32, 1.0] {
        for sy in [-1.0f32, 1.0] {
            let lx = sx * b.half_w;
            let ly = sy * b.half_h;

            corners[i] = [b.x + cos * lx - sin * ly, b.y + sin * lx + cos * ly];
            i += 1;
        }
    }

    corners
}

// точка контакта: вершины a вдоль нормали, смешанные по близости к самой
// глубокой (см. CONTACT_MANIFOLD_RATIO)
// tolerance строго положителен: тело с нулевыми полуразмерами проецируется
// в точку, и obb_vs_obb отсеивает его как промах, не дойдя сюда
fn contact_point(corners: &[[f32; 2]; 4], nx: f32, ny: f32, tolerance: f32) -> [f32; 2] {
    let mut best = f32::NEG_INFINITY;

    for p in corners {
        best = best.max(p[0] * nx + p[1] * ny);
    }

    let mut sum_x = 0.0;
    let mut sum_y = 0.0;
    let mut sum_weight = 0.0;

    for p in corners {
        let weight = 1.0 - (best - (p[0] * nx + p[1] * ny)) / tolerance;

        if weight > 0.0 {
            sum_x += p[0] * weight;
            sum_y += p[1] * weight;
            sum_weight += weight;
        }
    }

    [sum_x / sum_weight, sum_y / sum_weight]
}

/// SAT-тест двух повёрнутых прямоугольников (OBB).
/// `None` — пересечения нет (касание вплотную тоже промах).
pub fn obb_vs_obb(a: &Box2, b: &Box2) -> Option<Contact> {
    let (a_sin, a_cos) = a.angle.sin_cos();
    let (b_sin, b_cos) = b.angle.sin_cos();
    let axes = [
        [a_cos, a_sin],
        [-a_sin, a_cos],
        [b_cos, b_sin],
        [-b_sin, b_cos],
    ];

    let corners_a = obb_corners(a);
    let corners_b = obb_corners(b);

    let mut min_overlap = f32::INFINITY;
    let mut normal_x = 0.0;
    let mut normal_y = 0.0;

    for [ax, ay] in axes {
        let mut min_a = f32::INFINITY;
        let mut max_a = f32::NEG_INFINITY;
        let mut min_b = f32::INFINITY;
        let mut max_b = f32::NEG_INFINITY;

        for p in &corners_a {
            let proj = p[0] * ax + p[1] * ay;

            min_a = min_a.min(proj);
            max_a = max_a.max(proj);
        }

        for p in &corners_b {
            let proj = p[0] * ax + p[1] * ay;

            min_b = min_b.min(proj);
            max_b = max_b.max(proj);
        }

        let overlap = max_a.min(max_b) - min_a.max(min_b);

        if overlap <= 0.0 {
            return None;
        }

        if overlap < min_overlap {
            min_overlap = overlap;

            // нормаль ориентируется от центра a к центру b
            let cx = b.x - a.x;
            let cy = b.y - a.y;
            let sign = if cx * ax + cy * ay < 0.0 { -1.0 } else { 1.0 };

            normal_x = ax * sign;
            normal_y = ay * sign;
        }
    }

    let contact = contact_point(
        &corners_a,
        normal_x,
        normal_y,
        CONTACT_MANIFOLD_RATIO * (a.half_w + a.half_h),
    );

    Some(Contact {
        nx: normal_x,
        ny: normal_y,
        depth: min_overlap,
        cx: contact[0],
        cy: contact[1],
    })
}

/// Список контактов OBB со сплошными клетками тайловой сетки.
/// Один проход без внутренних итераций: многократное разрешение — задача
/// импульсного решателя (`client::rigid_body`), он же естественно отрабатывает
/// внутренний угол из нескольких тайлов.
/// Сетка описывается той же тройкой, что и в `raycast::ray_vs_grid`.
pub fn collect_tile_contacts(
    obb: &Box2,
    map: &[Vec<i32>],
    solid_tiles: &[i32],
    tile_size: f32,
) -> Vec<TileContact> {
    let rows = map.len();
    let cols = map.first().map(|row| row.len()).unwrap_or(0);
    let mut contacts = Vec::new();

    if rows == 0 || cols == 0 || solid_tiles.is_empty() {
        return contacts;
    }

    // консервативный AABB OBB (для отбора кандидатных клеток)
    let (sin, cos) = obb.angle.sin_cos();
    let (sin, cos) = (sin.abs(), cos.abs());
    let extent_x = obb.half_w * cos + obb.half_h * sin;
    let extent_y = obb.half_w * sin + obb.half_h * cos;

    let min_cell_x = (((obb.x - extent_x) / tile_size).floor() as i64).max(0);
    let max_cell_x = (((obb.x + extent_x) / tile_size).floor() as i64).min(cols as i64 - 1);
    let min_cell_y = (((obb.y - extent_y) / tile_size).floor() as i64).max(0);
    let max_cell_y = (((obb.y + extent_y) / tile_size).floor() as i64).min(rows as i64 - 1);

    for cell_y in min_cell_y..=max_cell_y {
        for cell_x in min_cell_x..=max_cell_x {
            if !solid_tiles.contains(&map[cell_y as usize][cell_x as usize]) {
                continue;
            }

            let tile_x = cell_x as f32 * tile_size + tile_size / 2.0;
            let tile_y = cell_y as f32 * tile_size + tile_size / 2.0;
            let tile = Box2 {
                x: tile_x,
                y: tile_y,
                angle: 0.0,
                half_w: tile_size / 2.0,
                half_h: tile_size / 2.0,
            };

            if let Some(contact) = obb_vs_obb(obb, &tile) {
                contacts.push(TileContact {
                    contact,
                    tile_x,
                    tile_y,
                });
            }
        }
    }

    contacts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box2(x: f32, y: f32, angle: f32, half_w: f32, half_h: f32) -> Box2 {
        Box2 {
            x,
            y,
            angle,
            half_w,
            half_h,
        }
    }

    #[test]
    fn origin_to_center_without_rotation_is_a_plain_offset() {
        assert_eq!(
            box_center_from_origin(10.0, 20.0, 0.0, 5.0, 3.0),
            [15.0, 23.0]
        );
    }

    #[test]
    fn origin_to_center_follows_rotation() {
        let center = box_center_from_origin(10.0, 20.0, core::f32::consts::FRAC_PI_2, 5.0, 3.0);

        assert!((center[0] - 7.0).abs() < 1e-5);
        assert!((center[1] - 25.0).abs() < 1e-5);
    }

    #[test]
    fn separated_boxes_do_not_touch() {
        let a = box2(0.0, 0.0, 0.0, 5.0, 5.0);
        let b = box2(20.0, 0.0, 0.0, 5.0, 5.0);

        assert!(obb_vs_obb(&a, &b).is_none());
    }

    #[test]
    fn flush_touch_is_a_miss() {
        let a = box2(0.0, 0.0, 0.0, 5.0, 5.0);
        let b = box2(10.0, 0.0, 0.0, 5.0, 5.0);

        assert!(obb_vs_obb(&a, &b).is_none());
    }

    #[test]
    fn overlap_normal_points_from_a_to_b() {
        let a = box2(0.0, 0.0, 0.0, 5.0, 5.0);
        let b = box2(8.0, 0.0, 0.0, 5.0, 5.0);
        let contact = obb_vs_obb(&a, &b).expect("контакт");

        assert!((contact.nx - 1.0).abs() < 1e-5);
        assert!(contact.ny.abs() < 1e-5);
        assert!((contact.depth - 2.0).abs() < 1e-5);
    }

    #[test]
    fn overlap_on_y_axis_keeps_direction() {
        let a = box2(0.0, 0.0, 0.0, 5.0, 5.0);
        let b = box2(0.0, -8.0, 0.0, 5.0, 5.0);
        let contact = obb_vs_obb(&a, &b).expect("контакт");

        assert!(contact.nx.abs() < 1e-5);
        assert!((contact.ny + 1.0).abs() < 1e-5);
        assert!((contact.depth - 2.0).abs() < 1e-5);
    }

    #[test]
    fn face_contact_lands_in_the_middle_of_the_face() {
        let a = box2(0.0, 0.0, 0.0, 5.0, 5.0);
        let b = box2(8.0, 0.0, 0.0, 5.0, 5.0);
        let contact = obb_vs_obb(&a, &b).expect("контакт");

        assert!((contact.cx - 5.0).abs() < 1e-5);
        assert!(contact.cy.abs() < 1e-5);
    }

    #[test]
    fn corner_contact_keeps_the_lever() {
        let a = box2(0.0, 0.0, core::f32::consts::FRAC_PI_4, 5.0, 5.0);
        let b = box2(9.0, 0.0, 0.0, 3.0, 3.0);
        let contact = obb_vs_obb(&a, &b).expect("контакт");

        // повёрнутый на 45° квадрат касается вершиной на расстоянии half_w·√2
        let distance = contact.cx.hypot(contact.cy);

        assert!((distance - 5.0 * core::f32::consts::SQRT_2).abs() < 1e-4);
    }

    #[test]
    fn returned_vector_actually_separates_rotated_boxes() {
        // длинная узкая балка (a) и повёрнутая на 45° пластина (b) сверху
        let a = box2(0.0, 0.0, 0.0, 10.0, 2.0);
        let b = box2(0.0, 5.0, core::f32::consts::FRAC_PI_4, 6.0, 1.0);
        let contact = obb_vs_obb(&a, &b).expect("контакт");

        // небольшой запас страхует от остаточного пересечения на грани
        // float-точности (SAT на самой границе даёт микроскопический depth)
        let epsilon = 1e-4;
        let separated = Box2 {
            x: b.x + contact.nx * (contact.depth + epsilon),
            y: b.y + contact.ny * (contact.depth + epsilon),
            ..b
        };

        assert!(obb_vs_obb(&a, &separated).is_none());
    }

    // на этом держится ширина контактного пятна: тело с нулевым габаритом
    // дало бы нулевой допуск и 0/0 в точке контакта, но сюда не доходит
    #[test]
    fn degenerate_box_is_a_miss() {
        let degenerate = box2(0.0, 0.0, 0.0, 0.0, 0.0);
        let b = box2(0.0, 0.0, 0.0, 5.0, 5.0);

        assert!(obb_vs_obb(&degenerate, &b).is_none());
        assert!(obb_vs_obb(&b, &degenerate).is_none());
    }

    #[test]
    fn no_solid_tiles_means_no_contacts() {
        let map = vec![vec![0, 0], vec![0, 0]];
        let obb = box2(5.0, 5.0, 0.0, 3.0, 3.0);

        assert!(collect_tile_contacts(&obb, &map, &[], 10.0).is_empty());
    }

    #[test]
    fn box_away_from_the_wall_has_no_contacts() {
        let map = vec![vec![0, 0], vec![0, 1]];
        let obb = box2(100.0, 100.0, 0.0, 3.0, 3.0);

        assert!(collect_tile_contacts(&obb, &map, &[1], 10.0).is_empty());
    }

    #[test]
    fn single_wall_gives_one_contact_along_the_shortest_axis() {
        // клетка (1,1) солид — мир [10,20]×[10,20], центр (15,15)
        let map = vec![vec![0, 0], vec![0, 1]];
        // бокс снизу, глубже въехал по Y (overlap 2), чем по X (overlap 6)
        let obb = box2(15.0, 22.0, 0.0, 3.0, 4.0);
        let contacts = collect_tile_contacts(&obb, &map, &[1], 10.0);

        assert_eq!(contacts.len(), 1);

        let hit = contacts[0];

        // нормаль направлена от obb к клетке, то есть вверх (−Y)
        assert!(hit.contact.nx.abs() < 1e-5);
        assert!((hit.contact.ny + 1.0).abs() < 1e-5);
        assert!((hit.contact.depth - 2.0).abs() < 1e-5);
        assert_eq!(hit.tile_x, 15.0);
        assert_eq!(hit.tile_y, 15.0);

        // выталкивание против нормали разрешает пересечение
        let resolved = Box2 {
            x: obb.x - hit.contact.nx * hit.contact.depth,
            y: obb.y - hit.contact.ny * hit.contact.depth,
            ..obb
        };
        let tile = box2(15.0, 15.0, 0.0, 5.0, 5.0);

        assert!(obb_vs_obb(&resolved, &tile).is_none());
    }

    #[test]
    fn inner_corner_gives_a_contact_per_touched_tile() {
        // L-форма: (0,0),(0,1),(1,0) солид; (1,1) — пустая клетка-«ниша»
        let map = vec![vec![1, 1], vec![1, 0]];
        // бокс прижат в угол ниши (10,10), пересекает все три стены сразу
        let obb = box2(12.0, 12.0, 0.0, 4.0, 4.0);
        let contacts = collect_tile_contacts(&obb, &map, &[1], 10.0);

        assert_eq!(contacts.len(), 3);

        let mut tiles: Vec<(i32, i32)> = contacts
            .iter()
            .map(|c| (c.tile_x as i32, c.tile_y as i32))
            .collect();

        tiles.sort();

        assert_eq!(tiles, vec![(5, 5), (5, 15), (15, 5)]);
        assert!(contacts.iter().all(|c| c.contact.depth > 0.0));
    }

    #[test]
    fn rotated_box_picks_candidate_cells_by_conservative_aabb() {
        let map = vec![vec![1, 0], vec![0, 0]];
        // бокс повёрнут на 45°, углом заходит в клетку (0,0) — мир [0,10]×[0,10]
        let obb = box2(13.0, 13.0, core::f32::consts::FRAC_PI_4, 5.0, 2.0);
        let contacts = collect_tile_contacts(&obb, &map, &[1], 10.0);

        assert_eq!(contacts.len(), 1);
        assert!(contacts[0].contact.depth > 0.0);
    }

    // геометрия карты у луча и у контакта одна: стена, в которую упёрся OBB,
    // и стена, которую нашёл луч в том же направлении, — одна и та же клетка
    #[test]
    fn ray_and_contact_agree_on_the_same_wall() {
        let map = vec![vec![0, 0], vec![0, 1]];
        let obb = box2(15.0, 22.0, 0.0, 3.0, 4.0);
        let contacts = collect_tile_contacts(&obb, &map, &[1], 10.0);
        let hit = super::super::raycast::ray_vs_grid(
            [obb.x, obb.y],
            [contacts[0].contact.nx, contacts[0].contact.ny],
            50.0,
            &map,
            &[1],
            10.0,
        );

        // луч вдоль нормали контакта упирается в ту же клетку (её грань y=20)
        assert!(hit.is_some());
        assert!((hit.unwrap() - 2.0).abs() < 1e-4);
    }
}
