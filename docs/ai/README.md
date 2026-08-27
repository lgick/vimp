# VIMP Engine — Game Authoring Guide for LLMs

This directory is a **self-contained specification of the VIMP Engine plugin
contract**, written for a language model that must create a complete,
working game plugin from scratch — the way `@vimp-games/tanks` is one.

You do **not** need access to the engine repository, the tanks repository, or
any package source to use this guide. Everything the contract requires —
every field name, every default, every byte layout, every method signature —
is reproduced here.

## What you are being asked to build

A **game plugin**: a standalone npm package, developed in its own repository,
that the engine loads dynamically at runtime. The engine owns networking,
rooms, rounds, chat, votes, statistics, input plumbing, rendering
infrastructure and the physics/frame primitives. The plugin owns the rules:
what entities exist, how they move, how they fight, how they look and sound.

A plugin is four artifacts built into one `dist/`:

| Artifact | Runs in | Written in |
| --- | --- | --- |
| Host plugin (`HostPlugin`) | the room creator's Web Worker | JS (Worker-safe, no DOM) |
| Client plugin (`ClientPlugin`) | every player's main thread | JS + PixiJS |
| WASM core (host + client halves) | both, as one `.wasm` | Rust |
| `manifest.json` + maps + sounds + images | served by the master | generated |

**Every asset the game needs is yours.** Tile sheets, dynamic-body sprites,
sounds, maps and configs all ship inside your package's `dist/` and reach the
client through the manifest's `assetsBase` (`${assetsBase}img/`,
`${assetsBase}sounds/`). The engine serves no game file of any kind — there
is no shared tile library to draw on, so plan for authoring or sourcing your
own images from the start. See [`07-maps-and-assets.md`](07-maps-and-assets.md).

## How to use this guide

**Step 1 — read everything in this directory, in order, before asking the
user anything.** The files are cross-referenced and the questionnaire assumes
you already know the contract. Do not skim: the numbers here are contract
values, not illustrative examples.

**Step 2 — interview the user** using [`12-questionnaire.md`](12-questionnaire.md).
The questionnaire text is written in Russian, but **conduct the interview in
whatever language the user is writing to you in**. Ask block by block, offer
the "same as tanks" default for every question, and never ask about something
the user has already answered implicitly.

**Step 3 — write a design document** summarising the answers, and get the
user's confirmation before generating code. Map every answer onto concrete
artifacts (the questionnaire ends with that mapping table).

**Step 4 — generate the plugin** following
[`11-authoring-workflow.md`](11-authoring-workflow.md), which prescribes the
order (scaffold → configs → Rust core → client → tests → build → link → smoke)
and lists which change requires which rebuild.

**Step 5 — verify.** Run the plugin through the engine's headless runner
([`13-debugging.md`](13-debugging.md)) until its invariant checks are green —
that is a text-only loop with no browser and no human — and only then go
through [`10-pitfalls.md`](10-pitfalls.md) before declaring the plugin done. That file is the checklist of every silent
contract in the engine — things that fail at runtime with no error, or with
an error far from the cause.

**Step 6 — document the game you just wrote.** A finished plugin ships its own
bilingual documentation; see "Documentation the plugin must ship" below.

## Documentation the plugin must ship

This directory documents the **contract**. A generated plugin must document
**itself** — the rules, numbers and decisions that are its own — because
nothing here can: the engine's docs describe every game and therefore none.

Write it as the shipped plugins do (`vimp-tanks`, `vimp-snakes`): two mirrored
trees, `docs/en/` (canonical) and `docs/ru/` (identical structure), each with a
`README.md` table of contents and these five pages:

| Page | Contents |
| --- | --- |
| `getting-started.md` | Requirements, install, the Rust toolchain, the build scripts, the fastest local match, linking against a local engine checkout, tests, the static contract check, the headless scenarios |
| `architecture.md` | Repository layout, how the plugin plugs into the engine (host/client/master), where the core's boundary runs, the client-side smoothing this game uses, the decisions the code depends on, the key invariants |
| `gameplay.md` | The rules a player experiences: the player journey, controls, scoring, chat commands, bots, kicks — and, explicitly, the engine features this game does **not** use |
| `core.md` | The Rust crate: layout, build, the ABI it fills in (commands, events, frames, state queries), the simulation model, determinism, tests |
| `configuration.md` | Every file under `src/config/` and `src/data/`, parameter by parameter, with the traps each one hides |
| `extending.md` | Recipes for adding content — one numbered procedure per artifact, each ending in the checks to run |

