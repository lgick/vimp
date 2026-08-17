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

## Schema

```
users:           id, provider, provider_uid, nick(UNIQUE), created_at
ratings:         user_id, game_id, rank, updated_at            ← denormalized cache
rank_events:     id, user_id, game_id, hoster_user_id, session_id,
                 delta, voided, created_at                     ← append-only ledger
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

**Rank ledger** (server-rating stage 1, `003_rank_ledger.sql`): `ratings.rank`
is a cache, not the source of truth. Every match result appends a signed
`delta` row to `rank_events`, attributed to the hosting server
(`hoster_user_id`, the room creator's `userId`) and its session
(`session_id`); `ratings.rank` is recomputed as
`SUM(delta) WHERE voided = false`, clamped to `config.rank.min/max`. This
attribution is what lets server-rating stage 4 void a banned server's contribution
without touching the rest of a player's history. `state_snapshots` captures
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
| `GET /dev/login?nick=&returnUrl=` **(dev only)** | skips OAuth entirely: finds/creates the user as `('dev', nick)`, sets the nick on first login (`setNick`'s `nick IS NULL` guard makes repeats a no-op) and redirects to `returnUrl` with `?token=` — exactly the shape `/oauth/:provider/callback` produces, so the client path is unchanged. The nick goes through the same `isValidNick`, the return URL through the same allow-list check as OAuth (no open redirect with a valid token). Registered **only** when `NODE_ENV !== 'production'`; in production the route does not exist (`404`). Handler — `src/devLogin.js`, see [getting-started.md](getting-started.md#central-auth-service-needed-to-reach-the-lobby) |
| `POST /nick` (Bearer pending token, `{ nick }`) | CORS-enabled for `VIMP_AUTH_ALLOWED_ORIGINS` origins (preflight `OPTIONS` too — the only endpoint called directly from the browser lobby, not proxied by a master), rate-limited per IP; rejects an identity token (`403 nickAlreadySet` — a pending token is required, so `/nick` can't rename an existing user); validates the nick against `NAME_REGEXP` (case-insensitively unique — see Schema) and sets it, returns `{ token }` (full identity JWT). `409 { error: 'nickTaken' }` on a race |
| `GET /jwks` | RS256 public key as a JWK — a host verifies `token`'s signature against this before trusting its `nick` |
| `GET /rank?game=` (Bearer identity token) | `{ rank }` — the cached, clamped sum of the caller's non-voided `rank_events` for that game |
| `PUT /rank?game=` (Bearer, `{ delta, hosterUserId?, sessionId? }`) | appends a match-delta ledger event (must be an integer within `±config.rank.maxDelta`, code-review fix — otherwise a single call could ram the cache clamp in one match) attributed to the reporting server/session, recomputes and returns `{ rank }`; mirrors `PUT /state` (Stage B4, delta semantics since server-rating stage 1). `hosterUserId`/`sessionId` are meant to be stamped by the caller's *master*, not the browser host itself — see [master.md](master.md#getput-authrank-getput-authstate) |
| `GET /state?game=` (Bearer) | `{ state }` (opaque JSON, the "skills" blob) |
| `PUT /state?game=` (Bearer, `{ state, hosterUserId?, sessionId? }`) | if `sessionId` is given and no snapshot exists yet for `(user, game, session)`, first stores the current `state` into `state_snapshots`, then upserts the new `state`; rejects a state above `config.state.maxBytes` (`400 stateTooLarge`) |
| `GET /host-rating` (Bearer identity token) | `{ score, blocked }` — the caller's **own** rating, as a hoster; the master calls this with the hoster's token on `register_host` to decide whether to reject the room (`blocked: true`), and to seed the room's cached lobby `rating` (server-rating stage 3) |
| `PUT /host-rating/:hosterUserId` (Bearer, `{ value, reason }`) | a guest's vote for/against `hosterUserId` (the caller is the voter, taken from their Bearer token — `403 selfVote` if it equals `hosterUserId`); `value` must be `1` or `-1` (`400 invalidVote`); an empty/missing `reason` isn't counted (returns the current rating with `counted: false`, no write); otherwise upserts the vote and returns `{ score, blocked, counted }` |
| `GET /host-rating/:hosterUserId` (no auth — server-rating stage 3) | `{ score, blocked }` for an arbitrary `hosterUserId`; unauthenticated because the value is already public lobby data (`GET /servers`' `rating` field) — the master's `HostRatingProxy.getPublic` polls this on a timer (`SignalingServer.refreshRatings()`) to refresh its per-room rating cache without holding a Bearer token for every active hoster between requests. `400 badRequest` for a non-integer `:hosterUserId` |
| `GET /leaderboard?game=&limit=` (no auth — lobby page plan) | `{ leaderboard: [{nick, rank, place}], total }` — top-`limit` (clamped `1..100`, default `10`) of `ratings` for `game`, restricted to `rank > 0 AND nick IS NOT NULL`, ordered by `rank DESC, nick ASC`. `place` is a competition ranking (`RANK() OVER (ORDER BY rank DESC)`) — tied `rank` values share a `place`, the next distinct value skips ahead by the tie's size — matching `GET /placement`'s definition below, not the row's plain 1-based index (code review M3: the two must agree, since the client shows the caller's own placement next to this same list). `total` and `place` both come from window functions computed over the whole `WHERE`-matched set before `LIMIT`, in the same query as the page (code review L1 — one round trip instead of a separate `COUNT(*)`). Unauthenticated: shown in the lobby before login, same trust level as `GET /host-rating/:hosterUserId`. `400 gameRequired` if `game` is missing |
| `GET /placement?game=` (Bearer identity token — lobby page plan) | `{ placement, total, rank }` for the caller: `rank` is their cached score (`0` if unranked), `total` is the same ranked-player count as `/leaderboard`, `placement` is the same competition-ranking position as `/leaderboard`'s `place` (`(COUNT(*) WHERE rank > mine) + 1`) or `null` if `rank` is `0` (not yet ranked) |

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

The identity JWT (`src/lib/jwt.js`) carries `sub` (user id) and `nick`,
signed RS256, short-lived (`config.jwt.expiresIn`, 4 hours by default — long
enough to outlast a match; the client also checks `exp` when restoring a
persisted token, see Lobby login below) and verified with
`issuer: 'vimp-auth'`. A pending token (issued between the OAuth callback and
`POST /nick`) instead carries `pending: true` and no nick — `requireAuth` in
`src/main.js` rejects it on every other endpoint, and `/nick` itself rejects
the opposite case (an identity token, i.e. `pending` missing).

## Modules

| Module | Responsibility |
| --- | --- |
| `src/main.js` | Express app, routes, `requireAuth` Bearer-token middleware |
| `src/config/auth.js` | port/domain, JWT key paths, DB connection string, OAuth provider config |
| `src/lib/jwt.js` | RS256 sign/verify (identity + pending tokens), JWKS export |
| `src/lib/oauthState.js` | signed stateless OAuth `state` param (return URL + CSRF nonce) |
| `src/devLogin.js` | dev-only login handler factory (`createDevLoginHandler({ userRepo, jwtLib, isAllowedReturnUrl, isValidNick })`) — dependencies injected so it is unit-testable without Express or a live database; wired in `main.js` behind `if (!isProduction)` |
| `src/lib/validators.js` | nick regexp, duplicated from `packages/engine/src/lib/validators.js` (`NAME_REGEXP`) — the two workspaces don't share a runtime dependency |
| `src/UserRepository.js` | all SQL: find/create user, set nick, get rank, append/recompute rank ledger events, get/upsert state, snapshot state, get host rating, upsert a vote and recompute `host_ratings`, void a banned hoster's rank/state contributions, read the leaderboard/placement for a game (lobby page plan) |
| `src/oauth/github.js`, `src/oauth/index.js` | provider registry; `getAuthorizationUrl`/`exchangeCode` shape, extensible for Google/Apple |
| `src/db/pool.js`, `src/db/migrate.js`, `src/db/migrations/*.sql` | `pg.Pool`, a minimal idempotent migration runner (`CREATE TABLE IF NOT EXISTS`, no version table yet) |

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
   blocks the join flow), which calls the master's `GET /auth/rank` and
   `GET /auth/state` (proxied to the central auth service — see
   [master.md](master.md#getput-authrank-getput-authstate))
   with the participant's own identity token. If the auth service is
   unreachable, the participant simply keeps the defaults (rank `0`, the
   game plugin's `playerState.defaultState`, e.g. `vimp-tanks`'s
   `src/config/game.js`) — a join is never blocked by auth-service downtime.
2. **Accumulate**: rank changes by ±1 per kill, accumulated at the same
   choke point as the ephemeral `Stat` score —
   `RoundManager.reportKill()` (win/team-kill branching included).
3. **Sync back**: `PlayerDataSync.flush()`/`flushAll()` `PUT`s the
   participant's current rank+state to the master's `PUT /auth/rank`/
   `PUT /auth/state` (best-effort, `Promise.allSettled` — a failed flush is
   silently retried on the next natural flush point, with whatever was
   accumulated meanwhile). Flush points: map change and round end (both in
   `RoundManager`), plus a final flush when a participant leaves
   (`HostGame.removeUser()`).

Rank here is a simple kill-delta accumulator (+1/-1), not an ELO or
matchmaking rating. The Rust/WASM game core has no notion of rank/state at
all — it's a purely engine/JS-side concept, exposed to game-plugin code via
`HostGame.getPlayerRank()`/`getPlayerState()`/`setPlayerState()`, and to
players via the engine-level `/rank` chat command (Stage B5,
[CommandProcessor](../../packages/engine/src/host/meta/core/CommandProcessor.js),
see the active game plugin's own gameplay docs, e.g. [vimp-tanks/docs/en/gameplay.md](https://github.com/lgick/vimp-tanks/blob/main/docs/en/gameplay.md#chat-c-key-and-commands)) — it reads the
locally cached rank via `PlayerDataSync.getRank()`, no extra network round
trip.

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
competition ranking, an empty game), `devLogin.test.js` (redirect carries a
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
