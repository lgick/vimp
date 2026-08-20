use indexmap::IndexMap;
use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use crate::config::FieldValue;
use crate::physics::{deg_to_rad, encode_map_object, round2};

// параметры поверхности по умолчанию (дефолты planck/Box2D,
// с которыми сбалансировано ощущение управления). Публичные: клиентская
// реплика контактов (client::rigid_body::MAP_SURFACE) обязана брать те же
// значения, иначе предсказание тихо разъедется с хостом
pub const DEFAULT_FRICTION: f32 = 0.2;
pub const DEFAULT_RESTITUTION: f32 = 0.0;

// порог «тело покоится» для хвоста скоростей в снапшоте: ниже него
// скорость не стоит 12 байт на строку (Map.js REST_VELOCITY_EPSILON)
const REST_VELOCITY_EPSILON: f32 = 0.01;

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
    #[serde(default)]
    pub respawns: IndexMap<String, Vec<[f32; 3]>>,
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
    /// Респауны по командам (масштабированные) — [x, y, angle°].
    pub respawns: IndexMap<String, Vec<[f32; 3]>>,
    static_bodies: Vec<RigidBodyHandle>,
    dynamic_bodies: Vec<RigidBodyHandle>,
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
                            .map(|[x, y, angle]| [x * scale, y * scale, *angle])
                            .collect(),
                    )
                })
                .collect(),
            static_bodies: Vec::new(),
            dynamic_bodies: Vec::new(),
        };

        map.create_static(world);
        map.create_dynamic(world, &cfg.physics_dynamic, scale);

        map
    }

    /// Жадный поиск прямоугольного блока стен (Map.searchStaticBlock).
    /// Обработанные ячейки затираются в рабочей копии сетки.
    fn search_static_block(&self, work: &mut [Vec<Option<i32>>], y0: usize, x0: usize) -> (f32, f32) {
        let mut x = x0;
        let mut w_counter = 0;
        let mut h_counter = 1;

        // ширина блока
        while x < work[y0].len()
            && work[y0][x].is_some_and(|tile| self.physics_static.contains(&tile))
        {
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
                if x < work[y].len()
                    && work[y][x].is_some_and(|tile| self.physics_static.contains(&tile))
                {
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

        (w_counter as f32 * self.step, h_counter as f32 * self.step)
    }

    /// Статические стены (Map.createStatic).
    fn create_static(&mut self, world: &mut PhysicsWorld) {
        let mut work: Vec<Vec<Option<i32>>> = self
            .grid
            .iter()
            .map(|row| row.iter().map(|&tile| Some(tile)).collect())
            .collect();

        for y in 0..work.len() {
            for x in 0..work[y].len() {
                let is_static = work[y][x].is_some_and(|tile| self.physics_static.contains(&tile));

                if is_static {
                    let (width, height) = self.search_static_block(&mut work, y, x);
                    let pos_x = x as f32 * self.step + width / 2.0;
                    let pos_y = y as f32 * self.step + height / 2.0;

                    let body = world
                        .insert_body(RigidBodyBuilder::fixed().translation(Vector::new(pos_x, pos_y)));

                    world.insert_collider(
                        ColliderBuilder::cuboid(width / 2.0, height / 2.0)
                            .friction(DEFAULT_FRICTION)
                            .restitution(DEFAULT_RESTITUTION),
                        Some(body),
                    );

                    self.static_bodies.push(body);
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
                    .restitution(DEFAULT_RESTITUTION),
                Some(body),
            );

            self.dynamic_bodies.push(body);
        }
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
    }

    /// Краткие данные динамических элементов (Map.getDynamicMapData):
    /// индекс → [x, y, angle] (как поля строки блока), значения скруглены
    /// до 2 знаков.
    ///
    /// При `with_velocities` движущееся тело отдаёт ещё и хвост
    /// [vx, vy, angvel] (кадр v4, `optionalFrom` в схеме блока): клиент
    /// предсказывает динамику карты рядом со своим танком, а оценка скорости
    /// конечной разностью между кадрами 30 Гц сильнее всего врёт именно в
    /// момент удара. Покоящееся тело хвост не шлёт.
    pub fn dynamic_map_data(
        &self,
        world: &PhysicsWorld,
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
