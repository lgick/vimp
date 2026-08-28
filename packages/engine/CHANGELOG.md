# Changelog

All notable changes to the npm package `vimp-engine` are documented here.
The Rust crate `vimp-engine-core` is versioned and released separately and
has its own journal: [core/CHANGELOG.md](core/CHANGELOG.md). The format is
based on [Keep a Changelog](https://keepachangelog.com/); this project uses
[Semantic Versioning](https://semver.org/) (in `0.x`, a breaking change
bumps the minor version).

## [Unreleased]

### Added

- `participants.setChatColor(gameId, color)` — a game may now colour a
  player's nickname in chat with a colour of its own (`'#rgb'`/`'#rrggbb'`,
  `null` back to the team colour). Until now the nickname could only take one
  of the four team colours of the stylesheet, which says nothing in a game on
  a single team. The colour lives on the participant (`Participant.chatColor`)
  and `HostGame.pushMessage` applies it to every message that player sends;
  `Chat.push` appends it as an optional fourth element of the message array
  and the client view sets it as `--chat-name-color` on the line, so the CSS
  of a game that sets no colour is untouched (`var(--chat-name-color,
  <team colour>)`). `ENGINE_API_VERSION` is unchanged.

## [0.21.0] — 2026-08-28

### Added

- Contract rule **`C11` (`statMode`)** — an ERROR when `gameConfig.statMode`
  and `modules.stat.params.mode` disagree. Declaring one without the other is
  a defect that never announces itself: only the client half and the host
  broadcasts a stat table every tick to a client that throws it away; only the
  host half and the client draws a room table nobody fills.

- `accolades.boardOf(period)` and `accolades.selfOf(id, period)` alongside
  `placeOf(id)` — the global top as rows, and the caller's own place in it.

- A game result is now an engine-wide concept: `vimp.addPlayerPoints(gameId,
  delta)` collects the points of the participant's CURRENT game (a life, a
  round, a match — whatever the game calls a game) and `vimp.finishPlayerGame(
  gameId)` turns them into a sum (monthly rating) and a maximum (daily
  rating). `RoundManager` closes every participant's game at its own
  boundaries (map change, round end), so a game with rounds gets a daily best
  without touching anything. `vimp.addPlayerRank` stays as an alias of
  `addPlayerPoints`, and `PlayerDataSync.addRank` as an alias of `addPoints`.

- `vimp.getPlayerRating(gameId, period)` / `vimp.isPlayerRatingLoaded(gameId)`
  / `vimp.refreshPlayerPlacement(gameId, period)` — the participant's
  `{ value, placement, total }` in the `day` / `month` / `all` slice, filled
  on join by one request to the master's new aggregating route
  `GET /auth/placements?game=` (three slices, one round trip, cached by
  `PlacementCache` for `master:placement:cacheTtl`). `getPlayerRank` /
  `isPlayerRankLoaded` keep answering from the `all` slice.

- `GET /auth/leaderboard` answers `304 Not Modified` on a matching
  `If-None-Match`: the leaderboard changes slowly and the lobby re-requests
  it on every tab open.

### Changed

- **A place is no longer a database query per player.** `GET /auth/placement`
  folded the whole window and joined `users` on every participant's join —
  measured at 6.03 ms on 8 000 players in the window, which at the target
  scale is ~1200 such queries a second, seven cores of one line of SQL. The
  auth service now caches, per (game, slice), the ladder of distinct scores
  and answers a place by binary search over it, with the caller's own score
  read by primary key: **6.03 ms → 0.14 ms**, and the shared ladder costs one
  query per slice per TTL (`rank.distributionTtl`) instead of one per player.
  The definition is unchanged — a place is still `/leaderboard`'s `RANK()` —
  and it was verified against `RANK()` on a live 8 000-player window.

- **A client in a match no longer talks to the master.** The `leaderboard`
  stat mode used to fetch the top and the caller's placement itself; both now
  arrive in the host's `ACCOLADES_DATA` broadcast, next to the badge places.
  The room asks the master once for all of its players. At the scale this is
  built for — 100 games × 100 servers × 8 players — a client asking for itself
  meant thousands of requests a second for a player's own placement, which no
  shared cache can collapse because it is personal. `modules.stat.params
  .refreshMs` is gone with the request it throttled.

- The write budget is retuned for that scale: `lobbyConfig.playerData
  .minFlushInterval` 60 s → **300 s** (80 000 players × 2 writes per interval
  is 2700 writes a second at a minute, 530 at five), `maxRequestsPerSecond`
  3 → **1**, `master:playerData:writesPerMinute` 240 → **120**, and
  `backoff` 2 s/120 s → **30 s/900 s** — a pause shorter than the flush
  interval delayed nothing and left the backoff as dead code. Nothing is lost
  by the longer interval: results merge in the room's memory and the urgent
  boundaries still bypass it.

- `PlayerDataSync` tracks `ratingsLoaded` **per slice**. The aggregating route
  answers `200` when at least one slice arrives and nulls the rest; one flag
  marked a failed slice loaded-as-zero forever, and a zero daily slice reads
  as "any game is a record".

- A game result is now sent whether or not the ratings loaded. It is a row
  appended to a ledger, not a value that replaces one, so there is nothing for
  it to clobber — gating it meant holding points in memory until the room
  died. The `state` PUT keeps its gate: that one does replace.

- **The engine, not the game, owns how often participant profiles reach the
  database** (`lobbyConfig.playerData`): a `PUT /auth/rank` goes out only
  when something was actually earned and a `PUT /auth/state` only when the
  state actually changed; one request in flight per participant; at most one
  sync per participant per `minFlushInterval` (60 s, jittered ±20 % per room);
  a room-wide queue capped at `maxRequestsPerSecond`; and an exponential
  room backoff on `5xx`/`429`/network failures. `vimp.flushPlayerData()` is
  now a request rather than a command — the urgent boundaries (a participant
  leaving, `destroy()`) still bypass the interval and take
  `{ urgent: true }`. A room of 32 where one player scored now makes ONE
  request instead of 64.

- `PUT /auth/rank` carries a game result — `{ points, best }` — instead of
  `{ delta }`. The master clamps both by the game's `maxGameScore`
  (`master:games[].maxGameScore`, default `master:playerData:maxGameScore` =
  10 000) and rate-limits writes per verified room
  (`master:playerData:writesPerMinute` = 240, over it → `429`). The auth
  service still accepts `delta` as an alias of `points` for one version, so
  an older host keeps working.

- `lobbyConfig.playerData.maxRequestsPerSecond` is `3`, not `5`: it has to sit
  below the master's own ceiling (`master:playerData:writesPerMinute / 60` =
  4/s), or the room learns its limit from a `429` that costs a round trip and
  drops everybody in the room into backoff.

- A join no longer forces a leaderboard fetch. `Accolades.noteRoster()`
  recomputes the room's places from the slices already in hand, so a rush of
  joins costs no requests, and a newcomer is no longer skipped when a poll
  happens to be in flight. `refresh()` lost its `force` option.

### Fixed

