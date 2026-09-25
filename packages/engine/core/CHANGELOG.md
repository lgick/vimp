# Changelog

All notable changes to the `vimp-engine-core` **crate** are documented here.
The npm package `vimp-engine` has its own journal:
[../CHANGELOG.md](../CHANGELOG.md). The format is based on
[Keep a Changelog](https://keepachangelog.com/); this crate uses
[Semantic Versioning](https://semver.org/) (in `0.x`, a breaking change bumps
the minor version).

A bump here has to be repeated by hand in every game crate that depends on
it (e.g. `vimp-tanks/core/Cargo.toml` → `vimp-engine-core = "X.Y.Z"`), since
the dependency is by version, not by path.

## [Unreleased]

## [0.22.4] — 2026-09-25

### Changed

- Test release: no code changes; exercises the tag-driven release flow.

## [0.22.3] — 2026-09-25

### Changed

- No functional change — a version-only release to exercise the new
  `.github/workflows/release.yml` (npm/crates.io OIDC Trusted Publishing
  pipeline) end to end.

## [0.22.2] — 2026-09-24

### Fixed

- `client::rigid_body::step_bodies` treats an ill-conditioned 2×2 block
  (condition number above 1000, Box2D's threshold) as degenerate, so its
  second point does not push. Two points of one manifold microns apart
  left the block singular only up to f32 rounding; its inverse was
  millions of times the single-point mass, the pair pumped energy into the
  body (it left a wall faster than it hit it), and a predicted body could
  reach inf/NaN — the client camera and the sound listener then received
  NaN and the picture disappeared.

## [0.22.1] — 2026-09-23

### Fixed

- `client::rigid_body::step_bodies` joins two rows into a 2×2 block only
  when they are the two points of one manifold (same bodies, same names in
  the keys, points 0 then 1). Matching body indices alone glued the contacts
  of two different walls held as one static body of the slice, and a point
  was then solved along the other wall's normal.
- `client::rigid_body::ContactRow::from_manifold` numbers a point by the
  incident-face vertex it came from, not by its place among the surviving
  points: when the first point dropped beyond the prediction distance, the
  second inherited its key — its warm start and "not new" status, so it
  never bounced.

## [0.22.0] — 2026-09-23

### Added

- `client::rigid_body::step_bodies` (`ContactRow`, `ContactKey`,
  `ContactCache`, `SOLVER_SUBSTEPS`): a step of predicted bodies that
  follows Rapier's TGS solver — four substeps with a biased pass, position
  integration and a bias-free pass, a 2×2 block solver for two-point
  manifolds, and per-contact memory between steps (warmstart, restitution
  only on a new contact). A body hitting a wall now leaves it exactly as on
  the host, whichever substep closes the gap. `apply_contact_impulse`,
  `separate_bodies` and `integrate` are unchanged.
- `client::collision::Manifold::solver_points` and
  `client::rigid_body::ContactRow::from_manifold`: the points `step_bodies`
  expects — midway between the two surfaces, as parry reports them (the
  gap's middle for a speculative contact) — laid out as consecutive rows of
  one pair. `Manifold::as_slice` keeps feeding the old solver unchanged.

### Fixed

- `client::collision::obb_manifold` no longer invents a contact for a
  separated pair whose faces do not overlap (corner to corner inside the
  prediction gap): the host (parry) has none there. The blended-point
  fallback remains for penetrating pairs only.

## [0.21.0] — 2026-09-23

### Added

- `divergence.angles`: components compared on the circle, so an angle
  crossing ±π no longer reports a 2π drift. Empty by default — the detector
  behaves as before; an index past the player block is ignored.

## [0.20.0] — 2026-09-14

### Added

- **Map `game` field**: `MapConfig::game` and `DynamicObjectConfig::game`
  (`serde_json::Value`, `Null` when absent) carry opaque game data through
  the map load; read them back with `GameMap::game_data()` and
  `GameMap::dynamic_game_data(index)`. The engine neither reads nor scales
  them, and they survive the handoff dump. `MapConfig::validate` rejects a
  `game` (on the map or on a dynamic object) that is neither absent nor an
  object.
- **`GameSim::on_map_loaded(ctx)`**, default `Ok(())`: called on every
  `load_map` once the map's bodies and navigation exist. An error fails
  `load_map` and leaves the world without a map (its bodies are removed,
  `nav` is cleared). Not called on `deserialize_state`.
- **Map body access**: `physics::encode_map_object_at(index)` and
  `physics::map_object_index(user_data)` put a dynamic body's index above the
  tag byte (`encode_map_object()` still returns the same value as before);
  `GameMap::dynamic_handle(index)` and `GameMap::dynamic_index_of(world,
  handle)`. A body the game disables (`set_enabled(false)`) is skipped by the
  level rules (`step_dynamic_levels`) and keeps its snapshot row without the
  velocity tail.
- **Map body state byte**: `FieldRole::State` (`role: 'state'`, a `u8` right
  after the dynamics row head — index 5 on a layered row, 3 on a flat one —
  and before `optionalFrom`), `BlockSchema::with_state()`,
  `BlockSchema::validate_roles()` (`validate_level_roles` stays as its
  alias), `GameMap::dynamic_map_data_with_state(world, with_levels,
  with_velocities, states)` and `SimCtx::map_body_state`, zeroed on every map
  load and kept in the handoff dump. The engine writes the byte only when the
  schema declares the role; `dynamic_map_data` keeps its exact layout.

### Changed

- `SimCtx` has a new public field, `map_body_state`: code that builds a
  `SimCtx` with a struct literal outside the engine has to add it (games only
  receive a `SimCtx`, so they are unaffected).
- A map dynamic body's `user_data` now carries its index above the tag byte:
  every body past the first no longer equals `MAP_OBJECT_TAG`. Test with
  `is_map_object`, which ignores the higher bits.

## [0.19.0] — 2026-09-11

### Added

- **`map::ramp_rail_span(&RampRun, tile) -> Option<(f32, f32)>`**: the side
  rails' bounds along a run's axis, `None` when the run gets no rails (one
  cell long — all foot, no middle). `ramp_guards` is built on it, and a game
  that draws the run's wedge takes the same call instead of re-deriving the
  offset: a second copy shows a wall where the physics lets a body through.

## [0.18.0] — UNRELEASED

### ⚠️ Breaking

- **`client::rigid_body::separate_bodies` takes `dt`** and no longer pushes
  the bodies apart by the full penetration depth. It now moves them by what
  the host's contact spring removes in one step — the new
  `penetration_correction(depth, dt)`, which is Rapier's own law:
  `min(erp(dt) * (depth - allowed_error), max_corrective_velocity * dt)`,
  with `contact_erp`, `ALLOWED_LINEAR_ERROR` and `MAX_CORRECTIVE_VELOCITY`
  exported next to it. A deep overlap (a falling body landing inside a
  crate) used to be undone by the replica in a single step while Rapier
  crept out of it over dozens — a jump of several units in the predicted
  position, enough to break a prediction-drift budget.

### Migration

- Pass the step length to every `separate_bodies` call:
  `separate_bodies(a, b, contact, dt)` — the same `dt` the step's
  `apply_contact_impulse` already gets.

## [0.17.0] — 2026-09-11

### Changed

- **`map::ramp_guards` opens the foot cell of every run.** A side rail now
  starts one cell past the run's foot, so a body may drive onto a hill
  head-on, at an angle or from the side, and the GAME decides whether that
  entry counts as a climb; the rails hold the middle of the run only. A
  run one cell long gets no rails at all — it is all foot and no middle.
  Leaving a run is unaffected: a legally climbing body passes the guards
  through (`levels_interaction_on_ramp`). Games that build their replica's
  guards from this function (as they must) inherit the change; a game that
  kept its own copy of the formula drifts from the host here.

## [0.16.0] — 2026-09-11

### Added

- **`map::ramp_guards(&MapLevels) -> Vec<RampGuard>`** and the `map::RampGuard`
  struct: the single source of ramp-guard geometry (the side rails and the
  "wrong" end cap of every ramp block). `GameMap::create_ramp_guards` is now a
  loop over it, and a game's client-side replica is expected to build its
  guards from the same function instead of re-deriving the formula — a copy
  drifts silently.
- **`client::collision::collect_block_contacts_into(obb, blocks, prediction,
  out)`**: the same collection, writing into a caller-owned buffer instead of
  allocating a `Vec` per call. `collect_block_contacts` is a thin wrapper over
  it and is unchanged. The buffer is not cleared — the caller decides whether
  it accumulates a step's contacts or starts over.

### Fixed

- **NaN contact point on a degenerate OBB with `prediction > 0`.** With a
  speculative gap, SAT no longer rejects a box with zero half-extents, and
  `contact_point` divided by a zero tolerance, leaking `NaN` into the
  replica's velocities without a single line in the console.
  `obb_vs_obb_within` and `obb_manifold` now return `None` for such a body.

## [0.15.0] — 2026-09-06

### ⚠️ Breaking

- **`client::collision::collect_block_contacts(obb, blocks, prediction)`**
  takes a third argument, the speculative-contact distance, and returns
  `Vec<BlockContact>` (a `Manifold` plus the block centre) instead of
  `Vec<TileContact>` (a single `Contact` plus `tile_x`/`tile_y`).
- **`client::rigid_body::apply_contact_impulse(a, b, contact, surface, dt,
  acc)`** takes two more arguments: the step `dt` and
  `&mut ContactImpulses`, the impulses accumulated over the solver's
  iterations for that one contact.
- **`client::collision::Contact::depth` is now signed.** `> 0` is
  penetration as before, `< 0` is a gap — a speculative contact found before
  the overlap. `separate_bodies` ignores such a contact (there is nothing to
  push apart); any game code that reads `depth` directly has to expect the
  sign.

### Migration

- `collect_block_contacts(&obb, blocks)` →
  `collect_block_contacts(&obb, blocks, prediction)`, where `prediction` is
  the body's `soft_ccd_prediction` on the host — literally the same number
  on both sides, taken from one shared formula, never a duplicated literal.
  `0.0` reproduces the old behaviour bit for bit.
- A hit is now a manifold: `hit.contact` → `hit.manifold.deepest()` for the
  positional correction, `hit.manifold.as_slice()` for the impulses;
  `hit.tile_x`/`tile_y` → `hit.block_x`/`block_y`. Feed **every** point of
  the manifold to `apply_contact_impulse` and only the deepest one to
  `separate_bodies`, once per pair.
- `apply_contact_impulse(a, b, contact, surface)` →
  `apply_contact_impulse(a, b, contact, surface, dt, acc)`. Store one
  `ContactImpulses::default()` next to each contact when the step's contacts
  are collected and pass the same `&mut` on every solver iteration; a fresh
  value per iteration turns the accumulated clamp back into an increment
  clamp and brings the drift back.
- A replica that resolved contacts **after** integrating the position has to
  swap the order: collect contacts on the pose at the **start** of the step
  with `prediction`, solve the impulses, and only then integrate. That is
  the order Rapier uses, and the speculative contact is meaningless without
  it.

### Added

- **`client::collision::obb_vs_obb_within(a, b, prediction)`** — the SAT test
  with speculative contacts: a contact is returned while the bodies are still
  apart, up to a gap of `prediction`. `obb_vs_obb` is now the wrapper with
  `prediction = 0.0` and is unchanged bit for bit.
- **`client::collision::obb_manifold(a, b, prediction)` and `Manifold`** —
  up to two contact points per pair, built by clipping the support faces
  (Sutherland—Hodgman) the way Rapier builds a cuboid manifold, each with its
  own depth. `Manifold::deepest()` is the point for the positional
  correction. A degenerate pair falls back to the single blended point.
- **`client::rigid_body::ContactImpulses`** — the normal and tangent
  impulses accumulated by the solver for one contact.

### Fixed

- **A client replica no longer drifts from the server on tangential hits.**
  Three things went wrong at once and only together: the replica saw a
  contact only after it had already moved into the wall (up to 1.24 units in
  one step at 148 u/s), it put a single contact point in the middle of the
  hull's face — no lever, so the hull did not turn where the server turned
  it — and its solver clamped per-iteration increments, letting the first
  point of a manifold take the whole impulse. Measured on the game's debug
  scenarios: `angle` was off by 0.21 rad and `angvel` by 2.8 rad/s against
  thresholds of 0.06 and 1.5.

## [0.14.1] — 2026-09-06

### Fixed

- **A ramp edge no longer hugs the guard of the run.** `connect_ramps`
  attached the foot and the top of a run to the nearest node of the common
  grid, whose step is two tiles: on a one-tile-wide run that node lands on
  the run's border, exactly where `create_ramp_guards` puts a side guard. A
  bot then drove along the guard and was pushed off a ramp it had a path
  through. The run now gets its own two nodes, on the centre line of its
  lane just outside either edge, wired to the level graph and to each other.

## [0.14.0] — 2026-09-06

### ⚠️ Breaking

- `map::RampRun` gains a public field, `block: u16` — the number of the ramp
  **block** a lane run belongs to. A wide ramp is cut into parallel lanes,
  and every consumer needed its own answer to «is this the same hill?»; the
  crate now gives one (`a.block == b.block`) and builds the physics by it.
  A struct literal of `RampRun` outside the crate has to name the field.

### Migration

- A game that built `RampRun` values by hand (fixtures, tests) adds
  `block: 0`. A game with its own «is this the same hill?» rule — comparing
  axis, sign, levels and the along-axis bounds of two runs — replaces it with
  `a.block == b.block`; two definitions of one thing is exactly how the
  physics and the game rules drifted apart.
- A client replica that resolved walls with `collect_tile_contacts` over the
  level grid switches to `collect_block_contacts(&obb,
  levels.static_blocks(level))`. Keeping the tile-by-tile collection means
  keeping the drift it causes on long walls.

### Added

- **`map::StaticBlock` and `MapLevels::static_blocks(level)`** — the glued
  rectangles of solid tiles, in world units, built once in `MapLevels::build`
  and handed to both sides.
- **`client::collision::collect_block_contacts(obb, blocks)`** — contacts of
  an OBB with those blocks, the replica's counterpart of the host's
  colliders. `collect_tile_contacts` stays for a grid a game holds itself.

### Fixed

- **Ramp guards fence a block of lanes, not every lane.** `create_ramp_guards`
  put two side guards and a far-end guard on every run, and a wide ramp is cut
  into one run per lane: the inner lane borders got two guards each, turning
  the block into tile-wide troughs whose walls reach the entry line. A body
  entering along a lane border is not climbing yet, so it sees those guards
  and stops short of the wedge — a wide hill could only be driven dead centre
  of a lane. Runs are now grouped by `RampRun::block`: only the outer sides of
  a block are fenced, and its far end gets one guard across the full width.
  Driving in from the side and under the wedge from the wrong end stay closed.
- **The host and the replica read the same wall geometry.** The host glued
  solid tiles into rectangular blocks while the client replica collected
  contacts tile by tile. On a tangential hit into the corner of a long wall
  (overlap 1.11 across against 1.27 along) the two sides picked different
  push-out axes, and prediction drifted silently — one reconciliation in
  ~350, enough to break the games' drift contracts. `MapLevels::build` now
  glues the blocks once (`static_blocks`), `GameMap::create_static` only
  places colliders by that list (the insertion order is unchanged, so a
  single-level map is bit-for-bit the same), and a replica reads them through
  `collect_block_contacts`.
- **The bot nav graph knows about ramp runs.** `NavigationSystem::
  generate_layered` marked a ramp run's cells walkable on the lower level:
  the run's tiles are not solid, so nodes were placed inside the run and
  paths were routed across it — straight into the ramp guard colliders,
  which are invisible to the graph. A bot spawned on the ground would nudge
  the guard, time out on `stuck_timer`, shoot at the obstacle and rebuild
  the same path forever. The run's cells are now marked `2` in the
  walkability grid of the level the run starts from: `is_walkable_on` reads
  only `0` as free, so the cells are impassable, while
  `has_obstacle_between_on` reads only `1` as an obstacle, so line of sight
  and fire still pass through a ramp. A bot gets onto the wedge through the
  ramp edge of `connect_ramps`, as it already did.

## [0.13.0] — 2026-09-05

### ⚠️ Breaking

- `map::MapLevels::build` takes a sixth argument, `level_height:
  Option<f32>` — the height of one level in world units, `None` for the tile
  size. Everything that reads a ramp has to build the geometry with the same
  number as the host, or the two sides compute different slopes in silence.
- `map::RampSample::slope` is now a **dimensionless** gradient
  (`rise * level_height / span`) instead of «levels per world unit». On a
  real map (tile 12.8 world units, one level over nine tiles) the old value
  was 0.0087 where the new one is 0.11: every constant tuned against a
  gradient — climb thrust, hull pitch, dust — used to miss by two orders of
  magnitude.
- `map::validate_levels` takes a seventh argument, `level_height:
  Option<f32>`, and rejects a value that is not finite and greater than 0.
- The layered dynamic row is switched on by field **roles**, not field
  names: `config::FieldSchema` gained `role` (`FieldRole::Z` /
  `FieldRole::Level`), and `BlockSchema::with_levels()` reads it. `load_map`
  fails loudly when a role sits at the wrong index, when only one of the pair
  is declared, or when fields named `z`/`level` occupy indices 3 and 4
  without declaring roles — comparing names meant that renaming a field
  silently returned a flat row.
- `level_interaction`/`levels_interaction` now also let a body see
  `RAMP_GUARD_GROUP`. A body that legally climbs a ramp run has to use the
  new `levels_interaction_on_ramp(mask)` instead, otherwise it stops at the
  guard across the top of the run.

### Migration

- A game crate that calls `MapLevels::build` passes `cfg.level_height`
  scaled by the map scale as the sixth argument (`None` keeps the previous
  behaviour bit for bit — the slope changes anyway, see above).
- A game that calls `validate_levels` passes `level_height` last (`None` if
  its client replica does not carry the field).
- A game that uses `RampSample::slope` recomputes its climb constants: the
  value is now a gradient, and `levelHeight` (map field, tile size by
  default) sets its scale.
- A game whose map-set snapshot schema declares `z`/`level` at indices 3 and
  4 adds `role: 'z'` and `role: 'level'` to those two fields; without them
  `load_map` now returns an error instead of quietly shipping a flat row.
- A game that puts a climbing body's mask together itself switches to
  `levels_interaction_on_ramp(mask)` (or `body_filter(mask, true)`) while
  the body is on a run; grounded bodies need no change.

### Added

- `MapConfig::level_height` (`levelHeight` in the map JSON) — the height of
  one level in world units, optional, the tile size by default, scaled by the
  map scale like `step`. `MapLevels::level_height()` exposes the effective
  value.
- `map::RAMP_GUARD_GROUP` (bit 9) and the ramp guard colliders:
  `GameMap::create_static` closes both sides of every ramp run and its far
  end on layered maps, so a run cannot be entered from the side or from the
  wrong end any more. The foot of the run stays open. `body_filter(mask,
  on_ramp)`, `levels_interaction_on_ramp(mask)` and
  `ramp_guard_interaction(low)` are the one place the guard bit is put into a
  filter.
- `config::FieldRole` and `BlockSchema::with_levels()` /
  `validate_level_roles(key)`.

### Fixed

- `validate_levels` rejects two ramps that share a cell: the run that claimed
  it was picked arbitrarily (the first declared one), so the climb did not
  follow from the map.

## [0.12.0] — 2026-09-04

### ⚠️ Breaking

- `MAX_LEVELS` is now **8** (ground plus seven overhead levels) and
  `level_group(level)` gives every level a bit of its own instead of folding
  everything above ground into `GROUP_2`. Levels take bits 0..7,
  `STATIC_LEVEL_GROUP` keeps bit 8; the values for levels 0 and 1 are
  unchanged, so masks already built on two levels behave exactly as before. A
  level out of range is clamped to the top one (`debug_assert!` in debug):
  in release a shift of 32 or more would panic and take the round down.
- `map::RampSample` gained `dir`, `slope`, `run` and `axis`. The uphill unit
  vector and the steepness (levels per world unit) are what a game needs to
  compute the grade under a heading, and `run`/`axis` are what tells entering
  a run from its foot apart from driving onto it from the side.
- `map::validate_levels` takes the ground level's `layers` and `volumes`
  ahead of `levels`/`ramps`: the render-layer heights are validated for level
  0 too, and level 0 lives in the root of the map config.
- `GameMap::dynamic_map_data(world, with_levels, with_velocities)` — with
  `with_levels` the row head becomes `[x, y, angle, z, level]`. The head, not
  the optional tail: a missing tail unpacks as zeros, and a crate resting on
  a bridge would land on the ground at the viewer. The engine turns it on
  from the schema the game declared for the map set (fields 3 and 4 named `z`
  and `level`), so a game with the old schema keeps the three fields it has.

### Migration

- A game crate that calls `map::validate_levels` passes the ground level's
  `layers` and `volumes` first: `validate_levels(map, physics_static, layers,
  volumes, levels, ramps)`. A client-side map config that has no render
  layers passes two empty `IndexMap`s.
- A game that calls `GameMap::dynamic_map_data` adds the `with_levels` flag
  ahead of `with_velocities`; `false` keeps the previous three-field row.
  To turn the levels on, declare `z` and `level` as fields 3 and 4 of the map
  set's snapshot schema and set `optionalFrom` to 5 — the engine reads the
  flag from the schema on its own.
- Code that matched on `level_group` expecting `GROUP_2` for every overhead
  level now gets one bit per level. Masks written as
  `level_group(0) | level_group(1)` keep working; a mask meant to cover
  everything above ground has to be built by folding `level_group(l)` over
  the levels the map has.
- `GameMap::dynamic_levels()` returns an owned `Vec<u8>` instead of a slice.

### Added

- `map::FallModel` — one fall trajectory for the whole ecosystem (tanks and
  map bodies alike), linear in `z` but with a duration that grows with the
  height: `duration`, `z_at` and its inverse `elapsed_at`, which a client
  replica needs to restore the phase of a fall from an authoritative frame.
  Its `time_per_level` comes from the new `EngineConfig.mapFallTime`
  (`DEFAULT_FALL_TIME`, 0.35 s).
- `map::MapLevels::landing_level(from, x, y)` — the nearest level strictly
  below `from` with a floor in that cell. A slab under a ledge is a legal
  landing, so ledges no longer have to end over walkable ground: the slab
  edge check, the bot ledge edges and the fall rules all ask this.
- Level rules for map bodies: `BodyLevelState`, `BodyLevelEvent`,
  `step_body_level`, `body_collision_mask` and the host wiring
  `GameMap::step_dynamic_levels` / `dynamic_level_state`, called by
  `EngineSim::step_fixed` before the world step (a game only ever sees the
  map by `&`). A crate that runs out of floor falls to its `landing_level`,
  carries `STATIC_LEVEL_GROUP` while it falls and takes the group of the
  level it lands on. Ramps are not for bodies — they are pushed, not driven —
  so a body on a ramp cell keeps its level.
- `volumes` on the map config and on every level config: the visual height of
  a render layer in levels, `{ "<layers key>": 0.6 }`. The core does not use
  it (it travels to the client and lives in the renderer) but validates it:
  the key has to name a render layer of the same level and the height has to
  be finite and within `(0, MAX_LEVELS]`.
- `validate_levels` rejects a ramp that climbs through the floor of an
  intermediate level, now that a ramp may span more than one level.

### Changed

- Ledge edges of the bot graph land on `landing_level` instead of always on
  the ground, and `LEDGE_PENALTY` is multiplied by the height of the fall: a
  jump two levels down costs twice a jump of one.

## [0.11.0] — 2026-09-04

### Added

- `map::validate_levels(map, physicsStatic, levels, ramps)` — the shape checks
  of the layered fields as a free function. `MapConfig::validate` now calls
  it, and so can a game's client replica: `MAP_DATA` arrives over the network
  and a level grid that disagrees with the host's builds different geometry,
  desyncing prediction with nothing in the console.
- Two checks the layers were built for, in `validate_levels` (and in contract
  rule `E4`, which shares the case corpus at
  `packages/engine/contract/fixtures/layered/`):
  - a **ramp that arrives nowhere** — the cell past the top end of a run must
    be drivable surface of the level the ramp climbs to; otherwise the tank
    reaches the top and falls in the same step, and both the climb and the
    fall are normal rules, so nothing complains;
  - a **slab edge that is neither railed nor a ledge** — a `floor` cell whose
    neighbour is neither floor nor railing is a fall, and the fall has to land
    on walkable level-0 ground. Over the grid border or over a wall it is an
    error: level-0 walls are no obstacle to a tank on the slab, so an
    unrailed end drives it off the map.
- `STATIC_LEVEL_GROUP` and `static_level_interaction(level)` — a map wall now
  carries its level group **and** a shared static group. A body whose mask is
  `STATIC_LEVEL_GROUP` alone collides with the walls of every level and with
  no dynamic body at all, which is what a game needs for a tank falling off a
  ledge: it must not phase through a building on the way down, but tanks,
  crates, rays and blasts must not reach it either.

### Changed

- Static colliders built by `GameMap` are now created with
  `static_level_interaction(level)` instead of `level_interaction(level)`.
  Level filtering is unchanged for every existing mask (a level-N body still
  sees only level-N walls); only the extra membership bit is new.

## [0.10.0] — 2026-09-03

### Added

- **Layered maps (2.5D).** A map may now declare above-ground levels next to
  the ground it already had: the optional `levels` field (key — the level
  number as a string, value — `map`/`floor`/`walls`/`layers`) and the optional
  `ramps` field (`tile`, `dir`, `from`, `to`). A map without them loads exactly
  as before, bit for bit: level 0 stays in `map`/`physicsStatic`/`layers`.
  - `MapLevels` — the layered geometry without a physics world (grids, solid
    and floor tiles per level, ramp runs). Built by the host inside `GameMap`
    and by a game's client replica from the same `MAP_DATA` fields, so both
    sides read the level rules from one place: `level_at`, `has_floor`,
    `is_solid`, `ramp_at`, `cell_at`.
  - `RampRun` / `RampSample` / `RampDir` — a ramp's continuous run along its
    axis and the climb progress `0.0..1.0` at a point.
  - `level_group` / `level_interaction` / `levels_interaction` — Rapier
    `InteractionGroups` masks per level (level 0 — `GROUP_1`, level 1 —
    `GROUP_2`). Static and dynamic map bodies now carry their level's mask;
    a body that sets no groups keeps `Group::ALL` and still interacts with
    level 0, so single-level worlds do not notice the change.
  - `MapConfig::validate` — checked by `load_map` before any body is created:
    level numbering, grid dimensions, railings being part of the floor, ramp
    tiles, and levels named by respawns and `physicsDynamic`. Every one of
    these is silent at runtime otherwise.
  - `GameMap::levels`/`is_layered`/`level_count`/`level_at`/`has_floor`/
    `ramp_at`/`dynamic_level`, `DynamicObjectConfig.level`.
  - `respawns` accepts a 4th number — the level (`[x, y, angleDeg, level]`).
    Without it the level is derived from the geometry.
- `GameSim::set_actor_level` (default no-op) and the matching ABI method
  `set_actor_level(game_id, level)` — the engine calls it right after
  `spawn_actor`/`reset_actor` when the respawn point named a level. A game
  without levels ignores it.
- `client::raycast::walk_ray_cells` — the DDA cell walk lifted out of
  `ray_vs_grid`, so a game can make its own decision at every cell (2.5D: the
  ray changing level at a slab edge). `ray_vs_grid` is now a thin wrapper and
  behaves identically.
- `NavigationSystem::generate_layered` — a graph with nodes on every level,
  two-way ramp edges and one-way ledge edges (top → bottom, with a penalty),
  plus `PathPoint`, `find_path_on`, `random_point`, `is_walkable_on`,
  `has_obstacle_between_on`, `node_level`, `level_count`. `generate` and the
  single-level API are unchanged.
- `debug.json` — the map block reports `levels`, `layered`, `staticByLevel`,
  `ramps` and `dynamicLevels`; the nav block reports `nodesByLevel`,
  `rampEdges` and `ledgeEdges`.

## [0.9.2] — 2026-08-29

### Changed

- `abi::OP_DEBUG_JSON` — the name of the `debug.json` opcode is now read from
  one constant instead of being spelled out in `ENGINE_GAME_OPS`,
  `ENGINE_CLIENT_OPS` and both `dispatch` match arms. A list that drifts from
  its handler produces a core advertising an opcode it does not answer, and
  the engine reads that as "not handled" and silently takes the fallback path.
  The JS side already reads the name from one place
  (`src/config/abiOps.js`). Behaviour is unchanged.

## [0.9.1] — 2026-08-29

### Changed

- Documentation only: the doc comment warning that the snapshot accumulators
  must be drained (`pack_body`) before `serialize_state` went back to
  `serialize_state`, from where `abi_describe`/`dispatch` had displaced it.
  No behaviour changed, and a game does not have to follow this bump.

## [0.9.0] — 2026-08-29

### Added

- `export_game_core_abi!` / `export_client_core_abi!` now also emit
  `abi_describe()` and `dispatch(op, payload)` (stage 4 of
  `plan/plugin-forward-compat`). `abi_describe()` returns
  `{ abi, core, ops }` — the self-description format version, the version of
  *this* crate the core was built against (`abi::CORE_VERSION`, not the game
  crate's) and the dispatch opcodes the core understands: the engine learns a
  core's capabilities when it loads it, not in the middle of a match.
  `dispatch` returns an empty vector for "opcode not handled" and the single
  byte `[0x00]` for "handled, no answer".
- `GameSim::dispatch_op` / `dispatch_ops` and their `GameClientDef` mirrors,
  both with default implementations — a game that needs neither writes no
  code, and a game crate that only bumps the dependency keeps compiling.
- The exported symbol set of both macros is **frozen** (see the header of
  `src/abi.rs`): future core capabilities arrive as `dispatch` opcodes, not
  as new exports. A symbol that is missing from an already published `.wasm`
  can never appear there, so growing the export table is what ages a game.
  The first engine opcode is `debug.json`, mirroring the frozen `debug_json`
  method, which stays in place.

## [0.8.3] — 2026-08-21

Released without journal entries: the only change is a test — the
`game_rows_alone_still_raise_the_tail_flag` case now feeds spectator frames
(no player block), so `my_game_id` stays `None` and the branch it means to
cover is actually reached (`d66d2aa`). No crate code changed.

## [0.8.2] — 2026-08-21

Released without journal entries: the only change is internal — `write_hot`
now looks a row's width up in a reverse `id → width` index built once in
`ClientState::new`, instead of scanning the snapshot schema for every
predicted row of every frame (`8c379eb`).

## [0.8.1] — 2026-08-21

### Fixed

- The hot buffer's `HOT_HAS_PREDICTED` flag is raised when the game returned
  only its own predicted rows (`GameClientDef::render_rows`) without a
  predicted record for the local actor. The flag means "there are trailing
  records behind the groups", and both JS consumers gate the parse of the
  whole buffer on it, so such a buffer used to be dropped unparsed.

## [0.8.0] — 2026-08-21

### Added

- `ClientState::game()` — access to the game half of the core: a plugin's ABI
  wrapper (`ClientCore`) reaches its own subsystems through it, whose shape the
  engine never knows.

## [0.7.0] — 2026-08-21

### Added

- `GameClientDef` hooks for bodies a game predicts itself (map dynamics,
  remote actors in contact with the local one), all with empty defaults:
  `begin_reconcile(&DecodedSnapshot)` hands the game the authoritative frame
  before the input replay, `finish_reconcile()` runs right after
  `on_server_state` so the divergence is folded once the replay has carried
  those bodies too, and `render_rows() -> Vec<PredictedRow>` returns rows for
  the render tick.
- `PredictedRow` — a row (`key_id`, `id`, `fields`) with which a game
  overrides an interpolated one. `write_hot` appends the rows after the
  predicted tail in the same record shape and brings each row's width to the
  key's schema (extra fields dropped, missing ones zero-filled), so a stray
  row cannot shift the parse of the rest of the tail. Reading a record puts
  it into `game[key][id]`, so a trailing row wins over the interpolated one —
  the same mechanism the predicted tail of the local actor already used.

## [0.6.0] — 2026-08-20

### Added

- Optional row tail in the snapshot schema: `BlockSchema.optionalFrom` marks
  the index of the first field that is written only when the row carries it.
  Such a row starts with a flag byte (`1` — the tail follows, `0` — the row
  ends after the mandatory part), so a body that has nothing to report does
  not pay for the tail every frame. Decoding still yields a **full-width**
  row — a missing tail reads as zeros — so the interpolator, the hot buffer
  and the JS side stay fixed-width. `SnapshotConfig::validate()` rejects an
  `optionalFrom` that points outside a non-empty tail.
- `GameMap::dynamic_map_data` can append the velocity tail
  (`vx`, `vy`, `angvel`) of a moving body; a resting one (asleep, or below
  `REST_VELOCITY_EPSILON` in both linear and angular speed) ships only its
  transform. The client predicts map dynamics next to its own tank, and a
  velocity estimated by finite differences between 30 Hz frames is worst
  exactly at the moment of impact.

### Changed

- **Breaking.** `GameMap::dynamic_map_data(world)` takes a second argument,
  `with_velocities`. `EngineSim::build_snapshot_blocks` derives it from the
  map set's own schema entry (`optionalFrom` present), so the engine never
  imposes a row width on the game.
- **Breaking.** The frame format is v5 (see the npm package's changelog):
  the engine and the game crate have to ship as a matching pair.

## [0.5.0] — 2026-08-20

### Added

- `client::collision` and `client::rigid_body` — the contact primitives a
  client needs to predict the geometry the host resolves. `collision`
  brings `box_center_from_origin` (a map body's origin corner → the box
  centre), `obb_vs_obb` (SAT, returning the minimum translation vector,
  the depth and a blended contact point) and `collect_tile_contacts` (an
  OBB against the solid cells of the tile grid); it reads the map through
  the same `Box2` and the same grid triple as `client::raycast`, so a ray
  and a contact can never disagree about a wall. `rigid_body` brings the
  `Body`/`Surface`/`MassProperties` types, `integrate`, `separate_bodies`
  and `apply_contact_impulse` (a sequential-impulse solver with
  restitution and a Coulomb friction cone), `box_mass_properties` and
  `combine_surfaces` (Rapier's `CoefficientCombineRule::Average`). Its
  `MAP_SURFACE` is built from `map::DEFAULT_FRICTION` /
  `DEFAULT_RESTITUTION`, now public, so the replica and the host cannot
  drift apart on surface values. `client::raycast::Box2` is now `Copy`.

### Fixed

- Dynamic map objects no longer sink into geometry on impact. Rapier's
  default contact prediction distance is 0.002 units, a figure meant for a
  metre-scale world, while a body in a match covers orders of magnitude more
  per `1/120` step — so the contact was born only once the shapes already
  overlapped deeply. `GameMap::create_dynamic` now builds the body with
  `soft_ccd_prediction(width.min(height))`, the object's own thickness.
  Static walls are unchanged.

## [0.4.0] — 2026-08-19

### Added

- `GameSim::apply_aim(game_id, seq, x, y, flags)` and
  `GameClientDef::apply_aim(x, y, flags, local_now)` — the pointer input
  channel (mouse, finger, stylus), carrying a value the discrete
  `apply_input(action, key_name)` string cannot: a **world** point plus a bit
  mask (bit 0 «pressed», bit 1 «double tap»). Both are declared with a
  **default empty body**, so a game crate that ignores the pointer compiles
  unchanged; `export_game_core_abi!` and `export_client_core_abi!` expose
  them as `apply_aim(...)` on the respective WASM cores. The engine converts
  screen coordinates to world coordinates before the call, so the game half
  gets a point in the same space as `actor_position`.

## [0.3.0] — 2026-08-09

### Added

- `ClientState::resync()` — clears the network half only (interpolation
  buffer, outgoing frame queue), leaving prediction and the local identity
  intact. For a tab returning from a long pause: the clock offset is
  reseeded from the next frame instead of being chased by the EMA for dozens
  of frames, while entities on the canvas stay alive. Exposed as `resync()`
  by `export_client_core_abi!`.

### ⚠️ Breaking — `reset()` also clears `my_game_id`

`ClientState::reset()` (the `CLEAR` port) means "the world is gone", so it
now drops the local player's identity as well. Previously the identity
survived a clear, and the game half kept rendering a predicted entity for a
player the host no longer had — a ghost on an otherwise empty canvas after a
map change. The identity is restored from the first player block that
follows; a spectator has none, so no predicted entity is drawn.

### Migration

A game crate that reads `my_game_id()` right after a `CLEAR` now gets
`None`; wait for the first frame carrying a player block. A `GameClientDef`
that keeps its own copy of the local actor's identity should clear it in its
`reset()` too (this is what `TanksClient` does with `my_tank_meta`).

### ⚠️ Breaking — `GameClientDef::set_server_offset` removed

The method handed the interpolator's offset to the game half once per render
tick, documented as "a latency estimate for RTT compensation of visual
effects". That description was wrong and the API existed only to serve it:
the offset is `serverTime − localNow`, where `serverTime` is the host's
`Date.now()` and `localNow` is the client's `performance.now()` — a clock
difference on the order of 1e12 ms, not a network delay. A game that took it
for a latency and extrapolated a spawn position by `velocity × offset` threw
the entity out of the world (visible only while moving; standing still the
term is zero). Nothing else needed the hook: reconciliation already receives
the offset as an argument of `on_server_state`, and `ClientState::offset()`
(ABI `offset()`) still exposes it for diagnostics, now documented as a clock
difference.

### Migration

Delete `set_server_offset` from every `impl GameClientDef` — no replacement
call is needed. A game that used it to compensate a locally spawned entity's
position should spawn at the predicted position and let the authoritative
row correct it once on confirmation (rename it to the local id instead of
dropping it, so the entity is updated rather than recreated).

## [0.2.1] — 2026-08-05

### Fixed

- `DivergenceTracker` with `capacity: 0` reported one eviction more than it
  performed: the buffer always keeps one record, but the counter assumed an
  empty buffer, so a report claimed "N dropped" after N−1 evictions. The
  configured capacity is now clamped to at least 1 (`client/divergence.rs`).

## [0.2.0] — 2026-08-05

### Added

- `debug.rs` — a curated world dump behind `debug_json`: bodies, map, nav
  and RNG state in one JSON slice, so "the core has a body, the canvas is
  empty" is visible from a single file.
- `client/divergence.rs` — a prediction-drift tracker behind
  `take_divergence`: the predicted state is captured before reconciliation
  and compared with the frame's player block, matched by frame time rather
  than by input `seq`.
- `GameClientDef::predicted_state` — drift detection level 1. A game that
  implements it gets a component-wise comparison of its own predicted state;
  a game that does not falls back to level 0 (the overlay camera).
- Config section for the detector (`config.rs`) and the corresponding ABI
  entries (`abi.rs`), so a game implements nothing to get either feature.

## [0.1.0] — 2026-07-26

### Added

- First published release. The simulation framework extracted from the game
  core into a reusable rlib: `rapier2d` physics, map model, snapshot frame
  codec, interpolation/prediction/raycast primitives, navigation and spatial
  utilities, RNG, and the `macro_rules!` ABI generators. Deliberately without
  `wasm-bindgen` — the WASM ABI wrappers are built by each game's own crate.

[0.22.4]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.22.4
[0.22.2]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.22.2
[0.22.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.22.1
[0.22.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.22.0
[0.21.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.21.0
[0.20.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.20.0
[0.19.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.19.0
[0.16.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.16.0
[0.15.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.15.0
[0.14.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.14.1
[0.14.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.14.0
[0.13.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.13.0
[0.12.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.12.0
[0.10.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.10.0
[0.9.2]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.9.2
[0.9.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.9.0
[0.8.3]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.8.3
[0.8.2]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.8.2
[0.8.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.8.1
[0.8.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.8.0
[0.7.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.7.0
[0.6.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.6.0
[0.5.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.5.0
[0.4.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.4.0
[0.3.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.3.0
[0.2.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.2.1
[0.2.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.2.0
[0.1.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine-core%400.1.0
