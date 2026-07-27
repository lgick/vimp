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

> **No Rust toolchain needed.** Since the game plugin (`@vimp-games/tanks`) moved
> to its own repository (Stage A3), [Dockerfile](../../Dockerfile) no
> longer builds any WASM core — the game repo's own CI does that and
> publishes the package. The node stage just runs `npm ci` (installs
> `@vimp-games/tanks` from the registry, which brings its already-built `dist/` —
> client/host entries, the WASM asset, maps, sounds, `manifest.json`)
> followed by `npm run build:app` (engine Vite build). The runner stage
> copies `packages/engine/dist/` and `node_modules/@vimp-games/tanks/dist/`; the
> master reads the plugin only through `GameCatalog`
> (`dist/manifest.json` + `dist/maps/*.json`) and rejects it at load time if
> its `engineApi` doesn't match this engine build's `ENGINE_API_VERSION`
> — it never imports game source.

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
     and a GHCR login + PAT (`read:packages`) ready to paste in.

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
    PAT (`read:packages`; leave blank if the image is public);
  - generates the RS256 key pair under `./.keys/` (once — reused on
    re-runs), writes `.env.prod` (`VIMP_AUTH_PUBLIC_URL`,
    `VIMP_AUTH_ALLOWED_ORIGINS`, `VIMP_AUTH_STATE_SECRET`,
    `VIMP_AUTH_GITHUB_CLIENT_ID`/`_SECRET`, `VIMP_AUTH_DATABASE_URL`) and a
    two-service `docker-compose.yml` (`postgres` + `auth`, same shape as
    the master's single-container setup but with a Postgres sidecar) in
    `~/vimp_projects/<domain>/`;
  - logs in to GHCR if credentials were given, then
    `docker compose pull && docker compose up -d`;
  - runs migrations (`docker compose exec auth node src/db/migrate.js`,
    retried until Postgres is ready) and checks `GET /jwks` for a 200.
  - **Re-running on the same auth domain** offers a choice: `1) update
    image` (keep the DB, RS256 keys and secrets, just re-pull and restart)
    or `2) recreate` (`docker compose down -v` — wipes the DB and keys,
    requires typing `yes` to confirm).
- **Migrations** run automatically as part of the above. To re-run by hand
  (e.g. after a manual schema change): `docker compose exec auth node
  src/db/migrate.js` from `~/vimp_projects/<domain>/`.
- **Adding a master later.** `VIMP_AUTH_ALLOWED_ORIGINS` is only set from
  what you entered when the auth stack was created/recreated — adding a
  new master domain afterwards means editing it by hand in
  `~/vimp_projects/<auth-domain>/.env.prod` and running `docker compose
  restart auth` there.
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
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' wss: data: https://auth.example.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;
```

Key directives: `script-src ... 'wasm-unsafe-eval'` (compiling the WASM
core in the browser), `worker-src 'self' blob:` (the host's Web Worker),
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

### Removing a server

On the VPS, use `./delete-server.sh` — it removes the Nginx configs, the
project folder, and stops the container.

> ⚠️ Afterward, remove that server's entry from `SERVERS_MATRIX` on
> GitHub!

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
