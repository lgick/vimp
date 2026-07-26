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

> **No Rust toolchain needed.** Since the game plugin (`@vimp/tanks`) moved
> to its own repository (Stage A3), [Dockerfile](../../Dockerfile) no
> longer builds any WASM core — the game repo's own CI does that and
> publishes the package. The node stage just runs `npm ci` (installs
> `@vimp/tanks` from the registry, which brings its already-built `dist/` —
> client/host entries, the WASM asset, maps, sounds, `manifest.json`)
> followed by `npm run build:app` (engine Vite build). The runner stage
> copies `packages/engine/dist/` and `node_modules/@vimp/tanks/dist/`; the
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
   - enter an email (for SSL notifications).

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
- **Hosting.** Deploy it once on its own domain: Steps 2–3 above
  (`install-system.sh`, then `add-server.sh`) give any domain/port Nginx +
  SSL, so they work for the auth service too. Run a two-service
  docker-compose stack instead of the master's single container:

  ```yaml
  services:
    postgres:
      image: postgres:16-alpine
      restart: always
      environment:
        POSTGRES_DB: vimp_auth
        POSTGRES_USER: vimp
        POSTGRES_PASSWORD: <secret>
      volumes:
        - pgdata:/var/lib/postgresql/data
    auth:
      image: ghcr.io/<repo>-auth:latest
      restart: always
      env_file: .env.prod
      volumes:
        - ./.keys:/app/.keys:ro
      ports:
        - '127.0.0.1:<port>:3010'
  volumes:
    pgdata:
  ```

  `.env.prod` on that host needs `VIMP_AUTH_DATABASE_URL` (pointing at the
  `postgres` service), the OAuth provider secrets
  (`VIMP_AUTH_GITHUB_CLIENT_ID`/`_SECRET`, see
  [auth.md](auth.md#running)), and three more the service refuses to start
  without in production: `VIMP_AUTH_PUBLIC_URL` (its own public origin, used
  to build the OAuth `redirect_uri` registered with the provider),
  `VIMP_AUTH_ALLOWED_ORIGINS` (CSV of master origins — CORS on `POST /nick`
  and the `returnUrl` allowlist for the OAuth redirect) and
  `VIMP_AUTH_STATE_SECRET` (HMAC secret for the OAuth `state` param). The
  RS256 key pair goes under `./.keys/` on the host (generated once —
  [auth.md](auth.md#running)); never bake it into the image or commit it.

- **Migrations.** Not run automatically on container start — apply them
  once, and again after any schema change: `docker compose exec auth node
  src/db/migrate.js`.
- **Wiring masters to it.** Set the `AUTH_SERVICE_URL` repository variable
  (Settings → Secrets and variables → Actions → Variables) to the auth
  service's public URL; `deploy.yml`'s `deploy` job writes it into every
  master's `.env.prod` as `VIMP_AUTH_SERVICE_URL` (read by
  [packages/engine/src/master/main.js](../../packages/engine/src/master/main.js),
  see [configuration.md](configuration.md#environment-variables-env)) — one
  variable, applied to every server in `SERVERS_MATRIX`.

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
Nginx, so the real auth-service origin must be substituted by hand into
the snippet below (or generated from `security.csp` and pasted into the
Nginx config).

The `install-system.sh` template already includes these headers; when
configuring manually, add them to the Nginx `server` block (or a shared
snippet):

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
