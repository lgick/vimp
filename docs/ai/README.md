# VIMP Engine — Game Authoring Guide for LLMs

This directory is a thin **meta-layer for a language model** that must create a
complete game plugin from scratch (the way `@vimp-games/tanks` is one). It holds
no contract text of its own: the contract lives in the canonical, bilingual
[`docs/en/`](../en/README.md) tree, and this layer only says **what to read, in
which order, and what to do with it**.

Everything the contract requires — field names, defaults, byte layouts, method
signatures — is in `docs/en/`. When a statement here and a page there differ,
the page wins (and the code wins over both).

## What you are being asked to build

A **game plugin**: a standalone npm package, developed in its own repository,
that the engine loads dynamically at runtime. The engine owns networking,
rooms, rounds, chat, votes, statistics, input plumbing, rendering
infrastructure and the physics/frame primitives. The plugin owns the rules:
what entities exist, how they move, how they fight, how they look and sound.

A plugin is four artifacts built into one `dist/`: a host plugin (Worker, JS),
a client plugin (main thread, JS + PixiJS), a WASM core (Rust, both halves in
one `.wasm`) and `manifest.json` with maps, sounds and images.

**Every asset the game needs is yours.** The engine serves no game file of any
kind — there is no shared tile library, so plan for authoring or sourcing your
own images from the start ([`maps-and-assets.md`](../en/maps-and-assets.md)).

## Reading order

Read these before asking the user anything; the numbers in them are contract
values, not examples.

| Page                                             | Why                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| [`architecture.md`](../en/architecture.md)       | Topology, who owns what, room lifecycle, version gates                  |
| [`plugin-api.md`](../en/plugin-api.md)           | `GameManifest`, `HostPlugin`, `ClientPlugin`, Wasm ABI, snapshot schema |
| [`packaging.md`](../en/packaging.md)             | Package layout, manifest, the two Vite builds, wasm-pack, dev mode      |
| [`host.md`](../en/host.md)                       | Worker host, meta modules, `gameConfig`, handoff                        |
| [`client.md`](../en/client.md)                   | Client modules, parts, input, sound, hooks                              |
| [`core.md`](../en/core.md)                       | Rust crate, generic traits, determinism, prediction                     |
| [`network.md`](../en/network.md)                 | Ports, frame format, opcodes                                            |
| [`maps-and-assets.md`](../en/maps-and-assets.md) | Map JSON, image and sound pipelines                                     |
| [`scaffolding.md`](../en/scaffolding.md)         | `npm create vimp-game` — the fastest valid starting tree                |
| [`debugging.md`](../en/debugging.md)             | Headless runner, scenarios, the invariant checks                        |
| [`pitfalls.md`](../en/pitfalls.md)               | Checklist of every silent contract                                      |

## Process

1. **Read** the pages above, in order.
2. **Interview** the user with [`questionnaire.md`](questionnaire.md). Its text
   is Russian, but conduct the interview in the language the user writes in.
   Ask block by block, offer the "same as tanks" default for every question,
   and never ask what the user has already answered implicitly.
3. **Design**: write a design document summarising the answers (the
   questionnaire ends with an answer → artifact mapping) and get the user's
   confirmation before generating code.
4. **Generate** the plugin following [`workflow.md`](workflow.md): scaffold →
   configs → Rust core → client → tests → build → link → smoke, with the
   rebuild matrix.
5. **Verify**: run the headless runner ([`debugging.md`](../en/debugging.md))
   until its invariant checks are green — a text-only loop, no browser — then go
   through [`pitfalls.md`](../en/pitfalls.md) before declaring the plugin done.
6. **Document** the game: a plugin ships its own bilingual docs, see "The
   documentation a plugin must ship" in [`packaging.md`](../en/packaging.md).

## Invariants

- **Numbers are contract values.** `ENGINE_API_VERSION = 4`,
  `PLAYER_STATE_LEN = 8`, `WORLD_VOICE_LIMIT = 30`, the byte layouts — a plugin
  cannot change them. If a generated plugin disagrees with one, the plugin is
  wrong.
- **"Optional" means optional only where `docs/en/` says so.** Several fields
  look optional but are mandatory; the pages state the real requirement.
- **Silence is the failure mode.** Most violations do not throw: they give a
  black canvas, a missing panel cell, an ignored room setting, a part that is
  never constructed. `pitfalls.md` and `vimp-contract` exist because of this.
- **Do not read engine or tanks sources to learn the contract.** The pages are
  sufficient; a plugin never imports engine code by path.
