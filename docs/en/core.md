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
│   ├── snapshot.rs                # SnapshotPacker + Block — packs the v3 binary frame;
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
│       ├── unpack.rs              # the v3 frame decoder + JSON forms
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
  tests.

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
  `remove_players_and_shots`, `clear`, `serialize/deserialize` (mid-round
  handoff — kept as groundwork), `rebuild_spatial_grid`.
- `SimCtx<'a>` — the game's access to engine facilities inside the tick
  callbacks; **not** generic over the game: `world` (Rapier), `cfg`
  (`EngineConfig`), `map` (respawns — `IndexMap<String, Vec<[f32;3]>>`,
  arbitrary teams), `nav`/`spatial` (A*/grid — engine utilities in a `nav/`
  module, no "bot" wording), `rng`, `events`, `bodies_to_destroy`. There is
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
  host resolves them: `obb_vs_obb` / `collect_tile_contacts` produce the
  `Contact`s (they read the map through the same `Box2` and the same tile
  grid as `raycast`, so a ray and a contact can never disagree about a
  wall), `separate_bodies` + `apply_contact_impulse` resolve them on
  `Body` values, and `MAP_SURFACE` reuses `map::DEFAULT_FRICTION` /
  `DEFAULT_RESTITUTION` — the same figures the host builds its colliders
  with. This is an approximation of Rapier, not a copy; the remaining drift
  is hidden by the game's reconciliation.

The trait's shape is validated by a fixture second client (`TestClient`,
tests in `packages/engine/core/src/client/game.rs`) before any real second
game exists — this is what guarantees the traits stay game-agnostic.

## Debugging: `debug_json` and the divergence detector

Two debugging facilities live in the engine crate and are exported through
the ABI macros, so every game gets them for free and
`ENGINE_API_VERSION` is unaffected. The full loop that consumes them is
[debugging.md](debugging.md).

- **`debug.rs` — `EngineSim::debug_json()`** (exported as
  `GameCore.debug_json()`): a *curated* world dump, next to the raw
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
  (`thresholds` positional, `defaultThreshold`, ring-buffer `capacity`) —
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

| Layer | Where | Covers |
| --- | --- | --- |
| Rust unit | `packages/engine/core/src/*` (`#[cfg(test)]`) | PRNG, the nav grid, A*, the spatial grid; the client module: round-trip unpack, the interpolator (seq/dedup/late/lerp), raycast, SAT contacts and the contact solver, the hot buffer; the `GameClientDef` trait's shape validated against a fixture `TestClient` |
| Rust integration | this repo has none — a game's simulation scenarios (driving, weapons, bots, handoff, etc.) are that game repo's concern | — |

`npm run core:test` runs `cargo test --workspace`, which in this repo is
just `packages/engine/core` — this is where the engine crate's own unit
tests run and where any change to its traits/macros/framing must be
verified. A game repo's own `cargo test --workspace` only exercises its
own game crate (a dependency on `vimp-engine-core`, not a workspace
member), so it doesn't re-run these tests — CI on this repo is the source
of truth for the engine crate itself.

---

[← Previous: Browser Host](host.md) · [Next: Client Modules →](client.md)
