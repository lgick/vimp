# Publishing a release

## The short way: `npm run release`

One command replaces the ~25 manual steps below. It runs from the `vimp`
repository, on a clean `main`, and asks before anything irreversible:

```bash
npm run release -- --dry-run     # rehearsal: full checks, nothing published
npm run release
```

What it decides on its own:

- **Which artifacts to publish** — from three independent signals: paths
  changed since the base point (the release tag, or the commit where the
  current version was set), the local version against the published one
  (`npm view`, `index.crates.io`), and a non-empty `## [Unreleased]`
  section. A game has the same three signals of its own — an unpublished
  local version and commits after its `vX.Y.Z` tag — so a game-only release
  works without touching the engine. Then the propagation rules of the table
  below apply: a crate release forces every game to be rebuilt and
  republished, an `ENGINE_API_VERSION` bump makes the game **required** and
  pushes production strictly last, and a crate or engine release makes
  `create-vimp-game` **required** too — its `prepack` hook stamps those two
  versions into the tarball, so a scaffolder left behind quietly generates
  games on stale pins.
- **Which version to suggest** — from the sub-headings of `[Unreleased]`, a
  closed list that fixes the level while the code is written; see
  [Changelog headings set the version](#changelog-headings-set-the-version).
  Enter accepts, or type `patch`/`minor`/`major`/an explicit version. Games
  have no changelog, so their suggestion follows the
  crate/`ENGINE_API_VERSION` bump — or a `vimp-engine-core` pin that lags
  behind the crate in the registry, which is what an interrupted run leaves
  behind — and is always confirmed. The pin is read from `core/Cargo.toml`,
  and, when the crate takes it from the workspace (`{ workspace = true }`),
  from the game's root `Cargo.toml`; the same file is the one step B
  rewrites.
- **Which game plugins exist on this machine** — from `npm link` symlinks,
  the global link registry and sibling directories. Every candidate is
  validated (scope, an `X.Y.Z` version, `vimp-engine` dependency,
  `build`/`core:build` scripts, `vimp-engine-core` in `core/Cargo.toml`,
  clean git tree with a remote and an upstream) and confirmed one by one.

What it does around the work: drops the local `npm link`s before any build
and restores exactly those pairs afterwards — including on failure and on
Ctrl-C; checks the npm/cargo logins only for the registries it will actually
publish to; runs every check with captured output (one status line each, the
full log printed only on failure — a failed check stops the run **before**
publishing). The `npm publish` / `cargo publish` commands are the exception:
they run attached to this terminal, so a registry can ask for a 2FA one-time
code or open a browser — with the output captured they have no stdin and fail
with `EOTP` instead of asking. A game is always rebuilt against the versions
that are **live in the registry**, not the ones this run happens to publish,
so an interrupted release cannot leave the plugin pinned to an older core.
It never pushes `main` until the last step, where it prints the
outgoing commits and asks for an explicit confirmation, because that push
**is** the production deploy.

| Flag | Effect |
| --- | --- |
| `--dry-run` | prints and checks everything, publishes and commits nothing |
| `--only=crate,engine,scaffold,games,prod` | a subset of the steps |
| `--game=<path>` | a game for non-interactive runs (repeatable) |
| `--relink` | only restore the local links and exit (after a `SIGKILL`); works offline — it asks no registry |
| `--yes` | accept the suggested versions and the plan; games then come only from `--game`, and the push to `main` is still asked |
| `--help` | the full description |

There is no flag to skip the checks. There is no state file either: the
repositories and the registries are the source of truth, so a re-run after a
failure sees the version that already made it out and does not publish it
twice.

The steps below are what the script does under the hood — and how to do it
by hand.

## The artifacts

Five artifacts ship independently, and they depend on each other in one
fixed order:

- **`vimp-engine-core`** — the Rust crate on crates.io
  (`packages/engine/core/`, an rlib every game core compiles against);
- **`vimp-engine`** — the engine package on npm (`packages/engine`, exactly
  the paths listed in its `files`: `src/lib`, `src/config`, `src/host`,
  `src/client`, `src/standalone`, `src/devtools`, `tests/fixtures`, `bin`);
- **`create-vimp-game`** — the scaffolder on npm
  (`packages/create-vimp-game`, the paths in its `files`: `bin`, `src`,
  `templates`), the package behind `npm create vimp-game`;
- **`@vimp-games/tanks`** — the game plugin on npm, built and published from
  the separate [vimp-tanks](https://github.com/lgick/vimp-tanks) repository;
- **the master server** — a Docker image built by CI and deployed to every
  VPS in `SERVERS_MATRIX` (see [deployment.md](deployment.md)).

`packages/auth` is not on this list: it is `private: true` and never reaches
npm — for it, the production deploy is the whole release.

## Why the order is crate → engine → scaffolder → game → production

```
vimp-engine-core (crates.io)
      │  the game crate depends on it by version, not by path:
      │  vimp-tanks/core/Cargo.toml → vimp-engine-core = "X.Y.Z"
      ▼
vimp-engine (npm)
      │  the game keeps it in devDependencies, and
      │  scripts/build-game-manifest.js reads ENGINE_API_VERSION from the
      │  installed copy to stamp dist/manifest.json
      ├─────────────────────────────┐
      ▼                             ▼
@vimp-games/tanks (npm)      create-vimp-game (npm)
      │                             the prepack hook snapshots BOTH versions
      │                             above into src/versions.generated.json;
      │                             the template pins them as
      │                             vimp-engine ^X.Y.Z and
      │                             vimp-engine-core "A.B.C"
      │  production installs the game with npm ci — the version comes from
      │  package-lock.json in this repo
      ▼
production (push to main → deploy.yml)
```

Three failure modes if the order is broken: the game's WASM core silently
builds against the previous crate release; the manifest gets stamped with a
stale `engineApi`, which `GameCatalog` then rejects at load time — the lobby
comes up, but no room can be created; and the scaffolder ships a snapshot of
the previous engine and crate, so the next `npm create vimp-game` produces a
game pinned to versions that are already behind, which surfaces only when
its core is built.

## What actually needs publishing

| Changed | Crate | Engine on npm | Scaffolder on npm | Game on npm | Production |
| --- | --- | --- | --- | --- | --- |
| Master, markup, deploy scripts | — | — | — | — | ✅ |
| `src/lib`, `src/config`, `src/host`, `src/client`, `src/standalone`, `src/devtools`, `bin`, fixtures | — | ✅ | **required** (pins) | when convenient | ✅ |
| `packages/engine/core/` (Rust) | ✅ | — | **required** (pins) | ✅ (rebuild against the new crate) | ✅ |
| Plugin contract without an `ENGINE_API_VERSION` bump | — | ✅ | **required** (pins) | when convenient | ✅ |
| `ENGINE_API_VERSION` bump | — | ✅ | **required** (pins) | **required** | ✅ strictly last |
| Game only (rules, maps, assets, game core) | — | — | — | ✅ | ✅ (re-pin + push) |
| `packages/create-vimp-game/{bin,src,templates,scripts}` | — | — | ✅ | — | — |
| `packages/auth/` | — | — | — | — | ✅ its own `deploy_auth` job, migrated separately (skipped when `AUTH_SERVER_IP` is unset) |

"**required** (pins)" is the scaffolder's own propagation rule: it has no
code of its own to change, but its `prepack` hook copies the engine and crate
versions into the published tarball, so a bump above it always means a
republish. `npm run release` derives this on its own — and also catches the
interrupted-run case, where the engine already went out and the scaffolder
did not, by comparing the pins at its base point against the current ones.

Anything outside the engine package's `files` list (`src/master`, views,
`src/client/_*` scratch files) never reaches npm — for those, the production
step alone is the release.

Since the standalone SDK, the client half of the engine is published too
(`src/client`, `src/standalone`, the `./client/*`, `./standalone` and
`./style.css` exports). Two consequences:

- everything the published client imports is part of the public surface —
  `howler` therefore lives in `dependencies`, not `devDependencies`, and a
  bare import from `src/client`/`src/standalone` that is missing from
  `dependencies` breaks the SDK consumer's install (guarded by
  `tests/scripts/packageSurface.test.js`);
