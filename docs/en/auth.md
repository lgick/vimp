# Central Auth Service

`packages/auth/` (`@vimp/auth`) is a standalone Node.js/Express service — a
separate npm workspace, its own deploy/domain, its own PostgreSQL database
(the project's first database dependency). It provides OAuth login, a
globally-unique nick, JWT identity tokens (RS256, verified by a browser host
via JWKS) and per-game rank/state storage. It carries no game logic and is
independent of `vimp-engine`.

> Status: Stages B1–B6 of `plan/README.md` are implemented — B1 (service +
> schema + REST), B2 (lobby login UI), B3 (JWT handoff into the game +
> host-side `/jwks` verification), B4 (rank/state loading + sync between the
> auth service, master and host), B5 (`/rank` chat command) and B6 (CI image,
> deployment, config docs — see
> [deployment.md](deployment.md#central-auth-service-packagesauth)). A
> follow-up code-review pass (`plan/done/central-auth/auth_fixes.md`) hardened the production
> path — CORS/open-redirect/callback-URL/token-renaming/TTL fixes below.

## Why a separate service

The master server (`packages/engine/src/master/`) has no database and is
deployed per-domain; several masters can share one auth service so a nick,
rank and per-game state stay global across domains. See
`plan/README.md` for the full rationale and the caveat that a browser host is
untrusted — any rank/state it reports is technically forgeable; JWT only
protects identity (the nick can't be spoofed), not match-result integrity.

## Running

```bash
npm run dev:auth          # dev, http://localhost:3010 (nodemon)
npm run start:auth        # production, reads .env
npm run auth:db:migrate   # apply packages/auth/src/db/migrations/*.sql
```

`dev:auth` and `auth:db:migrate` load the repository-root `.env` too
(`node --env-file-if-exists`), so OAuth credentials and
`VIMP_AUTH_DATABASE_URL` don't have to be exported into the shell by hand;
unlike `start:auth`, they don't fail when the file is absent.

Config file — [packages/auth/src/config/auth.js](../../packages/auth/src/config/auth.js).
Requires a PostgreSQL database (`VIMP_AUTH_DATABASE_URL`, defaults to
`postgres://localhost:5432/vimp_auth`) and an RS256 key pair under `.keys/`:

```bash
openssl genrsa -out .keys/jwt.pem 2048
openssl rsa -in .keys/jwt.pem -pubout -out .keys/jwt.pub.pem
```

GitHub is the only wired-up OAuth provider so far (Google/Apple follow the
same provider shape in `src/oauth/`). Register a GitHub OAuth App with
callback `http://localhost:3010/oauth/github/callback` and set
`VIMP_AUTH_GITHUB_CLIENT_ID` / `VIMP_AUTH_GITHUB_CLIENT_SECRET`.

In production (`NODE_ENV=production`) the service refuses to start unless
these are set (`src/main.js`):

| Env var | Purpose |
| --- | --- |
| `VIMP_AUTH_PUBLIC_URL` | public origin used to build the OAuth `redirect_uri` (`callbackUrl()`); without it the callback URL falls back to `http://localhost:PORT`, which OAuth providers can't reach |
| `VIMP_AUTH_ALLOWED_ORIGINS` | CSV of master origins allowed to CORS `POST /nick` and to receive an OAuth redirect (`returnUrl` origin checked on both `/start` and `/callback` — closes an open-redirect that would otherwise leak an identity token) |
| `VIMP_AUTH_STATE_SECRET` | HMAC secret for the stateless OAuth `state` param (`src/lib/oauthState.js`); compared with `crypto.timingSafeEqual`, not `!==` |
| `VIMP_AUTH_GITHUB_CLIENT_ID` / `VIMP_AUTH_GITHUB_CLIENT_SECRET` | GitHub OAuth App credentials |

In dev, `VIMP_AUTH_ALLOWED_ORIGINS` defaults to the dev master's origin
(`https://localhost:3002`).

`VIMP_ADMIN_NICKS` is optional in every mode (master-game-registry stage 1):
a CSV of nicks that are granted `role = 'admin'` on every login and
demoted back to `'user'` once they leave the list (`parseAdminNicks` in
`src/config/auth.js`, matched case-insensitively — a nick is globally unique
and case-insensitive, so the list is provider-independent). An empty value
means "no admins" and must not fail: in production that is the legitimate
state until the first setup.

`VIMP_ADMIN_IDENTITIES` is the safer, also optional source of the same
right: a CSV of `provider:uid` pairs (`github:1234567`), matched against the
`provider` / `provider_uid` columns of the `users` row — for GitHub that is
the numeric account id, which survives an account rename. **It wins over
`VIMP_ADMIN_NICKS` entirely**: while it is non-empty, a nick grants nothing
and only a listed identity gets `admin` (`isEnvAdmin` in
`src/lib/adminRights.js`); when it is unset, the nick list behaves exactly as
before.

**Why it exists.** Admin rights attached to a *string* are only as safe as
that string being taken. A nick listed in `VIMP_ADMIN_NICKS` that nobody has
registered yet — a fresh database, a nick added to the list before its owner's
first login, a typo in the list — is handed to whoever signs up with it first,
together with `role = 'admin'`; OAuth sign-up is open to everyone and the race
is won with a single request. Taking over an *already registered* admin nick
is not possible (a nick is globally unique case-insensitively and there is no
rename), so the exposure is exactly the free-nick window.

**Recommendation for a new install**: either register the admin nicks before
opening sign-up, or fill in `VIMP_ADMIN_IDENTITIES` right away. On start the
service prints one line per admin nick — a warning for a nick nobody has
registered, and `[admin] "<nick>" -> github:<uid>` for one that exists, which
is the ready-made value for `VIMP_ADMIN_IDENTITIES` (no SQL against
production needed). Both lines are skipped once `VIMP_ADMIN_IDENTITIES` is
set.

## Schema

```
users:           id, provider, provider_uid, nick(UNIQUE), role, created_at
games:           id, package_name, title, repo_url, author_user_id, status,
                 version, pending_version, max_game_score, moderator_note,
                 moderator_user_id, created_at, updated_at    ← game registry
ratings:         user_id, game_id, rank, updated_at            ← denormalized cache
rank_events:     id, user_id, game_id, hoster_user_id, session_id,
                 delta, best, voided, created_at               ← append-only ledger
                                                                 of GAME RESULTS
rank_periods:    user_id, game_id, kind('d'|'m'), period,
                 best, points                                  ← day/month aggregate
rank_periods:    user_id, game_id, kind('d'|'m'), period,
                 best, points                                  ← day/month aggregate
state_snapshots: user_id, game_id, session_id, hoster_user_id,
                 state_before, created_at                      ← rollback MVP
states:          user_id, game_id, state(JSONB opaque), updated_at  ← "skills"
host_ratings:    hoster_user_id, score, blocked, updated_at     ← denormalized cache
host_votes:      hoster_user_id, voter_user_id, value, reason,
                 updated_at                                    ← current opinion, one row/pair
```

`(provider, provider_uid)` is unique — one row per external identity;
`nick` is unique across the whole service (one nick, all games), enforced
case-insensitively (`002_nick_case_insensitive.sql`, a `UNIQUE INDEX` on
`lower(nick)` on top of the plain `UNIQUE(nick)`) so `"Admin"` and `"admin"`
can't coexist. `packages/auth/src/UserRepository.js` is the only module
touching these tables.

**The game registry** (master-game-registry stage 1, `009_games.sql`) lives
here rather than on a master because moderation must be one per platform, not
one per master (`SERVERS_MATRIX`). `status` is `pending` | `approved` |
`rejected` | `disabled`; `version` is the approved version masters serve
(`NULL` until the first approval) and `pending_version` the one under review —
there is deliberately no `testing` status, because "a game under test" is
simply a game that has a `pending_version` while players keep playing
`version`. `max_game_score` caps a single match's result for that game
(`NULL` — the engine default). `lower(package_name)` is unique: two rows for
one npm package would mean the same code served under two ids. Like every
migration here it is idempotent and re-runnable, and it seeds the two games
that already exist (`ON CONFLICT DO NOTHING`) so the lobby never empties.

`users.role` is `'user'` by default and there are exactly two roles,
`'user'` and `'admin'`. The single source of admin rights is the environment
— `VIMP_ADMIN_IDENTITIES` if set, otherwise `VIMP_ADMIN_NICKS`: `syncRole`
writes the role on every token issue in one statement, and its `CASE` demotes any `admin` that is not on the list — so an
admin cannot be appointed behind the list's back by editing the row in the
database. Other roles (a moderator appointed from an admin UI later) are left
alone.

**The ledger of game results** (server-rating stage 1, `003_rank_ledger.sql`;
snakes-v3, `007_game_results.sql`): `ratings.rank` is a cache, not the source
of truth. Every write appends one row to `rank_events`, attributed to the
hosting server (`hoster_user_id`, the room creator's `userId`) and its session
(`session_id`). That attribution is what lets server-rating stage 4 void a
banned server's contribution without touching the rest of a player's history.

Since snakes-v3 a row is a **game result**, and it carries two numbers:

| Column | Meaning |
| --- | --- |
| `delta` | the SUM of the points of the games in this row — the monthly and all-time ratings |
| `best` | the best SINGLE game among them — the daily rating |

Two columns rather than a row per game, because the engine is free to coalesce
several finished games of one player into one request: on a merge the sum adds
up and the maximum stays a maximum, so both aggregations stay exact. Rows
written before the migration are read as they are, and it backfills them with
`best = GREATEST(delta, 0)` — the closest honest reading of "the rank gained
in a match".

**Three ratings out of one ledger.** `period` picks not only the window but
the aggregation:

| `period` | Read from | Window |
| --- | --- | --- |
| `day` | `rank_periods.best` (kind `'d'`) | the calendar UTC day, live |
| `month` | `rank_periods.points` (kind `'m'`) | the calendar UTC month, live |
| `all` | the `ratings` cache | a snapshot, recomputed once a day |

**The two live slices read an aggregate, not the ledger**
(`008_rank_period_aggregates.sql`). One row per (player, game, window), so a
game that writes half a million ledger rows a day is read as eight thousand —
the number of its players — and a top or a placement becomes an index range
scan instead of a hash aggregate over the day. `recordGameResult` maintains it
in the SAME statement that appends the ledger row, so the two can never
disagree, and both windows are taken from that row's own `created_at` rather
than a second `now()` that could fall on the other side of midnight. The
ledger stays the source of truth: `recomputePeriods` rebuilds the aggregate
from it whenever a hoster's contribution is voided, because `best` is a
maximum and nothing can be subtracted from one.

**A place is not a query per player.** "How many are ahead of me" is the same
answer for everybody, so it is not asked per caller. `RankDistribution`
(`src/db/RankDistribution.js`) caches, per (game, slice) and for
`rank.distributionTtl`, the ladder of DISTINCT scores in that slice together
with how many players stand on each step and above it; a place is then a
binary search, and the caller's own score a primary-key lookup. The definition
is unchanged — `1 + (players strictly above me)` is exactly `/leaderboard`'s
`RANK()`, so the badge and the list still agree.

The ladder holds distinct scores rather than players, so its memory does not
grow with the size of the game; it is capped at `rank.distributionSteps` steps
and a game that overflows the cap answers its deep tail with an exact query
instead. The caller's own score is always read live, so only the FIELD can be
stale, and only for the TTL — and it can be stale in one direction only, since
`best` and `points` only ever grow.

`all` is deliberately not recomputed on write: `PUT /rank` is one statement and
nothing else, or every result would drag a `SUM` over the player's whole
history behind it. `packages/auth/src/db/ratingsJob.js` is the daily job that
moves the cache instead — it runs at **00:05 UTC** (five minutes after the
daily slice resets, so the two events are apart in the log), sums only the
events that arrived since `ratings.updated_at` and moves that cursor to
`now()`. `npm -w @vimp/auth run db:ratings` runs it by hand.

The run takes a **session-scoped advisory lock** (`pg_try_advisory_lock`) on a
dedicated connection and skips itself if the lock is held. That is not
housekeeping: the statement is incremental (`previous rank + SUM(new events)`),
so two runs overlapping would not merely duplicate work, they would DOUBLE
every player's day — the second one reads the same `ratings.updated_at`,
because the first has not committed its `now()` yet. And overlap is easy to
arrange: `startRatingsJob` runs in every auth process, a manual `db:ratings`
can land on the scheduled one, and a restart can fall inside the window. The
consequence of the daily cadence is worth stating out loud too: the all-time
list and the caller's own all-time row both show the snapshot taken at
00:00 UTC, and today's games are not in it.

**Write limits.** `config.rank` no longer holds a per-match `maxDelta` but two
absolute ceilings on a result: `maxGameScore` (10 000, one game) and
`maxPoints` (200 000 = ×20, the sum of games coalesced into one request);
`best <= points` is validated too, since `best` is a maximum over the games
whose sum is `points`. Both are the LAST line of defence and deliberately
generous — auth serves hundreds of games and one exact limit for all of them
is wrong by construction. The working per-game limit lives on the master
(`master:games[].maxGameScore`), together with the per-room write rate
(`master:playerData:writesPerMinute`). `state_snapshots` captures
`state` once per `(user, game, session)` — the value right before that
server's first write — as an MVP rollback point; a player who plays a clean
server between two sessions on a banned one will have that clean progress
overwritten if the snapshot is ever restored — an accepted MVP tradeoff,
since the alternative (a snapshot per session) is not implemented yet.

**Server rating** (server-rating stage 2, `004_host_ratings.sql`,
[master.md](master.md#server-rating-likeunlike)): unlike the rank ledger,
`host_votes` isn't append-only — it holds **one row per `(hoster, voter)`
pair**, since a guest's opinion of a hoster can change (`like`↔`unlike`) and
should replace, not accumulate on top of, their previous vote. `voteHost`
upserts that row (no-op if the value is unchanged — `counted: false`) and
recomputes `host_ratings.score = clamp(SUM(value), config.rating.min/max)`;
`blocked = score <= config.rating.blockAt`. `config.rating` here mirrors the
engine's default (`packages/engine/src/config/master.js: rating`) — this
service is the one that actually clamps/decides `blocked`, the master's copy
is just the documented default.

**Annulment on ban** (server-rating stage 4): the first time a vote pushes a
hoster's score to `blocked` (checked as an edge — a vote that keeps an
already-blocked hoster blocked doesn't repeat this), `_recomputeHostRating`
calls `voidHosterContributions(hosterUserId)` — entirely within the auth
service, since it's the sole owner of both the rank ledger and the state
snapshots (stage 4.1: "transactional on auth, not on the master"). It marks
every non-voided `rank_events` row for that hoster as `voided`, recomputes
`ratings.rank` for every `(user, game)` pair that hoster ever touched (even
if voiding is a no-op on retry, the cache recompute still runs — that's what
makes the whole call idempotent), and restores `states.state` from that
hoster's **earliest** `state_snapshots` row per `(user, game)` — the value
right before the player's first session on that hoster, discarding any
progress made specifically there. No SQL transaction wraps this (this class
doesn't use one anywhere, see `recomputeRank`); idempotency of each step
substitutes for atomicity. Known limitation carried over from stage 1: clean
progress made on other servers between two sessions on the banned one is
also reverted by the snapshot restore.

**Leaderboard index** (lobby page plan, `005_leaderboard_idx.sql`): a
`(game_id, rank DESC)` index on `ratings`, so `GET /leaderboard`'s
`ORDER BY rank DESC` per game doesn't fall back to a full table scan.

## REST API

| Endpoint | Purpose |
| --- | --- |
| `GET /oauth/:provider/start?returnUrl=` | redirects to the provider's authorize page; `returnUrl`'s origin must be in `VIMP_AUTH_ALLOWED_ORIGINS` (`400 returnUrlNotAllowed` otherwise) and a CSRF nonce are packed into a signed, stateless `state` param (`src/lib/oauthState.js` — HMAC, no server-side session), rate-limited per IP (`rateLimit(oauthStartLimiter)`) |
| `GET /oauth/:provider/callback` | exchanges `code`, finds/creates the user by `(provider, providerUid)`, re-checks the decoded `returnUrl` origin, then redirects to it with either `?token=` (nick already set — full identity JWT) or `?pendingToken=` (first login — nick not chosen yet) |
| `GET /dev/login?nick=&returnUrl=` **(dev only)** | skips OAuth entirely: finds/creates the user as `('dev', nick)`, sets the nick on first login (`setNick`'s `nick IS NULL` guard makes repeats a no-op) and redirects to `returnUrl` with `?token=` — exactly the shape `/oauth/:provider/callback` produces, so the client path is unchanged. The nick goes through the same `isValidNick`, the return URL through the same allow-list check as OAuth (no open redirect with a valid token). Nicks are unique case-insensitively (`users_nick_lower_unique_idx`), so logging in as `admin` while `Admin` exists is a refusal, not a new identity: `409 nickTaken`, and the half-created row is removed (`deleteIfAnonymous`) so the next attempt is not a `500`. Registered **only** when `NODE_ENV !== 'production'`; in production the route does not exist (`404`). Handler — `src/devLogin.js`, see [getting-started.md](getting-started.md#central-auth-service-needed-to-reach-the-lobby) |
| `POST /nick` (Bearer pending token, `{ nick }`) | CORS-enabled for `VIMP_AUTH_ALLOWED_ORIGINS` origins (preflight `OPTIONS` too — the only endpoint called directly from the browser lobby, not proxied by a master), rate-limited per IP; rejects an identity token (`403 nickAlreadySet` — a pending token is required, so `/nick` can't rename an existing user); validates the nick against `NAME_REGEXP` (case-insensitively unique — see Schema) and sets it, returns `{ token }` (full identity JWT). `409 { error: 'nickTaken' }` on a race |
| `GET /games` (no auth — master-game-registry) | `{ games: [...] }` — the catalog a master builds from: approved games that have a servable `version`, ordered by `id` (a deterministic order matters — the first game becomes the active one in the lobby). Unauthenticated for the same reason as `/leaderboard`: the platform's game list is public lobby data, so the row is projected down to `id`, `packageName`, `title`, `repoUrl`, `authorNick`, `version`, `maxGameScore` — the moderation note, the author's internal id and the pending version stay internal |
| `GET /games/mine` (Bearer identity token) | the caller's own submissions with `status`, `pendingVersion` and `moderatorNote` — but **not** `moderatorNick` (`src/lib/gameViews.js` drops it, and so do the author's own `POST /games` and `POST /games/:id/version` answers). Moderation is anonymous from the author's side: what is addressed to them is the note, not the person — "this submission was killed by *that* human" is a product decision about moderator harassment, not a by-product of the shared row projection. Same reason `GET /games` omits it |
| `POST /games` (Bearer, `{ id, packageName, title?, repoUrl?, version }`) | a submission from any signed-in user — there is no `developer` role: the submitter becomes the game's author (`author_user_id`), and only an admin can hand authorship to somebody else (`PATCH /admin/games/:id`, `authorNick`). `201 { game }`, created as `pending` with `pendingVersion = version`. Rate-limited per IP (5/60s). A missing `id`, `packageName` or `version` is `400 { error: 'badRequest', field }` — presence belongs to this route, while the format checks below are shared with moderation. Each field answers with its own code — `400 invalidGameId` \| `invalidPackageName` \| `invalidVersion` \| `invalidTitle` \| `invalidRepoUrl` — `409 gameExists` for a taken `id` or an already registered package (both are the same `23505`), `403 tooManyGames` above `config.games.maxPerUser` |
| `POST /games/:id/version` (Bearer — author or admin) | `{ version }` → `{ game }`: stages a new version for review without touching the served `version`, clears `moderatorNote` and lifts `rejected` back to `pending`. `404 unknownGame`, `403 forbidden` for someone else's game |
| `DELETE /games/:id` (Bearer — author or admin) | removes the game from the registry **and every row keyed by its `game_id`** — `rank_periods`, `rank_events`, `state_snapshots`, `states`, `ratings`, in that order, with the `games` row last. None of those tables has an FK on `games`, so the cleanup is explicit: orphaned rows would come back to life under a later submission that took the same id. Not wrapped in a transaction (this repository holds none anywhere) — the order makes an interrupted run safe to repeat, and the game stays visible until its own row goes. An admin may delete a game in any status; an author only their own, and only while it is not being served: `409 gamePublished` for an `approved` game (an admin disables it first), `403 forbidden` for someone else's, `404 unknownGame` if there is none. Rate-limited per IP with the other registry writes (5/60s) |
| `GET /admin/games` (Bearer, admin) | the whole moderation queue, freshest first, with author and moderator nicks |
| `PATCH /admin/games/:id` (Bearer, admin, `{ status?, version?, pendingVersion?, note?, maxGameScore?, authorNick? }`) | a moderator's decision — only the keys present are written. `status: 'approved'` without an explicit `version` promotes `pendingVersion` to `version` and clears it (the common path must not need two fields). `maxGameScore` must be a positive integer within this service's own ceilings (`<= config.rank.maxGameScore`, and `× 20` — the engine's merge window — still within `config.rank.maxPoints`), else `400 invalidMaxGameScore`: a ceiling above them would let the master forward a result this service then rejects, and the host would retry that flush forever. `404 unknownGame`. **`authorNick`** reassigns authorship: the nick is resolved to a user id case-insensitively (`400 badRequest` if it isn't a valid nick, `404 unknownUser` if nobody holds it), and `null` or `''` clears the author — a game of the platform's own is legitimately nobody's. It is the only way to give an author to the games seeded by `009_games.sql` with `author_user_id = NULL`: until an admin does it, they are in nobody's "My games" and nobody can request a new version for them. When the decision leaves the platform with no servable game at all, the answer carries `warning: 'catalogEmpty'` — not a refusal (the lobby stays up: sign-in, "My games" and "Moderation" do not depend on a game), but rooms cannot be created until something is published again, and the moderator has to learn that here rather than from the players |
| `GET /jwks` | RS256 public key as a JWK — a host verifies `token`'s signature against this before trusting its `nick` |
| `GET /rank?game=` (Bearer identity token) | `{ rank }` — the `ratings` cache for that game: the clamped all-time sum of the caller's non-voided `rank_events` **as of the last daily job**, not as of now |
| `PUT /rank?game=` (Bearer, `{ points, best, hosterUserId?, sessionId? }`) | appends one GAME-RESULT ledger row attributed to the reporting server/session and answers `{ ok: true }` — nothing is recomputed on the hot path, so returning a rank here would be a lie (`all` is a daily snapshot). Both numbers must be non-negative integers with `best <= config.rank.maxGameScore`, `points <= config.rank.maxPoints` and `best <= points`, else `400 invalidRank`. `delta` is still accepted as an alias of `points` for one version (an older host has no `best`, and its `points` is read as a single game). `hosterUserId`/`sessionId` are meant to be stamped by the caller's *master*, not the browser host itself — see [master.md](master.md#getput-authrank-getput-authstate) |
| `GET /state?game=` (Bearer) | `{ state }` (opaque JSON, the "skills" blob) |
| `PUT /state?game=` (Bearer, `{ state, hosterUserId?, sessionId? }`) | if `sessionId` is given and no snapshot exists yet for `(user, game, session)`, first stores the current `state` into `state_snapshots`, then upserts the new `state`; rejects a state above `config.state.maxBytes` (`400 stateTooLarge`) |
| `GET /host-rating` (Bearer identity token) | `{ score, blocked }` — the caller's **own** rating, as a hoster; the master calls this with the hoster's token on `register_host` to decide whether to reject the room (`blocked: true`), and to seed the room's cached lobby `rating` (server-rating stage 3) |
| `PUT /host-rating/:hosterUserId` (Bearer, `{ value, reason }`) | a guest's vote for/against `hosterUserId` (the caller is the voter, taken from their Bearer token — `403 selfVote` if it equals `hosterUserId`); `value` must be `1` or `-1` (`400 invalidVote`); an empty/missing `reason` isn't counted (returns the current rating with `counted: false`, no write); otherwise upserts the vote and returns `{ score, blocked, counted }` |
| `GET /host-rating/:hosterUserId` (no auth — server-rating stage 3) | `{ score, blocked }` for an arbitrary `hosterUserId`; unauthenticated because the value is already public lobby data (`GET /servers`' `rating` field) — the master's `HostRatingProxy.getPublic` polls this on a timer (`SignalingServer.refreshRatings()`) to refresh its per-room rating cache without holding a Bearer token for every active hoster between requests. `400 badRequest` for a non-integer `:hosterUserId` |
| `GET /leaderboard?game=&limit=&period=` (no auth — lobby page plan) | `{ leaderboard: [{nick, rank, place}], total }` — top-`limit` (clamped `1..100`, default `10`) of `ratings` for `game`, restricted to `rank > 0 AND nick IS NOT NULL`, ordered by `rank DESC, nick ASC`. `place` is a competition ranking (`RANK() OVER (ORDER BY rank DESC)`) — tied `rank` values share a `place`, the next distinct value skips ahead by the tie's size — matching `GET /placement`'s definition below, not the row's plain 1-based index (code review M3: the two must agree, since the client shows the caller's own placement next to this same list). `total` and `place` both come from window functions computed over the whole `WHERE`-matched set before `LIMIT`, in the same query as the page (code review L1 — one round trip instead of a separate `COUNT(*)`). Unauthenticated: shown in the lobby before login, same trust level as `GET /host-rating/:hosterUserId`. `400 gameRequired` if `game` is missing. **`period`** (rank-periods, snakes-v3) selects the time slice **and the aggregation**: `all` (the default, and what an older client that sends no `period` gets) reads the `ratings` cache — the daily job's snapshot; `month` is the `points` column and `day` the `best` column of the `rank_periods` aggregate (`008_rank_period_aggregates.sql`) for the current calendar UTC window — **not** a fold of the ledger: at the target scale a popular game writes half a million ledger rows a day, and folding them per request is what the aggregate removes (one row per player per window instead, two orders of magnitude fewer, read as an index range scan) — calendar windows, not rolling ones, so "today's top" means the same thing to everybody looking at it. `400 badPeriod` on any other value: answering with the wrong slice under the right heading is worse than refusing. The route also answers `304 Not Modified` to a matching `If-None-Match`: the list changes slowly and the lobby re-requests it on every tab open |
| `GET /placement?game=&period=` (Bearer identity token — lobby page plan) | `{ placement, total, rank }` for the caller: `rank` is their cached score (`0` if unranked), `total` is the same ranked-player count as `/leaderboard`, `placement` is the same competition-ranking position as `/leaderboard`'s `place` (`(COUNT(*) WHERE rank > mine) + 1`) or `null` if `rank` is `0` (not yet ranked). `period` is the same slice, computed the same way — the caller's own row must not contradict the list it is shown next to. **It is not one query per caller**: `rank` is a primary-key lookup, and `placement` is a binary search over a cached ladder of the slice's distinct scores, shared by every player of that game (`src/db/RankDistribution.js`, `rank.distributionTtl`). Measured on 8 000 players in the window: 6.03 ms → 0.14 ms, which at the target scale is the difference between seven cores and a twentieth of one |

Rate limiting is one middleware (`src/lib/rateLimit.js` — `main.js` starts the
server and the DB pool on import, so the limit's contract would be untestable
inside it). It keys on the client IP from `clientIp()` (`src/lib/clientIp.js`,
a copy of the engine helper) rather than Express's `req.ip`/`trust proxy`:
behind Nginx (production topology, see [deployment.md](deployment.md)),
`req.ip` alone would resolve to Nginx's address and collapse the limit into
one shared bucket for every client. In production the address comes from
`X-Real-IP` (the deploy's Nginx sets it from `$remote_addr`, overwriting
whatever the client sent), outside production from `req.socket.remoteAddress`.
`X-Forwarded-For` is deliberately not used: the same Nginx sets it with
`$proxy_add_x_forwarded_for`, which *appends* the real address to the client's
own, so the first hop is client-controlled — keying on it would lift both the
nick-guessing and the OAuth-start limits with a single header. A request with
no address at all (an already-broken socket) is answered `429` instead of
sharing one `''` bucket with every other such request — the master and the
dedicated server terminate those connections for the same reason. Both use the
same convention (`SignalingServer.handleConnection`), and a proxy that fails to
set `X-Real-IP` collapses every client into one bucket — see
[deployment.md](deployment.md#required-proxy-header-x-real-ip).

The identity JWT (`src/lib/jwt.js`) carries `sub` (user id), `nick` and
`role`,
signed RS256, short-lived (`config.jwt.expiresIn`, 4 hours by default — long
enough to outlast a match; the client also checks `exp` when restoring a
persisted token, see Lobby login below) and verified with
`issuer: 'vimp-auth'`. A pending token (issued between the OAuth callback and
`POST /nick`) instead carries `pending: true` and no nick — `requireAuth` in
`src/main.js` rejects it on every other endpoint, and `/nick` itself rejects
the opposite case (an identity token, i.e. `pending` missing).

`role` (master-game-registry stage 1) is additive: tokens already in players'
`localStorage` carry no `role` and are read as `'user'`, and the engine's
verifier (`packages/engine/src/lib/jwt.js`) checks `alg`/`iss`/`exp`/`nick`
and the signature only. The claim exists **for the client** — to show the
moderation tab. `requireAdmin` in `src/main.js` re-reads the role from the
database on every admin request instead of trusting the claim: the token
lives four hours, and a demotion has to take effect immediately.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/main.js` | Express app, routes, `requireAuth` Bearer-token middleware |
| `src/config/auth.js` | port/domain, JWT key paths, DB connection string, OAuth provider config |
| `src/lib/jwt.js` | RS256 sign/verify (identity + pending tokens), JWKS export |
| `src/lib/oauthState.js` | signed stateless OAuth `state` param (return URL + CSRF nonce) |
| `src/devLogin.js` | dev-only login handler factory (`createDevLoginHandler({ userRepo, issueIdentityToken, isAllowedReturnUrl, isValidNick })`) — dependencies injected so it is unit-testable without Express or a live database; wired in `main.js` behind `if (!isProduction)` |
| `src/lib/validators.js` | nick regexp, game-submission field checks (id/package/version/title/repo URL, taking `config.games` as an argument so the file stays a set of pure functions), duplicated from `packages/engine/src/lib/validators.js` (`NAME_REGEXP`) — the two workspaces don't share a runtime dependency |
| `src/UserRepository.js` | all SQL: find/create user, set nick, get rank, append/recompute rank ledger events, get/upsert state, snapshot state, get host rating, upsert a vote and recompute `host_ratings`, void a banned hoster's rank/state contributions, read the leaderboard/placement for a game (lobby page plan), sync/read a user's role and the whole game registry — list/get/create a game, request a version, apply a moderator's partial patch (master-game-registry) |
| `src/oauth/github.js`, `src/oauth/index.js` | provider registry; `getAuthorizationUrl`/`exchangeCode` shape, extensible for Google/Apple |
| `src/db/pool.js`, `src/db/migrate.js`, `src/db/migrations/*.sql` | `pg.Pool`, a minimal idempotent migration runner (`CREATE TABLE IF NOT EXISTS`, no version table yet). **No version table means every file runs again on every deploy**, so a migration must stay safe to repeat: a data-modifying one (`010_drop_anonymous_users.sql`) has to be scoped so that a re-run cannot touch a row that is legitimate now — `nick IS NULL`, for one, is the normal state of an OAuth login between the callback and `POST /nick` |

## Lobby login (client)

`plan/done/central-auth/auth_b2.md`. The engine's **LobbyAuth** MVC triplet
(`packages/engine/src/client/components/{model,view,controller}/LobbyAuth.js`,
documented in [client.md](client.md#mvc-components-packagesenginesrcclientcomponents))
gates the lobby behind a sign-in screen — `#lobby` stays hidden until it's
authenticated. Flow:

1. **Start**: the player clicks a provider button
   (`.lobby-auth-provider`) → the browser navigates (not a fetch) to
   `GET {authServiceUrl}/oauth/:provider/start?returnUrl=<current lobby URL>`.
2. **Callback**: the auth service exchanges the code, then redirects back to
   `returnUrl` with `?token=` (existing nick) or `?pendingToken=` (first
   login, no nick yet).
3. **Client boot**: `LobbyAuthModel.boot(location.search)` reads whichever
   query param is present (`main.js` then strips it via
   `history.replaceState`), or — if neither is present — restores a
   persisted identity JWT from `localStorage['vimpAuthToken']`. A
   `?token=` or a restored token is decoded client-side (display only, no
   signature check — see [client.md](client.md#mvc-components-packagesenginesrcclientcomponents))
   to read `nick` and show the lobby; a `?pendingToken=` shows the nick-entry
   screen instead.
4. **Nick pick**: submitting the nick screen does `POST {authServiceUrl}/nick`
   (Bearer pending token) directly from the browser — a cross-origin fetch,
   not proxied by the master, which needs the auth service's own CORS
   handling (`VIMP_AUTH_ALLOWED_ORIGINS`, see Running above) to succeed. On
   success the returned identity token is persisted and the lobby opens;
   `409 nickTaken` / `400 invalidNick` render inline.
5. **Restore/expiry**: on a fresh visit with no query params,
   `LobbyAuthModel._restore()` reads `localStorage['vimpAuthToken']`; if the
   decoded `exp` has already passed (or the token is otherwise invalid), the
   stored token is dropped and a clean sign-in screen shows again, with no
   error banner — a stale/expired token on a silent restore is an expected
   return-visit case, not an error. `login-error` (`tokenExpired` /
   `invalidToken`) is only emitted on the interactive path (OAuth redirect,
   nick submission), not on silent restore.

The auth-service origin is bundled client-side in
[packages/engine/src/config/authClient.js](../../packages/engine/src/config/authClient.js)
(`serviceUrl`, dev default `http://localhost:3010`) — Vite substitutes it at
build time from `import.meta.env.VITE_AUTH_SERVICE_URL`; the Dockerfile
declares `ARG VITE_AUTH_SERVICE_URL` and `deploy.yml`'s `build_and_push` job
passes it as a `build-args` from the same `AUTH_SERVICE_URL` repository
variable used for the server-side `VIMP_AUTH_SERVICE_URL` (see
[deployment.md](deployment.md#central-auth-service-packagesauth)), so no
manual edit before building is needed. `authClient.js` is also imported by
`master/main.js` under plain Node (for `.issuer`), where
`import.meta.env` is `undefined` — a `typeof` guard falls back to the dev
default there instead of throwing. The master's CSP `connect-src`
(`packages/engine/src/config/master.js`, `security.csp`, applied only in
production) is templated with the same origin
(`security.authServiceUrl`, overridable via `VIMP_AUTH_SERVICE_URL`) so the
`POST /nick` fetch isn't blocked; the OAuth redirects themselves are
top-level navigation and aren't subject to CSP `connect-src` either way.

## Joining a room (host verification)

`plan/done/central-auth/auth_b3.md`. The room-local **Auth** MVC triplet
(`packages/engine/src/client/components/{model,view,controller}/Auth.js`)
still runs the per-game auth form, but the form no longer has a `name`
field — the game plugin's `authSchema.params` (e.g. `vimp-tanks`'s
`src/config/auth.js`) now only declares game-specific fields (`model`). The nick is not typed: the
client attaches the lobby identity JWT (`LobbyAuthModel.getToken()`) to the
`AUTH_RESPONSE` payload (`packages/engine/src/client/main.js`, port 1) as
`token`, alongside the form fields.

The host (`packages/engine/src/host/host.worker.js`, the untrusted browser
running the match) is the verification point:

1. `validateAuth` still checks the game-specific `authSchema.params` (e.g.
   `isValidModel`) — unrelated to the token.
2. `verifyClientToken(data.token)` fetches (and caches for the Worker's
   lifetime) the master's `GET /auth/jwks` (`config/lobby.js`'s
   `auth.jwksUrl`), then calls `verifyIdentityToken` (`packages/engine/src/lib/jwt.js`)
   — RS256 signature check via Web Crypto (`crypto.subtle`, no JWT library
   needed; works identically in the browser, the host Worker and Node ≥19),
   `iss` compared against `authClient.js`'s `issuer` (must match
   `packages/auth`'s `config.jwt.issuer`, `'vimp-auth'`), and expiry.
3. On success, `host.createUser({ ...data, name: payload.nick }, socketId, cb)`
   uses the verified nick — `ParticipantManager.createHuman` is otherwise
   unchanged (its per-room `checkName` dedup still runs as a defensive
   fallback, though nicks are already globally unique). On failure,
   `AUTH_RESULT` carries `[{ name: 'token', error: 'invalid' }]` and the user
   is not created.

The auth-service origin itself is never contacted by the host — it only
trusts the master's proxied JWKS (`JwksProxy`, see
[master.md](master.md#get-authjwks)), keeping the untrusted host off the
auth service's attack surface.

## Rank and state loading and sync (host)

`plan/done/central-auth/auth_b4.md`. Once a participant's identity token is verified (see
above), the host auto-loads its rank/state and keeps them in sync with the
auth service for the rest of the session — see
[host.md](host.md#player-rank-and-state-sync-stage-b4) for the host-side
mechanics (`PlayerDataSync`, flush points, the `HostGame` accessor API). In
short:

1. **Load on join**: `HostGame.createUser()` fires
   `PlayerDataSync.load(participantId, token)` (fire-and-forget — it never
   blocks the join flow), which calls the master's `GET /auth/placements` —
   one round trip for all three slices, `{ day, month, all }`, served from
   `PlacementCache` (`master:placement:cacheTtl`) — and `GET /auth/state`
   (both proxied to the central auth service — see
   [master.md](master.md#getput-authrank-getput-authstate))
   with the participant's own identity token. If the auth service is
   unreachable, the participant simply keeps the defaults (no rating, the
   game plugin's `playerState.defaultState`, e.g. `vimp-tanks`'s
   `src/config/game.js`) — a join is never blocked by auth-service downtime.
2. **Accumulate the points of the CURRENT game**: `+1` per kill through
   `RoundManager.reportKill()` by default, or whatever the game reports with
   `vimp.addPlayerPoints()`. They become a rating only when the game ends —
   `vimp.finishPlayerGame()`, which `RoundManager` calls at a map change and a
   round end, and a roundless game calls at a boundary of its own.
3. **Sync back**: `PlayerDataSync.flush()`/`flushAll()` `PUT`s the
   participant's result and state to the master's `PUT /auth/rank`/
   `PUT /auth/state` (best-effort, `Promise.allSettled` — a failed flush is
   silently retried on the next natural flush point, with whatever was
   accumulated meanwhile). Since snakes-v3 the ENGINE owns the write budget
   (`lobbyConfig.playerData`): nothing is sent when nothing changed, at most
   one sync per participant per `minFlushInterval` (300 s, jittered ±20 % per
   room), one request in flight per participant, a room-wide queue capped at
   `maxRequestsPerSecond` and an exponential backoff on `5xx`/`429`. The
   urgent boundaries — a participant leaving, `destroy()` — bypass the
   interval, and so does a game that asks for it
   (`flushPlayerData({ urgent: true })`).

The Rust/WASM game core has no notion of rating/state at all — it is a purely
engine/JS-side concept, exposed to game-plugin code via
`HostGame.addPlayerPoints()`/`finishPlayerGame()`/`getPlayerRating()`/
`refreshPlayerPlacement()`/`getPlayerState()`/`setPlayerState()`, and to
players by whatever chat command the game registers (`/rank` in the scaffold's
`metaCommands.js`; the engine parses none of its own — see the active game
plugin's gameplay docs, e.g. [vimp-tanks/docs/en/gameplay.md](https://github.com/lgick/vimp-tanks/blob/main/docs/en/gameplay.md#chat-c-key-and-commands)).
A place is the one thing that cannot be answered locally — it moves with other
people's games — so `refreshPlacement()` re-asks the master for it; a value is
read from the slices loaded on join, no round trip.

## Tests

`tests/auth/` (a node Vitest project): `validators.test.js` (incl. the F13
control-whitespace case), `jwt.test.js` (signs with a throwaway RSA key pair,
mocks `config/auth.js`), `github.test.js` (mocks `fetch`), `oauthState.test.js`
(incl. the timing-safe compare still rejecting a tampered signature),
`UserRepository.test.js` (a stub `{ query() }` object — no real PostgreSQL
needed for unit tests, incl. the `nick IS NULL` rename guard, and the
`voteHost`/`getHostRating` cases: first vote, unchanged repeat vote as a
no-op, an opinion flip, clamping into `config.rating` and setting `blocked`;
`getLeaderboard`/`getPlacement` — single-query SQL shape, tied-`rank`
competition ranking, an empty game; the game registry and roles — all three
`CASE` branches of `syncRole`, the catalog/queue/author queries, `createGame`
with a duplicate and over the per-author limit (no `INSERT` at all in that
case), `requestGameVersion` as author/admin/stranger and its `rejected` →
`pending` lift, and `moderateGame` building its `SET` from the passed keys
only, with every value a placeholder), `adminNicks.test.js` (`VIMP_ADMIN_NICKS` and
`VIMP_ADMIN_IDENTITIES` parsing — case, spaces, a trailing comma, an empty
value, a malformed pair), `adminRights.test.js` (`isEnvAdmin` — the identity
list wins over the nick list, a foreign uid and a missing provider both fail
closed), `devLogin.test.js` (redirect carries a
token that verifies against a throwaway RSA key pair, the nick is set only on
the first login, an invalid nick and a foreign-origin `returnUrl` are both
rejected before any write).

Host-side verification (B3) and rank/state sync (B4) are tested in the
engine tree instead: `tests/lib/jwt.test.js` (`verifyIdentityToken` — valid
signature, forged key, wrong issuer, expired token, missing `nick`, unknown
`kid`, malformed token — all against a throwaway RSA key pair signed with
`jsonwebtoken`), `tests/master/JwksProxy.test.js` (proxying, TTL caching,
upstream failure), `tests/master/PlayerDataProxy.test.js` (proxying
GET/PUT `/rank`+`/state`, no caching, upstream failure) and
`tests/host/PlayerDataSync.test.js` (load with defaults on auth-service
failure, rank accumulation, flush/flushAll, plus the fix-up cases: `flush`
skips `PUT` entirely when `load` never succeeded and retries `load` instead
of clobbering a stored value with the default, a rank delta applied while
`load` is in flight isn't lost, and `defaultState` is cloned per participant
rather than shared), plus rank/flush coverage added to
`tests/host/RoundManager.test.js` and token passthrough in
`tests/host/ParticipantManager.test.js`. Client-side,
`tests/client/LobbyAuthModel.test.js` covers the expired-token restore path.

---

[← Previous: Master Server](master.md) · [Next: Browser Host →](host.md)
