# 05 — The Rust WASM core

One crate, one `.wasm`, two exported classes: `GameCore` (authoritative, runs
in the host Worker) and `ClientCore` (per-player, runs on the main thread).
The engine crate `vimp-engine-core` provides the physics world, the map
loader, navigation/spatial helpers, the deterministic RNG, the snapshot codec,
the interpolator and the ABI macros. You implement three traits.

## Crate setup

`core/Cargo.toml`:

```toml
[package]
name = "my-game-core"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
vimp-engine-core = "0.2"
rapier2d = { workspace = true }        # features: enhanced-determinism, serde-serialize
serde = { workspace = true }
serde_json = { workspace = true }
wasm-bindgen = "0.2"
```

Workspace root `Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = ["core"]

[workspace.dependencies]
rapier2d = { version = "0.34", features = ["enhanced-determinism", "serde-serialize"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
opt-level = 3
lto = true
```

`enhanced-determinism` is mandatory: the host and every client must reach
bit-identical results from the same inputs, or prediction diverges.

## The three traits

### `GameDef` — the binding

```rust
pub trait GameDef: Sized {
    type Config: serde::de::DeserializeOwned;   // the `game` half of init JSON
    type Sim: GameSim<Self>;
}
```

### `GameSim<G>` — the authoritative simulation

The engine's `EngineSim<G>` owns the physics world, map, navigation, spatial
grid, RNG and the destroy queue; your `GameSim` owns actors, weapons and
snapshot blocks. Exact method set:

```rust
pub trait GameSim<G: GameDef>: Sized {
    fn new(cfg: &G::Config, engine_cfg: &EngineConfig) -> Self;

    fn spawn_actor(&mut self, world: &mut PhysicsWorld, events: &mut Vec<CoreEvent>,
                   game_id: u32, model_name: &str, team_id: u8,
                   x: f32, y: f32, angle_deg: f32) -> Result<(), String>;
    fn remove_actor(&mut self, world: &mut PhysicsWorld, game_id: u32);
    fn reset_actor(&mut self, world: &mut PhysicsWorld, game_id: u32, team_id: u8,
                   x: f32, y: f32, angle_deg: f32);
    fn reset_all_vitals(&mut self, events: &mut Vec<CoreEvent>);
    fn spawn_scripted_actor(&mut self, world: &mut PhysicsWorld, rng: &mut Rng,
                            events: &mut Vec<CoreEvent>, game_id: u32,
                            model_name: &str, team_id: u8,
                            x: f32, y: f32, angle_deg: f32) -> Result<(), String>;
    fn remove_scripted_actor(&mut self, world: &mut PhysicsWorld, game_id: u32);

    fn apply_input(&mut self, game_id: u32, seq: u32, action: &str, key_name: &str);
    fn last_input_seq(&self, game_id: u32) -> u32;
    fn is_alive(&self, game_id: u32) -> bool;
    fn actor_position(&self, world: &PhysicsWorld, game_id: u32) -> Option<[f32; 2]>;
    fn prediction_state(&self, world: &PhysicsWorld, game_id: u32)
        -> Option<([f32; PLAYER_STATE_LEN], bool)>;
    fn alive_players_flat(&self, world: &PhysicsWorld) -> Vec<f32>;
    fn players_json(&self) -> String;

    fn on_fixed_step(&mut self, ctx: &mut SimCtx, dt: f32);
    fn on_contacts(&mut self, ctx: &mut SimCtx, pairs: &[(ColliderHandle, ColliderHandle)]);
    fn on_before_destroy(&mut self, world: &PhysicsWorld, handle: RigidBodyHandle);
    fn on_ai_tick(&mut self, ctx: &mut SimCtx, dt: f32);

    fn refresh_cached(&mut self, world: &PhysicsWorld);
    fn build_snapshot_blocks(&mut self) -> (Vec<(String, Block)>, bool);

    fn remove_players_and_shots(&mut self, world: &mut PhysicsWorld) -> Vec<String>;
    fn clear(&mut self);

    fn serialize(&self) -> serde_json::Value;
    fn deserialize(&mut self, value: serde_json::Value) -> Result<(), String>;
    fn rebuild_spatial_grid(&self, world: &PhysicsWorld, spatial: &mut SpatialGrid);
}
```