- The host stopped draining `Stat`'s update buffer in `statMode:
  'leaderboard'`. `getLast()` is its only drain — `reset()` only appends — so
  the buffer grew for the whole life of the room. The buffer is now always
  drained and only the SEND is gated.

- `StatModel` rebuilt the leaderboard on top of its own previous output, so
  the synthetic "your row" passed for a row of the top and the caller's place
  never updated again. It is now rebuilt from the pristine board every time.

- `StatModel` is a singleton that froze the first game's stat schema: entering
  a second match in the same tab kept the first game's mode, period and row
  count. Repeated construction now reconfigures it.

- `ratingsJob` could lose a result from the all-time rating permanently. Its
  cursor was `now()` — the transaction's start — while its snapshot sees only
  what was committed by then, so an event committed after the snapshot but
  stamped before it fell out of both windows. The cursor is now the greatest
  `created_at` the run actually counted, compared strictly.

- `rankCommand`'s catch block could throw the very unhandled rejection its
  comment warns about, and `Accolades.tick()` floated an uncaught promise into
  the game loop.

- **The daily `ratings` job could double every player's day.** The statement
  is incremental (`previous rank + SUM(new events)`), and two overlapping runs
  both read the same `ratings.updated_at` — the first has not committed its
  `now()` yet. `startRatingsJob` runs in every auth process, so overlap took
  no more than a second replica, a manual `db:ratings`, or a restart inside
  the window. The run now takes a session advisory lock on a dedicated
  connection and skips itself if the lock is held, and it reschedules from the
  calendar after each run instead of drifting on a 24 h `setInterval`.

- `PlayerDataSync.load()` added the server's value to the local one for every
  slice, including the daily one — but the daily slice is a MAXIMUM, and
  `finishGame` maintains it as such. A player whose first load failed and who
  then finished a few games saw an inflated daily value after the retry
  (`_sync` reloads before syncing), and `refreshPlacement` preserved it rather
  than correcting it. Each slice is now merged the way it is aggregated.

- A repeated `flush` while one was in flight resolved immediately, so
  `destroy()` and a participant's departure could outrun the write they were
  meant to guarantee. The repeat now returns the promise of the series in
  progress.

- A result refused with a `4xx` other than `429` stayed in the pending
  counters and was re-sent on every subsequent flush for the rest of the
  room's life, growing as new games were added to it. Such a body is refused
  on its content and is now dropped.

- **The only player in a room never got their places at all**, so a badge
  earned in the global top simply did not appear. Places are computed when a
  participant joins, the broadcast goes out to clients that are already
  `isReady`, and a joining client becomes ready an entire map load later — the
  frame was consumed by a tick with nobody to send it to and never repeated,
  since nothing changed afterwards. In a room where nobody else ever joined,
  the badge never showed. A participant is now sent the current places
  personally the moment they become ready, the way the first stat frame works.

- A place in the global top is handed only to a participant with a verified
  identity. Matching is by nickname, which in the lobby is the claim of a
  verified token — but in the guest contour it is a form field that
  `createGuestIdentity` openly calls spoofable, and a guest could wear a
  stranger's crown by naming themselves after them.


## [0.20.0] — 2026-08-27

### Added

- Daily / Monthly / All-Time slices of the game leaderboard (rank-periods):
  `GET /auth/leaderboard` and `GET /auth/placement` take `?period=day|month|all`
  (default `all` — the previous behaviour, so an older client is unaffected),
  `LeaderboardCache` keys by the period, and the lobby's Leaderboard tab gets
  a row of slice buttons (`lobbyConfig.leaderboardPeriods`). `day`/`month` are
  aggregated from the auth service's `rank_events` ledger over calendar UTC
  windows; `all` still reads the `ratings` cache. Requires the auth service's
  migration `006_rank_periods_idx.sql`.

- `vimp.flushPlayerData()` on the `HostGame` facade — syncs every current
  participant's rank/state to the master on demand (`PlayerDataSync.flushAll`).
  Both scheduled flushes live in `RoundManager` (map change, round end), which
  a game with `endlessRound` + `overrideMapData` never reaches: its rank
  otherwise only left the host when a participant left, and a closed host tab
  lost it. Best-effort like the rest of `PlayerDataSync` — the promise does
  not reject. Nothing changes for existing games.

## [0.19.0] — 2026-08-27

### Added

- `vimp.addPlayerRank(gameId, delta)` on the `HostGame` facade — a direct
  path to `PlayerDataSync.addRank` for games that never emit
  `CoreEvent::Death` and therefore never reach `RoundManager.reportKill`,
  where the built-in ±1 rank rule (and its team-wipe branch) lives. Nothing
  changes for existing games.
- `gameConfig.noSpectators: true` — opt-in for single-team games that have no
  spectator concept at all. `teams` must then declare exactly one team,
  `spectatorTeam` is no longer required (and `spectatorTeam`/`spectatorId` are
  `null` inside the host), a joining human is created directly in the playing
  team, their stat row is written there, and `RoundManager.admitPlayer(gameId)`
  gives them an actor as soon as their first frame is acknowledged — no vote,
  no team change. Rule `B4` and the boot gate accept the shorter config.
- `gameConfig.endlessRound: true` — opt-in for games whose round never ends.
  The engine then stops restarting the round on its own: the "fewer than two
  active humans" branch of `changeTeam` no longer wipes the stat table, a team
  wipe no longer ends the round, and the round timer expiring does nothing.
  Explicit restarts (`/nr`, a map change) keep working. The flag is
  independent of `noSpectators`.
- A game may now omit `modules.vote` from its client config entirely: the vote
  time is merged into whatever `params` there are, and an absent menu or
  template set renders as an empty menu instead of throwing.
- `vimp.isPlayerRankLoaded(gameId)` on the `HostGame` facade (and
  `PlayerDataSync.isRankLoaded`) — whether the participant's rank has actually
  come back from the master. `getPlayerRank` answers `0` both for an unknown
  id and while `load()` is still in flight, so a game that writes the rank
  into a stat column of its own (`bodyMethod: '='`) had no way to tell "rank
  0" from "no rank yet" and published the starting zero over the real value.
- `vimp.overrideMapData(scaledMapData)` on the `HostGame` facade — tells the
  engine which map `RoundManager._startRound` should place participants on,
  without changing the room's map or restarting the round. For games that
  rebuild their geometry on the fly (a map change would clear the world, the
  panel and the stat table); without it the next round start distributes the
  respawn points of the catalog map, i.e. of geometry the core no longer has.

### Fixed

- `RoundManager.changeTeam` no longer clears the participant's respawn slot
  before it knows the new team has one. The early return on a full team left
  an active player with `respawnIndex === null`, so the point they physically
  stand on looked free to the next allocation; the slot is now taken (and the
  old one released) only on the successful path, and `_freeRespawnIndex`
  accepts the switching participant as an exception instead.
- `RoundManager.admitPlayer` no longer evicts a bot when the team has no
  respawn points at all. `respawns?.[index]` was `undefined` both for "the
  slots ran out" and for "there is no list yet", and in the second case the
  eviction freed nothing while the human was refused anyway.

- Respawn points are no longer handed out by team SIZE. `RoundManager` now
  gives a joining or team-switching participant the first slot no active
  participant holds (`Participant.respawnIndex`), and frees the slot when the
  actor goes away. The old `getTeamSize(team) - 1` was only correct while
  participants were added and served strictly one at a time and never left:
  two players joining at once got the same point, a leave-then-join reused an
  occupied one, and after a map change every player got the same index, since
  `createMap` puts everyone in the team before anyone reaches their first
  frame. `admitPlayer` now also frees a slot with
  `scripted.removeOneForHuman(team)` before giving up — a human outranks a
  bot, as it already did in `changeTeam` — and tells a player it still had to
  refuse (`TEAMS_TEAM_FULL`) instead of leaving them without an actor
  silently.

- The centring rule for the game canvas is scoped to the canvas the engine
  sizes itself: `ensureCanvas` marks a canvas without `fixSize` with
  `vimp-letterbox`, and the stylesheet targets
  `.vimp-shell > canvas.vimp-letterbox`. The previous bare `canvas` selector
  also matched a game's fixed-size overlay canvas and leaked
  `bottom`/`left`/`margin` into it — properties such an overlay does not
  declare itself — which centred it on the screen instead of leaving it where
  the game put it (the radar of `vimp-tanks`).

- The game canvas is centred in its container. `CanvasManagerModel.resize`
  sized the letterbox correctly, but `ensureCanvas` mounted a bare `<canvas>`
  in normal flow and no rule in the engine's stylesheet ever touched it, so
  the whole black bar ended up on one side. The canvas is now placed with
  `inset: 0; margin: auto` under the same `.vimp-shell` marker the other
  engine screens use; the resize maths is untouched, and the visible world
  width is unchanged.

## [0.18.1] — 2026-08-26

### Fixed

- `resolveProjectUrl` now falls back to `homepage` whenever the declared
  `repository` resolves to nothing (an empty string, a `file:`/internal git
  host), not only when the field is absent — a package carrying both kept
  losing its footer link, and rule `A7` warned about a `homepage` it had
  never looked at.
- The `user/repo` shorthand is expanded only for `repository`, the field npm
  reads it in. In `homepage` such a string is a relative path, and expanding
  it sent players to an invented `github.com` address.
- `projectLink` re-validates that it was handed an `http(s)` URL. It is a
  public export whose result goes straight into an anchor's `href`, and since
  the normalising step moved to `resolveProjectUrl` nothing checked it.
- A footer link's label is read off the URL's host (`new URL`), so a
  credential in an `ssh://user@host/…` repository no longer becomes the
  label; the userinfo is stripped from the URL itself as well.

## [0.18.0] — 2026-08-26

### ⚠️ Breaking

- `vimp-engine/lib/packageLink.js` changed its surface: `homepageOf` and
  `resolvePackageLink` are replaced by `resolveProjectUrl(pkg)` (the package's
  project URL, normalised to https) and `projectLink(url)` (`{ url, label }`).
  The npm fallback is gone with them: a package that declares neither
  `repository` nor `homepage` now gets **no** footer link instead of a link to
  its npm page, and the footer cell stays empty.

### Migration

- Importing those two names: `homepageOf(pkg)` → `resolveProjectUrl(pkg)`
  (it now also normalises, so the separate `resolvePackageLink` step is gone);
  `resolvePackageLink({ name, homepage })` → `projectLink(url)`.
- A game package that declares no `repository` will show no link in its entry
  form. Add one to its `package.json` — `npm run check:contract` now says so
  (rule `A7`), and new games get the field from
  `npm create vimp-game --repository <url>`.

### Added

