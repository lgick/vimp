# Rust Engine Core (packages/engine/core)

`vimp-engine-core` is an rlib crate (`packages/engine/core/`, **no
wasm-bindgen**) providing the generic simulation framework: physics, the
fixed-step tick, snapshot framing, interpolation/predict/raycast
primitives, and nav utilities. It carries no game-specific code — no
"tank", no "bomb" — a game crate (published in the game's own repository,
e.g. `vimp-tanks-core`) depends on it, implements the `GameDef`/`GameSim`/
`GameClientDef` traits, and does the actual `#[wasm_bindgen]` wrapping
(wasm-bindgen cannot export generics, so the concrete `GameCore`/
`ClientCore` classes only exist in the game crate). The engine crate can't
import anything game-specific, so a second game adds its own crate next to
its own repo, reusing `vimp-engine-core` unchanged.

This page documents the **engine crate only** — its traits, generic
mechanisms, and build/test commands for this repository. The concrete WASM
ABI a game crate must implement is the contract in
[plugin-api.md](plugin-api.md#wasm-host-abi-v1); a game's own core
implementation is documented in that game's own repository (e.g.
`vimp-tanks`'s `docs/en/core.md`).

**The core's boundary is simulation, not meta**: chat, votes, stats, the
panel, round orchestration, the participant registry, and auth stay in JS.
Meta drives the core with commands and feeds on its events.

## Layout

```
Cargo.toml                        # workspace: packages/engine/core (only member in this repo)
packages/engine/core/             # vimp-engine-core — rlib, no wasm-bindgen
├── Cargo.toml                    # rapier2d (enhanced-determinism, serde) — no wasm-bindgen
├── src/
│   ├── lib.rs                    # pub mod declarations only
│   ├── sim.rs                    # GameDef/GameSim/SimCtx — the engine↔game trait boundary
│   ├── game.rs                   # EngineSim<G> — tick, contacts, destroy queue, handoff
│   ├── abi.rs                    # export_game_core_abi!/export_client_core_abi! — the
│   │                              #   wasm-bindgen boilerplate macros (see ABI sections below);
│   │                              #   expanded in the game crate, which supplies #[wasm_bindgen]
│   ├── map.rs                    # GameMap — static/dynamic bodies, map scaling,
│   │                              #   soft-CCD prediction on dynamics (see Map bodies)
│   ├── snapshot.rs                # SnapshotPacker + Block — packs the v5 binary frame;
│   │                              #   Block is generic by shape (Indexed8/Indexed32/
│   │                              #   List16/IndexedNoNull8), not by game entity — the
│   │                              #   engine doesn't know "tank" or "bomb", only row shape
│   ├── events.rs                  # CoreEvent — the standard event dictionary for JS meta
│   ├── config.rs                  # EngineConfig/EngineClientConfig + snapshot schema types
│   │                              #   (BlockKind is a row-shape enum, not a game-entity enum)
│   ├── physics.rs                 # map-object body tag (encode_map_object/is_map_object),
│   │                              #   rounding, angles — game body tags (e.g. player/shot)
│   │                              #   live in the game crate's own body-tag module
│   ├── rng.rs                     # deterministic PRNG (SplitMix64)
│   ├── debug.rs                   # curated world dump (debug_json) — bodies, colliders,
│   │                              #   map, nav, spatial, rng, fixed-step accumulator
│   ├── nav/                       # generic bot-adjacent utilities (no "bot" naming)
│   │   ├── navigation.rs         # nav grid + graph + line-of-sight (NavigationSystem)
│   │   ├── pathfinder.rs         # A*
│   │   └── spatial.rs            # spatial grid for target search
│   └── client/                    # generic client-side primitives + orchestration
│       ├── game.rs                # GameClientDef trait + generic ClientState<G> — the
│       │                          #   sample() pipeline, the hot buffer, frame queue;
│       │                          #   the game supplies prediction/shot-spawn via the trait
│       ├── unpack.rs              # the v5 frame decoder + JSON forms
│       ├── divergence.rs          # prediction divergence detector (ring buffer of records)
│       ├── interpolator.rs        # the snapshot buffer, seq, lerp (schema-driven)
│       ├── raycast.rs             # DDA over tiles + an OBB slab test
│       ├── collision.rs           # SAT contacts: OBB vs OBB, OBB vs the tile grid
│       └── rigid_body.rs          # sequential-impulse contact solver + map surface
```

## Build

The engine crate itself has no WASM target — it's a plain rlib exercised by
its own unit tests and by whatever game crate depends on it. From this
repository:

```bash
npm run core:test         # cargo test --workspace (this repo's only member: packages/engine/core)
```

The actual WASM build (`wasm-pack build`, web + nodejs targets) happens in
the game's own repository, since that's where the `#[wasm_bindgen]`
classes are defined — see that repo's `core.md` (e.g. `vimp-tanks`'s
`npm run core:build`).

## ABI: the macros

The wasm-bindgen boilerplate for a game's two exported classes (mechanical
1:1 delegations into the generic `EngineSim<G>`/`ClientState<G>`) is
generated by two macros in `packages/engine/core/src/abi.rs` —
`export_game_core_abi!` and `export_client_core_abi!` — the single source
of truth for the required method set, so a game crate can't silently drift
from it. A game crate calls each macro next to its own additional methods
(e.g. a fire/reload/model-switch action, or a config-dependent spawn
signature); `new` (config parsing) and non-`#[wasm_bindgen]` test
accessors stay hand-written in the game crate. The exact mandatory method
set is documented as the contract in
[plugin-api.md](plugin-api.md#wasm-host-abi-v1).

That set is **frozen** (stage 4 of `plan/plugin-forward-compat`): the export
table of an already published `.wasm` cannot grow, so neither can the
macros'. Both of them additionally emit `abi_describe()` (the core's
self-description: format version, the `vimp-engine-core` version it was
built against, the dispatch opcodes it understands) and
`dispatch(op, payload)` — the single entry point through which every future
capability arrives as an opcode rather than a symbol. Empty return means
"opcode not handled", `[0x00]` means "handled, no answer".

