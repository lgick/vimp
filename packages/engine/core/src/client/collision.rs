//! 2D-примитивы столкновений для клиентского предсказания — порт
//! src/lib/collision.js (срез tank-battle 2026-08): «угол объекта» → центр,
//! OBB против OBB (SAT), сбор контактов OBB с тайловой сеткой стен.
//! Геометрия берётся тем же `Box2` и той же тайловой сеткой, что и
//! `client::raycast`, — предсказание движения и предсказание выстрела обязаны
//! видеть карту одинаково. Разрешение собранных контактов — в
//! `client::rigid_body`.

use super::raycast::Box2;
use crate::map::StaticBlock;

/// Ширина контактного пятна как доля габарита тела. Одиночная опорная вершина
/// при почти плоском контакте даёт автоколебание: импульс перекидывает корпус
/// через положение «заподлицо», опорным становится противоположный угол грани,
/// и так каждый шаг. Поэтому вершины грани смешиваются с непрерывным весом:
/// при контакте заподлицо точка контакта — середина грани (плеча нет, тело
/// успокаивается), при явно косом ударе вес второй вершины падает до нуля и
/// остаётся честный угловой контакт с полным плечом разворота.
const CONTACT_MANIFOLD_RATIO: f32 = 0.15;

/// Контакт двух OBB: минимальный вектор выталкивания (нормаль направлена от
/// центра `a` к центру `b`), ЗНАКОВАЯ глубина и мировая точка контакта.
///
/// `depth > 0` — проникновение (тела уже перекрыты), `depth < 0` — зазор:
/// спекулятивный контакт, найденный до перекрытия
/// (`obb_vs_obb_within`). Решатель обязан различать эти случаи:
/// разводить по зазору нечего, а импульс считается от скорости, которая
/// закрывает зазор быстрее, чем за шаг (`rigid_body::apply_contact_impulse`).
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

/// Манифольд пары OBB: до ДВУХ точек с общей нормалью и своими глубинами.
/// Одна точка на пару — приближение, которое расходится с Rapier ровно там,
/// где важно: у него манифольд «куб — куб» строится клиппингом опорных
/// граней, и на касательном ударе две точки дают другое плечо, чем середина
/// грани. Отсюда и брался разъезд `angle`/`angvel` предсказания с сервером.
#[derive(Clone, Copy, Debug)]
pub struct Manifold {
    points: [Contact; 2],
    len: usize,
}

impl Manifold {
    /// Точки манифольда (одна или две).
    pub fn as_slice(&self) -> &[Contact] {
        &self.points[..self.len]
    }

    /// Самая глубокая точка — ею делается позиционная коррекция: развод
    /// по каждой точке пары растолкал бы тела кратно их числу.
    pub fn deepest(&self) -> Contact {
        let mut best = self.points[0];

        for point in &self.points[1..self.len] {
            if point.depth > best.depth {
                best = *point;
            }
        }

        best
    }
}