- Contract rule `A7` (`packageRepository`, warning): the game's `package.json`
  declares a `repository`/`homepage`. Without it the entry form's footer shows
  no project link, and nothing else would have pointed that out.

### Changed

- `repository` now wins over `homepage` when resolving a package's project
  link — the footer should lead to the source repository, not to a landing
  page that `homepage` may hold.
- The package metadata the master adds to each served manifest is now
  `packageVersion` + `packageUrl` (an already-normalised https URL) instead of
  `packageName`/`packageVersion`/`packageHomepage`. `packageName` existed only
  to build the npm fallback and is no longer read by anything.
- A footer link is labelled `GitHub` for `github.com` and by its host
  otherwise (`gitlab.com`), so the label never misstates where it leads.

## [0.17.0] — 2026-08-26

### Added

- Both the lobby and the entry form (`#auth`) now carry the same footer strip:
  a link to the package's project page, its version, and the copyright. The
  link is built by the new `vimp-engine/lib/packageLink.js`
  (`homepageOf`/`resolvePackageLink`): it normalises a package's
  `homepage`/`repository` to https and falls back to that package's npm page,
  which needs nothing but the name — so a package declaring neither still gets
  a working link. On `#auth` the link points at the game, in the lobby at the
  engine.
- The master's `GameCatalog` adds `packageName`, `packageVersion` and
  `packageHomepage` to every manifest it serves, read off the resolved game
  package's own `package.json`. The dedicated server reuses the same catalog,
  so both contours that show `#auth` are covered.

### Changed

- The game version in the `#auth` footer now comes from the metadata above
  instead of an optional `GameManifest` field. The manifest route required
  every game repository to patch its `build-game-manifest.js`, rebuild and
  republish before a player saw anything — which is why the line was blank for
  `@vimp-games/tanks` and `@vimp-games/snakes` after 0.16.0. Reading the
  installed package's `package.json` works for already-published games with no
  rebuild.
- Both footers render the version as a bare number (`0.16.0`) rather than
  `vimp-engine <version>` / `v<version>`.

### Removed

- The optional `packageVersion` `GameManifest` field introduced in 0.16.0. No
  published game ever shipped it, and with the master deriving the version it
  would have been a second source of one fact. `ENGINE_API_VERSION` is
  unchanged and a manifest that still carries the field is loaded exactly as
  before — the value is simply ignored.

## [0.16.0] — 2026-08-26

### Added

- The lobby screen has a footer showing `vimp-engine <version>`, read from the
  package's own `package.json` through the new `src/client/lib/engineVersion.js`
  and baked into the bundle at build time. The crate `vimp-engine-core` is not
  shown: it is `rlib`-only, its WASM is built in the game's repository, and
  every game pins its own version of it.
- The entry form (`#auth`) shows the active game's `manifest.packageVersion` in
  its footer. `packageVersion` is a new **optional** `GameManifest` field — the
  semver of the game's npm package, as opposed to `manifest.version`, which is
  a bundle content hash. `ENGINE_API_VERSION` is unchanged and a manifest
  without the field stays valid: the footer line is simply left empty. Games
  need `create-vimp-game` ≥ 0.1.15 (or the same one-line change in their own
  `scripts/build-game-manifest.js`) plus a rebuild for the version to appear.

## [0.15.0] — 2026-08-25

### Added

- `vimp-engine/lib/validators.js` exports `resolveValidator(name, validators)`
  — the single definition of "a validator name resolves" (engine rules
  overridden by the game's, a non-function resolving to `undefined`), used by
  `validateAuth`, by contract rule `C10` and by the host's own startup check.
- `vimp-engine/lib/formOptions.js` — `normalizeOptions(list)`, the descriptor
  option-list parsing (`'red'` or `{ value, label }`) moved out of
  `src/client/lib/formBuilder.js` so the host can check membership against
  the same list the form offers, without importing the client layer (the same
  arrangement as `lib/formPattern.js`).
- `roomForm`/`authSchema.params[].options` field descriptors accept two new
  optional keys, `min`/`max` (numeric text fields): rendered as a
  "(min–max)" hint suffix on the field's label, and checked by the new
  `collectFormErrors()` (`src/client/lib/formBuilder.js`).
- A `select`/`radio` field resolving (`options`/`source`) to exactly one
  choice is automatically not rendered as a form row — nothing for the
  player to actually choose — while still being built and submitted. That
  choice is also forced as the field's value: `setValue()` becomes a no-op,
  so a stale `localStorage`-remembered value or a `default` naming an option
  since removed from the list can no longer desync a hidden `<select>` to
  `''` with no way for the player to fix it. The same rule is applied to
  `PS_AUTH_DATA.params[].value` before the form is built
  (`resolveForcedValue()`, a new `formBuilder.js` export), so the solo path
  (`boot.autoAuth`), which answers the host without rendering a form at all,
  reaches the same value.
- A `select`/`radio` resolving to *zero* choices is treated as a schema or
  catalog defect rather than "nothing to choose": the row is rendered, a
  `console.error` names the field, and the field always fails validation
  with `no options available` — `required` or not. No game declares
  `required` on `map`, so an empty map catalog used to create the room with
  `map: ''`; and "required" would have pointed the player at a field there
  is nothing to put in.
- Both forms check themselves **as the player types** (`bindLiveErrors()`, a
  new `formBuilder.js` export, used by the room and the auth form alike): a
  value out of range is reported the moment it is entered rather than on the
  next click of the submit button, and a line disappears when its own field
  is fixed, so a player with three errors no longer loses the other two by
  starting to fix the first. Before the first submit only fields the player
  has actually touched can report anything — `required` on a field nobody
  has opened yet is noise, not help; submitting lifts that filter, since a
  click answers for the whole form. Rebuilding the form (switching games in
  the lobby) puts it back: the new form is nobody's until it is touched.

### Changed

- The host now applies the declarative part of the auth descriptor itself:
  `validateAuth` (`src/lib/validators.js`) checks length (`too long`),
  membership in a `select`/`radio` field's declared `options` (`not an
  option`) and `regExp` (`invalid format`, anchored as `^(?:…)$`, the way the
  client and the browser apply `pattern`) before running the game's
  validator, so a client that bypasses the form is bound by the same rules
  the form enforces — a `select` field with no game validator no longer
  accepts an arbitrary string. `maxlength`/`regExp` apply to text fields
  only, as in the form; a field whose `options` list is empty or absent
  accepts nothing at all (the form rejects it unconditionally with `no
  options available`, so the host must not be the laxer of the two); a
  `source` list is not checked (the host resolves no catalogs). An empty
  value still passes these checks (`required` is deliberately not enforced
  on the host: the solo path answers with the schema defaults, and those may
  be `''`), and a `regExp` that does not compile is no constraint rather
  than a rejection — the same as on the client.
- An auth field with no `maxlength` is capped at 256 characters. The game's
  `regExp` now runs on the host — the Worker holding the authoritative match,
  or the whole `dedicated` process — where a catastrophic pattern such as
  `(a+)+b` would turn a few dozen characters of a single `PC_AUTH_RESPONSE`
  into minutes of a blocked event loop.
- Contract rule `C10` additionally reports an `authSchema` param whose
  `validator` names something `authSchema.validators` does not provide as a
  function (an engine validator such as `isValidName` still resolves): the
  host skips an unresolved validator silently, so a typo left the field
  checked by nobody. The host itself now says the same at runtime — a
  `console.error` per offending param when the port machine is built — for
  those who do not run the contract checker. A non-function under a correct
  name is no longer called at all: it used to throw a `TypeError` out of the
  Worker's message handler.
- Room-form and auth-form validation no longer shows native browser
  validation popups (`reportValidity()`): failing fields are rendered as
  lines inside `#lobby-error`/`#auth-error` instead
  (`collectFormErrors()`/`renderFormErrors()`, `src/client/lib/formBuilder.js`),
  the same rendering `AuthView.renderError` already used for server-pushed
  errors. `#lobby-error`/`#auth-error` share one `.form-error` style, and an
  error line is titled with the field's `label` (the caption the player sees
  next to it), falling back to its `name` for server-pushed errors.
- `collectFormErrors()` checks `regExp` on numeric text fields too (against
  the raw displayed string, e.g. the range pattern `build-game-manifest.js`
  still generates for `roomForm` fields without `min`/`max`) — it previously
  checked `regExp` only on non-numeric text fields, so an out-of-range
  `maxPlayers`/`roundTime`/`mapTime` on a manifest built before the
  `min`/`max` keys above went unreported. That `regExp` check is also now
  anchored to the whole value (`^(?:…)$`, matching how a browser applies the
  `pattern` attribute) — unanchored, `new RegExp(descriptor.regExp).test()`
  accepted any value containing a matching substring, so e.g. `99` passed
  silently against `rangeToPattern`'s un-anchored 1–32 pattern (a plain `9`
  at the start already matched) and the invalid room was created anyway.
