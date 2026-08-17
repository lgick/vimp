# Standalone SDK (browser)

`vimp-engine/standalone` runs a full match inside one browser tab: the
authoritative host, the client and the game plugin all live in the page. No
master server, no OAuth, no lobby screen. It exists for the *game* repository:
`npm run dev` there should open a playable match against the game's own
scripted participants.

The dedicated Node.js server is a different contour — see
[network.md](network.md) for the transports and
[deployment.md](deployment.md) for running servers.

## Quick start

Install the engine in the game repository (a normal dependency of the dev
setup) and add three files.

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>my-game — dev</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
        background: #000;
      }
      /* the SDK container must be full-screen and positioned */
      #game {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
    </style>
  </head>
  <body>
    <div id="game"></div>
    <script type="module" src="/dev/main.js"></script>
  </body>
</html>
```

`dev/main.js`:

```js
import { startStandaloneGame } from 'vimp-engine/standalone';
import hostPlugin from '../src/host/index.js';
import clientPlugin from '../src/client/index.js';
import wasmUrl from '../core/pkg/my_game_bg.wasm?url';

await startStandaloneGame({
  hostPlugin,
  clientPlugin,
  wasmUrl,
  container: document.getElementById('game'),
  assetsBase: '/assets/',
  playerName: 'dev',
  playerModel: 'm1',
  startupVotes: [['teamChange', 'team1']],
  startupCommands: ['/bot 4'],
  room: { map: 'arena', maxPlayers: 8 },
});
```

The engine stylesheet is imported by the client itself, so a bundler setup
needs nothing extra; the `vimp-engine/style.css` export exists for setups that
prefer to pull it in explicitly (`import 'vimp-engine/style.css'`).

`vite.config.js`:

```js
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // two PixiJS copies mean two extension registries and a dead renderer
    dedupe: ['pixi.js'],
  },
  optimizeDeps: {
    // the engine ships as ESM sources; pre-bundling breaks its dynamic
    // imports and the module-level boot config shared with the SDK
    exclude: ['vimp-engine'],
  },
  server: {
    // only needed with `npm link`: the linked package lives outside the root
    fs: { allow: ['..'] },
  },
});
```

## API

```js
startStandaloneGame(options): Promise<{ stop(): void }>
```

| Option | Default | Meaning |
| --- | --- | --- |
| `hostPlugin` | — | the live `HostPlugin` object (required) |
| `clientPlugin` | — | the live `ClientPlugin` object (required) |
| `wasmUrl` | — | URL of the **web** build of the game core (required) |
| `container` | `document.body` | mount point for the UI shell *and* the canvases |
| `assetsBase` | `'/'` | asset base of the game; sounds are read from `${assetsBase}sounds/` |
| `playerName` | — | set → the auth form is skipped and the player enters as a guest |
| `playerModel` | — | the `model` field of the game's `authSchema` |
| `auth` | `{}` | any other `authSchema` fields of the game |
| `startupVotes` | `[]` | answers to the initial vote, e.g. `[['teamChange', 'team1']]` |
| `startupCommands` | `[]` | game chat commands sent after the votes, e.g. `['/bot 4']` |
| `room` | `{}` | room overrides: `map`, `maxPlayers`, `roundTime`, `mapTime`, `friendlyFire`, `seed` |
| `devMode` | `false` | `room.isDevMode`: match recorder and the host `CONSOLE` log |

Both plugins are checked against `ENGINE_API_VERSION` before anything else —
a plugin built for another engine API is rejected up front instead of failing
somewhere in the middle of the handshake.

`stop()` closes the transport, which tears the match down: the render loop is
detached, the inline host is destroyed (its timers would otherwise keep
running) and sound/keyboard listeners are released.

### The container

The container must be **full-screen and positioned** (`position: relative`).
`#panel`, `#stat` and the runtime-created `#vote` are `position: absolute`,
and their containing block is the nearest positioned ancestor. The engine
builds the missing UI elements inside the container and mounts the game
canvases there as well — elements the game already put in its own markup
(`<canvas id="vimp">`, `#chat`, …) are reused as they are, never moved.

The engine also marks the container with the `vimp-shell` class: `style.css`
hides `.vimp-shell > *` so the engine's screens do not all show at once — each
of them is revealed by its own module. Nothing hides the container itself, at
any nesting depth, and the page needs no `display` rule for it. Note that the
rule is a class selector: an element of your own that sits at the container's
first level and is shown by a type or class rule (`canvas { display: block }`)
will lose to it — target it by id.

`style.css` is a page-level stylesheet, not a scoped one: importing the SDK
also gives the embedding page `html, body { width: 100%; height: 100% }`, the
engine's `body` background, color and font, and `* { user-select: none }` —
which disables text selection across the whole page, not just inside the
container. Reserve the page for the game.

### wasmUrl and assets

`wasmUrl` is the web build of the game core, imported with Vite's `?url`
suffix so the bundler emits the file and hands back its URL. The Node build
of the core (`entries.wasmNode`) is for the headless runner and the dedicated
server, not for the tab.

Sounds are looked up under `${assetsBase}sounds/`. Missing files do not block
entry: `SoundManager.init` loads them with `Promise.allSettled` and only logs
the failures.

### startupVotes before startupCommands

A player enters as a **spectator**, and a game is free to require an active
team for its commands (in tanks, `/bot` is refused to a spectator). The only
way out of the spectators is answering the initial vote, so `startupVotes`
must carry `['teamChange', '<team>']` and are always sent **before**
`startupCommands`. Both are sent on the first render tick after the first
frame arrives.

The engine has no notion of a "bot": scripted participants are spawned by a
*game* chat command declared in `hostPlugin.chatCommands` — hence
`startupCommands: ['/bot 4']` rather than a `bots: 4` option. Keep their
number within `room.maxPlayers`, or the game will refuse part of the batch.

## How solo differs from production

| | production (lobby) | standalone (solo) |
| --- | --- | --- |
| host | Web Worker in the room creator's tab | **main thread** (inline), no Worker |
| identity | OAuth via `packages/auth`, JWT verified by the host | guest: the nick comes from the form or `playerName` |
| rank / state | fetched and flushed through the master | offline stub, nothing is persisted |
| game catalog | `GET /games/manifest.json` from the master | an in-memory manifest built from the plugin |
| maps | the master's map catalog, hot updates | the maps bundled in `gameConfig` |
| transport | WebRTC (or loopback for the host-player) | loopback to the inline host |
| Worker relay on new code | yes | not applicable |

The host runs inline because a `HostPlugin` cannot cross a `postMessage`
boundary (functions are not cloneable) and the SDK is handed the live object.
The divergence between dev and production is deliberate.

A useful consequence: `solo` touches neither WebRTC nor module workers — both
are used only on lobby paths — so the game starts in a browser with WebRTC
fully disabled.

## Troubleshooting

- **Blank canvas, no errors** — two PixiJS copies. Add
  `resolve.dedupe: ['pixi.js']`.
- **The UI is stacked in the top-left corner** — the container is not
  `position: relative` or not full-screen.
- **Black screen while the match is clearly running** (sound plays, no errors)
  — an element of the container's own is covering it, or the game's CSS shows
  something at the container's first level with a rule weaker than
  `.vimp-shell > *` (see above) and the engine keeps it hidden.
- **`/bot` answers "players only"** — `startupVotes` are missing, so the
  player is still a spectator.
- **`game "<id>" requires engine API vN`** — the plugin and the installed
  `vimp-engine` are from different API generations; align the versions.
