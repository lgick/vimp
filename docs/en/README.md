# VIMP Documentation

A multiplayer 2D real-time online game on a P2P architecture: a browser host
(Web Worker + Rust core in WASM) runs the authoritative simulation, PixiJS
clients connect over WebRTC, and a Node.js master server handles the lobby
and signaling.

## Sections

| Page | Covers |
| --- | --- |
| [getting-started.md](getting-started.md) | Local setup: install, linking a local game plugin, HTTPS certificates, auth service, running, development loop, tests, local multiplayer |
| [architecture.md](architecture.md) | Overall architecture: master/host/client, game loop, connection lifecycle, key invariants |
| [master.md](master.md) | Master server (entry point): room registry, `GET /servers`, map catalog, WebRTC signaling, `/like`·`/unlike` server rating |
| [auth.md](auth.md) | Central auth service (`packages/auth/`): OAuth login, global nick, JWT/JWKS, per-game rank/state |
| [host.md](host.md) | Browser host: Worker with the core, `GameCoreAdapter`, the host facade, meta modules, host-player loopback, main-thread router |
| [core.md](core.md) | Rust engine core (`vimp-engine-core`): `packages/engine/core/` layout, generic traits/macros, snapshot framing, build, tests |
| [client.md](client.md) | Client modules: MVC components, client core (interpolation/prediction/shot spawning), rendering, sound |
| [standalone.md](standalone.md) | Standalone SDK (`vimp-engine/standalone`): a playable match in one tab without master, OAuth or lobby — options, container, assets, how solo differs from production |
| [dedicated.md](dedicated.md) | Dedicated Node.js server: one 24/7 match of one game in a Node process, direct WebSocket, entry-point fork, environment variables, limitations |
| [network.md](network.md) | Host↔client sync: WebRTC channels, port protocol, binary snapshot frame (v3), data formats, RTT |
| [configuration.md](configuration.md) | Engine configuration: `.env` variables, every file under `packages/engine/src/config/` |
| [debugging.md](debugging.md) | Debugging loop: headless runner (`npm run sim`), scenario format, invariant checks, core dumps, prediction divergence, browser recorder |
| [deployment.md](deployment.md) | Deployment: VPS setup, adding/removing servers, CI/CD |
| [publishing.md](publishing.md) | Releasing: the `npm run release` script, the changelog headings that set the version, publishing the `vimp-engine-core` crate, the `vimp-engine` package and the game plugin, rolling out production, the order between them |
| [scaffolding.md](scaffolding.md) | The `npm create vimp-game` scaffolder: flags, what the minimal game contains, the check loop (`check:contract` → `core:test` → `sim` → `dev`), developing against a local engine checkout |
| [plugin-api.md](plugin-api.md) | Engine ↔ game plugin contracts: GameManifest, HostPlugin, ClientPlugin, Wasm ABI, snapshot schema, versioning |

Game rules and content-authoring docs (gameplay, extending, game-specific
configuration/core) live in the active game plugin's own repository, e.g.
[vimp-tanks/docs/en/](https://github.com/lgick/vimp-tanks/blob/main/docs/en/README.md).

Writing a game plugin with an LLM? [docs/ai/](../ai/README.md) is a separate,
self-contained specification of the whole plugin contract (plus an authoring
workflow and an interview questionnaire) aimed at language models — not part
of this bilingual set.

## Where to start

- **I want to run it locally** → [getting-started.md](getting-started.md)
- **I want to understand how it works** → [architecture.md](architecture.md), then [host.md](host.md) / [client.md](client.md) / [network.md](network.md)
- **I want to start a new game plugin** → [scaffolding.md](scaffolding.md)
- **I want to run my game plugin without the master** → [standalone.md](standalone.md)
- **I want to run a 24/7 server without a host tab** → [dedicated.md](dedicated.md)
- **I want to host my own server** → [deployment.md](deployment.md)
- **I want to ship an update** → [publishing.md](publishing.md)
- **Something is silently broken in a match** → [debugging.md](debugging.md)
- **I want to add a map/weapon** → the active game plugin's own docs (e.g. [vimp-tanks/docs/en/extending.md](https://github.com/lgick/vimp-tanks/blob/main/docs/en/extending.md))

> Documentation is maintained alongside the code: whenever functionality changes, the relevant page is updated in the same change (a rule codified in [CLAUDE.md](../../CLAUDE.md)).