- Validation covers only fields with a rendered row: `hidden: true` and
  single-choice `select`/`radio` are skipped, the way the native
  `reportValidity()` walk over the container's controls skipped them. An
  error on a field the player can neither see nor fix would only lock the
  form.
- A numeric text field (`numeric`/`unit`) is implicitly `required`: an empty
  one reports `required` and an unparseable one `must be a number`, instead
  of silently submitting the `default` its reader falls back to. No game
  declares `required` on `maxPlayers`/`roundTime`/`mapTime`, so an empty box
  used to create the room on the default value.
- Checks now run emptiness → `must be a number` → `min`/`max` → `maxlength`
  → `regExp`. The range comes before the pattern because a generated
  `regExp` encodes the same bounds, but `must be ≤ 32` repeats the label's
  hint while `invalid format` says nothing; the pattern is left to catch
  what the range cannot (a fraction, a leading zero).
- The lobby's error block moved above the "Create server" button, next to
  the fields it describes, and no longer occupies a row of its own while
  empty (`.form-error:empty`).
- `AuthModel.update()` no longer re-validates the value against
  `options.regExp` and no longer blanks it on a mismatch: form validation is
  `collectFormErrors()` alone. Over the wire (`PS_AUTH_DATA`) `regExp`
  arrives as a JSON string, which has no `.test` — the check threw a
  `TypeError` on the first edit of any auth field declaring one, and the
  silent blanking it did with a `RegExp` object gave the player neither an
  error line nor a clue where the input went.

### Fixed

- A `regExp` that does not compile no longer kills the submit. It arrives
  from the game manifest as a string, and the `SyntaxError` from `new
  RegExp()` escaped `collectFormErrors()` into the click handler: "Create
  server" and `#auth-enter` stopped doing anything at all, with nothing
  rendered in the error block — the native `pattern` attribute behaved the
  other way round, a browser ignores a pattern it cannot read. Such a
  pattern is now no constraint at all, named once in a `console.error`, and
  contract rule `B5` catches it before the game ships. Compiled patterns are
  also cached, instead of being rebuilt per field per submit.
- A `select`/`radio` resolving to exactly one choice no longer sends a
  non-string value to the host. `resolveForcedValue()` returned the schema's
  own value, while a rendered control always yields a DOM string — a game
  declaring `options: [1, 2]` therefore failed `validateAuth` with
  "Property must be a string" on a field whose row is not rendered, leaving
  the player no way to fix it.
- A text field is trimmed on both sides of the border it sits on: the value
  it reports and the value it is checked against are now the same string.
  Only whitespace counts as empty rather than as `0` (`Number(' ')` is `0`,
  so a space used to create a room on a numeric field declared without
  `min`/`max`/`regExp`), and padding around a valid value neither changes
  the verdict nor travels to the host — the client used to pass
  `"  Bob  "` and let the host's own `isValidName` reject it.
- The auth form's error block is no longer wiped on blur.
  `AuthView.renderData()` cleared it on every model `form` event, and that
  event rides on `change` — which a text input fires when it loses focus, so
  moving from a field the player had just fixed to the next one took the
  errors of every field they had not touched yet with it. The block is owned
  by the live re-check alone now.
- A `select`/`radio` that resolves to no choices at all and has no rendered
  row (`hidden: true`) is left out of the submit entirely, instead of
  contributing an empty string: there is no value to send, so the host keeps
  the `roomDefaults`/schema one.
- Contract rule `C4` (`componentDependencies`) no longer fails a game for
  naming a service the game itself provides. The rule matched only the
  engine's own four (`renderer`, `soundManager`, `assetsBase`,
  `localPlayer`) and predated `ClientPlugin.hooks.services(core)`, whose
  return value `src/client/main.js` merges into the same pool — so any game
  using that documented hook (`@vimp-games/tanks` and its `mapDynamics`)
  failed the checker on a correct declaration. A plugin declaring
  `hooks.services()` now gets a warning instead: the hook needs a live core
  the static checker cannot build, so the name stays in the report without
  blocking (`--strict` still fails on it). Without such a hook the unknown
  name remains an error, as before.
- Contract rule `C6` (`statColumns`) no longer warns about the column count
  itself. How many stat columns there are is the game's decision — its schema
  declares them and the engine drops writes to undeclared ones
  (`src/host/meta/modules/Stat.js`) — so the count was never the engine's
  business. What is: the engine CSS lays out five
  (`#stat …:nth-child(1)…(5)`), and a further column has no width until the
  plugin restates the layout. The rule now reads `ClientPlugin.styles` and
  warns only about declared columns those styles leave unaddressed, so a game
  that ships the layout it needs (`@vimp-games/snakes`, six columns) passes,
  and one that does not is still told which column collapses.
- A contract rule's verdict may now carry its own `level`, overriding the
  rule's for that run (`verdict(violations, note, level)`,
  `src/devtools/contract/result.js`) — a rule whose violation is only
  partially provable can report it without blocking. An unrecognised level
  falls back to the rule's own and says so on `console.error`: silently
  accepting one would disable `hasBlockingFailure()` for that rule, since it
  compares against `error`. `runRules(ctx, ruleList)` takes an explicit rule
  list so that resolution is testable on its own.
- Contract rule `B5` (`roomForm`) also checks that each `regExp` compiles,
  in the anchored form the client uses — both sides now build it through one
  `anchorPattern()` (`src/lib/formPattern.js`), so the rule cannot drift
  from what it predicts.
- Contract rule `C6` (`statColumns`) reads the declaration body, not just
  the selector: a column counts as laid out only when a `#stat` rule naming
  a cell declares a width (`width`/`min-width`/`max-width`/`flex`/
  `flex-basis`/`grid-template-columns`). It also stopped losing rules nested
  in `@media`/`@supports` (the previous split on `}` saw the wrapper and
  dropped the selector), recognises `th` alongside `td`/`span`, and takes a
  `grid-template-columns` track list on the container as covering every
  column — so the rule no longer passes a colour-only rule as a layout, nor
  warns about a column that is in fact styled.

## [0.14.4] — 2026-08-21

### Changed

- The panel's line height follows its font size (16px for 14px text,
  `src/client/style.css`): at 12px the line box was shorter than the glyphs,
  so the bar only held together thanks to its own `height`/`overflow`.

## [0.14.3] — 2026-08-21

### Changed

- The panel's font size is 14px — 16px turned out to be too large for the
  24px bar (`src/client/style.css`, `b8efdb6`).

## [0.14.2] — 2026-08-21

### Changed

- The panel's font size is 16px instead of 10px, which was hard to read at
  the top of the canvas (`src/client/style.css`, `bb5418c`).

## [0.14.1] — 2026-08-21

### Fixed

- The hot buffer's `PREDICTED` flag is now raised when the game returned only
  its own predicted rows (`render_rows`) without a predicted record for the
  local actor: such a buffer used to be dropped by the client without being
  parsed at all, since both consumers gate the parse on
  `HOT_HAS_GAME | HOT_HAS_PREDICTED`.
- The hot-buffer reader rejects a truncated trailing record with an explicit
  error instead of silently producing a row with missing fields and walking
  past the end of the buffer.

## [0.14.0] — 2026-08-21

### Added

- Optional `ClientPlugin` hook `hooks.services(core)`: the game returns its own
  services, which are merged into the client's service pool next to the
  engine's own (`renderer`, `soundManager`, `localPlayer`, `assetsBase`) and
  reach a part through `componentDependencies`. That is how a part talks to the
  game core without the engine knowing what is handed over; engine keys win a
  name clash.
- `setId` in the `set_map` payload handed to the client core — the snapshot key
  the map's dynamics travels under (`c1`/`c2`), without which a game cannot tell
  its own dynamics block from another map constructor's.

## [0.13.0] — 2026-08-21

### Added

- The hot-buffer reader (`reconstructHot`) consumes the whole record tail
  instead of exactly one predicted record: besides the local actor's, a game
  core built on `vimp-engine-core` ≥ 0.7.0 may append rows for bodies it
  predicts itself (map dynamics, actors in contact), and each of them
  overrides the interpolated row of the same entity. Record width still comes
  from the game's snapshot schema, so the traversal invariant
  (`consumed === hot.length`, `devtools/invariants.js`) is unchanged.

## [0.12.0] — 2026-08-20

### Changed

- **Breaking.** `SNAPSHOT_FORMAT_VERSION` is 5. v4 gives a block schema an
  optional row tail (`optionalFrom`): the fields from that index on are
  written only when the row carries them, and a flag byte in front of the
  row says whether they follow — dynamic map elements use it to ship
  `[vx, vy, angvel]` only while they move, so a resting crate costs 12 bytes
  less every frame. v5 widens the reference plugin's tank row with `angvel`,
  which the client needs to predict how far another tank's hull turns during
  the interpolation delay. A client on the old version drops such frames:
  the engine and the game plugin have to ship as a matching pair.
  `ENGINE_API_VERSION` stays at 3 — `optionalFrom` is additive, an existing
  game's schema is still valid, and a frame is always packed and unpacked by
  the same plugin core off the same schema, so no already-published game
  becomes unloadable.
