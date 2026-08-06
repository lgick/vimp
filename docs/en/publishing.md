# Publishing a release

Four artifacts ship independently, and they depend on each other in one
fixed order:

- **`vimp-engine-core`** — the Rust crate on crates.io
  (`packages/engine/core/`, an rlib every game core compiles against);
- **`vimp-engine`** — the engine package on npm (`packages/engine`, exactly
  the paths listed in its `files`: `src/lib`, `src/config`, `src/host`,
  `src/devtools`, `tests/fixtures`, `bin`);
- **`@vimp-games/tanks`** — the game plugin on npm, built and published from
  the separate [vimp-tanks](https://github.com/lgick/vimp-tanks) repository;
- **the master server** — a Docker image built by CI and deployed to every
  VPS in `SERVERS_MATRIX` (see [deployment.md](deployment.md)).

## Why the order is crate → engine → game → production

```
vimp-engine-core (crates.io)
      │  the game crate depends on it by version, not by path:
      │  vimp-tanks/core/Cargo.toml → vimp-engine-core = "X.Y.Z"
      ▼
vimp-engine (npm)
      │  the game keeps it in devDependencies, and
      │  scripts/build-game-manifest.js reads ENGINE_API_VERSION from the
      │  installed copy to stamp dist/manifest.json
      ▼
@vimp-games/tanks (npm)
      │  production installs it with npm ci — the version comes from
      │  package-lock.json in this repo
      ▼
production (push to main → deploy.yml)
```

Two failure modes if the order is broken: the game's WASM core silently
builds against the previous crate release, and the manifest gets stamped
with a stale `engineApi`, which `GameCatalog` then rejects at load time —
the lobby comes up, but no room can be created.

## What actually needs publishing

| Changed | Crate | Engine on npm | Game on npm | Production |
| --- | --- | --- | --- | --- |
| Master, client, markup, deploy scripts | — | — | — | ✅ |
| `src/lib`, `src/config`, `src/host`, `src/devtools`, `bin`, fixtures | — | ✅ | when convenient | ✅ |
| `packages/engine/core/` (Rust) | ✅ | — | ✅ (rebuild against the new crate) | ✅ |
| Plugin contract without an `ENGINE_API_VERSION` bump | — | ✅ | when convenient | ✅ |
| `ENGINE_API_VERSION` bump | — | ✅ | **required** | ✅ strictly last |
| Game only (rules, maps, assets, game core) | — | — | ✅ | ✅ (re-pin + push) |
| `packages/auth/` | — | — | — | ✅ its own `deploy_auth` job, migrated separately (skipped when `AUTH_SERVER_IP` is unset) |

Anything outside the engine package's `files` list (`src/master`,
`src/client`, views) never reaches npm — for those, the production step
alone is the release.

## Versions

The developer sets versions and runs the releases. Bump rules:

| Artifact | File | Rule |
| --- | --- | --- |
| `vimp-engine-core` | `packages/engine/core/Cargo.toml` | cargo semver (`0.x`: breaking bumps the minor), plus an entry in `packages/engine/core/CHANGELOG.md` |
| `vimp-engine` | `packages/engine/package.json` | same, plus an entry in `packages/engine/CHANGELOG.md` |
| `@vimp-games/tanks` | `vimp-tanks/package.json` | same, in the game repo |

A crate bump has to be repeated by hand in the game:
`vimp-tanks/core/Cargo.toml` → `vimp-engine-core = "X.Y.Z"`.

## Step 0: unlink the local checkouts (before any release)

Local development links the two repositories into each other. A surviving
link means the game builds its manifest against the engine in your working
copy instead of the published one — and its WASM core against whatever
`[patch.crates-io]` you may have added. Break the links **before** any
release build, in both repositories:

```bash
cd vimp
npm unlink @vimp-games/tanks         # drops the symlink (uninstall --no-save)
npm install                          # restore the registry copy from the lockfile
npm ls @vimp-games/tanks             # no "-> ./../vimp-tanks" in the output

cd ../vimp-tanks
npm unlink vimp-engine
npm install
npm ls vimp-engine                   # no "-> ./../vimp/packages/engine"
```

Rust side: `vimp-tanks/core/Cargo.toml` must depend on `vimp-engine-core`
by version, and neither `Cargo.toml` may carry a `[patch.crates-io]`
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
