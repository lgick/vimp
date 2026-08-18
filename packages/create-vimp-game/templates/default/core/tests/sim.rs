// Integration tests of the simulation: they drive the real `GameCore` ABI —
// the very methods the host Worker calls — instead of the internals, so a
// change that breaks the host is caught here and not in the browser.

use vimp_engine_core::events::CoreEvent;
use {{CRATE_SNAKE}}::GameCore;

const DT: f32 = 1.0 / 120.0;

/// Core config — a mirror of src/config/game.js + src/data/. The same flat
/// object is put into both halves of `{engine, game}`: each side ignores the
/// fields that are not its own.
fn config_json() -> String {
    let flat = flat_config_json();

    serde_json::json!({ "engine": flat.clone(), "game": flat }).to_string()
}

fn flat_config_json() -> serde_json::Value {
    serde_json::json!({
        "timeStep": DT,
        "friendlyFire": false,
        "mapScale": 1,
        "mapSetId": "m1",
        "models": {
            "a1": {
                "currentWeapon": "w1",
                "size": 32.0,
                "maxSpeed": 200.0,
                "maxReverseSpeed": 100.0,
                "acceleration": 400.0,
                "braking": 600.0,
                "turnSpeed": 3.0,
                "fixture": { "density": 1.0, "friction": 0.2, "restitution": 0.0 }
            }
        },
        "weapons": {
            "w1": {
                "damage": 25.0,
                "range": 600.0,
                "fireRate": 0.05,
                "spread": 0,
                "consumption": 1,
                "cameraShake": { "intensity": 12, "duration": 150 }
            }
        },
        "playerKeys": {
            "forward": { "key": 1 },
            "back": { "key": 2 },
            "left": { "key": 4 },
            "right": { "key": 8 },
            "fire": { "key": 16, "type": 1 }
        },
        "panel": {
            "health": { "value": 100 },
            "w1": { "value": 30 }
        },
        "snapshot": {
            "version": 3,
            "port": 5,
            "keys": {
                "a1": { "id": 1, "kind": "indexed8", "class": "hot", "fields": [
                    { "name": "x", "ty": "f32", "interp": "lerp" },
                    { "name": "y", "ty": "f32", "interp": "lerp" },
                    { "name": "angle", "ty": "f32", "interp": "lerpAngle" },
                    { "name": "vx", "ty": "f32", "interp": "lerp" },
                    { "name": "vy", "ty": "f32", "interp": "lerp" },
                    { "name": "health", "ty": "u8" },
                    { "name": "team", "ty": "u8" }
                ] },
                "w1": { "id": 2, "kind": "list16", "class": "event", "fields": [
                    { "name": "startX", "ty": "f32" },
                    { "name": "startY", "ty": "f32" },
                    { "name": "endX", "ty": "f32" },
                    { "name": "endY", "ty": "f32" },
                    { "name": "wasHit", "ty": "u8" },
                    { "name": "shooterId", "ty": "u8" }
                ] },
                "m1": { "id": 3, "kind": "indexedNoNull8", "class": "hot", "fields": [
                    { "name": "x", "ty": "f32", "interp": "lerp" },
                    { "name": "y", "ty": "f32", "interp": "lerp" },
                    { "name": "angle", "ty": "f32", "interp": "lerpAngle" }
                ] }
            }
        },
        "seed": 42
    })
}

/// A walled 20x20 room, cell 32 — the shape of src/data/maps/arena.js.
fn map_json() -> String {
    let mut grid: Vec<Vec<i32>> = vec![vec![0; 20]; 20];

    for (y, row) in grid.iter_mut().enumerate() {
        for (x, cell) in row.iter_mut().enumerate() {
            if y == 0 || y == 19 || x == 0 || x == 19 {
                *cell = 1;
            }
        }
    }

    serde_json::json!({
        "setId": "m1",
        "scale": 1,
        "step": 32,
        "map": grid,
        "physicsStatic": [1],
        "physicsDynamic": [],
        "respawns": {
            "team1": [[100.0, 100.0, 0.0], [100.0, 200.0, 0.0]],
            "team2": [[500.0, 100.0, 180.0], [500.0, 200.0, 180.0]]
        }
    })
    .to_string()
}

fn make_core() -> GameCore {
    GameCore::new(&config_json()).unwrap()
}

fn steps(core: &mut GameCore, count: usize) {
    for _ in 0..count {
        core.step(DT);
    }
}

fn events(core: &mut GameCore) -> Vec<CoreEvent> {
    serde_json::from_str(&core.take_events()).unwrap()
}

/// One broadcast frame as bytes — the unit the determinism tests compare.
fn frame(core: &mut GameCore, seq: u32) -> Vec<u8> {
    core.pack_body().unwrap();
    core.pack_frame(1000.0 + seq as f64, seq, false, 0.0, 0.0, false, None, -1);

    core.frame_bytes()
}

/// Kills `victim` with shots from `shooter` (both must already exist and see
/// each other).
fn kill(core: &mut GameCore, shooter: u32, victim: u32) {
    for _ in 0..8 {
        if !core.is_alive(victim) {
            break;
        }

        core.apply_input(shooter, 1, "down", "fire");
        steps(core, 8);
    }
}