## [0.11.1] — 2026-08-20

### Fixed

- The lobby's game picker now actually hosts the game it shows. "Create
  server" was disabled whenever the picked game differed from the one loaded
  at bootstrap, so with more than one game in the master's catalog only the
  first entry could ever be hosted. The active game is no longer frozen:
  `src/client/lib/gameActivator.js` loads the picked game's `ClientPlugin` on
  click (cached per `gameId`, a failed load is not cached so a retry
  re-imports) and `bindActiveGame` re-points the manifest, the plugin and the
  injected game stylesheet at it, after which `roomDefaults` and the
  `room.game` entries sent to the Worker come from the picked manifest. The
  artificial gate (`src/client/lib/hostGate.js`) is gone.
- Joining a room of a game other than the loaded one connected with the wrong
  `ClientPlugin`. The `join` event now carries the room's `gameId`, and that
  game is activated before P2P is established; a host that sends no `gameId`
  (older than 6.4) still joins on the active game.
- A `ClientPlugin` that fails to load at lobby time is reported inline
  (`#lobby-error`) and leaves the lobby usable, instead of the bootstrap path
  that replaces the whole document body.

## [0.11.0] — 2026-08-19

### Added

- Pointer input (mouse, finger, stylus) as an engine primitive, opt-in per
  game through `modules.controls.pointer` (`keySets`, `doubleTapMs`,
  `doubleTapPx`, `sendIntervalMs`). `InputListener` now also listens to
  Pointer Events — one set covering mouse, finger and stylus, which is what
  makes a game playable on a phone (touch events did not exist here at all)
  — `ControlsModel` recognises the double tap itself (`dblclick` is not
  guaranteed on touch) and gates the channel exactly like the keys (input
  disabled, an open `chat`/`stat`/`vote`, a key set outside `keySets` — each
  mutes it and releases a held pointer), `CanvasManagerView.toWorld` turns
  the screen point into a world point (canvas of
  `modules.canvasManager.pointerCanvas`, the first one by default), and it
  travels the existing `KEYS_DATA` port as `'seq:aim:x:y:flags'` next to the
  byte-for-byte unchanged `'seq:action:name'`, reaching the core through
  `GameCoreAdapter.applyAim` / `ClientCore.apply_aim`. A game that does not
  declare `pointer` attaches no listener and sends nothing;
  `ENGINE_API_VERSION` is unchanged, because a core without the new trait
  method behaves exactly as before. Scenarios gained an `aim` op
  (`who`, `x`, `y`, `flags`) and `DebugRecorder` records it, so pointer
  input is replayable by `vimp-sim`. Canvases are created with
  `touch-action: none`, so a finger on the canvas plays the game instead of
  scrolling the page (`docs/ai/04-client-plugin.md`,
  `docs/{en,ru}/client.md`).

- The game catalog discovers itself outside production: with no
  `GAMES_MATRIX` set, every built `@vimp-games/*` package present in
  `node_modules` (an ordinary dependency or an `npm link` symlink) is added to
  `master:games`, sorted by id and ahead of the configured entries
  (`src/master/localGames.js`, used by both `src/master/lobby.js` and
  `src/dedicated/main.js`). A linked game now reaches the lobby without
  editing `src/config/master.js`, which ships with the package. The first
  catalog entry is the lobby's active game — set `GAMES_MATRIX` locally to
  pin the order.

- `localPlayer` — a fourth service in the part dependency pool
  (`{ id, is(id) }`, `src/client/lib/localPlayer.js`), plus the instance id
  itself, handed to every part as a fourth constructor argument
  (`{ id }`, `src/client/components/model/Game.js`; `{ id: null }` for an
  effect). Together they let a part tell the local player's entity from
  everyone else's — until now the id stayed inside `GameModel` and the
  client's own game id was only known to the client core, so a game could not
  play a cue for its player alone. Ask `localPlayer.is(id)` at the moment the
  answer is needed: entities are created from `FIRST_SHOT_DATA`, before the
  first player block, so a flag computed in the constructor is wrong exactly
  for the local entity. Both additions are backward compatible — a part that
  ignores the extra argument and a game that does not declare the service
  behave as before (`docs/ai/04-client-plugin.md`).

### Changed

- **Breaking:** the engine no longer parses any chat command of its own.
  `CommandProcessor` is a bare registry filled entirely from
  `HostPlugin.chatCommands`, so `/name`, `/nr`, `/timeleft`, `/mapname` and
  `/rank` are game code now — the same name may mean different things in two
  games, or exist in only one of them. Everything the old handlers used is
  still in the handler context (`roundManager`, `timerManager`,
  `playerDataSync`, `chat`, `isDevMode`); the `create-vimp-game` scaffold
  ships the three portable ones in `src/host/metaCommands.js`. Contract rule
  `B7` no longer reports "engine command" shadowing and checks the shape of
  the array instead: leading slash, a handler function, no duplicate names
  (`src/host/meta/core/CommandProcessor.js`,
  `src/devtools/contract/rules/b7-chat-commands.js`).
- The room capacity is declared by the game, not capped by the master: the
  upper bound of `maxPlayers` in `HostRegistry.add` now comes from
  `roomDefaults.maxPlayers` of the room's game manifest, resolved through the
  `gameMaxPlayers` option the lobby wires to `GameCatalog` — the same source
  the lobby's room form is seeded from (`src/master/HostRegistry.js`,
  `src/master/lobby.js`). `master:host:maxPlayersLimit` stays as the sanitary
  bound for a room whose game the master does not know (`gameId: null` from a
  pre-composition host, or an id outside the catalog) and keeps its default of
  8, so nothing that was accepted before is rejected now — a room registered by
  a known game is simply no longer clamped below what that game declares
  (`src/config/master.js`).

- Env overrides (`applyMasterEnv`) are read by the lobby master in
  development too, not only in production (`src/master/lobby.js`): the
  catalog is what `GAMES_MATRIX` mostly carries, and it was ignored exactly
  where a developer sets it by hand. `VIMP_DOMAIN` is still required in
  production and every other override is still guarded by its own presence
  check, so a dev run with no variables set behaves as before.

## [0.10.2] — 2026-08-18

### Changed

- `master:games` entries are now `{id, package}`: the `version` field was
  never read — `GameCatalog` resolves the plugin through `node_modules/` and
  takes its version from the package's own `dist/manifest.json`, so the pin
  lives in the root `package.json`. An entry that still carries `version` is
  ignored, not rejected, so an existing `GAMES_MATRIX` keeps working
  (`src/config/master.js`).

## [0.10.1] — 2026-08-18

### Fixed

- `roundTo2Decimals` JSDoc example referenced a nonexistent `round(value,
  precision)` signature; corrected to match the actual single-argument
  function (`src/lib/formatters.js`).

## [0.10.0] — 2026-08-18

### Added

- `vimp-contract` — a static contract checker for a game package, published
  as a second bin next to `vimp-sim`
  (`packages/engine/bin/vimp-contract.js`, rules in
  `packages/engine/src/devtools/contract/`). It reads `package.json`,
  `vite.config.js`, `core/Cargo.toml` and `dist/manifest.json`, imports both
  plugin halves as modules, and evaluates 32 rules over the result: packaging
  (`A1`–`A6`), host plugin (`B1`–`B10`), client plugin (`C1`–`C10`), snapshot
  schema (`D1`–`D3`) and shipped assets (`E1`–`E3`). Flags: `--game <path>`,
  `--json`, `--quiet`, `--strict`; exit code `1` on any `error`-level
  failure. A rule with no input returns `skip`, so the checker is usable from
  a plugin's first commit — and the `⚙`-marked half of
  `docs/ai/10-pitfalls.md` stops being a by-eye checklist. A rule that finds
  its file but not the data it needs (the `vimp-engine-core` pin, for one)
  reports that in the notes instead of passing, and a run where no rule
  found any input exits `1`. `files` now also publishes
  `core/Cargo.toml` — without the crate version in the tarball, rule `A5`
  could only check the pin inside this repository. Nothing is required from
  a plugin and `ENGINE_API_VERSION` is unchanged.
- `ParticipantManager.maxPlayers` — the room cap, readable by a game so it
  can clamp player input (`/spawn <count>`) before a loop instead of
  hammering `isFull` on every iteration.

### Fixed

- Draw order on the game canvas. `GameView.add()` passed a `layer`-based
  comparator to `stage.sortChildren()`, but PixiJS 8 takes no comparator
  there and skips the sort entirely unless the container is marked sortable
  and dirty — which never happened, because parts assign `zIndex` in their
  constructor, before `addChild`. Layers were painted in insertion order and
  a late-arriving map layer could silently cover the actors. The engine now
  sets `stage.sortableChildren` and calls `sortChildren()` with no
  arguments, so the documented `zIndex` contract holds.