A game plugs into `dispatch` through `GameSim::dispatch_op` /
`dispatch_ops` (and their `GameClientDef` mirrors), both with **default
implementations** — a required trait method would stop a game crate from
compiling, which is the very breakage this design forbids. The macro expands
in the game crate, so a game that rebuilds against a newer engine gains
every opcode that engine knows for free.

## Determinism

- `rapier2d` is built with `enhanced-determinism` (bit-for-bit across
  platforms given identical input);
- all randomness (weapon spread, bot decisions, etc.) is expected to go
  through the built-in SplitMix64 PRNG seeded from the config (`seed`), no
  `Math.random` — enforced by convention in games built on this engine;
- a handoff dump is expected to restore the simulation bit-for-bit; the
  engine provides the serialize/deserialize hooks in `GameSim`, a game
  locks this in with its own `state_dump_restores_identical_simulation`
  tests;
- **round what you pack yourself**: the packer writes raw `f32`s, the decoder
  restores every snapshot field through `round2`, so an unrounded value comes
  back to the client as a different number than the one the host holds — see
  [network.md](network.md#rounding) (the player block is the one exception);
- every gameplay-relevant computation stays in Rust: JS-side arithmetic on
  snapshot values will not match the core.

## Game crate setup

A game's `core/Cargo.toml` (the crate that holds the `#[wasm_bindgen]`
classes) builds a `cdylib` and depends on the published engine crate:

```toml
[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
vimp-engine-core = "0.23"
rapier2d = { workspace = true }   # features: enhanced-determinism, serde-serialize
serde = { workspace = true }
serde_json = { workspace = true }
wasm-bindgen = "0.2"
```

`enhanced-determinism` is mandatory: the host and every client must reach
bit-identical results from the same inputs, or prediction diverges (contract
rule `A` checks it, see [debugging.md](debugging.md)). The macros require the
struct to have **exactly** the fields `state: EngineSim<G>` and
`packer: SnapshotPacker` (`ClientCore`: `state: ClientState<G>`) and must be
expanded in a module where `wasm-bindgen` is a dependency; `new` is never
generated, the game writes it (it parses the init JSON below).

## Init JSON

Both cores receive one JSON string of shape `{ engine, game }`, assembled by
`packages/engine/src/lib/coreConfig.js` (host) and `clientCoreConfig.js`
(client). The game's `Config` structs must match the `game` half.

```jsonc
// host — GameCore
{
  "engine": {
    "timeStep": 0.008333333, // SECONDS
    "mapScale": 0.3,
    "mapSetId": "c1",
    "mapFallTime": 0.35,
    "snapshot": { "version": 5, "port": 5, "keys": {} },
    "seed": null
  },
  "game": {
    "friendlyFire": false,
    "models": {}, // gameConfig.parts.models
    "weapons": {}, // gameConfig.parts.weapons
    "playerKeys": {},
    "panel": {} // gameConfig.panel.fields
    // + every key of gameConfig.coreParams, as is
  }
}

// client — ClientCore, from CONFIG_DATA
{
  "engine": {
    "timeStepMs": 8.333333, // MILLISECONDS
    "snapshot": { "version": 5, "port": 5, "keys": {} },
    "interpolation": { "delay": 100, "maxFrameAge": 1000 }
    // + "divergence" in a debug config only
  },
  "game": { "playerKeys": {}, "models": {}, "weapons": {}, "seed": null }
  // + every key of prediction.coreParams, as is
}
```

The unit difference is deliberate and encoded in the names: `timeStep` is
seconds on the host, `timeStepMs` milliseconds on the client. `coreParams` is
an opaque game dictionary the engine only delivers to `GameSim::new` /
`GameClientDef::new`; the engine's own keys win over a same-named one.

## Body tags

Rigid bodies carry a `u128` user-data tag. **Low byte `1` is reserved by the
engine** (`MAP_OBJECT_TAG`); a game numbers its own kinds from `2` upward and
packs extra data into the higher bits. A map dynamic body carries its index
above the tag byte (`encode_map_object_at(i)`, read back with
`map_object_index`) — test map bodies with `is_map_object`, never with
`user_data == MAP_OBJECT_TAG`.

## Input keys

`apply_input(game_id, seq, action, key_name)` receives the raw wire events
(`action` is `"down"` or `"up"`). The `playerKeys` table (action name → bit,
`type: 0 | 1`) arrives in the `game` half of the init JSON and the engine
**never interprets it** — mapping names to bits and honouring `type` is the
core's job. The reference pattern: a `current_keys` bitmask for held keys
(`down` sets the bit, `up` clears it) plus a one-shot mask for the `type: 1`
keys (`down` sets a pending bit the next fixed step consumes exactly once,
`up` is ignored). The client predictor must apply the same rule in its own
`apply_input`, or prediction diverges on every trigger press.

