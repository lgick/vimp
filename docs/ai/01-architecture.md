# 01 — Architecture

## The P2P model

VIMP has no game server. The authoritative match runs **in the browser tab of
the player who created the room**, inside a Web Worker. Everyone else is a
client connected to that tab over WebRTC.

```
                    ┌────────────────────────────────┐
                    │ MASTER (Node.js, one per site) │
                    │  lobby · room registry         │
                    │  WebRTC signaling (WebSocket)  │
                    │  game catalog + map catalog    │
                    │  static /games/<id>/*          │
                    │  NO game logic, NO simulation  │
                    └───────┬────────────────┬───────┘
                            │ signaling      │ signaling
              ┌─────────────┴──────┐   ┌─────┴──────────────┐
              │ HOST TAB (browser) │   │ CLIENT TAB         │
              │ ┌────────────────┐ │   │ ┌────────────────┐ │
              │ │ Web Worker     │ │   │ │ main thread    │ │
              │ │  HostGame (JS) │ │   │ │  MVC + PixiJS  │ │
              │ │  host WASM core│◄├───┼─┤  client WASM   │ │
              │ └────────────────┘ │ W │ │  core          │ │
              │ main thread: also  │ e │ └────────────────┘ │
              │ a normal client    │ b │                    │
              └────────────────────┘RTC└────────────────────┘
```

- The host tab is **both** the authority and an ordinary player. Its own
  client half talks to its Worker through a loopback transport, not WebRTC.
- The master never executes plugin code. It reads the already-built
  `dist/manifest.json` and serves `dist/` statically.
- The host browser is **untrusted**. Anti-cheat is out of scope; the only
  countermeasure is social (server rating, see `08-gameplay-meta.md`).

## Who owns what

| Concern | Engine | Plugin |
| --- | --- | --- |
| Lobby, room registry, signaling | ✅ | — |
| WebRTC transport, ports, frame envelope | ✅ | — |
| Rounds, respawn cycle, scoring, team balance | ✅ (rules configurable) | supplies config |
| Chat, votes, statistics table, panel, timers, RTT/idle kicks | ✅ | supplies schema + texts |
| Auth screen skeleton, identity (JWT nickname) | ✅ | supplies fields + texts |
| Canvas creation, camera, sound engine, input plumbing | ✅ | supplies layout + assets |
| Physics primitives, snapshot codec, interpolation | ✅ (`vimp-engine-core`) | — |
| Entities, movement, weapons, damage, AI | — | ✅ (Rust) |
| Rendering (sprites, effects, particles) | — | ✅ (PixiJS parts) |
| Maps, models, weapons, sounds, textures | — | ✅ |
| Bots ("scripted participants") | ✅ lifecycle hooks | ✅ implementation |

The boundary is **URL-driven**: the engine never imports a plugin statically.
It loads `manifest.entries.client` in the client, `manifest.entries.host` in
the Worker, and the master only reads `dist/manifest.json`.

## Version numbers — three independent values

| Constant | Value | Meaning | Checked where |
| --- | --- | --- | --- |
| `ENGINE_API_VERSION` | `4`, frozen | Generation label of the plugin contract (`GameManifest`, `HostPlugin`, `ClientPlugin`, WASM ABI, form schema). **Not a gate**: no plugin is rejected for its age | nowhere at runtime; contract rule `B2` checks it is consistent inside the package |
| `SNAPSHOT_FORMAT_VERSION` | `3` | Byte layout of the state frame | inside the WASM core, both ends |
| `HANDOFF_VERSION` | `3` | Shape of the state blob passed when host duty migrates | `HostGame` (rejects a mismatched blob) |

A plugin publishes `engineApi` in **three** places and all three must agree
**with each other** (a mismatch means a stale `dist/`): `manifest.engineApi`,
`hostPlugin.engineApi`, `clientPlugin.engineApi`. Import `ENGINE_API_VERSION`
from `vimp-engine/config/opcodes.js` rather than hardcoding `4`. Agreeing with
the *installed* engine is not required — a game built a year ago runs on
today's build.

Compatibility is negotiated by capability, not by number. If your game cannot
run without a specific engine feature, list it in the optional
`manifest.requires`; the engine rejects the plugin only when a name is unknown
to its capability registry (`vimp-engine/src/lib/capabilities.js`), which means
the game is newer than the engine. On the master such a game stays in the
catalog, flagged `compat: {ok: false, …}` and shown unavailable in the lobby
(and the signaling server refuses to register a host for it);
`loadGamePackage`, `loadClientPlugin` and the standalone SDK throw. The SDK
reads the list from `HostPlugin.requires` / `ClientPlugin.requires`, since in
solo mode there is no manifest — declare the same list in all three places,
and keep them equal: rule `B2` refuses a package whose manifest and halves
disagree, and `loadGamePackage` warns about it. A manifest with no `requires` needs nothing
beyond the base contract.