`build_snapshot_blocks` returns `(blocks, had_events)` — the boolean decides
whether the frame goes over the reliable channel.

### `SimCtx<'a>` — what tick callbacks get

```rust
pub struct SimCtx<'a> {
    pub world: &'a mut PhysicsWorld,
    pub cfg: &'a EngineConfig,
    pub map: &'a Option<GameMap>,
    pub nav: &'a Option<NavigationSystem>,
    pub spatial: &'a mut SpatialGrid,
    pub rng: &'a mut Rng,
    pub events: &'a mut Vec<CoreEvent>,
    pub bodies_to_destroy: &'a mut Vec<RigidBodyHandle>,
}
```

It is **not** generic over `G` and carries no game config — your `GameSim`
keeps whatever it needs from `new`.

### `GameClientDef` — the client half

```rust
pub trait GameClientDef: Sized {
    type Config: serde::de::DeserializeOwned;

    fn new(cfg: &Self::Config, engine_cfg: &EngineClientConfig) -> Self;

    fn on_server_state(&mut self, state: [f32; PLAYER_STATE_LEN], centering: bool,
                       server_time: f64, offset: f64, local_now: f64);
    fn set_server_offset(&mut self, offset: Option<f64>);
    fn update(&mut self, local_now: f64);
    fn track_frame(&mut self, my_game_id: Option<u32>, frame: &FrameData);
    fn filter_frame_game(&mut self, game: &mut Map<String, Value>,
                         my_game_id: Option<u32>, local_now: f64);
    fn update_world(&mut self, snapshot: &DecodedSnapshot);
    fn update_world_interpolated(&mut self, game: &InterpolatedGame);
    fn render_overlay(&self, my_game_id: Option<u32>) -> Option<RenderOverlay>;

    // --- both have a default of `None`; implementing them upgrades the
    // --- prediction-drift detector from level 0 to level 1 (see 13-debugging.md)
    fn predicted_state(&self) -> Option<[f32; PLAYER_STATE_LEN]> { None }
    fn replayed_inputs(&self) -> Option<(f64, f64, usize)> { None }

    fn apply_input(&mut self, action: &str, key_name: &str, local_now: f64);
    fn set_model(&mut self, model_name: &str);
    fn set_active(&mut self, active: bool);
    fn set_map(&mut self, map_json: &str) -> Result<(), String>;
    fn sync_panel(&mut self, items: &[String]);
    fn reset(&mut self);
    fn cycle_item(&mut self, back: bool);
    fn try_action(&mut self, my_game_id: Option<u32>, local_now: f64) -> Option<String>;
}
```

Every method above is required except the two with bodies. `predicted_state`
returns your predicted actor in the player-block layout; the engine samples it
immediately before `on_server_state`, i.e. before the authoritative state
overwrites the prediction, and compares component by component.
`replayed_inputs` reports the local-time window the last reconciliation
replayed. Leave both at `None` and drift detection falls back to comparing the
predicted overlay's camera with the frame's x/y (level 0) — enough to notice
divergence, not enough to say which component drifted. Invariant 9
(`predictionDrift`) works either way; see `13-debugging.md`.

## The ABI macros

```rust
use vimp_engine_core::{export_game_core_abi, export_client_core_abi};

#[wasm_bindgen]
pub struct GameCore {
    state: EngineSim<MyGame>,                    // required field name + type
    packer: SnapshotPacker,                      // required field name + type
}

#[wasm_bindgen]
impl GameCore {
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str) -> Result<GameCore, JsError> { … }   // hand-written
}

export_game_core_abi!(GameCore);
```

The macro requires the struct to have **exactly** the fields `state:
EngineSim<G>` and `packer: SnapshotPacker`, and it must be expanded in a
module where `wasm-bindgen` is a dependency. `new` is never generated — you
write it (it parses the init JSON).

