# CLAUDE.md

## Overview

`{{PACKAGE_NAME}}` is a game plugin for the VIMP engine: the engine owns
networking, rounds, chat, panel and stat; this package owns the game. Only
`dist/` is published. The full contract lives in the engine repository under
`docs/ai/` (`03-host-plugin`, `04-client-plugin`, `05-wasm-core`,
`06-snapshot-protocol`, `10-pitfalls`) — read it there, it is not copied here.

## Boundaries

- `src/host/` runs in a **Web Worker**: no DOM, no PixiJS, no `window`.
- `src/client/` runs in the **main thread**: PixiJS parts and bakers only.
- `core/` (Rust) owns **all** physics, movement and damage. The engine does
  none of it: `core/src/game.rs` and `core/src/motion.rs` are the simulation,
  and `motion.rs` is shared by the host step and the client predictor — moving
  logic out of it desynchronises prediction from the server.

## Contract constants

- `ENGINE_API_VERSION` is always imported from
  `vimp-engine/config/opcodes.js`, never written as a literal.
- `PLAYER_STATE_LEN = 8` — the prediction budget `[x, y, angle, vx, vy, hp,
  ammo, 0]`; the JS and Rust sides must agree on it.
- Hot snapshot buffers are `indexed8` / `indexedNoNull8` only.
- `src/config/auth.js` must declare the `model` parameter — the engine expects
  that exact name.

## Order of work

1. snapshot schema and `src/config/` — decide what travels the wire first;
2. Rust simulation in `core/`, with `npm run core:test` green;
3. `npm run check:contract` and `npm run sim` — the machine reads the
   invariants the browser only hints at;
4. rendering: `src/client/parts/` and bakers.

## Commands

```bash
npm run core:build      # REQUIRED before npm run dev
npm run core:test
npm run check:contract
npm run sim
npm run build
npm test && npx eslint .
npm run dev
```

Any functional change updates the tests covering it in the same change;
`npx eslint .` and `npm test` end every change green.