## [0.9.0] — 2026-08-17

### ⚠️ Breaking

- The engine no longer serves any game image. `packages/engine/public/img/`
  (`tiles.png`, `tiles2.png`, `tiles3.png`, `b1.png`, `bob.jpg`,
  `stalin.jpg`) is gone, and with it the `/img/<name>` URL a plugin's `Map`
  part could rely on. Those files were never referenced by a single line of
  engine code — they were the tanks plugin's assets sitting in the engine's
  Vite `public/`, reachable only because the engine happens to serve that
  directory at the site root. A plugin that still requests `/img/*` gets a
  404 and renders an empty canvas with nothing in the console. Images now
  travel in the plugin package exactly as sounds already do.

### Added

- `assetsBase` in the client's `DependencyProvider` service pool
  (`renderer`, `soundManager`, `assetsBase`). It carries the active game's
  asset base from its manifest, so a part that draws from image files builds
  its own URLs — `${assetsBase}img/<file>` — the same way `SoundManager`
  resolves `${assetsBase}sounds/`. Declared like any other service, in the
  game's `parts.componentDependencies`. The engine keeps knowing nothing
  about file names or the layout inside the package.

### Migration

For a plugin that loaded images from the engine's `/img/`:

1. Move the files into your package (`assets/img/`) and copy them to
   `dist/img/` in the build — mirroring the sounds pipeline.
2. Declare the service in the client config:
   `componentDependencies: { assetsBase: ['Map'] }`.
3. Build the URL from it: `` `${dependencies.assetsBase}img/${data.spriteSheet.img}` ``
   instead of `` `/img/${data.spriteSheet.img}` ``. Throw when the service is
   missing — `undefined` as a base silently produces a blank map.

`ENGINE_API_VERSION` is unchanged (3): the addition is purely additive and
no manifest or plugin is rejected at load time. A plugin that keeps the old
URLs still loads — it just has nothing to draw.

## [0.8.0] — 2026-08-17

### Added

- `vimp-engine/host/PortMachine.js` — the client handshake automaton (client
  ports 0–8), lifted out of `host.worker.js` as an isomorphic module: no
  `self`, no `postMessage`, no DOM, all transport arriving through
  `makeSocket`. It can now be driven from a plain browser tab or a Node
  process, not only from the host Worker. `new PortMachine({ host,
  socketManager, clientCfg, authSchema, makeSocket, identity })`, methods
  `connect`/`restore`/`message`/`disconnect`/`has` and the `socketIds`
  getter. The lobby wire protocol is unchanged, byte for byte.
- `vimp-engine/host/identity.js` — pluggable identity strategies
  (`{ params, errorField, resolve(data, socketId) }`) for the port machine:
  `createTokenIdentity({ jwksUrl, issuer })` is the lobby path (the `nick`
  claim of an RS256 identity token verified against the master's JWKS, with
  the same per-instance cache the Worker used to hold), and
  `createGuestIdentity({ fallbackPrefix })` is the master-less one — it
  declares a `name` form field validated by the engine's own `isValidName`,
  and falls back to `Player_xxxx`. A strategy's `params` go in front of the
  game's `authSchema.params` in both directions, so a guest nickname reaches
  the client form through the same channel as the game's own fields — and as
  its first field.
- `vimp-engine/lib/offlinePlayerData.js` — `offlinePlayerData()` builds the
  `hostOptions.playerDataFetch` for a contour with no master: every profile
  request answers `{ rank: 0, state: null }` instead of hitting the network.
  It was the headless runner's private stub; the standalone and dedicated
  hosts need the same one.
- `HostGame.destroy()` — a public teardown (stop the timers, flush the
  profiles, remove every participant), returning the flush promise. A tab's
  match dies with its Worker, but a long-lived process needs a graceful
  shutdown.
- Client boot modes: `vimp-engine/client/boot.js` picks between `lobby`
  (the master, signaling and the OAuth gate — today's behaviour), `solo` (the
  host inline in the same tab) and `dedicated` (a direct WebSocket to a Node
  server). `setBootConfig(cfg)` is the SDK's injection point;
  `resolveBootConfig()` falls back to `GET /config` and then to
  `{ mode: 'lobby' }`, so a network failure, a 404 or a malformed body all
  keep existing deployments on the lobby path. `main.js` branches on the mode
  in five places only (manifest source, signaling/lobby, transport,
  auto-authentication, canvas mount point).
- `vimp-engine/client/network/WebSocketTransport.js` — the third
  transport, interface-compatible with `WebRtcManager`/`LoopbackTransport`.
  `binaryType` is forced to `'arraybuffer'`; `reliable` is ignored (a
  WebSocket has no reliability levels), which moves RTT measurement onto the
  TCP path and backpressure onto the server.
- `vimp-engine/client/network/InlineHostBridge.js` — a drop-in
  replacement for `HostController` that runs the authoritative host in the
  page's main thread (`createHostRuntime` + `PortMachine` + guest identity +
  `offlinePlayerData`), so `LoopbackTransport` is reused unchanged. A
  `HostPlugin` cannot cross `postMessage`, hence inline; the production
  Worker path is untouched.
- `vimp-engine/client/views/gameShell.js` — `ensureGameShell(container)`
  builds the game UI containers in code (idempotent, so the pug markup of the
  lobby build is left alone) and `ensureCanvas(id, size, container)` mounts a
  canvas into the boot container instead of `document.body`. A parity test
  keeps the two sources of markup from drifting.
- `vimp-engine/client/lib/autostart.js` — the solo autostart:
  `startupVotes` (leaving the spectators) strictly before `startupCommands`
  (the game's chat commands, e.g. spawning bots), both on the first
  `renderTick` after `FIRST_SHOT_READY`.
- `vimp-engine/standalone` — `startStandaloneGame({ hostPlugin, clientPlugin,
  wasmUrl, container, assetsBase, playerName, playerModel, auth, startupVotes,
  startupCommands, room, devMode })` runs a whole match inside one browser tab
  of a *game* repository: no master, no OAuth, no lobby screen. It takes the
  live plugin objects, checks both against `ENGINE_API_VERSION`, builds the UI
  shell and an in-memory manifest, and hands the boot config to the engine
  client; it resolves to `{ stop() }`, which tears the match down (render loop
  off, inline host destroyed). There is no `bots: N` option — the engine has
  no notion of a bot; scripted participants are spawned by the game's own chat
  command via `startupCommands`, and `startupVotes` must precede them.
  Documented in `docs/en/standalone.md`.
- `vimp-engine/client/main.js` exports `stopGame()` — the external stop used
  by the SDK; it closes the transport, which runs the existing teardown path.
- The published surface of the package grew to the client half of the engine:
  `files` now carries `src/client` (minus the `_*` scratch files) and
  `src/standalone`, with the new exports `./client/*`, `./standalone` and
  `./style.css`. Consequently `howler` moved from `devDependencies` to
  `dependencies` — it is imported by the published `src/client/SoundManager.js`.
  A consumer bundling the SDK must dedupe `pixi.js` (two copies mean two
  extension registries and a dead renderer).
- The dedicated Node.js server — `src/dedicated/main.js`: one authoritative
  match of one game inside a Node process, with browsers connecting over a
  direct WebSocket (`/game`) and no lobby, OAuth or WebRTC anywhere.
  `startDedicatedServer({ gameId, port, host, room, loadGame, serveClient })`
  is exported for tests and embedders; the process form is selected by
  `VIMP_DEDICATED_GAME`. It reuses `createHostRuntime`, `PortMachine`,
  `createGuestIdentity` and `offlinePlayerData`, serves the master's catalog
  routes for its single game, mirrors the Worker's frame format byte for byte,
  drops unreliable frames above 256 KB of `bufferedAmount`, validates
  `Origin`, and shuts down gracefully on `SIGTERM`/`SIGINT`. Being public and
  long-lived, it also caps what an anonymous socket can cost: a 64 KB
  `maxPayload`, 300 frames/s per socket, 30 connections/minute per address and
  a 120 s handshake timeout. Documented in `docs/en/dedicated.md`.
- `src/master/main.js` is now a dispatcher between `src/master/lobby.js` (the
  lobby master, the previous content of `main.js`, unchanged) and
  `src/dedicated/main.js`, so one entry point serves both roles.
- `GET /config` on both servers: `{ mode: 'lobby' }` from the master and
  `{ mode: 'dedicated', gameId, gameVersion, wsPath }` from the dedicated
  server — the single contract the engine client probes to pick its boot mode.
- `vimp-engine/lib/loadGamePackage.js` — `loadGamePackage(distDir, { core })`
  loads a built game package in Node (manifest, both plugin halves, the
  `file:` URL of `entries.wasmNode`), with the `engineApi` and stale-`dist/`
  checks and named failures when the node core is missing. Lifted out of
  `src/devtools/pluginLoader.js`, which now delegates to it: a production
  server must not depend on the debugging tooling.
- `vimp-engine/config/env.js` — `applyMasterEnv(config, env)` (the
  `VIMP_DOMAIN`, `VIMP_MASTER_PORT`, `VIMP_AUTH_SERVICE_URL`, `GAMES_MATRIX`
  overrides, previously inline in the master and production-only) and
  `readDedicatedRoom(env)` for `VIMP_DEDICATED_ROOM`. The dedicated server
  applies them in development too — the game, port and room have no other
  source.
- `vimp-engine/client/network/policyClose.js` — `shouldReloadAfterClose(code)`
  and `POLICY_CLOSE_INFORMS`, the client's rule for a server's policy close
  codes, split out of `client/main.js` so it can be tested.
- `vimp-engine/config/closeCodes.js` — the transport close codes as one map
  (`staleHost`, `invalidOrigin`, `blocked`, `kickForMaxLatency`,
  `kickForMissedPings`, `kickIdle`, `roomFull`, `handshakeTimeout`,
  `tooManyConnections`), a shared contract of the server circuits and the
  client the way `config/gameCodes.js` already is: every call site now names
  the code instead of spelling out a literal, and a test requires each entry
  to be classified by `policyClose.js`. The numbers are unchanged.

### Changed

- The page's base CSS rules (`html`/`body`, the screen-hiding rule,
  `body.hide-cursor`) moved from the inline `<style>` of
  `packages/engine/index.html` into `src/client/style.css`: a game
  repository has no `index.html` of ours, and without them every engine
  screen would show at once. The CSP hash of the inline importmap is
  unaffected. The published form of the hiding rule keys on the boot
  container — `.vimp-shell > *`, the class being set by `ensureGameShell` —
  so the screens stay hidden inside an SDK container, while the page
  embedding the SDK keeps its own top-level markup. `index.html` keeps the
  pre-JS form (`body > *`) inline: until the class is set there is no
  container to key on, and the pug markup would flash.