/// Манифольд OBB со склеенным блоком стен уровня.
/// `block_x`/`block_y` — центр блока (плечо статики).
#[derive(Clone, Copy, Debug)]
pub struct BlockContact {
    pub manifold: Manifold,
    pub block_x: f32,
    pub block_y: f32,
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
/// Обёртка над `obb_vs_obb_within` без предсказания: контакт рождается по
/// факту перекрытия.
pub fn obb_vs_obb(a: &Box2, b: &Box2) -> Option<Contact> {
    obb_vs_obb_within(a, b, 0.0)
}

/// SAT-тест с предсказанием: контакт возвращается, пока зазор между телами
/// не больше `prediction`. Это клиентский аналог `soft_ccd_prediction`
/// Rapier — хост строит контакт, пока тела ещё разведены, ведёт его через
/// шаг и решает скорости ДО интеграции позиции. Реплика без предсказания
/// успевала уйти в стену на несколько юнитов за шаг и реагировала уже
/// изнутри: точка контакта и плечо получались другими, и предсказание
/// молча расходилось с сервером на касательных ударах.
///
/// Выигрывает ось с наибольшим зазором (она же — ось минимального
/// перекрытия при проникновении), `Contact::depth` знаковый.
/// `prediction = 0.0` даёт прежнее поведение бит в бит.
pub fn obb_vs_obb_within(a: &Box2, b: &Box2, prediction: f32) -> Option<Contact> {
    let (axis, corners_a, _) = separating_axis(a, b, prediction)?;
    let contact = contact_point(
        &corners_a,
        axis.nx,
        axis.ny,
        CONTACT_MANIFOLD_RATIO * (a.half_w + a.half_h),
    );

    Some(Contact {
        nx: axis.nx,
        ny: axis.ny,
        depth: axis.depth,
        cx: contact[0],
        cy: contact[1],
    })
}

/// Манифольд пары OBB: до двух точек контакта, как их строит Rapier.
/// Ось берётся тем же SAT, что и в `obb_vs_obb_within`; опорная грань тела,
/// которому ось принадлежит, отсекает встречную грань второго тела
/// (Sutherland—Hodgman по двум боковым плоскостям), и каждая уцелевшая точка
/// получает СВОЮ глубину. Пара «грань — грань» даёт две точки и честное
/// плечо разворота, «угол — грань» — одну.
/// `prediction` — тот же зазор спекулятивного контакта.
/// Вырожденный случай (грани не перекрываются вовсе) откатывается к
/// смешанной точке `obb_vs_obb_within`: манифольда там нет, а контакт есть.
pub fn obb_manifold(a: &Box2, b: &Box2, prediction: f32) -> Option<Manifold> {
    let (axis, _, owner_is_a) = separating_axis(a, b, prediction)?;
    let normal = [axis.nx, axis.ny];
    let flipped = [-axis.nx, -axis.ny];

    // опорная грань тела, которому принадлежит ось, — референсная;
    // встречная грань второго тела — падающая
    let (reference, incident) = if owner_is_a {
        (support_face(a, normal), support_face(b, flipped))
    } else {
        (support_face(b, flipped), support_face(a, normal))
    };

    let (ref_face, ref_normal) = reference;
    let (incident_face, _) = incident;
    let tangent = [-ref_normal[1], ref_normal[0]];
    let t0 = ref_face[0][0] * tangent[0] + ref_face[0][1] * tangent[1];
    let t1 = ref_face[1][0] * tangent[0] + ref_face[1][1] * tangent[1];

    let clipped = clip_segment(&incident_face, tangent, t0.min(t1), t0.max(t1));

    let Some(clipped) = clipped else {
        return obb_vs_obb_within(a, b, prediction).map(|contact| Manifold {
            points: [contact, contact],
            len: 1,
        });
    };

    let mut points = [Contact {
        nx: axis.nx,
        ny: axis.ny,
        depth: axis.depth,
        cx: 0.0,
        cy: 0.0,
    }; 2];
    let mut len = 0;

    for point in &clipped {
        // глубина точки — насколько она зашла ЗА плоскость референсной
        // грани; знак тот же, что у `Contact::depth`
        let depth = -((point[0] - ref_face[0][0]) * ref_normal[0]
            + (point[1] - ref_face[0][1]) * ref_normal[1]);

        if depth < -prediction {
            continue;
        }

        points[len] = Contact {
            nx: axis.nx,
            ny: axis.ny,
            depth,
            cx: point[0],
            cy: point[1],
        };
        len += 1;
    }

    if len == 0 {
        return obb_vs_obb_within(a, b, prediction).map(|contact| Manifold {
            points: [contact, contact],
            len: 1,
        });
    }

    Some(Manifold { points, len })
}

// ось SAT пары: нормаль от центра `a` к центру `b`, знаковая глубина,
// признак «ось принадлежит телу a». Общая часть одноточечного контакта и
// манифольда — оба обязаны выбирать одну и ту же ось
struct Axis {
    nx: f32,
    ny: f32,
    depth: f32,
}

fn separating_axis(a: &Box2, b: &Box2, prediction: f32) -> Option<(Axis, [[f32; 2]; 4], bool)> {
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
    let mut owner_is_a = true;

    for (index, [ax, ay]) in axes.into_iter().enumerate() {
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

        // зазор больше предсказания — разделяющая ось найдена, контакта нет
        if overlap <= -prediction {
            return None;
        }

        if overlap < min_overlap {
            min_overlap = overlap;
            owner_is_a = index < 2;

            // нормаль ориентируется от центра a к центру b
            let cx = b.x - a.x;
            let cy = b.y - a.y;
            let sign = if cx * ax + cy * ay < 0.0 { -1.0 } else { 1.0 };

            normal_x = ax * sign;
            normal_y = ay * sign;
        }
    }

    Some((
        Axis {
            nx: normal_x,
            ny: normal_y,
            depth: min_overlap,
        },
        corners_a,
        owner_is_a,
    ))
}

// опорная грань OBB в направлении `dir`: два её мировых конца и внешняя
// нормаль грани
fn support_face(b: &Box2, dir: [f32; 2]) -> ([[f32; 2]; 2], [f32; 2]) {
    let (sin, cos) = b.angle.sin_cos();
    let u = [cos, sin];
    let v = [-sin, cos];
    let du = dir[0] * u[0] + dir[1] * u[1];
    let dv = dir[0] * v[0] + dir[1] * v[1];

    let (axis, half, along, along_half, projection) = if du.abs() >= dv.abs() {
        (u, b.half_w, v, b.half_h, du)
    } else {
        (v, b.half_h, u, b.half_w, dv)
    };
    let sign = if projection < 0.0 { -1.0 } else { 1.0 };
    let normal = [axis[0] * sign, axis[1] * sign];
    let center = [b.x + normal[0] * half, b.y + normal[1] * half];

    (
        [
            [
                center[0] - along[0] * along_half,
                center[1] - along[1] * along_half,
            ],
            [
                center[0] + along[0] * along_half,
                center[1] + along[1] * along_half,
            ],
        ],
        normal,
    )
}

// отсечение отрезка боковыми плоскостями референсной грани: остаётся его
// часть, чья проекция на касательную лежит в [min, max]
fn clip_segment(
    segment: &[[f32; 2]; 2],
    tangent: [f32; 2],
    min: f32,
    max: f32,
) -> Option<[[f32; 2]; 2]> {
    let t0 = segment[0][0] * tangent[0] + segment[0][1] * tangent[1];
    let t1 = segment[1][0] * tangent[0] + segment[1][1] * tangent[1];
    let span = t1 - t0;

    // грань перпендикулярна касательной (вырожденная проекция) — отсекать
    // нечем: точка внутри диапазона или манифольда нет
    if span.abs() < f32::EPSILON {
        return (t0 >= min && t0 <= max).then_some(*segment);
    }

    let s_min = ((min - t0) / span).clamp(0.0, 1.0);
    let s_max = ((max - t0) / span).clamp(0.0, 1.0);
    let (low, high) = if s_min <= s_max {
        (s_min, s_max)
    } else {
        (s_max, s_min)
    };

    // отрезок целиком вне диапазона грани — чистый угловой случай
    if (t0.min(t1) > max) || (t0.max(t1) < min) {
        return None;
    }

    let at = |s: f32| {
        [
            segment[0][0] + (segment[1][0] - segment[0][0]) * s,
            segment[0][1] + (segment[1][1] - segment[0][1]) * s,
        ]
    };

    Some([at(low), at(high)])
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

/// Список контактов OBB со склеенными блоками стен уровня
/// (`MapLevels::static_blocks`). В отличие от `collect_tile_contacts` видит
/// ровно ту геометрию, по которой хост поставил коллайдеры: на длинной стене
/// SAT выбирает ту же ось выталкивания, что Rapier, и касательный удар об
/// угол не разводит предсказание с сервером.
/// `prediction` — дистанция спекулятивного контакта (см. `obb_vs_obb_within`);
/// она обязана совпадать с `soft_ccd_prediction` тела у хоста.
pub fn collect_block_contacts(
    obb: &Box2,
    blocks: &[StaticBlock],
    prediction: f32,
) -> Vec<BlockContact> {
    let mut contacts = Vec::new();

    if blocks.is_empty() {
        return contacts;
    }

    // консервативный AABB OBB (для отбора кандидатных блоков), раздутый на
    // дистанцию предсказания — иначе спекулятивный контакт отсеялся бы
    // грубым тестом, не дойдя до SAT
    let (sin, cos) = obb.angle.sin_cos();
    let (sin, cos) = (sin.abs(), cos.abs());
    let extent_x = obb.half_w * cos + obb.half_h * sin + prediction;
    let extent_y = obb.half_w * sin + obb.half_h * cos + prediction;

    for block in blocks {
        if (block.x - obb.x).abs() > block.half_w + extent_x
            || (block.y - obb.y).abs() > block.half_h + extent_y
        {
            continue;
        }

        let box2 = Box2 {
            x: block.x,
            y: block.y,
            angle: 0.0,
            half_w: block.half_w,
            half_h: block.half_h,
        };

        if let Some(manifold) = obb_manifold(obb, &box2, prediction) {
            contacts.push(BlockContact {
                manifold,
                block_x: block.x,
                block_y: block.y,
            });
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
    fn block_contact_matches_the_host_collider_on_the_long_wall() {
        // разобранный случай: юго-западный угол перил уровня 1 карты
        // overpass. Хост склеивает строку в ОДНО тело 537.6 × 12.8, реплика
        // раньше собирала контакты потайлово. Танк входит в угол по
        // касательной: перекрытие по x 1.106, по y 1.27.
        let block = StaticBlock {
            x: 345.6,
            y: 403.2,
            half_w: 268.8,
            half_h: 6.4,
        };
        let obb = box2(74.906, 395.07, 0.0, 3.0, 3.0);

        let by_block = collect_block_contacts(&obb, &[block], 0.0);

        // одно тело у хоста — один контакт у реплики
        assert_eq!(by_block.len(), 1);

        let deepest = by_block[0].manifold.deepest();

        // нормаль и глубина — те же, что даёт Rapier на этом коллайдере
        // (parry: normal (1, 0), dist -1.10599)
        assert!((deepest.nx - 1.0).abs() < 1e-3);
        assert!(deepest.ny.abs() < 1e-3);
        assert!((deepest.depth - 1.106).abs() < 1e-2);
        // плечо статики — центр ОДНОГО тела хоста, а не центр тайла
        assert_eq!(by_block[0].block_x, block.x);
        assert_eq!(by_block[0].block_y, block.y);
    }

    #[test]
    fn block_and_tile_collection_differ_on_a_long_wall() {
        // тот же кусок стены, но собранный потайлово: корпус лежит на двух
        // тайлах сразу и получает ДВА контакта с разными плечами — импульсы
        // разворачивают танк не так, как единственный контакт хоста
        let tile = 12.8;
        let map: Vec<Vec<i32>> = (0..34)
            .map(|y| {
                (0..48)
                    .map(|x| i32::from(y == 31 && (6..48).contains(&x)))
                    .collect()
            })
            .collect();
        let obb = box2(89.6, 395.07, 0.0, 6.0, 3.0);

        let blocks = [StaticBlock {
            x: 345.6,
            y: 403.2,
            half_w: 268.8,
            half_h: 6.4,
        }];

        assert_eq!(collect_block_contacts(&obb, &blocks, 0.0).len(), 1);
        assert_eq!(collect_tile_contacts(&obb, &map, &[1], tile).len(), 2);
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
    fn prediction_finds_the_contact_before_the_overlap() {
        // зазор 0.5 по x: без предсказания промах, с предсказанием 1.0 —
        // контакт с ОТРИЦАТЕЛЬНОЙ глубиной, равной зазору
        let a = box2(0.0, 0.0, 0.0, 5.0, 5.0);
        let b = box2(10.5, 0.0, 0.0, 5.0, 5.0);

        assert!(obb_vs_obb(&a, &b).is_none());

        let contact = obb_vs_obb_within(&a, &b, 1.0).expect("спекулятивный контакт");

        assert!((contact.nx - 1.0).abs() < 1e-5);
        assert!(contact.ny.abs() < 1e-5);
        assert!((contact.depth + 0.5).abs() < 1e-5);
    }

    #[test]
    fn prediction_keeps_the_normal_of_the_overlapping_pair() {
        // та же пара, сдвинутая до перекрытия: нормаль обязана совпасть —
        // иначе спекулятивный контакт решался бы по другой оси, чем реальный
        let a = box2(0.0, 0.0, 0.0, 5.0, 5.0);
        let gap = box2(10.5, 0.0, 0.0, 5.0, 5.0);
        let hit = box2(9.0, 0.0, 0.0, 5.0, 5.0);

        let speculative = obb_vs_obb_within(&a, &gap, 1.0).expect("спекулятивный контакт");
        let real = obb_vs_obb(&a, &hit).expect("контакт");

        assert!((speculative.nx - real.nx).abs() < 1e-5);
        assert!((speculative.ny - real.ny).abs() < 1e-5);
    }

    #[test]
    fn gap_wider_than_the_prediction_is_a_miss() {
        let a = box2(0.0, 0.0, 0.0, 5.0, 5.0);
        let b = box2(12.0, 0.0, 0.0, 5.0, 5.0);

        assert!(obb_vs_obb_within(&a, &b, 1.0).is_none());
    }

    #[test]
    fn zero_prediction_repeats_the_plain_overlap_test() {
        let a = box2(0.0, 0.0, 0.0, 5.0, 5.0);

        // касание вплотную — промах в обоих вариантах
        assert!(obb_vs_obb_within(&a, &box2(10.0, 0.0, 0.0, 5.0, 5.0), 0.0).is_none());

        let b = box2(8.0, 0.0, 0.0, 5.0, 5.0);
        let plain = obb_vs_obb(&a, &b).expect("контакт");
        let within = obb_vs_obb_within(&a, &b, 0.0).expect("контакт");

        assert_eq!(plain.nx, within.nx);
        assert_eq!(plain.ny, within.ny);
        assert_eq!(plain.depth, within.depth);
        assert_eq!(plain.cx, within.cx);
        assert_eq!(plain.cy, within.cy);
    }

    #[test]
    fn manifold_of_a_flush_face_contact_has_two_points() {
        let a = box2(0.0, 0.0, 0.0, 5.0, 5.0);
        let b = box2(8.0, 0.0, 0.0, 5.0, 5.0);
        let manifold = obb_manifold(&a, &b, 0.0).expect("манифольд");
        let points = manifold.as_slice();

        assert_eq!(points.len(), 2);
        // грани совпадают целиком — точки на концах общей грани, плеча нет
        assert!((points[0].cy + points[1].cy).abs() < 1e-4);
        assert!(points.iter().all(|p| (p.depth - 2.0).abs() < 1e-4));
        assert!(points.iter().all(|p| (p.nx - 1.0).abs() < 1e-5));
    }

    #[test]
    fn manifold_is_clipped_to_the_overlapping_part_of_the_faces() {
        // стена вдвое ниже корпуса и сдвинута вниз: Rapier ведёт манифольд
        // только по перекрытию граней, и обе точки лежат НИЖЕ центра
        let a = box2(0.0, 0.0, 0.0, 5.0, 5.0);
        let b = box2(8.0, 5.0, 0.0, 5.0, 2.5);
        let manifold = obb_manifold(&a, &b, 0.0).expect("манифольд");
        let points = manifold.as_slice();

        assert_eq!(points.len(), 2);
        assert!(points.iter().all(|p| p.cy > 0.0), "{points:?}");
        // середина грани корпуса (0) в манифольд не попадает — она вне стены
        let middle = (points[0].cy + points[1].cy) / 2.0;

        assert!(middle > 2.0, "плечо разворота: {middle}");
    }

    #[test]
    fn manifold_of_a_corner_contact_keeps_one_point() {
        let a = box2(0.0, 0.0, core::f32::consts::FRAC_PI_4, 5.0, 5.0);
        let b = box2(9.0, 0.0, 0.0, 3.0, 3.0);
        let manifold = obb_manifold(&a, &b, 0.0).expect("манифольд");

        assert_eq!(manifold.as_slice().len(), 1);

        let point = manifold.as_slice()[0];
        let distance = point.cx.hypot(point.cy);

        assert!((distance - 5.0 * core::f32::consts::SQRT_2).abs() < 1e-3);
    }

    #[test]
    fn manifold_and_single_point_agree_on_the_axis() {
        let a = box2(0.0, 0.0, 0.3, 5.0, 3.0);
        let b = box2(0.0, -7.0, 0.0, 5.0, 5.0);
        let single = obb_vs_obb(&a, &b).expect("контакт");
        let manifold = obb_manifold(&a, &b, 0.0).expect("манифольд");

        assert!((manifold.deepest().nx - single.nx).abs() < 1e-5);
        assert!((manifold.deepest().ny - single.ny).abs() < 1e-5);
        assert!((manifold.deepest().depth - single.depth).abs() < 1e-4);
    }

    #[test]
    fn block_collection_sees_the_wall_through_the_prediction_gap() {
        let block = StaticBlock {
            x: 345.6,
            y: 403.2,
            half_w: 268.8,
            half_h: 6.4,
        };
        // корпус ещё не дошёл до западного торца блока: зазор по x 0.19
        let obb = box2(72.61, 395.07, 0.0, 4.0, 3.0);

        assert!(collect_block_contacts(&obb, &[block], 0.0).is_empty());

        let hits = collect_block_contacts(&obb, &[block], 6.0);

        assert_eq!(hits.len(), 1);

        let deepest = hits[0].manifold.deepest();

        assert!(deepest.depth < 0.0);
        assert!((deepest.nx - 1.0).abs() < 1e-3);
        // корпус стоит грань-в-грань с торцом блока: две точки, обе НИЖЕ
        // центра корпуса — плечо разворота, которое видит Rapier
        assert_eq!(hits[0].manifold.as_slice().len(), 2);
        assert!(hits[0].manifold.as_slice().iter().all(|p| p.cy > obb.y));
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