`ClientCore` is analogous with `state: ClientState<MyClientGame>` and
`export_client_core_abi!(ClientCore);`.

### `GameCore` — generated method list

`load_map`, `map_info`, `clear`, `spawn_actor(id, model, teamId, x, y,
angleDeg)`, `remove_actor`, `reset_actor`, `reset_all_vitals`,
`spawn_scripted_actor`, `remove_scripted_actor`, `remove_players_and_shots`
(→ JSON), `apply_input(id, seq, action, keyName)`, `last_input_seq`,
`is_alive`, `position_of`, `players_data`, `alive_players` (→ `f32[]`),
`step(dt)`, `take_events` (→ JSON), `pack_body`, `body_has_events`,
`pack_frame(serverTime, seq, hasCamera, camX, camY, forceReset, shake,
playerId)`, `frame_ptr`, `frame_bytes`, `debug_json` (→ JSON world dump),
`serialize_state`, `deserialize_state`.

`pack_frame` with `playerId < 0` produces a frame without a player block
(spectator view). `frame_ptr` + the WASM memory let JS read the frame
zero-copy.

### `ClientCore` — generated method list

`push_frame(bytes, localNow) -> bool`, `my_game_id() -> i32` (`-1` until the
first player block), `offset()`, `sample(localNow) -> usize` (hot buffer
length), `hot_ptr()`, `hot_values()`, `take_frames()` (→ JSON),
`apply_input(action, keyName, localNow)`, `set_active`, `set_map`, `reset`,
`debug_json` (→ JSON client dump), `take_divergence` (→ JSON drift records),
`decode_frame`.

`debug_json` and `take_divergence` are generated for you — they are what the
headless runner reads for world dumps and prediction drift (`13-debugging.md`).
Do not hand-write them.

**Game-specific client methods are hand-written**, not generated:
`set_model`, `sync_panel`, `try_fire` / `try_action`, `cycle_weapon` /
`cycle_item`. They are called only from `ClientPlugin.hooks` — the engine
never calls them.

## Init JSON

Both cores receive one JSON string of shape `{ engine, game }`.

**Host (`GameCore`)** — assembled by the engine from `gameConfig`:

```json
{
  "engine": {
    "timeStep": 0.008333333,          // SECONDS
    "mapScale": 0.3,
    "mapSetId": "c1",
    "snapshot": { "version": 3, "port": 5, "keys": { … } },
    "seed": null
  },
  "game": {
    "friendlyFire": false,
    "models":  { … },                 // gameConfig.parts.models
    "weapons": { … },                 // gameConfig.parts.weapons
    "playerKeys": { … },
    "panel": { … }                    // gameConfig.panel.fields
  }
}
```

**Client (`ClientCore`)** — assembled from `CONFIG_DATA`:

```json
{
  "engine": {
    "timeStepMs": 8.333333,           // MILLISECONDS
    "snapshot": { "version": 3, "port": 5, "keys": { … } },
    "interpolation": { "delay": 100, "maxFrameAge": 1000 }
  },
  "game": { "playerKeys": { … }, "models": { … }, "weapons": { … }, "seed": null }
}
```

> The unit difference is deliberate and encoded in the field names:
> `timeStep` is seconds on the host, `timeStepMs` is milliseconds on the
> client. Your `Config` structs must match.

## Core events

`take_events()` returns a JSON array of tagged objects:

| Event | Payload | Consumed by |
| --- | --- | --- |
| `panelSet` | `{ id, field, value }` | engine `Panel.updateUser` |
| `panelActive` | `{ id, field }` | engine `Panel.setActiveWeapon` |
| `death` | `{ victim, killer }` | engine `RoundManager.reportKill` (scoring, rank) |
| `shake` | `{ id, intensity, duration }` | per-user camera shake in the frame |
| `custom` | `{ data }` | routed to `HostPlugin.onCoreEvent` — the engine does not interpret it |

`field` is a **key of your panel schema** (`"health"`, a weapon name, …). Ids
are stringified by the JS adapter before reaching plugin code.