- a change to `src/client` is no longer "production only": it ships to npm
  and needs a changelog entry like any other published code.

## Versions

The developer sets versions and runs the releases. Bump rules:

| Artifact | File | Rule |
| --- | --- | --- |
| `vimp-engine-core` | `packages/engine/core/Cargo.toml` | cargo semver (`0.x`: breaking bumps the minor), plus an entry in `packages/engine/core/CHANGELOG.md` |
| `vimp-engine` | `packages/engine/package.json` | same, plus an entry in `packages/engine/CHANGELOG.md` |
| `create-vimp-game` | `packages/create-vimp-game/package.json` | same, plus an entry in `packages/create-vimp-game/CHANGELOG.md`; a release forced by the pins alone carries no entry and is a patch |
| `@vimp-games/tanks` | `vimp-tanks/package.json` | same, in the game repo |

A crate bump has to be repeated by hand in the game:
`vimp-tanks/core/Cargo.toml` → `vimp-engine-core = "X.Y.Z"`.

## Changelog headings set the version

The sub-heading an entry lands under is not cosmetic: it **is** the release
level, chosen while the code is written, and `npm run release` derives the
exact number from it (current version + level). The list is closed — the six
Keep a Changelog names plus two of this project's own:

| Sub-heading | Level | Use for |
| --- | --- | --- |
| `### ⚠️ Breaking` | minor in `0.x`, major from `1.0` | anything that can reject a plugin or config which loaded before |
| `### Added` | minor | a new public API or behaviour |
| `### Changed` | patch | a change that cannot break a consumer |
| `### Deprecated` | patch | an announced future removal |
| `### Removed` | patch | a removal that cannot break a consumer |
| `### Fixed` | patch | a bug fix |
| `### Security` | patch | a closed vulnerability |
| `### Migration` | — | the mandatory companion of `⚠️ Breaking`; never stands alone |