- The runtime-built vote window (`#vote`) is mounted into the boot container
  instead of `document.body`: in `solo` it used to land outside the SDK
  container, where it was both hidden and positioned against the wrong
  containing block.

### Fixed

- A dedicated server's policy refusal no longer puts the client in a reload
  loop. The client reloads the page 3 s after a disconnect, which is right for
  an ordinary drop and wrong for every close code the server uses to refuse a
  connection: reloading spends another connection against the same rate limit
  (4009), restarts the same handshake timer (4008), leaves the page's origin
  exactly as it was (4001) and does not free a room slot (4006). An abandoned
  tab reloaded forever, and a player waiting for a slot walked into the
  connection limit after 30 reloads and was shown its message instead of their
  own reason. The rule now lives in `vimp-engine/client/network/policyClose.js`
  (`shouldReloadAfterClose`, `POLICY_CLOSE_INFORMS`); the texts in that map are
  fallbacks, shown only when the server sent no reason of its own (`roomFull`
  arrives in a `TECH_INFORM` frame before the close and always wins).
- `vimp-engine/lib/clientIp.js` warns once per process when `trustProxy` is on
  but no `X-Real-IP` arrives. That combination silently keys every client on
  the proxy's own address — a single shared bucket, under which the master's
  "1 room per IP" rule allows one room on the whole server and the ping limit
  becomes global. It happens with a hand-written proxy config, a CDN in front,
  or an `/etc/nginx/vimp.template` older than the header.

### Security

- A `WebSocket` close reason is capped at 123 bytes, and `ws` enforces that by
  throwing: an `Origin` header longer than ~80 bytes made both the master's
  signaling server and the dedicated server answer a rejected connection with
  an over-long reason, raising an unhandled `RangeError` — an unauthenticated
  request could kill the process. The rejected client now gets the short
  `invalidOrigin` marker and the full text goes to the log.
- The dedicated server registers an `error` listener on every game socket (and
  on the WebSocket server): `ws` emits `'error'` on the socket itself
  (ECONNRESET, a malformed frame), and without a listener one broken client
  was an `uncaughtException` that took the whole match down.
- Rate limits no longer key on `X-Forwarded-For`. The deploy's Nginx sets that
  header with `$proxy_add_x_forwarded_for`, which *appends* the real address to
  whatever the client sent, so the first hop — the value the master's signaling
  server and the auth service used as their key — is written by the client:
  one header per request lifted the ping limit, the "one room per IP" rule and
  the auth service's nick-guessing and OAuth-start limits, and filling another
  address's bucket kept that person from hosting or signing in. The address now
  comes from the new `vimp-engine/lib/clientIp.js` — the socket address, or
  `X-Real-IP` when a `trustProxy` flag is set (production), where the same
  Nginx overwrites that header with `$remote_addr`. A signaling connection
  whose address cannot be determined is terminated instead of sharing one
  bucket with every other such connection, which also removes a `TypeError` on
  a socket that is already gone.
- The signaling server attaches its socket `error` listener before any early
  rejection, not after: both rejection paths call `ws.terminate()` and return,
  and the "no address" one runs precisely on an already-broken socket — the
  likeliest source of the late `ECONNRESET` that `ws` re-emits as `'error'`,
  which without a listener is an `uncaughtException`. The auth service answers
  `429` to a request with no address instead of counting it into a shared `''`
  bucket, and its rate limit moved into `packages/auth/src/lib/rateLimit.js`
  so that contract is covered by tests.

## [0.7.0] — 2026-08-09

Items marked *(app shell)* live in `src/client/**`, which is outside the
package `files`: they change the engine app, not the published artifact.

### Added

- Wasm ABI: `ClientCore.resync()` (from `vimp-engine-core`) — a clock resync
  after a long tab pause, network half only. The engine shell calls it as
  `clientCore?.resync?.()` on `visibilitychange` → visible, so a plugin
  built against an older crate keeps working; a plugin rebuilt on the new
  crate gets the method for free. `ENGINE_API_VERSION` is unchanged (**3**).
- WebGL context-loss handling in the client shell *(app shell)*: rendering is
  paused on `webglcontextlost`, and on `webglcontextrestored` assets are
  re-baked and the map is rebuilt from the cached `MAP_DATA` (no repeat
  `MAP_READY`) — every visible pixel is a GPU-only `RenderTexture` with no
  CPU source. Loss is tracked **per canvas** (`lib/contextTracker.js`): the
  browser restores each context separately, and re-baking into a still-dead
  one yields empty textures with no second event to fix them, so the scene
  is rebuilt only once every context is alive again.
- `SoundManager.releaseSound(id)` *(app shell)* — unregisters while letting
  an already playing one-shot finish, for entities that disappear earlier
  than their sound (a detonated bomb and its "planted" sample). A looped
  sound is still stopped.

### Changed

- `SoundManager.reset()` *(app shell)* no longer clears looped registrations,
  only stops the playing instances and their active ids: registrations belong
  to entities, and after a partial clear a surviving loop is restarted by the
  next `processAudibility()` instead of going silent for the rest of the
  session. One-shot registrations **are** dropped — `Howler.stop()` emits no
  `end`, so a sample that already played would otherwise be started over.
  `destroy()` still clears the whole registry.
- `RoundManager.createMap()` sends every human the spectator `KEYSET_DATA`
  right before `CLEAR`, so client prediction is off by the time the canvas
  is cleared and can no longer recreate the local entity as a ghost.
- `CanvasManagerModel` *(app shell)* ignores a zero-sized resize (minimized
  tab/window), which used to drive the scale to `0` and the renderer to
  `0x0` with no recovery until the next real resize; emitted sizes are
  clamped to `1`. `fixSize` now parses both parts as numbers — the height
  used to leak out as a string.
- `clientCore.resync()` *(app shell)* is called only after a tab pause of at
  least 3 s. A short alt-tab used to throw away a perfectly valid frame
  buffer together with its event frames (entity create/delete), freezing the
  scene for the interpolation delay and dropping removals.
- `BakingProvider` *(app shell)* destroys each baked object once per re-bake
  even when a baker returned it under several keys, and logs a failed
  `destroy` instead of swallowing it. A baker owns what it returns: re-baking
  destroys the result together with its `TextureSource`, so returning a view
  onto a shared atlas is not allowed.

## [0.6.0] — 2026-08-05

### ⚠️ Breaking — stricter `gameConfig` gate

The plugin API itself is unchanged: `ENGINE_API_VERSION` stays **3**, no
manifest restamp and no plugin rebuild are required. What changed is that
configs the engine used to accept and then fail on later — or silently
degrade on — are now rejected at load, naming the field:

- `teams` and `spectatorTeam` are **required** (`REQUIRED_GAME_CONFIG_PATHS`
  grew from seven paths to nine). They always were, de facto: without them
  `HostGame` dereferenced `undefined` and the game died in three different
  places with three unrelated messages.