Rules for that documentation:

- **Do not duplicate the engine.** Transport, the master, Worker
  infrastructure, generic core traits and the plugin contract itself belong to
  the engine's own `docs/en|ru` tree — link out to
  `https://github.com/lgick/vimp-engine/blob/main/docs/en/...` instead of
  restating them. This directory (`docs/ai/`) is for authoring and is not
  linked from a plugin's docs at all.
- **Document the decisions, not just the fields.** The value of these pages is
  in the "why": why a config key exists, what breaks silently without it, what
  the alternative was and why it was rejected. A table of defaults that the
  code already states is worth little.
- **State what is deliberately absent.** Rounds, teams, votes, weapons,
  spectators — an engine feature a game does not use is a decision, and a
  reader who cannot tell it from an oversight will "fix" it.
- **Record the rule in the plugin's `CLAUDE.md`**: any functional change
  updates the matching `docs/en/` and `docs/ru/` pages in the same change,
  with an area → page table so there is no doubt which page that is.
- **Link the docs from the plugin's `README.md`** (a short list plus a pointer
  to the other language). The README stays a landing page; the depth lives in
  `docs/`.

## File map

| File | Contents |
| --- | --- |
| [`01-architecture.md`](01-architecture.md) | P2P topology, who owns what, version gates, room lifecycle, transport |
| [`02-packaging.md`](02-packaging.md) | Package layout, `manifest.json`, the two Vite builds, wasm-pack, dev mode, master routes |
| [`03-host-plugin.md`](03-host-plugin.md) | `HostPlugin` surface, full `gameConfig` reference, modules, chat commands, votes, rank/state, handoff |
| [`04-client-plugin.md`](04-client-plugin.md) | `ClientPlugin` surface, parts, bakers, canvases, panel, stat, chat/vote UI, input, sound, hooks, auth screen |
| [`05-wasm-core.md`](05-wasm-core.md) | Rust crate, `GameDef`/`GameSim`/`GameClientDef`, ABI macros, init JSON, events, determinism, prediction |
| [`06-snapshot-protocol.md`](06-snapshot-protocol.md) | Snapshot schema, the four kinds, frame v3 byte layout, hot buffer, all ports |
| [`07-maps-and-assets.md`](07-maps-and-assets.md) | Map JSON, scaling cascade, respawns, tile images and the image pipeline, sound pipeline, baked assets |
| [`08-gameplay-meta.md`](08-gameplay-meta.md) | Engine-owned rules you configure: rounds, scoring, teams, kicks, timers, sound cues, informs |
| [`09-reference-implementations.md`](09-reference-implementations.md) | Two worked examples: a minimal plugin in full, and tanks excerpts |
| [`10-pitfalls.md`](10-pitfalls.md) | Invariant and trap checklist — verify against this before finishing |
| [`11-authoring-workflow.md`](11-authoring-workflow.md) | Generation process, testing, build, linking, smoke test, rebuild matrix |
| [`12-questionnaire.md`](12-questionnaire.md) | The interview (Russian text, conduct in the user's language) + answer→artifact mapping |
| [`13-debugging.md`](13-debugging.md) | The headless runner (`npm run sim`), scenario format, the 12 invariant checks, world dumps, prediction drift, browser recording |

## Reading rules

- **Numbers are contract values.** `ENGINE_API_VERSION = 3`,
  `PLAYER_STATE_LEN = 8`, `WORLD_VOICE_LIMIT = 30`, the byte layouts — none
  of these are configurable by a plugin. If a generated plugin disagrees with
  one, the plugin is wrong.
- **"Optional" here means optional.** Several fields that older engine
  documentation calls optional are in fact mandatory. This guide states the
  real requirement; treat it as authoritative.
- **Silence is the failure mode.** Most contract violations in this engine do
  not throw. They produce a black canvas, a missing panel cell, an ignored
  room setting, or a part that is never constructed. `10-pitfalls.md` exists
  because of this.
- **This directory is engine-only.** It documents what a plugin must satisfy.
  It is not a tutorial for the tanks game, and it carries no links into the
  engine's own bilingual `docs/en|ru` tree — the single exception is the
  documentation step above, which tells a plugin's own docs to link there
  instead of restating the engine.