What the script enforces in preflight, before anything is built or published
— for the artifacts of that run only, so a typo in a journal that stays put
blocks nobody:

- **A heading outside the list stops the release.** An unknown name would
  otherwise fall through to patch and silently ship an under-numbered
  release.
- **`⚠️ Breaking` and `### Migration` come as a pair**, in both directions.
  One section may hold several such pairs — `core/CHANGELOG.md` does.
- A heading may carry a clarification after ` — ` or in round brackets:
  `### ⚠️ Breaking — reset() also clears my_game_id`,
  `### Migration (game plugins)`. Names are case-sensitive; the `⚠️` itself
  is optional for the parser, but both journals carry it — keep to the form
  in the table.
- **Every entry sits under a `###` heading.** Text with no heading above it,
  a `##` where a `###` was meant, and a missing `[Unreleased]` section all
  stop the release too — each of them would otherwise leave the section
  headingless and quietly settle on patch. An empty `[Unreleased]` is fine:
  a change to fixtures or `bin/` is not an entry.
- A journal belonging to an artifact that is **not** being published only
  warns — but it does warn. A `##` written where a `###` was meant empties the
  section, and an empty section is what makes the artifact skippable, so the
  defect would otherwise hide itself behind "nothing changed since X.Y.Z".
- **Examples inside code fences are not parsed** (``` ``` ``` or `~~~`), so a
  `Migration` section may show a changelog snippet without moving the level.

What it cannot check — and the reason the level is chosen this early:

- A new public export goes under `Added`, not `Changed`. That is exactly the
  difference between a minor and a patch release.
- A removal that can break a plugin goes under `⚠️ Breaking` + `Migration`,
  not under `Removed`.
- Tests, refactors and `docs/` are not entries at all.

The number itself is never written into `[Unreleased]`: the heading is the
single source of the level, and the script computes the number at release
time. Games have no changelog — their level comes from propagation (a crate
release or a new `ENGINE_API_VERSION` → minor, otherwise patch) and is always
confirmed by hand.

## Step 0: unlink the local checkouts (before any release)

Local development links the two repositories into each other. A surviving
link means the game builds its manifest against the engine in your working
copy instead of the published one — and its WASM core against whatever
`[patch.crates-io]` you may have added. Break the links **before** any
release build, in both repositories:

```bash
cd vimp
npm unlink --no-save @vimp-games/tanks   # drops the symlink, keeps the manifest
npm install                              # restore the registry copy from the lockfile
npm ls @vimp-games/tanks                 # no "-> ./../vimp-tanks" in the output

cd ../vimp-tanks
npm unlink --no-save vimp-engine
npm install
npm ls vimp-engine                       # no "-> ./../vimp/packages/engine"
```

> ⚠️ **`--no-save` is not optional.** `npm unlink <pkg>` is an alias of
> `npm uninstall`, so without the flag it also deletes the dependency from
> `package.json` **and** `package-lock.json`, and the `npm link` of step D
> does not write it back. In `vimp` that silently drops
> `@vimp-games/tanks` — and production installs the plugin from exactly that
> lockfile (`npm ci`), so the loss rides into the release commit.

Rust side: `vimp-tanks/core/Cargo.toml` must depend on `vimp-engine-core`
by version — literally, or through `[workspace.dependencies]` of the game's
root `Cargo.toml` — and neither `Cargo.toml` may carry a `[patch.crates-io]`
pointing at a local path. If you added one to develop the crate, remove it
now and run `cargo update -p vimp-engine-core`.

## Step A1: publish the crate `vimp-engine-core`

Only needed when `packages/engine/core/` changed.

```bash
cd vimp

npm run core:test                              # cargo test --workspace
cargo package -p vimp-engine-core --list       # what goes into the tarball

# bump packages/engine/core/Cargo.toml and add the entry to
# packages/engine/core/CHANGELOG.md by hand, then:
cargo build                                    # refresh Cargo.lock
git add -A && git commit -m "chore: bump vimp-engine-core to X.Y.Z"

cargo login                                    # once, token from crates.io
cargo publish -p vimp-engine-core --dry-run
cargo publish -p vimp-engine-core

git tag vimp-engine-core@X.Y.Z && git push origin vimp-engine-core@X.Y.Z
```

crates.io serves the new version within a minute; the game picks it up in
step B. The tag is what the changelog's release-notes links resolve to —
without it they 404.

## Step A2: publish `vimp-engine` on npm

```bash
cd vimp

# 1. Full check
npx eslint .
npm test
npm run core:test
npm run sim:check                                       # fixture: 9/0/3
npm run sim -- --game node_modules/@vimp-games/tanks    # the real plugin

# 2. Version + changelog, by hand:
#    packages/engine/package.json, packages/engine/CHANGELOG.md
npm install                          # refresh package-lock.json
git add -A && git commit -m "chore: bump vimp-engine to X.Y.Z"

# 3. Publish
npm login
npm publish -w vimp-engine --dry-run # review the tarball contents
npm publish -w vimp-engine
git tag vimp-engine@X.Y.Z && git push origin vimp-engine@X.Y.Z

# 4. Verify
npm view vimp-engine version
```

> ⚠️ **A `git push` here also deploys production.**
> [deploy.yml](../../.github/workflows/deploy.yml) triggers on every push to
> `main`, independently of `test.yml`. That is usually fine — production
> simply gets the new engine before the new plugin — but when
> `ENGINE_API_VERSION` changed, hold the push until step C, otherwise the
> deployed master rejects the plugin version it still pins.

## Step A3: publish `create-vimp-game` on npm

Runs **after** A1 and A2, never before: the `prepack` hook
(`packages/create-vimp-game/scripts/write-versions.js`) reads the *local*
`packages/engine/package.json` and `packages/engine/core/Cargo.toml` — the
files those two steps have just bumped — and writes the snapshot to
`src/versions.generated.json`, which is what the template's
`{{ENGINE_VERSION}}` / `{{CORE_VERSION}}` resolve to outside the monorepo.
Publishing earlier stamps the previous versions into the tarball.

```bash
cd vimp

# 1. Refresh the pin snapshot FIRST — prepack would only do it at publish
#    time, and tests/scaffold/versions.test.js compares it against the
#    engine version step A2 has just bumped
node packages/create-vimp-game/scripts/write-versions.js

# 2. Full check — the E2E is the only one that actually unpacks the
#    template and builds its core (cargo + wasm-pack, minutes)
npx eslint .
npm test
npm run test:scaffold

# 3. Version + changelog, by hand:
#    packages/create-vimp-game/package.json,
#    packages/create-vimp-game/CHANGELOG.md
npm install
git add -A && git commit -m "chore: bump create-vimp-game to X.Y.Z"

# 4. Publish
npm publish -w create-vimp-game --dry-run   # prepack prints the pins it stamped
npm publish -w create-vimp-game
git tag create-vimp-game@X.Y.Z && git push origin create-vimp-game@X.Y.Z

# 5. Verify — the pins must match what A1/A2 published
npm view create-vimp-game version
npm create vimp-game@latest /tmp/pin-check -- --yes
grep vimp-engine /tmp/pin-check/package.json /tmp/pin-check/Cargo.toml
```

`src/versions.generated.json` is under version control, so the snapshot goes
into the release commit — leave it out and the next release stops at
"working tree is not clean", because `prepack` rewrites it during
`npm publish` anyway. When the scaffolder rides along only because of a pin
bump, its `[Unreleased]` is empty, nothing is dated, and the release is a
patch.

## Step B: publish `@vimp-games/tanks`

Runs in the game repository. It needs the Rust toolchain (`rustup` +
`wasm-pack`) — see that repo's `docs/en/getting-started.md`.

```bash
cd vimp-tanks

# 1. Pull in the freshly published engine halves
#    - the crate: bump core/Cargo.toml to vimp-engine-core = "X.Y.Z"
cargo update -p vimp-engine-core
#    - the npm package: this is what stamps engineApi into the manifest
npm i -D vimp-engine@^X.Y.Z
npm ls vimp-engine                   # a registry copy, not a link

# 2. Build: WASM first, then dist/
npm run core:build                   # pkg-web + pkg-node
npm run build                        # bundles, assets, maps, manifest.json

# 3. Check
npx eslint .
npm test
npm run core:test
npm run sim                          # the engine's smoke run on this game
npm run sim:scenarios                # the game's own scenarios
npm run check:pack                   # manifest points inside dist/ (also on prepack)

# 4. Version: bump package.json by hand (or `npm version patch`, which also
#    creates a commit and a tag)

# 5. Publish (the scope is public via publishConfig)
npm publish --dry-run
npm publish

# 6. Push
git push && git push --tags
npm view @vimp-games/tanks version
```

Then eyeball `dist/manifest.json`: `engineApi` must equal the published
engine's `ENGINE_API_VERSION`, and `entries.wasmNode` must point at
`./core-node/<crate>.js` — inside `dist/`, the only directory the package
ships.

## Step C: roll out production

```bash
cd vimp

# 1. Pin the new plugin — production installs it with npm ci from the lockfile
npm i @vimp-games/tanks@X.Y.Z

# 2. Prove the pair works together before it ships
npm test
npm run sim -- --game node_modules/@vimp-games/tanks

# 3. Push to main — this is the deploy
git add package.json package-lock.json
git commit -m "chore: bump @vimp-games/tanks to X.Y.Z"
git push
```

> A **new** game (not yet in the catalog) additionally needs the
> `GAMES_MATRIX` repository variable set — `npm i` alone does not add it to
> `master:games` in production. See
> [deployment.md → Adding a second game](deployment.md#adding-a-second-game-to-the-catalog).

CI then builds the master image, pushes it to GHCR, and SSHes into every
server in `SERVERS_MATRIX` to `docker compose pull && up -d`; the auth
service is built, deployed and migrated in its own jobs (skipped when
`AUTH_SERVER_IP` is unset). Details in [deployment.md](deployment.md).

```bash
gh run watch                                    # follow the run
curl -s https://<your-domain>/servers | head    # the lobby answers
```

Final check by hand: open the lobby, create a room, join it from a second
tab. An `engineApi` mismatch shows up exactly here — the lobby loads, room
creation fails, and the master logs a `GameCatalog` rejection.

## Step D: re-link the checkouts for local development

The release left both repositories on registry copies. To go back to the
local loop:

```bash
cd vimp-tanks && npm run core:build && npm run build   # WASM + dist/

cd vimp-tanks && npm link                     # register @vimp-games/tanks
cd ../vimp/packages/engine && npm link        # register vimp-engine

cd ../.. && npm link @vimp-games/tanks        # engine ← plugin
cd ../vimp-tanks && npm link vimp-engine      # plugin ← engine
```

Both directions matter: without the reverse link the plugin's
`vimp-engine/*` imports resolve to a registry copy inside its own
`node_modules` — a second module instance with a silently different
`ENGINE_API_VERSION`. See
[getting-started.md](getting-started.md#linking-a-local-game-plugin).

## Pitfalls

- **A leftover `npm link` or `[patch.crates-io]`.** Covered by step 0; it is
  the single most common way to publish a package built against code nobody
  else has.
- **npm versions are immutable, crates.io versions are too.** A rollback is
  always a new patch release; on crates.io a bad version can additionally be
  hidden with `cargo yank --version X.Y.Z`.
- **`deploy.yml` does not wait for `test.yml`.** Green tests before the push
  are on you; CI does not gate production.
- **`dist/` and `core/pkg-*` are gitignored in the game repo.** The tarball
  is built from whatever is on disk — publish only right after a clean
  `npm run core:build && npm run build`, or yesterday's `dist/` ships.
- **A freshly created GHCR package is private.** Only relevant when standing
  up a new server; see [deployment.md](deployment.md).

## Rollback

| Broken | Undo |
| --- | --- |
| Crate on crates.io | Publish a fixed patch version; `cargo yank` the bad one so nobody resolves to it |
| Engine or game package on npm | Publish a fixed patch version (npm never overwrites) |
| Production runs a bad plugin version | Re-pin the previous `@vimp-games/tanks` in `package.json`/`package-lock.json`, commit, push |
| Production runs a bad master build | `git revert` the deploy commit and push — CI rebuilds and redeploys the previous state |

---

[← Back to docs index](README.md)