Additionally, `manifest.id` must equal both the id configured in the master's
game list and the URL prefix the master mounts (`/games/<id>/`). A mismatch is
skipped with a warning and the game silently disappears from the lobby.

## Room lifecycle

1. **Create.** A logged-in user fills the room form in the lobby (fields come
   from `manifest.roomForm`, defaults from `manifest.roomDefaults`) and the
   tab sends `register_host` to the master over WebSocket. The master's
   `HostRegistry` sanitises the name (≤30 chars), clamps `maxPlayers` to
   `1..8`, and allows **one room per IP**.
2. **Boot.** The host tab spawns the Worker, which dynamically imports the
   host plugin, validates the required `gameConfig` fields,
   merges engine defaults with `gameConfig`, applies the room overrides,
   builds the core config and instantiates the WASM core.
3. **Join.** A client picks the room in the lobby; the master relays
   SDP/ICE; two data channels open (see below); then the port handshake runs.
4. **Play.** The Worker steps the simulation at a fixed rate and emits a
   binary state frame every Nth tick. Meta events (chat, votes, panel, stat,
   sounds, informs) travel as JSON messages on the reliable channel.
5. **Rotate.** Round ends on team wipe or timeout; map rotates when the map
   timer expires (a system vote picks the next one).
6. **End / handoff.** When the host leaves, the match either ends or the host
   duty migrates to another participant, carrying a `HANDOFF_VERSION`-tagged
   blob (participants, scores, current map, remaining map time — **not** the
   physics world).

## Transport: two data channels

| Channel | Config | Carries |
| --- | --- | --- |
| `meta` | `{ ordered: true }` — reliable, ordered | every JSON message `[portId, payload]` **and** any state frame that must not be lost |
| `state` | `{ ordered: false, maxRetransmits: 0 }` — unreliable, unordered | ordinary positional state frames |

A state frame is sent **reliably** (over `meta`) when it carries information
that cannot be reconstructed from a later frame:

```
reliable = body_has_events() || forceReset || shake
```

Otherwise it goes over `state` and losing it is harmless — the next frame
supersedes it. This is why events (shots, explosions, pickups) must live in
`class: 'event'` snapshot keys: those set `body_has_events()`.

## Client port state machine

Every client walks a fixed handshake before the first frame. Ports are small
integers (full table in `06-snapshot-protocol.md`).

```
host                                   client
────────────────────────────────────────────────────────────
CONFIG_DATA (0)      ──────────────►   build modules from config
                     ◄──────────────   CONFIG_READY (0)
AUTH_DATA (1)        ──────────────►   render auth screen
                     ◄──────────────   AUTH_RESPONSE (1) { …fields, token }
AUTH_RESULT (2)      ──────────────►   accepted / rejected
                     ◄──────────────   MODULES_READY (2)
MAP_DATA (3)         ──────────────►   build map parts, reset core
                     ◄──────────────   MAP_READY (3)
FIRST_SHOT_DATA (4)  ──────────────►   first full frame
                     ◄──────────────   FIRST_SHOT_READY (4)
────────────────── steady state ───────────────────────────
SHOT_DATA (5, binary) ─────────────►   interpolate + render
                     ◄──────────────   KEYS_DATA (5) "seq:action:name"
PANEL/STAT/CHAT/VOTE/SOUND/… ──────►
```

`AUTH_RESPONSE` carries the lobby JWT. The host verifies it against the
master's JWKS and takes the player's **nickname from the token claim** — the
auth form never contains a nickname field.

On map change the client is sent `CLEAR` (11) and then a new `MAP_DATA`,
re-entering the map step of the machine.

## The two WASM cores

One Rust crate, one `.wasm` file, two exported classes:

- **`GameCore`** — the authoritative simulation. Lives in the Worker. Steps
  physics, resolves damage, packs snapshot frames.
- **`ClientCore`** — the local half. Lives on each client's main thread.
  Decodes frames, interpolates remote entities, and **predicts the local
  player** so input feels instant.

Both are generated by macros from `vimp-engine-core`; you implement traits,
not the ABI. Details in `05-wasm-core.md`.

## Threading constraints

- The host plugin and everything it imports run in a **Web Worker**. No
  `window`, no `document`, no DOM APIs, no PixiJS. Only isomorphic APIs
  (`Date`, `Math`, `performance`, `setTimeout`, `queueMicrotask`, `fetch`).
- The client plugin runs on the main thread and may use PixiJS — but PixiJS
  must stay a **single shared instance** supplied by the engine (see
  `02-packaging.md`), never bundled into the plugin.