- `spectatorTeam` must be a **key of `teams`**. A typo used to leave the
  spectator team id `undefined`, and the first participant to join crashed in
  `ParticipantManager.createHuman` on a team counter that does not exist.
- `null` in any required path now counts as **missing**. Previously only
  `undefined` did, so `snapshot: null` or `weapons: null` passed the gate and
  failed later, somewhere else.

**Migration.** If the host now refuses to start with
`gameConfig is missing required field(s): …` or
`spectatorTeam '…' is not a key of teams (…)`, the named field was already
broken — declare it (or spell it as one of the `teams` keys) and the plugin
loads as before. A plugin that passes today needs no change.

### Added

- `vimp-sim`: the built-in smoke scenario is now built from the game's own
  `gameConfig` — model from `parts.models`, playable team from `teams` minus
  `spectatorTeam`, and the first `playerKeys` entry that is not a `type: 1`
  trigger. It used to hardcode the engine fixture's `m1`/`team1`/`forward`,
  which crashed or failed a perfectly good third-party plugin.
- Scenario field `unusedSnapshotKeys: "*"` — "this scenario does not audit key
  coverage at all", which makes invariant 2 **skip** instead of reporting the
  game's keys as never spawning.
- `vimp-sim --core` without `--game` prints a notice: the run falls back to
  the fixture, whose core is plain JS, so the flag does nothing.

### Changed

- The `gameConfig` gate now runs inside `devtools/pluginLoader.js`, not only
  in `createHostRuntime` — the built-in scenario reads `gameConfig` before the
  run starts, so a plugin without one answered with a raw `TypeError`. The
  fixture goes through the same gate as a third-party plugin.
- Invariant 9 (`predictionDrift`) skipped by a scenario that sets
  `divergence: null` now says so, instead of blaming the client core for
  reporting no divergence data.
- `vimp-sim` usage errors (unknown option, missing option value) print the
  message and `USAGE` without a Node stack; `--scenario`/`--game`/`--core`/
  `--out` reject a missing value instead of silently falling back to the
  fixture.

### Fixed

- `vimp-sim --game <plugin>` no longer reports a false red verdict on a
  healthy game: the two invariants the built-in scenario cannot judge (2 —
  key coverage, 9 — prediction drift, whose thresholds are per-game) are
  skipped with a notice on stderr instead of being judged by the fixture's
  values.

## [0.5.0] — 2026-08-05

Code-review pass over the 0.4.0 debugging loop. No API change:
`ENGINE_API_VERSION` stays **3**.

### Added

- `GameManifest.entries.wasmNode` is now verified to exist at load. A manifest
  advertising a Node core that the published package did not ship failed with
  a raw `ERR_MODULE_NOT_FOUND` from the resolver; it now names the manifest,
  the declared path and the fix. Both plugin halves are additionally
  re-checked against the manifest's `engineApi`, which catches a rebuilt
  manifest sitting next to a stale `dist/`.
- Prediction-drift level 1 (`vimp-engine-core` 0.2.0): with
  `GameClientDef::predicted_state` implemented, the detector compares the
  core's own predicted state component-wise instead of the overlay camera.
- Browser debug requests to the Worker got a 5 s timeout — debugging is needed
  exactly on a hung Worker, where a silent `await` in the console is the very
  failure being investigated.

### Changed

- `RecordingSocketManager` now **inherits** `SocketManager` instead of
  re-declaring its ports, so a port added to the engine can no longer be
  invisible to the headless runner. Frames are published in wire order
  (a composite sender before the payloads it nests), and a second payload
  from one sender throws with the violated contract named instead of being
  silently overwritten.
- `ScenarioRunner`: frame-stream hashes are collected only under
  `--determinism` (a long match no longer carries megabytes of unused hashes
  into the report); the scenario's `config.timers` is merged explicitly;
  a leaving participant's client core is destroyed.

## [0.4.0] — 2026-08-04

Two large tracks: the headless debugging loop and the lobby page.
`ENGINE_API_VERSION` unchanged (**3**) — no plugin rebuild required.

### Added

- **Headless match runner** — `vimp-sim` (`packages/engine/bin/vimp-sim.js`,
  exposed as the package's bin) plus `src/devtools/`: virtual clock,
  recording transport, a real `ClientCore` per participant, scene dumps, and
  **12 invariant checks** that turn a silent contract break (a snapshot key
  that never spawns, a field-width drift, an uncovered `gameSets` class) into
  a named line of text. Root scripts: `npm run sim`, `sim:check`,
  `sim:replay`. Docs: `docs/en/debugging.md`, `docs/ru/debugging.md`.
- **`src/lib/createHostRuntime.js`** — the production match initialisation,
  now shared by `host.worker.js` and the runner, so the headless run cannot
  drift from the real one.
- **`src/lib/clock.js`** — a single injectable source of `now`/monotonic/
  random/timers, which is what makes a match reproducible under a virtual
  clock.
- **Browser half of the loop**: `DebugRecorder` in the host and
  `window.__vimpDebug` in the tab record a live match into the runner's
  scenario format; `POST /debug/report` on the master (dev only, 404 in
  production) collects the uploads into the same `.debug/` tree.
- **Rust core** (`vimp-engine-core` 0.2.0): `debug.rs` — a curated world dump
  behind `debug_json`; `client/divergence.rs` — a prediction-drift tracker
  behind `take_divergence`. Both arrive through the ABI macros, so a game
  implements nothing.
- **Lobby leaderboard**: `GET /auth/leaderboard` (public, no token) and
  `GET /auth/placement`, proxied by the master under the same origin (no CSP
  change), with a keyed TTL cache in front of the leaderboard
  (`master.leaderboard.cacheTtl`, `maxLimit`). Lobby config gained
  `leaderboardUrl`, `placementUrl`, `leaderboardLimit`.
- **`docs/ai/`** — a self-contained English spec of the plugin contract for
  an LLM authoring a game plugin, including a questionnaire and an authoring
  workflow.

### Changed

- Lobby page reworked: game selector filling from the master catalog,
  servers/leaderboard tabs, new panel and animations.
- `PlayerDataSync` no longer blocks a participant's entry: rank/state load
  asynchronously and an auth-service failure leaves engine defaults.

## [0.3.0] — 2026-07-30

### ⚠️ Breaking — plugin API v3 (`ENGINE_API_VERSION` 2 → 3)

The form-control set is reduced to **native form elements**:
`select` | `text` | `checkbox` | `radio`. `range`, `number`, `toggle` and
`segmented` are gone. A plugin whose `roomForm` or `authSchema.params[]`
still uses a removed control renders nothing for that field, and a plugin
built against v2 is rejected outright by `GameCatalog`, the host Worker and
the client.

### Added

- Native constraint validation on `control: 'text'`: `regExp` → `pattern`,
  plus `required` and `maxlength`; the engine calls `reportValidity()` on
  every control before submit (room form and auth form alike).
- `numeric: true` — a text field whose value is parsed as a number and
  converted through the same `unit` as the stored value. Empty or invalid
  input falls back to `default` instead of becoming `0` on submit.
- `hidden: true` — the field is built and submitted, but no row is rendered.

### Changed

- Controls are plain native elements with no themed markup, so a plugin's
  form always matches the rest of the page (≈160 lines of custom control CSS
  dropped).
- Silent token restore no longer shows an error: an expired or invalid stored
  token is dropped and a clean sign-in screen appears. `login-error`
  (`tokenExpired`/`invalidToken`) is emitted only on the interactive path
  (OAuth redirect, nickname submission) — a stale token on a return visit is
  expected, not an error.

### Migration (game plugins)

1. Bump the `vimp-engine` dependency to `^0.3.0` and rebuild so the manifest
   stamps `engineApi: 3`.
2. Replace removed controls: `range`/`number` → `text` with `numeric: true`
   (and an exact-range `regExp` generated by your manifest builder),
   `toggle` → `checkbox`, `segmented` → `radio` or `select`.
3. Republish; on the master, install the new plugin version and redeploy.

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

[0.21.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.21.0
[0.20.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.20.0
[0.19.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.19.0
[0.18.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.18.1
[0.18.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.18.0
[0.17.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.17.0
[0.16.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.16.0
[0.15.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.15.0
[0.14.4]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.14.4
[0.14.3]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.14.3
[0.14.2]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.14.2
[0.14.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.14.1
[0.14.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.14.0
[0.13.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.13.0
[0.12.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.12.0
[0.11.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.11.1
[0.11.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.11.0
[0.10.2]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.10.2
[0.10.1]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.10.1
[0.10.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.10.0
[0.9.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.9.0
[0.8.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.8.0
[0.7.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.7.0
[0.6.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.6.0
[0.5.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.5.0
[0.4.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.4.0
[0.3.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.3.0
[0.2.0]: https://github.com/lgick/vimp/releases/tag/vimp-engine%400.2.0
