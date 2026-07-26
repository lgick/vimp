use indexmap::IndexMap;
use rapier2d::prelude::*;
use serde::{Deserialize, Serialize};

use crate::config::FieldValue;
use crate::physics::{deg_to_rad, encode_map_object, round2};

// параметры поверхности по умолчанию (дефолты planck/Box2D,
// с которыми сбалансировано ощущение управления)
const DEFAULT_FRICTION: f32 = 0.2;
const DEFAULT_RESTITUTION: f32 = 0.0;

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
    pub fn dynamic_map_data(&self, world: &PhysicsWorld) -> Vec<(u8, Vec<FieldValue>)> {
        self.dynamic_bodies
            .iter()
            .enumerate()
            .filter_map(|(index, &handle)| {
                world.bodies.get(handle).map(|body| {
                    let pos = body.translation();

                    (
                        index as u8,
                        vec![
                            FieldValue::F32(round2(pos.x)),
                            FieldValue::F32(round2(pos.y)),
                            FieldValue::F32(round2(body.rotation().angle())),
                        ],
                    )
                })
            })
            .collect()
    }
}