## Body tags

Rigid bodies carry a `u128` user-data tag. **Low byte `1` is reserved by the
engine** (`MAP_OBJECT_TAG`); a game numbers its own kinds from `2` upward and
packs extra data into the higher bits.

```rust
// example layout used by tanks
// byte 0      : kind (2 = Player, 3 = Shot)
// bits 8..    : game_id
// bits 40..   : owner / weapon index
// bits 48.., 80..: game-specific
```

## Input keys — semantics are yours

`apply_input(game_id, seq, action, key_name)` receives the raw wire events
(`action` is `"down"` or `"up"`). The `playerKeys` table (action name → bit,
`type: 0 | 1`) arrives in the `game` half of the init JSON, and the engine
**never interprets it** — mapping names to bits and honouring `type` is your
core's job. The reference pattern (tanks):

- a `current_keys` bitmask for held keys — `down` sets the bit, `up` clears
  it;
- a one-shot mask built from the `type: 1` keys — for those, `down` sets a
  pending bit that the next fixed step consumes exactly once; `up` is
  ignored.

The client predictor must apply the same rule in its own `apply_input`, or
prediction diverges on every trigger press.

## `PLAYER_STATE_LEN = 8` — the prediction budget

The per-user player block carries exactly **eight `f32`s** describing the
local actor's authoritative state, plus a `centering` flag. That is the whole
reconciliation channel: whatever the client must predict has to fit in eight
floats (tanks uses `[x, y, angle, vx, vy, angvel, gunRotation,
engineThrottle]`, with `centeringGun` as the flag).

If your design needs more predicted state, either derive it client-side from
those eight values, or do not predict it.

## Determinism

- All randomness goes through the engine `Rng` (SplitMix64) seeded from the
  init JSON. **Never** use `rand`, `Math.random`, or time-based seeding.
- The physics uses `enhanced-determinism`.
- **Round the values you pack yourself.** The packer writes raw `f32`s, but
  the decoder restores every snapshot field through `round2` (2 decimals) —
  so anything you pack unrounded comes back to the client as a *different*
  number than the one your host still holds. Call
  `vimp_engine_core::physics::round2` on the coordinates, angles and other
  floats you put into `build_snapshot_blocks` (the engine does exactly that
  for its own dynamic-map-object block). The per-user player block is the
  one exception: it is packed and decoded raw, because prediction needs the
  precision.
- Keep every gameplay-relevant computation in Rust. JS-side arithmetic on
  snapshot values will not match the core.

## The prediction pattern

1. The client applies input locally through `ClientCore.apply_input` and steps
   its own copy of the movement model each render tick (`update`).
2. Every frame carrying a player block calls `on_server_state(...)`: the
   client rewinds to the authoritative state and replays inputs newer than
   `input_seq`.
3. `render_overlay()` returns the predicted tail appended to the hot buffer;
   returning `None` (no local actor / no model yet) makes the engine fall back
   to the interpolated camera and clears the `PREDICTED` flag.

**Motion parity is a hard requirement**: the client's predicted movement code
and the host's `on_fixed_step` movement code must produce identical results.
Keep the movement math in one shared module used by both halves, and add a
`cargo` parity test that steps both and asserts equality. Re-run it after any
movement change.

## Shot prediction and duplicate suppression

A locally predicted shot would otherwise be drawn twice — once immediately,
once when the authoritative event arrives.

The pattern:

1. `try_action` spawns a local effect with an id of the form `L<n>` and
   returns its spawn JSON to `ClientPlugin.hooks.onLocalAction`, which feeds
   it to the renderer.
2. The **last field of every weapon event block is the author's game id**.
3. `filter_frame_game` inspects incoming event rows, and when the author id
   equals the local player, drops the row (or replaces the local id) so the
   effect is not duplicated.
4. A `null` row in an indexed block is the removal marker for an entity.

## Save / restore

`serialize_state()` / `deserialize_state(bytes)` exist for tooling and tests.
They are **not** used by the host handoff — a migrating room re-creates the
map and respawns everyone.
