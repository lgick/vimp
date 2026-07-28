# Changelog

All notable changes to the `vimp-engine` package are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/);
this project uses [Semantic Versioning](https://semver.org/) (in `0.x`, a
breaking change bumps the minor version).

## [0.2.0] — 2026-07-28

### ⚠️ Breaking — plugin API v2 (`ENGINE_API_VERSION` 1 → 2)

Game plugins built against v1 are **rejected**: `GameCatalog` (master),
the host Worker, and the client all gate on `manifest.engineApi ===
ENGINE_API_VERSION`. A v1 plugin is silently dropped from the catalog, so a
server whose only game is a stale plugin reports **"master has no games in
its catalog"**. Every game plugin must be rebuilt against `vimp-engine@^0.2.0`
and republished so its manifest stamps `engineApi: 2`.

### Added

- **Explicit form-schema contract** for both in-app forms, rendered by the new
  shared module `src/client/lib/formBuilder.js`
  (`buildField`/`buildForm`/`mergeRoomDefaults`):
  - `GameManifest.roomForm` — the ordered field-descriptor array the
    "Create server" form is built from.
  - `authSchema.params[].options` — the same field-descriptor contract for the
    per-room player (auth) form, delivered over the wire in `PS_AUTH_DATA`.
  - Supported controls: `select`, `range` (with numeric readout), `number`,
    `toggle`, `segmented`, `text`. Numeric `min`/`max`/`step` are expressed in
    stored units (ms for `unit:'s'`); the engine converts them for display.
  - See [`docs/en/plugin-api.md` → Form schema](../../docs/en/plugin-api.md).
- Tokenized, theme-consistent styling for all form controls (design tokens in
  `:root`, shared `.panel`/`.btn`/`.form-row`, styled toggle/segmented/range/
  select) — same palette as before.

### Changed

- The engine no longer **infers** a control from a value's type. A manifest
  without `roomForm` renders an empty room form (with a console warning); an
  `authSchema` param without `options.control` is skipped (with a console
  error) instead of silently guessed.
- `roomDefaults` remains the single source of default values — the room form is
  seeded from it via `mergeRoomDefaults` (an explicit `descriptor.default`
  wins).
- `authSchema.elems`: **`formId` removed** (no longer used), **`fieldsId` added**
  (the `#auth-fields` container the engine renders player-setting controls into).

### Migration (game plugins, e.g. `vimp-tanks`)

1. Bump the `vimp-engine` dependency to `^0.2.0`, reinstall, and confirm the
   installed `ENGINE_API_VERSION` is `2` (the manifest's `engineApi` is stamped
   from it at build time).
2. Add `roomForm` to the manifest (one descriptor per `roomDefaults` key).
3. Give every `authSchema.params[].options` a `control`; drop `formId` and add
   `fieldsId: 'auth-fields'` in `authSchema.elems`.
4. Rebuild and verify `dist/manifest.json` shows `"engineApi": 2`, then
   republish. On the master, install the new plugin version and redeploy —
   startup should log `-> Games loaded: <id>`.

[0.2.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.2.0