`apply_aim(game_id, seq, x, y, flags)` is the analogue for the pointer
channel: a **world** point plus a bit mask (bit 0 «pressed», bit 1 «double
tap»). Both trait methods default to an empty body; a core that implements
the pointer must feed the target into the SAME turn function the keys use
(and into the predictor's input history), or the two halves curve apart.

## `PLAYER_STATE_LEN = 8` — the prediction budget

The per-user player block carries exactly **eight `f32`s** describing the
local actor's authoritative state plus a `centering` flag
([network.md](network.md#binary-snapshot-frame-port-5)). That is the whole
reconciliation channel: whatever the client must predict has to fit in eight
floats (tanks: `[x, y, angle, vx, vy, angvel, gunRotation, engineThrottle]`,
`centeringGun` as the flag). More predicted state is either derived
client-side from those eight values or not predicted.

## The prediction pattern

1. The client applies input locally through `ClientCore.apply_input` and
   steps its own copy of the movement model each render tick (`update`).
2. Every frame with a player block calls `on_server_state(...)`: the client
   rewinds to the authoritative state and replays inputs newer than
   `input_seq`.
3. `render_overlay()` returns the predicted tail appended to the hot buffer;
   `None` (no local actor or model yet) makes the engine fall back to the
   interpolated camera and clears the `PREDICTED` flag.
4. A game that also predicts _other_ bodies (map dynamics, actors in contact
   with the local one) reads their authoritative state in
   `begin_reconcile(snapshot)`, lets the replay carry them, folds the
   divergence in `finish_reconcile()` and returns them from `render_rows()`;
   each row is appended after the predicted tail and overrides the
   interpolated row of the same entity.

**Motion parity is a hard requirement**: the client's predicted movement and
the host's `on_fixed_step` movement must produce identical results. Keep the
movement math in one shared module used by both halves and add a `cargo`
parity test that steps both and asserts equality; re-run it after any
movement change.

### Shot prediction and duplicate suppression

A locally predicted shot would otherwise be drawn twice — immediately and
again when the authoritative event arrives.

1. `try_action` spawns a local effect with an id of the form `L<n>` and
   returns its spawn JSON to `ClientPlugin.hooks.onLocalAction`, which feeds
   the renderer.
2. The **last field of every weapon event block is the author's game id**.
3. `filter_frame_game` inspects incoming event rows and, when the author id
   equals the local player, drops the row (or replaces the local id).
4. A `null` row in an indexed block is the removal marker of an entity.

## Save / restore

`serialize_state()` / `deserialize_state(bytes)` carry a match to another
host when the game sets `gameConfig.migration.midRound` (a host checkpoint,
[host.md](host.md#checkpoints)): the dump is the game's `GameSim::serialize`
plus the engine's world, map, PRNG and accumulator, and the new host continues
from the same tick. The game's `serialize`/`deserialize` must then cover
**all** simulation state — a field left out silently resets at every host
change. Without the flag the dump is unused: a migrating room re-creates the
map and respawns everyone.

## Map bodies

`GameMap::create` builds the map's physics from the map JSON: static walls
are merged into rectangular blocks (`RigidBodyBuilder::fixed()`), each
`physicsDynamic` entry becomes one dynamic body with a collider offset by
half its size (the body's position is the object's corner, as in the map
data).

Every dynamic body is created with
`soft_ccd_prediction(width.min(height))` — its own thickness. Rapier's
default prediction distance, 0.002 units, is calibrated for a metre-scale
world; a body in a match covers orders of magnitude more per `1/120` step,
so without prediction the contact is born only once the shapes already
overlap deeply, and the object visibly sinks into the wall before being
pushed out. Static walls do not need it (they never move).

A game's own bodies (actors, projectiles) are built in the game crate and
have to set their own prediction distance the same way.

A dynamic body's `user_data` carries its index above the map-object tag byte
(`encode_map_object_at(i)`, read back with `map_object_index`), so a game maps
a contact pair to a map body without a search: `GameMap::dynamic_index_of(world,
handle)`, and back with `GameMap::dynamic_handle(i)`. A game must never remove
a map body — the engine removes them all on the next map load, and a second
removal is invalid in Rapier. It **disables** it instead
(`set_enabled(false)`): `step_dynamic_levels` skips a disabled body (a group
change would give it back its collisions), and its snapshot row stays, with
the position frozen and no velocity tail.

The map's `game` field and `physicsDynamic[i].game` are opaque game data
(`MapConfig::game`, `DynamicObjectConfig::game`): the engine keeps them as
declared, unscaled, and hands them back through `GameMap::game_data()` and
`GameMap::dynamic_game_data(i)`; they travel in the handoff dump with the
map. `MapConfig::validate` only fixes their shape — an object or nothing.

After the bodies and the navigation graph are built, `EngineSim::load_map`
zeroes `map_body_state` (one byte per dynamic body) and calls
`GameSim::on_map_loaded(ctx)` — on every load, a reload of the same map at
round start included. An error from the hook fails `load_map`, and there is
nothing to roll back to: the previous map was removed before the new one was
built, so the engine removes the new bodies too and clears `nav` and
`map_body_state`, leaving the world without a map. (A `MapConfig::validate`
error is different: it happens before the old map is touched.) The hook is not
called on `deserialize_state` — the game restores what it derived from the
map from its own dump, while `map_body_state` is part of the engine dump.

## Layered maps (2.5D)

A map may carry above-ground levels next to the ground: level 0 is the
ground, levels 1..7 are overhead (`MAX_LEVELS` = 8, one Rapier mask bit per
level). Level 0 stays in `map` / `physicsStatic` / `layers`, so a map without
the new fields loads exactly as before. The other levels arrive in the
optional `levels` field and the transitions between them in the optional
`ramps` field:

```json
{
  "levels": {
    "1": { "map": [[0, 9]], "floor": [9], "walls": [7], "layers": {} }
  },
  "ramps": [{ "tile": 3, "dir": "east", "from": 0, "to": 1 }]
}
```

- `map` — the level's tile grid; its dimensions must match `map`, and `0`
  means "no level here, the one below shows through".
- `floor` — the tiles you can drive on (the bridge slab). `walls` — the
  railings: they block movement and the ray on this level, and every railing
  tile has to be part of `floor` too, otherwise it hangs in the air and does
  not shield the ray from below.
- `dir` is the direction of the _climb_ (`north` = `-y`, `south` = `+y`,
  `west` = `-x`, `east` = `+x`); `from`/`to` default to `0`/`1` and may span
  more than one level.
- `levelHeight` — optional, at the root of the map: the height of ONE level
  in world units (the tile size by default). It makes `RampSample::slope` a
  dimensionless gradient (`rise * levelHeight / span`) instead of «levels per
  pixel», which is what every climb constant is tuned against.
- `volumes` — optional, next to `layers` at any level: the visual height of a
  render layer in levels (`{ "<layers key>": 0.6 }`). The core never uses it;
  it travels to the client and lives in the renderer, but is validated here,
  because a typo in a layer key would otherwise give a flat map in silence.
- `physicsDynamic[].level` places a dynamic body on a level; a respawn point
  may name its level as a 4th number (`[x, y, angleDeg, level]`) — without it
  the level is derived from the geometry (`GameMap::level_at`).

`MapConfig::validate` runs inside `load_map` _before_ any body is created and
turns every one of these mistakes into an error from `load_map`; at runtime
they are all silent. Two of the checks are about the geometry a level is for:

- a **ramp must arrive somewhere** — the cell past the top end of a run has
  to be drivable surface of the level it climbs to, or the tank reaches the
  top and falls in the same step;
- a **slab edge must be railed or land somewhere** — a `floor` cell whose
  neighbour is neither floor nor railing is a ledge, and the fall from it has
  to land on the walkable surface of `MapLevels::landing_level` (the nearest
  level below with a floor there, the ground if there is none); over the grid
  border or over a wall it is an error (walls of a lower level are no
  obstacle to a tank on the slab);
- a **ramp must not climb through a slab** — a run of a `from -> to` ramp may
  not pass under the floor of a level in between;
- **two ramps must not share a cell** — the run that claims a shared cell is
  picked arbitrarily (the first declared one), so the climb would stop
  following from the map;
- **`levelHeight`, when present, must be finite and greater than 0** — it
  scales the whole ramp slope.

The shape checks live in `map::validate_levels`, a free function taking the
raw `levels`/`ramps` fields, so a game's client replica can run the very same
rules on `MAP_DATA` — the map arrives there over the network, and a level
grid that disagrees with the host's desyncs prediction without a word. The
Rust validator and contract rule `E4` share one corpus of cases
(`packages/engine/contract/fixtures/layered/`).

`MapLevels` holds the layered geometry without a physics world — the grids,
the solid and floor tiles per level, and the ramp runs. The host keeps it
inside `GameMap`, and a game's client replica builds the same structure from
the same `MAP_DATA` fields, so both sides answer `level_at`, `has_floor`,
`is_solid` and `ramp_at` from one implementation: a second copy of the rules
would drift from the authoritative one silently.

Physics separates the levels with Rapier masks: `level_interaction(level)`
puts a body in the group of its level (bit `N` for level `N`: `GROUP_1` is
the ground, `GROUP_2` the first overpass) and lets it see only that level;
`STATIC_LEVEL_GROUP` (bit 8) is the shared group of the walls;
`RAMP_GUARD_GROUP` (bit 9) is the group of the ramp guards — the colliders
along both sides of a **block** of ramp lanes and across its far end, built
by `GameMap::create_static` for layered maps only (lanes of one wide ramp
share `RampRun::block` and are fenced together, never one by one). Their
geometry lives in one place, `map::ramp_guards(&MapLevels) -> Vec<RampGuard>`:
the host builds its colliders from it, and a game's client replica is expected
to build its own guards from the same call rather than re-derive the boxes —
the two copies drift silently, and predicted movement up a ramp is exactly
where that shows. A side rail starts ONE CELL past the run's foot: the foot
cell is open from every direction, so a body may drive onto the hill head-on,
at an angle or from the side, and it is the GAME that judges whether that
entry counts as a climb (in tanks, `level::entry_is_legal`). The rails hold
the MIDDLE of the run only, and a one-cell run — all foot, no middle — gets
no rails at all. Those bounds are a call of their own,
`map::ramp_rail_span(run, tile) -> Option<(f32, f32)>`: a game that DRAWS
the run (the wedge's skirt) takes them from it rather than repeating the
offset, or the picture grows a wall where the physics lets a body through. Leaving a run is never held: a legally climbing body passes
the guards through. A body's filter comes from
`body_filter(mask, on_ramp)` (`levels_interaction` / the `_on_ramp` variant):
a body standing on the level the run starts from sees the guards, a body
legally climbing the run does not, and a body of another level never matches
them at all. Building that filter by hand in a game would be a second copy
of the rule. A body that
sets no groups keeps `Group::ALL` and still interacts with level 0, so
single-level worlds and games that know nothing about levels are unaffected.

`ramp_at` returns the ramp under a point: `progress` along the run, `from` /
`to`, the uphill unit vector `dir` and the steepness `slope` (levels per
world unit — the grade under a heading is `slope * dot(dir, heading)`), plus
`run` / `axis`, which tell entering a run from its foot apart from driving
onto it from the side.

Falling is one primitive for the whole ecosystem — `FallModel`, linear in `z`
with a duration that grows with the height (`EngineConfig.mapFallTime`,
0.35 s per level). A game adds its own rules on top (blocked input, damage)
but has to take the trajectory from here, or a crate and a tank fall
differently and diverge in silence. `elapsed_at` is the inverse of `z_at`: a
client replica restores the phase of a fall from an authoritative frame.

Map bodies live by the same rules: `GameMap::step_dynamic_levels` (called by
`EngineSim::step_fixed` before the world step — a game only ever sees the map
by `&`) runs `step_body_level` for every dynamic body. A crate that runs out
of floor falls to its `landing_level`, carries `STATIC_LEVEL_GROUP` while it
falls (walls yes, bodies no) and takes the group of the level it lands on.
Ramps are not for bodies — they are pushed, not driven — so a body on a ramp
cell keeps its level. With `dynamic_map_data(world, with_levels, ...)` the
row of the map-dynamics block becomes `[x, y, angle, z, level]`; the engine
turns it on when the game's schema for the map set names fields 3 and 4 `z`
and `level`, so a game with the old schema keeps its three fields. The pair
goes in the head and not in the optional tail: a missing tail unpacks as
zeros, and a crate resting on a bridge would land on the ground at the
viewer. `dynamic_map_data_with_state(world, with_levels, with_velocities,
states)` adds the body's state byte right after that head (index 5 on a
layered row, 3 on a flat one) and before the velocity tail;
`build_snapshot_blocks` passes `SimCtx::map_body_state` when the schema
declares a field with `role: 'state'` (`BlockSchema::with_state`), and
`dynamic_map_data` keeps the layout without it.

A game reads a participant's level from `GameSim::set_actor_level` (the ABI
method of the same name), which the engine calls right after
`spawn_actor`/`reset_actor` when the respawn point named a level. The default
implementation is a no-op.

Bot navigation on such a map is built by `NavigationSystem::generate_layered`:
nodes on every level, two-way ramp edges, and one-way ledge edges (top →
bottom only, to `landing_level`, with a penalty per level of height, because
the jump costs the game's `fallDamage`).
Paths are searched with `find_path_on(PathPoint, PathPoint)`; a level change
between two neighbouring points of the path means a ramp or a ledge.

### Navigation queries

On top of the finished graph `NavigationSystem` keeps two derived grids per
level (built last, so graph construction does not depend on them). A cell is
free exactly when `is_walkable_on` says so; the map border counts as blocked:

- **`fit`** — the side (in cells, capped at 15) of the largest free square
  containing the cell; `0` means blocked. A body of width `w` fits a cell when
  `fit ≥ ceil(w / grid_step)`.
- **`clear`** — the Chebyshev distance (in cells) to the nearest blocked cell
  or the map border; `1` means the cell touches a wall.

Every edge also carries private metadata: its kind (walk, ramp, ledge) and
the minimum `fit`/`clear` over the cells of its line.

`find_route(start, end, &PathQuery) -> Option<Route>` searches with rules:

| `PathQuery` field   | Unit                 | Meaning                                                                                                                                                                                                                                                   | Default             |
| ------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `min_width`         | world units          | body width: an edge whose `fit` is too small is forbidden, the direct segment needs a `has_clear_corridor_on` corridor                                                                                                                                    | `0` (no limit)      |
| `comfort_clearance` | world units          | desired distance from walls                                                                                                                                                                                                                               | `0` (no preference) |
| `narrow_cost`       | share of edge length | added at zero clearance, linearly down to 0 at `comfort_clearance`                                                                                                                                                                                        | `0`                 |
| `ledge_cost_scale`  | multiplier           | scales the ledge penalty `LEDGE_PENALTY · height`: `0` — a jump costs its length, `f32::INFINITY` — ledges forbidden                                                                                                                                      | `1`                 |
| `penalties`         | `&[PenaltyZone]`     | circles `{ level, center, radius, cost_per_unit }`: an edge whose midpoint is inside costs `cost_per_unit · (1 − d/radius)` more per unit of length; a direct segment crossing a zone of its level is not taken as a shortcut — A* over the edges decides | `&[]`               |

`PathQuery::default()` reproduces `find_path_on`, which (like `find_path`)
is now a thin wrapper over `find_route`. A `Route` is `legs: Vec<RouteLeg>`
plus `cost` (length plus penalties); each `RouteLeg { point, kind }` says how
the point is reached: `LegKind::Walk`, `LegKind::Ramp { axis, sign }` (as in
`RampRun`) or `LegKind::Ledge { height }`. The last leg is always `end`
(`Walk`). Entry nodes are looked up in rings of up to 4 cells of the node
grid around the point, preferring a visible node whose `fit` suits the body;
start and end snapping to one node give a two-leg route instead of `None`.

Helpers: `clearance_on(level, x, y)` (world units from the cell centre to the
nearest blocked cell, `0` on a blocked cell), `fits_on(level, x, y, width)`,
`has_clear_corridor_on(level, start, end, half_width)` (the centre line and
parallel ones on both sides, at most a cell apart and out to `±half_width`,
cross free cells only),
`nearest_walkable_on(level, pos, width, max_radius)` (the closest free cell
centre that fits the body; ties by distance, then y, then x) and
`random_point_where(rng, level, width)` (a random node of the level that fits
the body; up to 16 tries, then `random_point`).

A* (`pathfinder::find_path_with`, with a per-edge cost callback that may
forbid an edge) runs on a binary heap with lazy deletion; ties on `f` go to
the smaller node index, so equal queries always give equal routes.

```rust
let zones = [PenaltyZone { level: 0, center: danger, radius: 80.0, cost_per_unit: 4.0 }];
let query = PathQuery {
    min_width: 12.0,          // tank hull
    comfort_clearance: 10.0,
    narrow_cost: 1.0,
    penalties: &zones,
    ..PathQuery::default()
};
let route = nav.find_route(from, to, &query);
```

The cells of a ramp run are **not walkable** on the level the run starts
from: a bot gets onto the wedge only through the ramp edge, never by
stepping onto it from the side or from the far end — which is exactly what
the ramp guard colliders enforce in the physics. The ramp edge itself hangs
on two nodes of the run's own, on the centre line of its lane just outside
either edge — a node of the common grid (its step is two tiles) would land on
the run's border, where the guard stands. Such a cell is marked `2`
in the walkability grid, not `1`: `is_walkable_on` treats only `0` as free,
while `has_obstacle_between_on` treats only `1` as an obstacle, so bots keep
seeing and shooting each other through a ramp.

`client::raycast::walk_ray_cells` walks the ray's cells and hands each one to
a callback, so a game can change the ray's level at a slab edge instead of
the single hard-wired "wall — stop". `ray_vs_grid` is a thin wrapper over it.

## Rust traits (`vimp-engine-core`)

The engine crate is pure Rust without wasm-bindgen (errors are
`Result<_, String>`; a game crate maps them to `JsError`). Static generic
dispatch: `EngineSim<G>` (host) and `ClientState<G>` (client) are
monomorphized for a game's `GameDef` `G` — zero overhead at 120 Hz; no `dyn`
needed (one wasm bundle = one game). The full signatures are in
[plugin-api.md](plugin-api.md#rust-traits-vimp-engine-core); the summary here
must not drift from them.

- `trait GameDef { type Config; type Sim: GameSim<Self>; }`
- `trait GameSim<G: GameDef>`: `new`, `spawn_actor`, `remove_actor`,
  `reset_actor`, `reset_all_vitals`, `spawn_scripted_actor`,
  `remove_scripted_actor`, `apply_input`, `apply_aim` (pointer input, default
  empty), `last_input_seq`, `is_alive`,
  `actor_position`, `prediction_state`, `alive_players_flat`,
  `players_json`, `on_fixed_step(ctx, dt)`, `on_contacts(ctx, pairs)`,
  `on_before_destroy`, `on_ai_tick(ctx, dt)`, `refresh_cached`,
  `build_snapshot_blocks(&mut self) -> (Vec<(String, Block)>, has_events)`,
  `remove_players_and_shots`, `clear`, `serialize/deserialize` (the host
  checkpoint: with `gameConfig.migration.midRound` the `serialize_state` dump
  carries the match to a new host mid-round, see
  [host.md](host.md#checkpoints)), `rebuild_spatial_grid`; `on_map_loaded(ctx)`
  (default `Ok(())`, see [Map bodies](#map-bodies)).
- `SimCtx<'a>` — the game's access to engine facilities inside the tick
  callbacks; **not** generic over the game: `world` (Rapier), `cfg`
  (`EngineConfig`), `map` (respawns — `IndexMap<String, Vec<[f32;3]>>`,
  arbitrary teams), `nav`/`spatial` (A*/grid — engine utilities in a `nav/`
  module, no "bot" wording), `rng`, `events`, `bodies_to_destroy`,
  `map_body_state` (the state byte of each map dynamic body). There is
  no `game_cfg` field: the game config reaches the game once, in
  `GameSim::new`, and the implementation keeps what it needs.
- The engine owns: the fixed-step accumulator, contact collection, the
  destroy queue, the schema-driven `SnapshotPacker`, the handoff skeleton,
  `CoreEvent`.
- The client half: `trait GameClientDef` — `new`, `on_server_state`,
  `update`, `track_frame`, `filter_frame_game`,
  `update_world`, `update_world_interpolated`, `render_overlay`,
  `apply_input`, `apply_aim` (pointer input, default empty), `set_model`,
  `set_active`, `set_map`, `sync_panel`,
  `reset`, `cycle_item`, `try_action`, the three hooks for bodies the game
  predicts itself — `begin_reconcile(snapshot)`/`finish_reconcile()` around
  the replay and `render_rows()` for the render tick, all defaulting to
  empty (see below) — plus the two divergence hooks
  (`predicted_state`, `replayed_inputs`) that default to `None` (see
  below). The engine provides the `Interpolator` (schema-driven), the
  generic `ClientState<G>` orchestration (network buffer, event-frame
  queue, render-tick hot buffer), raycast and the collision primitives
  (`collision`, `rigid_body`). Actor prediction, visual
  spawn prediction and the panel are entirely the game crate's own concern
  inside its `GameClientDef` implementation, and call the engine primitives.

  `collision` and `rigid_body` let a client predict contacts the way the
  host resolves them: `obb_manifold` / `collect_block_contacts` produce the
  `Contact`s (they read the map through the same `Box2` as `raycast`, so a
  ray and a contact can never disagree about a wall). Walls are read as the
  **glued blocks** of `MapLevels::static_blocks` — the very list the host
  puts its colliders by. Collecting them tile by tile (`collect_tile_contacts`,
  kept for a grid a game holds itself) makes a body straddling a long wall
  meet several contacts where the host has one, and a tangential hit on a
  corner is then resolved along a different axis on each side — a silent
  drift. `collect_tile_contacts` also has **no speculative contacts**: it
  finds a contact only once the boxes already overlap, so on a fast
  tangential hit it parts ways with the host's `soft_ccd_prediction`. A
  layered map must read its walls through `collect_block_contacts`.
  `collect_block_contacts_into` is the same collection into a caller-owned
  buffer, for a step that collects several times per frame.

  Four details make the replica behave like Rapier rather than merely
  resemble it, and a game that skips any of them drifts on tangential hits:

  - **Speculative contacts.** `obb_vs_obb_within(a, b, prediction)` and
    `obb_manifold(a, b, prediction)` return a contact while the bodies are
    still apart, up to a gap of `prediction`; `Contact::depth` is signed
    (`> 0` penetration, `< 0` gap). `prediction` must be the body's
    `soft_ccd_prediction` on the host — the same number on both sides,
    or the two see the contact on different steps. Without it a body moving
    at a few hundred units per second is already inside the wall by the time
    it reacts, and its lever is not the host's. `obb_vs_obb` is the wrapper
    with no prediction.
  - **Two-point manifolds.** Rapier clips the two support faces of a
    cuboid pair, so a face contact carries two points with their own
    depths. A single point blended to the middle of the face has no lever at
    all, and the hull does not turn where the server turns it. `Manifold`
    holds up to two `Contact`s; `Manifold::deepest()` is the one point that
    gets the positional correction (`separate_bodies` once per **pair**,
    never per point). When the faces do not overlap at all, a
    **penetrating** pair falls back to the blended point of
    `obb_vs_obb_within` (the bodies still have to be pushed apart), while a
    **separated** pair — corner to corner inside the prediction gap — gets
    no contact, exactly like parry. Otherwise the replica braked on a "gap"
    the host drives straight past (a hull passing an opening in a wall).
  - **Accumulated impulses.** `apply_contact_impulse` takes
    `&mut ContactImpulses` — one per contact, living from the solver's first
    iteration to its last — and clamps the _accumulated_ impulse, not the
    iteration's increment. Applying increments lets the first point of a
    manifold take the whole normal impulse, spin the hull on its lever and
    leave the second point separating, with no way back; accumulation gives
    the excess back. It also takes `dt`, which a speculative contact needs:
    the gap closes at `-depth / dt`, and only what closes it faster is
    cancelled, so a body stops **at** the wall instead of inside it.

  - **Metered positional correction.** `separate_bodies(a, b, contact, dt)`
    does not undo the whole penetration in one step: it moves the pair by
    `penetration_correction(depth, dt)` —
    `min(contact_erp(dt) * (depth - ALLOWED_LINEAR_ERROR),
MAX_CORRECTIVE_VELOCITY * dt)`, the law of Rapier's contact spring
    (`contact_natural_frequency` 30 Hz, `contact_damping_ratio` 5,
    `normalized_allowed_linear_error` and
    `normalized_max_corrective_velocity` on `length_unit = 1`, the host's
    defaults). A deep overlap — a body that fell inside a crate — is
    something Rapier creeps out of over dozens of steps, fractions of a
    unit at a time; a replica pushing it out at once jumps several units
    and blows the game's prediction-drift budget.

  `separate_bodies` + `apply_contact_impulse` resolve the contacts on
  `Body` values, and `MAP_SURFACE` reuses `map::DEFAULT_FRICTION` /
  `DEFAULT_RESTITUTION` — the same figures the host builds its colliders
  with. This pair is an approximation of Rapier and is kept for
  compatibility: it does not match the host on a hit.

  **Rapier-matching step.** `step_bodies(bodies, rows, cache, dt)` replaces
  `separate_bodies` + the `apply_contact_impulse` iterations + `integrate`
  with a port of Rapier's TGS solver. The constraints are built once on the
  step's start pose, then `SOLVER_SUBSTEPS` (4) substeps of `dt / 4` each
  recompute the gap from the current poses, warm-start with the previous
  substep's impulses, run a biased pass (a soft spring removes penetration,
  a gap allows approach at `gap / h`), integrate the poses (rotation
  linearized as in Rapier) and run a bias-free pass whose target is the
  bounce of a _new_ contact. The two points of one manifold are solved
  together by a 2×2 block solver, normals before friction. Unlike Rapier,
  whose only test is `det > 0`, a block whose condition number exceeds
  1000 (Box2D's threshold, `MAX_BLOCK_CONDITION`) is treated as degenerate
  and its second point does not push: two points microns apart leave the
  block singular only up to f32 rounding, and its inverse then pumped
  energy into the body until it reached inf/NaN. Damping is
  applied once, on the full `dt`. Why it matters: the outcome of a hit
  depends on which substep closes the gap. Before the last one the body
  leaves the wall with `−e·v`; on the last one there is no bounce, the rest
  of the closing speed survives, and on the next step the point is no
  longer new and cancels it. With a 1/120 step that is roughly one hit in
  four, and a single per-step rule jerks by up to ~130 units/s there.

  - **Rows.** Build them only with `ContactRow::from_manifold(a, b,
&manifold, surface, key_base)`: it takes `Manifold::solver_points()` —
    the point midway between the two surfaces, as parry reports it (in the
    middle of the gap for a speculative contact) — and lays the pair out as
    consecutive rows. `Manifold::as_slice()` returns points on the incident
    body's surface; it is what the old solver expects, and feeding it to
    `step_bodies` shifts the friction lever by half the depth: an oblique
    hit then turns the hull unlike the host, silently. Only the two rows of
    one manifold form a 2×2 block — same bodies, same names in the keys,
    points 0 then 1 — so a caller may keep all its walls as one static body
    of the slice.
  - **Keys.** `ContactKey::new(a, b, point)` names the contact point
    across steps with **stable** names of the bodies (a game id, a block's
    index on its level), never with indices into `bodies`: the caller
    rebuilds that slice every step. The point number is the vertex of the
    incident face the point came from, not its place among the surviving
    points — like parry's feature id, it does not shift when the
    neighbouring point drops beyond the prediction distance.
  - **Memory.** `ContactCache` carries what parry keeps per point: the
    last substep's impulses (warm start) and the step's total normal
    impulse (a point that pushed last step is not new, so it does not
    bounce). One cache per simulation; its `Clone` copies only that memory.
    A predictor keeps a copy per step in its snapshot history and rewinds
    it with the state; `clear()` is for a teleport, a reset or a rewind
    past the history. Clearing it on every server frame is wrong: a replay
    against a wall would then bounce on every frame.

The trait's shape is validated by a fixture second client (`TestClient`,
tests in `packages/engine/core/src/client/game.rs`) before any real second
game exists — this is what guarantees the traits stay game-agnostic.

## Debugging: `debug_json` and the divergence detector

Two debugging facilities live in the engine crate and are exported through
the ABI macros, so every game gets them for free and
`ENGINE_API_VERSION` is unaffected. The full loop that consumes them is
[debugging.md](debugging.md).

- **`debug.rs` — `EngineSim::debug_json()`** (exported as
  `GameCore.debug_json()`): a _curated_ world dump, next to the raw
  `serialize_state()` serde output, which is unreadable. Bodies (`tag`,
  `userData`, `translation`, `rotation`, `linvel`, `angvel`, `mass`,
  `bodyType`, `ccd`), colliders (`shape` + `halfExtents`/`radius`,
  `isSensor`, collision/solver groups in hex, `parent`), map (`setId`,
  step, grid, static/dynamic body counts, respawns), nav graph
  (nodes/edges/step), spatial grid (cell size, per-cell counts), `rng.state`
  and the fixed-step accumulator. Record order is deterministic, so two
  dumps can be diffed. `ClientState::debug_json()` mirrors it on the client:
  interpolator buffer depth, `seq` window, `offset`, the last frame's
  `seq`/`serverTime`.
- **`client/divergence.rs` — the prediction divergence detector.** Just
  before `on_server_state` overwrites the prediction, `ClientState` compares
  the predicted state against the authoritative player block and stores a
  record if any component exceeds its threshold. Level 0 needs nothing from
  the game (the `render_overlay()` camera against the frame's x/y); level 1
  uses the optional `GameClientDef::predicted_state()` (component-wise) and
  `replayed_inputs()` (the replayed input window), both defaulting to
  `None`. Configuration is the optional `EngineClientConfig.divergence`
  (`thresholds` positional, `defaultThreshold`, ring-buffer `capacity`,
  `angles` — angle components whose delta is wrapped into `(−π, π]`) —
  absent in production, and then the frame path is untouched.
  `ClientCore.take_divergence()` drains the buffer. Matching is by frame
  **time**, not by `seq`, because reconciliation replays the input history
  from the authoritative timestamp.

## Snapshot blocks — a declarative schema

Fixed block layouts are a schema, not hardcoded structs:
`SnapshotConfig.keys` maps each key to a `BlockSchema` of exactly four
fields — `id` (the block's opcode in the frame), `kind` (`BlockKind`: the
row shape, which is what implies the count/id widths and whether rows carry
a null marker), `class` (`hot` — interpolated / `event` — frame-only), and
`fields` (each with a type `f32/u8/u16/u32` and an interpolation mode
`lerp`/`lerpAngle`/discrete). The `d` prefix on `indexedNoNull8` ids is not
a schema field either — it is hardcoded in the decoders. The packer
(`snapshot.rs`), the unpacker (`client/unpack.rs`), the interpolator, and
the engine hot buffer are all schema interpreters; a game crate only
supplies rows as flat `Vec<FieldValue>`. The schema itself is game data, supplied through
`HostPlugin.gameConfig.snapshot` (see [plugin-api.md](plugin-api.md)) —
the engine bundle carries no snapshot keys of its own.
`SNAPSHOT_FORMAT_VERSION` (currently `5`) is the engine's framing version;
byte compatibility across deploys is not required (host and clients are
one deploy — the version only protects framing within a room).

## Tests

| Layer            | Where                                                                                                                   | Covers                                                                                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust unit        | `packages/engine/core/src/*` (`#[cfg(test)]`)                                                                           | PRNG, the nav grid, A*, clearance grids, `find_route`, the spatial grid; the client module: round-trip unpack, the interpolator (seq/dedup/late/lerp), raycast, SAT contacts and the contact solver, the hot buffer; the `GameClientDef` trait's shape validated against a fixture `TestClient` |
| Rust integration | this repo has none — a game's simulation scenarios (driving, weapons, bots, handoff, etc.) are that game repo's concern | —                                                                                                                                                                                                                                                                                               |

`npm run core:test` runs `cargo test --workspace`, which in this repo is
just `packages/engine/core` — this is where the engine crate's own unit
tests run and where any change to its traits/macros/framing must be
verified. A game repo's own `cargo test --workspace` only exercises its
own game crate (a dependency on `vimp-engine-core`, not a workspace
member), so it doesn't re-run these tests — CI on this repo is the source
of truth for the engine crate itself.

---

[← Previous: Browser Host](host.md) · [Next: Client Modules →](client.md)
