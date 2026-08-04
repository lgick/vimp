//! Курированный дамп мира для отладки (`plan/ai-debug/stage_4.md`).
//! `EngineSim::serialize_state` уже умеет дампить всё — но в сыром
//! serde-формате rapier, который нечитаем ни человеком, ни нейросетью.
//! Здесь — второй, отдельный дамп: только то, по чему диагностируют
//! «танк в стене», «снаряд без коллайдера», «бот не видит нав-граф».
//!
//! Формат — стабильный JSON (ключи в camelCase, как в остальных
//! JSON-мостах ядра). Порядок записей детерминирован (сортировка по
//! индексу дескриптора/ключу ячейки), иначе два прогона одного сценария
//! дадут разный текст и диф дампов станет бесполезным.

use rapier2d::prelude::*;
use serde_json::{Value, json};

use crate::map::GameMap;
use crate::nav::navigation::NavigationSystem;
use crate::nav::spatial::SpatialGrid;
use crate::physics::round2;
use crate::rng::Rng;

/// Полный дамп движковой половины симуляции.
#[allow(clippy::too_many_arguments)]
pub fn engine_json(
    world: &PhysicsWorld,
    map: &Option<GameMap>,
    nav: &Option<NavigationSystem>,
    spatial: &SpatialGrid,
    rng: &Rng,
    accumulator: f32,
    time_step: f32,
) -> Value {
    json!({
        "bodies": bodies_json(world),
        "colliders": colliders_json(world),
        "map": map_json(map),
        "nav": nav_json(nav),
        "spatial": spatial_json(spatial),
        "rng": { "state": rng.state().to_string() },
        "step": {
            "timeStep": time_step,
            "accumulator": accumulator,
        },
    })
}

// Тела: тег движка знает только младший байт user_data (crate::physics),
// остальное — игровая раскладка, поэтому user_data отдаётся целиком
// строкой (u128 не влезает в число JSON) — игра восстановит свой gameId.
fn bodies_json(world: &PhysicsWorld) -> Value {
    let mut rows: Vec<(u32, Value)> = world
        .rigid_bodies()
        .map(|(handle, body)| {
            let translation = body.translation();
            let linvel = body.linvel();

            (
                handle.into_raw_parts().0,
                json!({
                    "handle": handle.into_raw_parts().0,
                    "tag": (body.user_data & 0xff) as u64,
                    "userData": body.user_data.to_string(),
                    "translation": [round2(translation.x), round2(translation.y)],
                    "rotation": round2(body.rotation().angle()),
                    "linvel": [round2(linvel.x), round2(linvel.y)],
                    "angvel": round2(body.angvel()),
                    "mass": round2(body.mass()),
                    "bodyType": format!("{:?}", body.body_type()),
                    "ccd": body.is_ccd_enabled(),
                }),
            )
        })
        .collect();

    rows.sort_by_key(|(index, _)| *index);

    Value::Array(rows.into_iter().map(|(_, row)| row).collect())
}

// Коллайдеры: маски групп — в hex, потому что в конфигах игр они и
// задаются битами, а десятичное 4294901762 не сверить глазами.
fn colliders_json(world: &PhysicsWorld) -> Value {
    let mut rows: Vec<(u32, Value)> = world
        .colliders
        .iter()
        .map(|(handle, collider)| {
            let collision = collider.collision_groups();
            let solver = collider.solver_groups();
            let mut row = json!({
                "handle": handle.into_raw_parts().0,
                "isSensor": collider.is_sensor(),
                "collisionGroups": groups_hex(collision),
                "solverGroups": groups_hex(solver),
                "parent": collider.parent().map(|body| body.into_raw_parts().0),
            });

            merge(&mut row, shape_json(collider.shape()));

            (handle.into_raw_parts().0, row)
        })
        .collect();

    rows.sort_by_key(|(index, _)| *index);

    Value::Array(rows.into_iter().map(|(_, row)| row).collect())
}

// Форма коллайдера: движок раскрывает только те примитивы, из которых
// строит тела сам (cuboid статики карты, ball снарядов игр) — прочее
// остаётся именем типа, дампу этого достаточно.
fn shape_json(shape: &dyn Shape) -> Value {
    if let Some(cuboid) = shape.as_cuboid() {
        let half = cuboid.half_extents;

        return json!({
            "shape": "cuboid",
            "halfExtents": [round2(half.x), round2(half.y)],
        });
    }

    if let Some(ball) = shape.as_ball() {
        return json!({ "shape": "ball", "radius": round2(ball.radius) });
    }

    json!({ "shape": format!("{:?}", shape.shape_type()) })
}

fn map_json(map: &Option<GameMap>) -> Value {
    let Some(map) = map else {
        return Value::Null;
    };

    let rows = map.grid.len();
    let cols = map.grid.first().map(|row| row.len()).unwrap_or(0);

    json!({
        "setId": map.set_id,
        "step": map.step,
        "grid": { "rows": rows, "cols": cols },
        "physicsStatic": map.physics_static,
        "staticBodies": map.static_body_count(),
        "dynamicBodies": map.dynamic_body_count(),
        "respawns": map
            .respawns
            .iter()
            .map(|(team, points)| (team.clone(), Value::from(points.len())))
            .collect::<serde_json::Map<String, Value>>(),
    })
}

fn nav_json(nav: &Option<NavigationSystem>) -> Value {
    let Some(nav) = nav else {
        return Value::Null;
    };

    json!({
        "nodes": nav.node_count(),
        "edges": nav.edge_count(),
        "gridStep": nav.grid_step(),
    })
}

fn spatial_json(spatial: &SpatialGrid) -> Value {
    let cells = spatial.cell_counts();

    json!({
        "cellSize": spatial.cell_size(),
        "cells": cells.len(),
        "entities": cells.iter().map(|(_, _, count)| count).sum::<usize>(),
        "cellCounts": cells
            .iter()
            .map(|(cx, cy, count)| json!({ "cell": [cx, cy], "count": count }))
            .collect::<Vec<Value>>(),
    })
}

fn groups_hex(groups: InteractionGroups) -> String {
    format!(
        "0x{:08x}/0x{:08x}",
        groups.memberships.bits(),
        groups.filter.bits()
    )
}

// дописывает поля формы в объект строки коллайдера
fn merge(target: &mut Value, extra: Value) {
    let (Some(target), Some(extra)) = (target.as_object_mut(), extra.as_object()) else {
        return;
    };

    for (key, value) in extra {
        target.insert(key.clone(), value.clone());
    }
}
