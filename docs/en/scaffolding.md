# Scaffolding a game plugin (`create-vimp-game`)

The engine imports no game code by path: a game is a separate npm package
that ships a `dist/manifest.json` and two bundles. Writing that package from
zero means reproducing a build pipeline, a Rust crate, a snapshot schema and
about thirty silent invariants before the first pixel appears — and the
usual result is a plugin that builds but never shows up in the lobby.

`create-vimp-game` writes that package for you, already playable:

```bash
npm create vimp-game my-game
```

The generator lives in this repository under `packages/create-vimp-game/`
and is published as its own npm artifact, driven by `npm run release` — see
[publishing.md → Step A3](publishing.md#step-a3-publish-create-vimp-game-on-npm);
it has no runtime dependencies, so `npm create` does not install a tree
before asking its first question.

## The command

```bash
npm create vimp-game <directory> [-- <options>]
```

Everything after `--` reaches the scaffolder. Without `--yes` and with a
live terminal it asks five questions (directory, game id, title, package
name, author); with `--yes`, under a pipe or in CI it takes the defaults
silently.

| Option | Meaning |
| --- | --- |
| `--id <id>` | game id, kebab-case — the URL segment `/games/<id>/`, the catalog key and `HostPlugin.id` (default: the directory name, normalised) |
| `--title <title>` | human-readable title (default: the id, title-cased) |
| `--package <name>` | npm package name (default: `@vimp-games/<id>`) |
| `--author <name>` | `author` in `package.json` and the `LICENSE` |
| `--yes`, `-y` | accept all defaults, ask nothing |
| `--force` | allow a non-empty target directory |
| `--no-git` | skip `git init` (the first commit is always yours) |
| `--engine-path <p>` | dev only: depend on a local engine checkout |
| `--core-path <p>` | dev only: `[patch.crates-io]` for `vimp-engine-core` |
| `--help`, `--version` | print usage / the scaffolder's own version |

`cargo` and `wasm-pack` are checked after generation. Missing ones are a
warning, not a failure: the project is written either way, and the error
would otherwise surface on `npm run core:build` with no project to fix it
in.

**Versions are never hardcoded in the template.** The `vimp-engine` and
`vimp-engine-core` pins are read from the engine itself — from
`packages/engine/package.json` and `packages/engine/core/Cargo.toml` when
the scaffolder runs inside this repository, otherwise from
`src/versions.generated.json`, written by the `prepack` hook at publish
time. A stale pin is a silent breakage that only surfaces when the core is
built, so the template carries no version literal to go stale.

## What you get

A minimal but complete game — not a copy of tanks, and not a skeleton of
`TODO`s:

- two playing teams plus spectators, one actor class, one hitscan weapon,
  one map, bots;
- **all graphics are procedural** (PixiJS `Graphics` plus bakers): the
  package ships no images at all. Sounds are two placeholder `webm`+`mp3`
  pairs, with the `assets/audio-raw/` → `npm run audio:process` pipeline
  wired but optional (it needs ffmpeg);
- the full build infrastructure of [plugin-api.md](plugin-api.md): two Vite
  modes (`client`, `host`), the five build scripts, a Cargo workspace with
  the crate `<id>-core`, Vitest with a `unit` and an `integration` project,
  ESLint;
- a Rust core where the movement math sits in one `motion.rs` shared by the
  server step and the client predictor, with a parity test guarding that
  sharing;
- a dev harness (`index.html` + `dev/main.js`) starting a standalone match
  against bots — see [standalone.md](standalone.md);
- a `CLAUDE.md` stating the thread boundaries, the contract constants and
  the check commands, for whoever (or whatever) writes the gameplay next.

Layout and per-file contracts: [plugin-api.md](plugin-api.md), and
`docs/ai/02-packaging.md` for the LLM-facing form of the same thing.

## The check loop

In the generated project, in this order:

```bash
npm install
npm run core:build      # cargo + wasm-pack → core/pkg-web, core/pkg-node
npm run check:contract  # vimp-contract: the static engine↔game contract
npm run core:test       # cargo test --workspace (includes the parity test)
npm test && npx eslint .
npm run build           # dist/: both bundles, maps, sounds, manifest.json
npm run sim             # a headless match on the real core
npm run dev             # the same match in the browser, against bots
```

`npm run core:build` is not optional and not a later step: `dev/main.js`
imports the wasm from `core/pkg-web/`, so until the core has been built once
`npm run dev` dies on startup while resolving that import.

`check:contract` is the step that pays for itself. It is `vimp-contract`
from the engine package — 32 rules over `package.json`, `vite.config.js`,
`core/Cargo.toml`, `dist/manifest.json` and both plugin halves imported as
modules; a rule with no input reports `skip`, so it is usable from the first
commit. It catches exactly the class of mistake that otherwise reaches the
browser as a black canvas: a wrong auth parameter name, a snapshot key with
no `gameSets` entry, a part missing from `entitiesOnCanvas`. Details:
[debugging.md](debugging.md).

`scripts/build-game-manifest.js` also copies your `package.json` `version`
into the manifest as `packageVersion` — the engine shows it in the `#auth`
footer, since the manifest's own `version` is a bundle hash and means nothing
to a player. Nothing else reads the field, and a manifest without it is still
valid (see [plugin-api.md](plugin-api.md)).

## Developing against a local engine checkout

While the engine and the game move together, the published versions are
useless. Both halves have to be linked — the dev server serves the plugin's
sources through `/@fs/`, so a one-way link is not enough:

```bash
npm create vimp-game my-game -- --yes \
  --engine-path ../vimp/packages/engine \
  --core-path   ../vimp/packages/engine/core
```

`--engine-path` replaces the `vimp-engine` pin with a `file:` dependency on
your checkout; `--core-path` appends a `[patch.crates-io]` section to the
game's `Cargo.toml` so cargo builds against the local crate instead of the
published one. Both are development conveniences and must be undone before
publishing the game.

Without those flags the equivalent is the manual link described in
[getting-started.md](getting-started.md) — `npm link` in both directions,
plus `npm link <game-package>` in the engine so the master can resolve the
game.

## Keeping the template honest

Template files carry `{{TOKEN}}` placeholders and therefore do not build in
place: every check goes through a real generation into a temporary
directory. `npm run test:scaffold` in this repository does exactly that —
scaffolds a game, builds the core, runs the contract check, the tests, the
build and `sim`. It needs cargo and wasm-pack and takes minutes, so it is
not part of `npm test`; CI runs it as its own job.
