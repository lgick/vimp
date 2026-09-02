# Deployment

A guide to preparing a clean VPS, configuring the environment, and running
the **master server** (lobby + signaling; matches run on browser hosts,
there are no server-side game instances) via GitHub Actions CI/CD. Setup
scripts live in [.github/deployment/](../../.github/deployment/).

**How it works**: a push to `main` →
[.github/workflows/deploy.yml](../../.github/workflows/deploy.yml) builds a
Docker image and publishes it to GHCR → SSHes into every server in
`SERVERS_MATRIX`, generates `.env`, and restarts the `vimp-<domain>`
container. On the VPS, Nginx terminates HTTPS and proxies to the app port
(the master listens on `3002` inside the container).

> **No games in the image, no Rust toolchain.** [Dockerfile](../../Dockerfile)
> builds the engine and nothing else: the node stage runs `npm ci` (engine
> dependencies only — game packages are not dependencies of this repository)
> followed by `npm run build:app` (engine Vite build), and the runner stage
> copies `packages/engine/dist/` plus the server sources. Games arrive **at
> runtime**: the master reads the catalog from the registry of the central
> auth service, downloads each approved package from the npm registry into
> `VIMP_GAMES_DIR` (a mounted volume) and serves it from there, reading only
> `dist/manifest.json` + `dist/maps/*.json` and never importing game source.
> Adding a game or raising its version therefore rebuilds and redeploys
> nothing — see "Adding a game to the catalog" below.

This page is about infrastructure: preparing a server and how the rollout
works. The release order itself — publishing `vimp-engine` and the game
plugin to npm before pushing to `main` — is in
[publishing.md](publishing.md).

## 📋 Prerequisites

1. A **VPS** running Ubuntu 20.04, 22.04, or 24.04.
2. A **domain name** pointed at your server's IP.
3. **SSH access** to the server (sudo preferred).
4. **Git** installed locally and the project repo cloned.

## Step 1: DNS (domain setup)

Before configuring the server, create an **A record** with your domain
registrar:

- **Type:** `A`
- **Name (Host):** `game` (for example, for game.example.com)
- **Value:** `YOUR_SERVER_IP`

## Step 2: Initial system setup (once)

Runs **once** on a new server. The script installs Nginx, Docker,
Fail2Ban, and configures the firewall.

1. Upload the scripts to the server:

   ```bash
   scp .github/deployment/*.sh root@YOUR_SERVER_IP:~/vimp-deployment-scripts/
   ```

2. SSH in and make the scripts executable:

   ```bash
   ssh root@YOUR_SERVER_IP

   cd ~/vimp-deployment-scripts
   chmod +x *.sh
   ```

3. Prepare the VPS:

   ```bash
   ./install-system.sh
   ```

**What happens:**

- required packages are installed;
- ports are opened (the script asks for confirmation);
- the root projects directory `~/vimp_projects` is created;
- Nginx security keys are generated.

## Step 3: Adding a master server

Run this whenever you need to stand up a new master instance on a new
domain (e.g. `game.example.com`).

1. On the server, run:

   ```bash
   cd ~/vimp-deployment-scripts
   ./add-server.sh
   ```