#[test]
fn spawns_actors_at_the_respawns_of_their_team() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();

    let info: serde_json::Value = serde_json::from_str(&core.map_info()).unwrap();
    let team1 = info["respawns"]["team1"].as_array().unwrap();
    let team2 = info["respawns"]["team2"].as_array().unwrap();

    assert_eq!(team1.len(), 2);
    assert_eq!(team2.len(), 2);

    let spawn = |core: &mut GameCore, id: u32, team: u8, point: &serde_json::Value| {
        let x = point[0].as_f64().unwrap() as f32;
        let y = point[1].as_f64().unwrap() as f32;
        let angle = point[2].as_f64().unwrap() as f32;

        core.spawn_actor(id, "a1", team, x, y, angle).unwrap();
    };

    spawn(&mut core, 1, 1, &team1[0]);
    spawn(&mut core, 2, 2, &team2[0]);

    assert_eq!(core.position_of(1), vec![100.0, 100.0]);
    assert_eq!(core.position_of(2), vec![500.0, 100.0]);

    // [id, team, x, y] per alive actor
    assert_eq!(core.alive_players(), vec![1.0, 1.0, 100.0, 100.0, 2.0, 2.0, 500.0, 100.0]);
}

#[test]
fn input_drives_the_actor_and_a_wall_stops_it() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    // facing 180 degrees — towards the left wall (inner face at x = 32)
    core.spawn_actor(1, "a1", 1, 100.0, 100.0, 180.0).unwrap();
    core.apply_input(1, 7, "down", "forward");

    steps(&mut core, 60);

    let moved = core.position_of(1);

    assert!(moved[0] < 90.0, "the actor should drive off, x = {}", moved[0]);
    assert_eq!(core.last_input_seq(1), 7);

    steps(&mut core, 300);

    let stopped = core.position_of(1);

    assert!(
        stopped[0] > 32.0,
        "the wall should stop the actor, x = {}",
        stopped[0]
    );
}

#[test]
fn hitscan_takes_health_and_death_removes_the_actor_from_the_canvas() {
    let mut core = make_core();

    // the shooter faces the target point blank
    core.spawn_actor(1, "a1", 1, 0.0, 0.0, 0.0).unwrap();
    core.spawn_actor(2, "a1", 2, 60.0, 0.0, 0.0).unwrap();

    // warm-up: the broad phase learns about the new bodies on the first step
    core.step(DT);
    core.take_events();

    core.apply_input(1, 1, "down", "fire");
    steps(&mut core, 8);

    let health = events(&mut core)
        .into_iter()
        .find_map(|event| match event {
            CoreEvent::PanelSet { id: 2, field, value } if field == "health" => Some(value),
            _ => None,
        })
        .expect("a hit must report the new health of the victim");

    assert_eq!(health, 75.0);
    assert!(core.is_alive(2));

    kill(&mut core, 1, 2);

    assert!(!core.is_alive(2));
    assert!(
        events(&mut core)
            .iter()
            .any(|event| matches!(event, CoreEvent::Death { victim: 2, killer: 1 })),
        "death must report the kill to the engine scoring"
    );

    // the dead actor leaves alive_players and the frame carries its removal
    assert!(!core.alive_players().contains(&2.0));

    frame(&mut core, 1);

    assert!(
        core.body_has_events(),
        "a removal row is an event row: the frame must go over the reliable channel"
    );
}

#[test]
fn friendly_fire_off_protects_the_own_team() {
    let mut core = make_core();

    core.spawn_actor(1, "a1", 1, 0.0, 0.0, 0.0).unwrap();
    core.spawn_actor(2, "a1", 1, 60.0, 0.0, 0.0).unwrap();

    core.step(DT);
    core.take_events();

    for _ in 0..4 {
        core.apply_input(1, 1, "down", "fire");
        steps(&mut core, 8);
    }

    assert!(core.is_alive(2));
    assert!(
        !events(&mut core).iter().any(|event| matches!(
            event,
            CoreEvent::PanelSet { id: 2, field, .. } if field == "health"
        )),
        "a team mate must take no damage while friendlyFire is off"
    );
}

#[test]
fn wiping_a_team_leaves_only_the_other_one_alive() {
    let mut core = make_core();

    core.spawn_actor(1, "a1", 1, 0.0, 0.0, 0.0).unwrap();
    core.spawn_actor(2, "a1", 2, 60.0, 0.0, 0.0).unwrap();
    core.spawn_actor(3, "a1", 2, 120.0, 0.0, 0.0).unwrap();

    core.step(DT);
    core.take_events();

    kill(&mut core, 1, 2);
    kill(&mut core, 1, 3);

    assert!(core.is_alive(1));
    assert!(!core.is_alive(2));
    assert!(!core.is_alive(3));

    // [id, team, x, y] — only the surviving team is left for the round meta
    let alive = core.alive_players();

    assert_eq!(alive.len(), 4);
    assert_eq!(alive[0], 1.0);
    assert_eq!(alive[1], 1.0);
}

#[test]
fn serialize_deserialize_round_trips_the_frame() {
    let mut core = make_core();

    core.load_map(&map_json()).unwrap();
    core.spawn_actor(1, "a1", 1, 100.0, 100.0, 0.0).unwrap();
    core.apply_input(1, 1, "down", "forward");
    steps(&mut core, 30);

    let dump = core.serialize_state().unwrap();
    let mut restored = make_core();

    restored.deserialize_state(&dump).unwrap();

    // both continue from the dump: the frames must stay bit-identical
    for seq in 0..10 {
        steps(&mut core, 6);
        steps(&mut restored, 6);

        assert_eq!(frame(&mut core, seq), frame(&mut restored, seq));
    }
}

#[test]
fn one_seed_gives_one_stream_of_frames() {
    let run = || {
        let mut core = make_core();

        core.load_map(&map_json()).unwrap();
        core.spawn_scripted_actor(1, "a1", 1, 100.0, 100.0, 0.0).unwrap();
        core.spawn_scripted_actor(2, "a1", 2, 500.0, 100.0, 180.0).unwrap();

        let mut frames: Vec<Vec<u8>> = Vec::new();

        for seq in 0..40 {
            steps(&mut core, 6);
            frames.push(frame(&mut core, seq));
        }

        frames
    };

    assert_eq!(run(), run());
}