2. Follow the setup wizard:
   - enter the **domain** (e.g. `game.example.com`);
   - enter the **port** (e.g. `3005`) — **remember it**;
   - enter an email (for SSL notifications);
   - answer whether this domain **is the central auth-service itself**;
     if not (a master domain), enter the **auth-service URL** (e.g.
     `https://auth.example.com`) — required, for the CSP `connect-src`, so
     the lobby browser can `fetch POST /nick` (see "🔒 Security headers and
     CSP" below). **Deploy and add the auth-service domain first** — a
     master domain cannot be added without a working auth-service URL.
   - if you answer "yes" (this is the auth-service domain), the script
     then also brings up the whole auth stack itself (see "Central auth
     service" below); prepare a **GitHub OAuth App** beforehand
     (github.com/settings/developers) with callback URL
     `https://<domain>/oauth/github/callback`, and have its Client ID/Secret
     and a GHCR login + PAT (`read:packages`) ready to paste in — the
     freshly published GHCR package defaults to **private**, so either make
     it public (Package settings → Change visibility → Public) beforehand
     or have the PAT ready.

**Result:**

- the project folder `~/vimp_projects/game.example.com` is created;
- an SSL certificate is obtained (Let's Encrypt);
- Nginx is configured (HTTPS proxying to the chosen port).

> ⚠️ The server is configured but **empty** — the game won't run until
> the next step is done.

## Step 4: Configuration and launch (CI/CD)

The server list is configured through GitHub repository variables.

1. Open **Settings → Secrets and variables → Actions → the Variables
   tab**.
2. Create (or edit) the `SERVERS_MATRIX` variable:

   ```json
   [
     {
       "ip": "YOUR_SERVER_IP",
       "domain": "game.example.com",
       "port": 3005
     }
   ]
   ```

   _(`domain` and `port` must exactly match Step 3. Game parameters aren't
   set in the matrix: room creators configure them in the lobby — see
   [configuration.md](configuration.md#environment-variables-env))._

3. In the **Secrets** tab there must be deployment SSH secrets:
   `SERVER_USER` (the VPS user) and `SERVER_SSH_KEY` (the private key).
4. Go to the **Actions** tab and re-run the pipeline manually (Re-run
   jobs) or `git push` to `main` — the system deploys the master to every
   server in the list.

After `docker compose up -d` the job waits for the container to actually
serve: it polls `docker inspect` and `curl http://127.0.0.1:<port>/` for up
to a minute, and a container that exits, restarts in a loop or never answers
fails the job with the last 50 log lines printed. `docker compose up -d`
alone would succeed even when the process dies right after start — the
domain would answer 502 while the deploy stayed green. A dedicated box is
the usual victim: a game built against an older `ENGINE_API_VERSION` is
simply dropped from the lobby catalog, but kills the dedicated server at
startup (see below).

## Dedicated game box (`dedicatedGame`)

The same image also runs the [dedicated server](dedicated.md) — one 24/7
match of one game inside the Node process, with browsers connecting over a
direct WebSocket and no lobby, OAuth or WebRTC. The role is chosen by a
single environment variable, so a dedicated box is deployed exactly like a
master: Steps 1–3 above (DNS, `install-system.sh`, `add-server.sh` — a
regular domain with its own port), then one extra field in
`SERVERS_MATRIX`:

```json
[
  {
    "ip": "YOUR_SERVER_IP",
    "domain": "duel.example.com",
    "port": 3006,
    "dedicatedGame": "@vimp-games/tanks"
  }
]
```

- `dedicatedGame` names the game by its **npm package** or by its **registry
  id**, optionally pinned to an exact version (`"@vimp-games/tanks"`,
  `"tanks"`, `"@vimp-games/tanks@0.16.1"`). Prefer the package name: it is
  the same string npm and the registry use, and it resolves even on a box
  that has no registry to ask. With the field present, `deploy.yml` writes
  `VIMP_DEDICATED_GAME` into that server's `.env.prod` and
  `src/master/main.js` starts the dedicated server instead of the lobby;
  without it the box stays a lobby master. Nothing else in the matrix
  changes.
- The game is resolved the same way the lobby master resolves its catalog:
  a package installed into `node_modules` wins, otherwise the server asks the
  registry (`VIMP_AUTH_SERVICE_URL`) and downloads the package into
  `VIMP_GAMES_DIR` itself — so **a dedicated box needs the same volume**.
  With neither available the process exits with a named error naming every
  way, see [dedicated.md](dedicated.md).
- The package must publish `dist/core-node/` — the dedicated server loads
  the Node build of the core, like `npm run sim` does. A game whose `dist/`
  lacks it fails at startup with a named error, see
  [plugin-api.md](plugin-api.md).
- The game's age is **not** a deployment concern. `ENGINE_API_VERSION` is
  frozen and no longer a gate: the lobby catalog accepts a `dist/` built
  against any older engine, and `engineApi` is only a generation stamp. The
  one fatal case is `manifest.requires` naming a capability this engine build
  does not provide (`src/lib/capabilities.js`) — the game is *newer* than the
  engine. Even then it is not equally fatal everywhere: the lobby master keeps
  the game in the catalog with `compat: {ok: false, …}` (the lobby shows it
  disabled with the reason and refuses to register a host for it) and keeps
  serving the rest, while the dedicated server has nothing to fall back to and
  exits at startup — the container restart-loops and the domain answers 502.
  Fix it by upgrading `vimp-engine`, not by rebuilding the game.
- Room overrides (`VIMP_DEDICATED_ROOM`, see
  [configuration.md](configuration.md#environment-variables-env)) are not
  part of the matrix: add the line to `~/vimp_projects/<domain>/.env.prod`
  on the box and `docker compose up -d --force-recreate` (a CI deploy
  regenerates `.env.prod` and drops it).
- **A deploy interrupts the match.** There is no handoff: the container is
  recreated, the process dies with its simulation, and every connected
  client loses the round and reconnects into a fresh one. Unlike the lobby
  master (where matches live in host tabs and survive a restart, see
  "Updating the game"), a dedicated box should be redeployed when it's
  empty.
- No Nginx or CSP change is needed — `location /` already proxies the
  upgrade headers, so `/game` reaches the WebSocket, and `connect-src
  'self' wss:` already covers it.

## Central auth service (`packages/auth`)

Lobby login, nick, rank and state ([auth.md](auth.md)) need `@vimp/auth`
running as its own long-lived service with PostgreSQL. Unlike the master
(one instance per domain in `SERVERS_MATRIX`), it's normally a single
shared instance that every master domain points at.

- **Image.** `deploy.yml`'s `build_and_push_auth` job builds and pushes a
  second image, `ghcr.io/<repo>-auth:latest`, from
  [packages/auth/Dockerfile](../../packages/auth/Dockerfile) on every push
  to `main` — a plain Node image, no Rust/Vite stages.
- **Hosting is fully automated by `add-server.sh`.** Prepare only what
  can't be done on the VPS: a **GitHub OAuth App**
  (github.com/settings/developers) with Homepage URL `https://<domain>`
  and Authorization callback URL `https://<domain>/oauth/github/callback`.
  Then run Steps 2–3 above (`install-system.sh`, then `add-server.sh`) and
  answer "yes" to "is this domain the central auth-service itself?". The
  script:
  - asks for the master origins to allow (CSV,
    `VIMP_AUTH_ALLOWED_ORIGINS`), the OAuth Client ID/Secret, the image
    name (default `ghcr.io/lgick/vimp-auth`), and an optional GHCR login +
    PAT (`read:packages`; leave blank if the image is public — note the
    freshly published package defaults to **private** until switched to
    Public in its GitHub package settings);
  - generates the RS256 key pair under `./.keys/` (once — reused on
    re-runs), writes `.env.prod` (`VIMP_AUTH_PUBLIC_URL`,
    `VIMP_AUTH_ALLOWED_ORIGINS`, `VIMP_AUTH_STATE_SECRET`,
    `VIMP_AUTH_GITHUB_CLIENT_ID`/`_SECRET`, `VIMP_AUTH_DATABASE_URL`) and a
    two-service `docker-compose.yml` (`postgres` + `auth`, same shape as
    the master's single-container setup but with a Postgres sidecar) in
    `~/vimp_projects/<domain>/`;
  - logs in to GHCR if credentials were given, then runs `docker compose
    pull` with whatever auth is present (so an existing valid ambient
    `docker login` is used as-is and not discarded); on failure it first
    retries once anonymously (clearing any stale ghcr.io credentials, which
    covers a public image blocked by an expired login), and if it still
    fails prompts for a GHCR login/PAT and retries in the same run (no need
    to restart the whole script), up to 3 attempts, then `docker compose up
    -d`;
  - runs migrations (`docker compose exec auth node src/db/migrate.js`,
    retried until Postgres is ready) and checks `GET /jwks` for a 200, first
    against `http://127.0.0.1:<port>` (up to 10 attempts, 1s apart) — this
    local check can spuriously fail (`Connection reset by peer`) even when
    the service is actually up, a race with the docker-proxy/freshly-started
    process, not a real fault. Since Nginx+SSL for the domain are already in
    place by this point (Step 3 above runs first), a failed local check is
    re-verified against the real public path instead of being guessed at:
    `https://<domain>/jwks` (up to 5 attempts, 2s apart). Only if *both* fail
    does the script report a genuine failure (`docker compose ... logs
    auth`). Known limitation: the public re-check runs from the VPS itself
    back to its own public domain — on a host without hairpin NAT that
    request can fail even though outside clients reach the service fine,
    producing a false "partial" result. The failure mode is one-directional
    (never a false "success"), so at worst it costs an unnecessary manual
    log check (`docker compose ... logs auth`, `curl https://<domain>/jwks`
    from another machine), not a masked real outage.
  - **Re-running on the same auth domain** offers a choice: `1) update
    image` (keep the DB, RS256 keys and secrets, just re-pull and restart)
    or `2) recreate` (`docker compose down -v` — wipes the DB and keys,
    requires typing `yes` to confirm).
- **Migrations** run automatically as part of the above, and on every push
  to `main`: `deploy.yml`'s `deploy_auth` job pulls the new auth image,
  restarts the stack and runs `node src/db/migrate.js` (idempotent —
  `CREATE TABLE/INDEX IF NOT EXISTS`). It derives the project directory from
  `AUTH_SERVICE_URL` and connects with the same `SERVER_USER`/`SERVER_SSH_KEY`
  secrets as the master `deploy` job, but runs independently of it (masters
  are not blocked when the auth domain isn't configured). To re-run by hand
  (e.g. after a manual schema change): `docker compose exec auth node
  src/db/migrate.js` from `~/vimp_projects/<domain>/`.
- **`AUTH_SERVER_IP`** (Settings → Secrets and variables → Actions →
  Variables) is the auth VPS's IP address, and it gates `deploy_auth`: with
  the variable unset the job is skipped and the auth service is never
  updated by CI, so a new migration reaches production only together with a
  manual `add-server.sh` re-run — and nothing signals the omission. Set it
  once, right after the auth domain is deployed.
- **Adding a master later.** `VIMP_AUTH_ALLOWED_ORIGINS` is only set from
  what you entered when the auth stack was created/recreated — adding a
  new master domain afterwards means editing it by hand in
  `~/vimp_projects/<auth-domain>/.env.prod` and running `docker compose up -d
  --force-recreate auth` there — `env_file` is only read when the container
  is created, so a plain `restart` would silently keep the old value.
- **Wiring masters to it.** Set the `AUTH_SERVICE_URL` repository variable
  (Settings → Secrets and variables → Actions → Variables) to the auth
  service's public URL; `deploy.yml`'s `deploy` job writes it into every
  master's `.env.prod` as `VIMP_AUTH_SERVICE_URL` (read by
  [packages/engine/src/master/main.js](../../packages/engine/src/master/main.js),
  see [configuration.md](configuration.md#environment-variables-env)) — one
  variable, applied to every server in `SERVERS_MATRIX`. The same variable is
  also passed as the `VITE_AUTH_SERVICE_URL` build-arg in the
  `build_and_push` job (the client bundle needs it baked in before Nginx
  serves the static assets — the `Dockerfile`'s single shared image build,
  not the per-server `deploy` job), so it must be set before the first
  deploy or the client falls back to the dev default (`http://localhost:3010`)
  and the "Sign in" button breaks in production — see
  [configuration.md](configuration.md#environment-variables-env) and
  [auth.md](auth.md#lobby-login-client).

## 🔒 Security headers and CSP

Environment hygiene: it filters out "street" attackers — not a cheating
host, since it physically runs the simulation in its own process and its
WASM memory is reachable from its own JS, bypassing the core's logic;
CSP doesn't prevent that. In production, client static assets and
`.wasm` are served by **Nginx**, so the authoritative
Content-Security-Policy point is the Nginx `server` block for the
domain. The policy's single source of truth is
[packages/engine/src/config/master.js](../../packages/engine/src/config/master.js) (`security.csp`, a
function of `authServiceUrl` — see [auth.md](auth.md#lobby-login-client)); the
master applies it to its own responses, but HTML/`.wasm` go through
Nginx.

The `install-system.sh` template includes a `connect-src` with an
`__AUTH_SERVICE_URL__` placeholder, filled in by `add-server.sh` from the
"central auth-service URL" prompt (Step 3 above) — answer it with the real
auth-service origin on master domains, otherwise the lobby browser's
`fetch POST /nick` is blocked by this same CSP (`Refused to connect ...
violates Content Security Policy`). If the installed template predates this
placeholder, `add-server.sh` aborts and asks you to re-run `install-system.sh`
first. When configuring manually, add these
headers to the Nginx `server` block (or a shared snippet):

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header X-Frame-Options "DENY" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-XJmzkFBLHYpcM8KgGRFztTJTwfMb5xIFKAmqlgTpobo='; worker-src 'self' blob:; connect-src 'self' wss: data: https://auth.example.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;
```

Key directives: `script-src ... 'wasm-unsafe-eval'` (compiling the WASM
core in the browser) `'sha256-...'` (allows the single inline
`<script type="importmap">` in `packages/engine/index.html` mapping the bare
`pixi.js` / `pixi.js/unsafe-eval` specifiers — an external importmap
`src="..."` isn't supported by any browser, so it stays inline; the hash
must match the built `dist/index.html` byte-for-byte since `vite build`
minifies HTML — recompute with `npm run build` in `packages/engine`, whose
`postbuild` step (`scripts/check-importmap-csp-hash.mjs`) fails and prints
the correct value if it drifts), `worker-src 'self' blob:` (the host's Web Worker),
`connect-src 'self' wss: data: https://auth.example.com` (the master's
signaling WebSocket; `data:` — PixiJS checks `ImageBitmap` support by
fetching a test `data:` URL; `https://auth.example.com` — replace with
the real central auth-service origin, needed for the lobby's `POST
/nick` fetch, see [auth.md](auth.md#lobby-login-client); CSP doesn't
gate WebRTC data channels). In **dev**, CSP
isn't applied — ViteExpress + HMR need `'unsafe-inline'` and the HMR
WebSocket.

CSP deliberately omits `'unsafe-eval'` — PixiJS throws `Current
environment does not allow unsafe-eval` without it, so
`packages/engine/src/client/main.js` imports `pixi.js/unsafe-eval` (before creating the
`Application`) — this switches PixiJS to a safe-eval path without
weakening the policy.

Minifying the JS shell is standard for `vite build`. Heavier obfuscation
is deliberately out of scope: it's useless against a cheating host.

**Troubleshooting: `Executing inline script violates ... script-src` /
`Failed to resolve module specifier "pixi.js/unsafe-eval"` in production.**
This means the deployed Nginx `server` block's CSP is missing (or has a
stale) `'sha256-...'` hash for the importmap, so the browser blocks the
inline `<script type="importmap">` and the bare `pixi.js` specifier never
resolves. CI only redeploys the master; it never touches the already
-deployed Nginx config. Any change to the importmap or its CSP hash (a
`pixi.js` version bump, an `index.html` edit) requires **regenerating the
Nginx `server` block** on every affected master domain: re-run
`install-system.sh` → `add-server.sh <domain>` for each domain, then
`nginx -t && systemctl reload nginx` (or manually update the `sha256-...`
value in `script-src` and reload).

### Required proxy header: `X-Real-IP`

Every rate limit in the project keys on the client address returned by
`clientIp()` ([packages/engine/src/lib/clientIp.js](../../packages/engine/src/lib/clientIp.js),
copied into the auth service): the socket address, or `X-Real-IP` when the
process runs behind a proxy. So any reverse proxy in front of the master, a
dedicated box or the auth service **must** set it:

```nginx
proxy_set_header X-Real-IP $remote_addr;
```

`install-system.sh` puts this line in the template `add-server.sh` deploys for
every domain, so a server set up by these scripts is already correct. It
matters when the proxy is configured by hand, when a CDN or load balancer is
added in front, or when the installed `/etc/nginx/vimp.template` predates the
line. Without it every client keys on the proxy's own address — one shared
bucket — and the master's "1 room per IP" rule allows exactly **one room on
the whole server** while the ping limit becomes global. The process logs a
`[clientIp] trustProxy … X-Real-IP` warning once on startup traffic when this
happens.

`X-Forwarded-For` is deliberately not used as the key: Nginx sets it with
`$proxy_add_x_forwarded_for`, which *appends* the real address to whatever the
client sent, so its first hop is client-controlled — see
[master.md](master.md#protection).

## 🛠 Maintenance and removal

### Changing server settings

Edit `SERVERS_MATRIX` in GitHub settings and re-run the Action.

### Updating the game

Just `git push` to `main` — GitHub Actions automatically updates every
server in `SERVERS_MATRIX`. Client static assets and the WASM core are
baked into the image. Already-open rooms pick up the new code version on
their own (the Worker handoff): a master restart drops hosts' signaling
WS → reconnect → re-register brings a new `codeVersion` → the host tab
downloads the new worker bundle (`GET /worker/manifest.json`) and
replaces the Worker at the nearest round boundary without dropping P2P
connections (score and participants carry over, clients see a normal
round start). Client pages stay on the old build until reloaded — the
client↔host protocol must stay compatible across a deploy (the client
drops an incompatible binary frame by format version). Details —
[host.md](host.md#worker-handoff).

### Adding a game to the catalog

**Nothing is deployed for this.** The catalog lives in the game registry of
the central auth service, and a master picks changes up within
`master:gameStore:refreshInterval` (60 s by default):

1. The developer publishes the package to npm and submits it from the lobby
   ("My games" → the submission form). The master downloads and validates the
   package before the row is written, so a broken package is refused with a
   list of problems instead of entering the queue.
2. An admin opens "Moderation", optionally presses "Test" (the version is
   downloaded and staged — the admin can open a room on it, hidden from
   `GET /servers`), and approves it. The approved version reaches every
   master on its next sync pass.
3. A new version of an already approved game goes the same way ("My games" →
   "Update version" → moderation), and again deploys nothing.

There is no deploy variable for the catalog: the registry is its only source,
and an empty registry means an empty lobby. `master:games` stays a config
array for local development and for the dedicated server — see
[configuration.md](configuration.md#packagesenginesrcconfigmasterjs).

**Who is an admin** is set by the `VIMP_ADMIN_NICKS` repository variable
(Settings → Secrets and variables → Actions → Variables): a CSV of nicks the
auth service grants `role = 'admin'` to on every token issue, and demotes back
to `'user'` as soon as they leave the list. `deploy_auth` rewrites the line in
the auth stack's `.env.prod` on every deploy and recreates the container with
`--force-recreate` — `env_file` is only read when a container is created, so a
plain restart would keep the old list (the same trap as
`VIMP_AUTH_ALLOWED_ORIGINS` above). An **empty** variable does not rewrite the
line: an unset repository variable would otherwise mean `VIMP_ADMIN_NICKS=`
and demote every superadmin on their next login. To clear the list on purpose,
edit `.env.prod` on the server.

**The package store.** Every master's `.env.prod` gets
`VIMP_GAMES_DIR=/var/vimp/games`, and the generated `docker-compose.yml`
mounts the named volume `vimp-games` there, so downloaded packages survive a
container recreate — otherwise every deploy would re-fetch the whole catalog
from npm. The volume is created root-owned and the image runs as root, which
is enough to write; the master still checks the directory at startup and exits
with a named error naming the path and `VIMP_GAMES_DIR` if it cannot.

### Removing a server

On the VPS, use `./delete-server.sh` — it removes the Nginx configs, the
project folder, and stops the container. It detects whether the domain is
a master or the central auth service (`VIMP_AUTH_PUBLIC_URL` in its
`.env.prod`, or its Postgres companion container as a fallback) and prints
the matching instructions below.

#### Removing a master

> ⚠️ Afterward, remove that server's entry from `SERVERS_MATRIX` on
> GitHub!

#### Removing/moving the auth service

The auth domain is **not** in `SERVERS_MATRIX` — there is nothing to edit
there. Instead:

1. Update or clear the `AUTH_SERVICE_URL` repository variable (Settings →
   Secrets and variables → Actions → Variables).
2. Re-run the `Build & Deploy` workflow (one run redeploys every master) —
   otherwise they
   keep the old `VIMP_AUTH_SERVICE_URL` baked into their containers and
   JWKS/`/rank`/`/state`/`/host-rating` fetches start failing. See
   "Wiring masters to it" under
   [Central auth service](#central-auth-service-packagesauth) above.
3. Each master's Nginx `connect-src` has the auth origin baked in at
   `add-server.sh` time; a plain redeploy doesn't refresh it — re-run
   `add-server.sh` on each master domain, or edit the config by hand. See
   [Security headers and CSP](#-security-headers-and-csp).
4. The client bundle's `VITE_AUTH_SERVICE_URL` is baked into the shared
   image at `build_and_push` time — it only picks up the new URL after
   step 2's rebuild.
5. If you're standing up a replacement auth service, fill in its
   `VIMP_AUTH_ALLOWED_ORIGINS` with every master's origin — see
   "Adding a master later" under
   [Central auth service](#central-auth-service-packagesauth) above.

### Viewing logs on the VPS

| Action | Docker command |
| --- | --- |
| Tail logs (node.js) | `docker logs -f vimp-<domain>` |
| List processes | `docker ps -a` |
| Restart | `docker restart vimp-<domain>` |
| Stop | `docker stop vimp-<domain>` |
| Resource usage | `docker stats` |

---

[← Previous: Configuration](configuration.md) · [Next: Plugin API →](plugin-api.md)
