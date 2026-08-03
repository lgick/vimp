# 09 — Reference implementations

Two worked examples. **Example A** is a minimal plugin shown file by file —
every plugin-contract file in full; the two fake-core stand-ins it imports
are summarised at the end of the example. Use it as the skeleton for a new
game. **Example B** shows how the full reference game (tanks) fills the same
slots.

---

# Example A — a minimal plugin ("miniGame")

One playing team, one model, one resource (`energy`), two snapshot keys, three
input actions, no PixiJS, and a fake JS core instead of WASM. This is the
engine's own contract fixture: everything the contract truly requires and
nothing more.

## `config/game.js` — the `HostPlugin.gameConfig`

```js
export default {
  parts: {
    models: { m1: { radius: 10 } },
    weapons: {},
    friendlyFire: false,
  },

  snapshot: {
    a1: {
      id: 1,
      kind: 'indexed8',
      class: 'hot',
      fields: [
        { name: 'x',     ty: 'f32', interp: 'lerp' },
        { name: 'y',     ty: 'f32', interp: 'lerp' },
        { name: 'angle', ty: 'f32', interp: 'lerpAngle' },
        { name: 'team',  ty: 'u8' },
      ],
    },
    e1: {
      id: 2,
      kind: 'list16',
      class: 'event',
      fields: [
        { name: 'x', ty: 'f32' },
        { name: 'y', ty: 'f32' },
      ],
    },
  },

  soundCues: {},
  initialVote: 'teamChange',

  maps: {
    arena: {
      setId: 'm1',
      scale: 1,
      spriteSheet: { img: 'tiles.png', frames: [[0, 0, 32, 32]] },
      layers: { 1: [0] },
      physicsStatic: [1],
      physicsDynamic: [],
      step: 32,
      respawns: { team1: [[100, 100, 0], [200, 100, 0]] },
      map: [
        [1, 1, 1, 1],
        [1, 0, 0, 1],
        [1, 0, 0, 1],
        [1, 1, 1, 1],
      ],
    },
  },
  mapScale: 1,
  currentMap: 'arena',
  mapsInVote: 1,
  mapSetId: 'm1',

  roomDefaults: { maxPlayers: 4 },

  stat: {
    name:    { key: 0, bodyMethod: '=', headSync: true, headMethod: '#' },
    status:  { key: 1, bodyMethod: '=', bodyValue: '', headValue: '' },
    score:   { key: 2, bodyMethod: '+', bodyValue: 0, headMethod: '+', headValue: 0 },
    deaths:  { key: 3, bodyMethod: '+', bodyValue: 0, headMethod: '+', headValue: 0 },
    latency: { key: 4, bodyMethod: '=' },
  },

  panel: {
    fields: { energy: { key: 'h', value: 100 } },
    activeKey: null,
  },

  scripted: { namePrefix: 'Scripted', defaultModel: 'm1' },

  spectatorTeam: 'spectators',
  teams: { team1: 1, spectators: 2 },

  playerKeys: {
    forward: { key: 1 << 0 },
    back:    { key: 1 << 1 },
    fire:    { key: 1 << 2, type: 1 },
  },
};
```

Note how the panel field is called `energy`, not `health`: the cell's
semantics come from the **client** schema's `type`, never from the field name.

## `config/client.js` — the `buildClientGameConfig()` result

```js
export default {
  parts: {
    gameSets: { m1: ['Actor'] },
    entitiesOnCanvas: { Actor: 'vimp' },
    bakedAssets: {},
    componentDependencies: {},
    sounds: {},
  },

  initIdList: ['vimp', 'panel', 'chat'],

  modules: {
    canvasManager: {
      canvases: {
        vimp: { width: 640, height: 400, aspectRatio: '16:10',
                baseScale: '5:1', dynamicCamera: false, shakeCamera: false },
      },
    },

    controls: {
      keySetList: [
        {},                                           // [0] spectator
        { 87: 'forward', 83: 'back', 74: 'fire' },    // [1] player
      ],
    },

    chat: {
      params: {
        messages: {
          s: [
            'Team {0} is full. Your current team: {1}',
            'Your team: {0}',
            'Your new team: {0}',
            'Your new status: spectator',
            '{0} killed {1}',
            '{0} joined the game',
            '{0} left the game',
          ],
          v: ['A vote has been created', 'Voting has started',
              'Your vote has been accepted', 'Voting is temporarily unavailable',
              'Vote passed', 'Vote failed'],
          m: ['Current map: {0}', 'Next map: {0}'],
          c: ['Command not found'],
          n: ['Invalid name', '{0} changed name to {1}'],
          g: ['{0} scripted participant(s) spawned'],   // game-owned group
        },
      },
    },

    panel: {
      keys: { h: 'energy' },
      fields: [
        { name: 'energy', elem: 'panel-energy', type: 'bar', max: 100, blocks: 10 },
      ],
    },

    stat: {
      params: {
        columns: ['names', 'status', 'score', 'deaths', 'latency'],
        heads:  { 1: 'team1' },
        bodies: { 1: 'team1', 2: 'spectators' },
        sortList: { team1: [[2, true], [3, false]] },
      },
    },

    vote: {
      params: {
        templates: {
          teamChange:        ['Choose a team', 'teams', true],
          mapChangeBySystem: ['Choose the next map'],
          mapChangeByUser:   ['{0} suggested the map: {1}', ['Yes', 'No']],
        },
        menu: [
          ['teamChange', ['Switch team', 'teams']],
          ['mapChange',  ['Suggest map', 'maps']],
        ],
      },
    },
  },

  gameInform: { list: ['{0} WINS!', 'ROUND START!', 'GAME OVER!'] },
};
```

## `config/auth.js`

```js
import gameConfig from './game.js';

export default {
  elems: {
    authId: 'auth',
    fieldsId: 'auth-fields',     // NOT formId — this is the id the engine reads
    errorId: 'auth-error',
    enterId: 'auth-enter',
    titleId: 'auth-title',
    informsId: 'auth-informs',
  },
  texts: {
    title: 'Mini Game',
    sections: [
      { heading: 'Controls', lines: [
        { keys: 'W, S', text: 'move' },
        { keys: 'J', text: 'fire' },
      ] },
    ],
  },
  params: [
    { name: 'model', value: 'm1',
      options: { validator: 'isValidModel', storage: 'model' } },
  ],
  validators: {
    isValidModel: model => model in gameConfig.parts.models,
  },
};
```

## `host/index.js`

```js
import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import GameCore from './core.js';
import gameConfig from '../config/game.js';
import authSchema from '../config/auth.js';
import clientConfig from '../config/client.js';
import systemMessages from './systemMessages.js';
import spawnCommand from './spawnCommand.js';
import createModules from './createModules.js';

export default {
  id: 'miniGame',
  engineApi: ENGINE_API_VERSION,

  async createCore(coreConfigJson) {
    return new GameCore(coreConfigJson);
  },

  gameConfig,
  authSchema,
  chatCommands: [spawnCommand],
  systemMessages,
  createModules,
  buildClientGameConfig: () => clientConfig,
};
```

## `host/createModules.js`

```js
import ScriptedManager from './ScriptedManager.js';

export default function createModules(ctx) {
  return { scripted: new ScriptedManager(ctx) };
}
```

## `host/systemMessages.js`

```js
export default {
  SCRIPTED_SPAWNED: 'g:0',   // client text: '{0} scripted participant(s) spawned'
};
```

## `host/spawnCommand.js`

```js
export default {
  name: '/spawn',
  handler(ctx, gameId, args) {
    const count = Number(args[0]) || 1;
    const created = ctx.scripted.createScripted(count);

    ctx.chat.pushSystem('SCRIPTED_SPAWNED', [created]);
    ctx.roundManager.initiateNewRound();
  },
};
```

## `host/ScriptedManager.js` — the full `scripted` contract

```js
export default class ScriptedManager {
  constructor({ participants, coreAdapter, panel, stat, scripted }) {
    this._participants = participants;
    this._coreAdapter = coreAdapter;
    this._panel = panel;
    this._stat = stat;

    this._model = scripted.defaultModel;
    this._respawns = null;
  }

  createMap(mapData) {
    this._respawns = mapData.respawns;
  }

  createScripted(count, teamName = null) {
    if (!this._respawns) {
      return 0;
    }

    const playableTeams = this._participants.getPlayableTeams();
    let createdCount = 0;

    for (let i = 0; i < count; i += 1) {
      if (this._participants.isFull) {
        break;
      }

      let targetTeam = teamName;

      if (!targetTeam) {
        targetTeam = playableTeams.sort(
          (a, b) =>
            this._participants.getTeamSize(a) - this._participants.getTeamSize(b),
        )[0];
      }

      // respawns length is the hard capacity of the team
      if (
        !targetTeam ||
        !this._respawns[targetTeam] ||
        this._participants.getTeamSize(targetTeam) >=
          this._respawns[targetTeam].length
      ) {
        continue;
      }

      const gameId = this._participants.createScripted({
        team: targetTeam,
        model: this._model,
      });
      const participant = this._participants.get(gameId);

      this._stat.addUser(gameId, participant.teamId, {
        name: participant.name,
        status: 'dead',
        latency: 'SCRIPTED',
      });
      this._panel.addUser(gameId);

      createdCount += 1;
    }

    return createdCount;
  }

  removeScripted(teamName = null) {
    const toRemove = teamName
      ? this._participants.getScripted().filter(p => p.team === teamName)
      : this._participants.getScripted();

    toRemove.forEach(p => this._removeById(p.gameId));
  }

  removeOneForHuman(teamName) {
    for (const participant of this._participants.getScripted()) {
      if (participant.team === teamName) {
        this._removeById(participant.gameId);
        return true;
      }
    }

    return false;
  }

  getCountsPerTeam() {
    const counts = {};

    for (const participant of this._participants.getScripted()) {
      counts[participant.team] = (counts[participant.team] || 0) + 1;
    }

    return counts;
  }

  _removeById(gameId) {
    const participant = this._participants.get(gameId);

    if (!participant || !participant.isScripted) {
      return;
    }

    this._stat.removeUser(gameId, participant.teamId);
    this._panel.removeUser(gameId);
    this._coreAdapter.removePlayer(gameId);
    this._participants.remove(gameId);
  }
}
```

## `client/index.js`

```js
import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import ClientCore from './core.js';
import Actor from './parts/Actor.js';
import ActorRadar from './parts/ActorRadar.js';

export default {
  id: 'miniGame',
  engineApi: ENGINE_API_VERSION,

  async createClientCore(clientConfigJson) {
    return { core: new ClientCore(clientConfigJson), memory: null };
  },

  parts: { Actor, ActorRadar },
  bakers: {},
  styles: '',

  hooks: {
    onAuth(core, authData) {
      core.set_model?.(authData.model);
    },

    onPanel() {},

    onLocalAction(core, action, name, now) {
      if (action === 'down' && name === 'fire') {
        return core.try_fire?.(now) || null;
      }

      return null;
    },
  },
};
```

## `client/parts/Actor.js` — the minimal part interface

```js
export default class Actor {
  constructor(id) {
    this.id = id;
    this.destroyed = false;
  }

  update(state) {
    this.state = state;
  }

  destroy() {
    this.destroyed = true;
  }
}
```

```js
// the *shape* of a second projection of the same entity on another canvas
import Actor from './Actor.js';

export default class ActorRadar extends Actor {}
```

Note: in this minimal example `ActorRadar` is exported in `parts` but is
deliberately **not** wired up — there is no `radar` canvas, no
`entitiesOnCanvas` entry and no `gameSets` slot for it, so it is never
constructed. To make a second projection real, do all three (see the tanks
`TankRadar` wiring in Example B).

## The two `core.js` files (fixture stand-ins, summarised)

`host/index.js` and `client/index.js` above import `./core.js`. In the
fixture these are **fake JS cores** — plain classes implementing the same
method surface the WASM macros generate (the exact method lists are in
`05-wasm-core.md`):

- The **host fake** keeps actors as flat objects
  (`{ x, y, angle, team, alive, vx, vy, lastInputSeq }`) in a `Map`.
  `step(dt)` is a trivial velocity integration; `apply_input` moves on
  `forward`/`back` and pushes a `custom` event on `fire`; `spawn_actor`
  pushes a `panelSet` event (`energy: 100`); `pack_frame`/`frame_bytes` emit
  JSON-over-bytes instead of the binary codec; `body_has_events()` returns
  `false`.
- The **client fake** is a stub: `push_frame()` → `true`, `sample()` → `0`,
  `take_frames()` → `'[]'`, `my_game_id()` → `null`, the rest are no-ops.
  That is also why `createClientCore` above may return `memory: null` — the
  fixture never enters the render loop. A real plugin must return the WASM
  memory (see `04-client-plugin.md`).

They exist to prove the engine is coupled to a method surface, not to Rust.
**A real plugin ships the WASM core from `05-wasm-core.md` instead** — do
not copy the fakes into a production game.

---

# Example B — the full reference (tanks)

Same slots, production scale.

## Models (`data/models.js`)

```js
export default {
  m1: {
    constructor: 'Tank',
    currentWeapon: 'w1',
    size: 2,                       // aspect 4:3 → width size*4, height size*3
    accelerationFactor: 1000,
    brakingFactor: 10,
    maxForwardSpeed: 260,          // units/s
    maxReverseSpeed: -130,
    baseTurnTorqueFactor: 215,
    damping: { linear: 3, angular: 100.0 },
    fixture: { density: 200, friction: 0.5, restitution: 0.1 },
    lateralGrip: 20,
    // …
  },
};
```

## Weapons (`data/weapons.js`)

```js
export default {
  w1: {
    type: 'hitscan',
    impulseMagnitude: 5000,
    damage: 40,
    range: 1500,
    fireRate: 0.01,               // cooldown in SECONDS (0 = none)
    spread: 0,                    // radians
    consumption: 1,               // ammo per shot
    cameraShake: { intensity: 20, duration: 200 },
  },
  w2: {
    type: 'explosive',
    constructor: 'Bomb',
    time: 300,
    shotOutcomeId: 'w2e',         // snapshot key used for the detonation event
    size: 8,
    fireRate: 0.1,
    damage: 70,
    radius: 50,
    impulseMagnitude: 2000000,
    cameraShake: { intensity: 30, duration: 400 },
  },
};
```

`type` values (`hitscan`, `explosive`) are **your** vocabulary — the engine
does not interpret them; your Rust core does. Ammo counts are not here: the
starting ammo is the `value` of the matching `panel.fields` entry.

## Snapshot schema (`config/snapshot.js`)

```js
export default {
  m1: {
    id: 1, kind: 'indexed8', class: 'hot',
    fields: [
      { name: 'x',           ty: 'f32', interp: 'lerp' },
      { name: 'y',           ty: 'f32', interp: 'lerp' },
      { name: 'angle',       ty: 'f32', interp: 'lerpAngle' },
      { name: 'gunRotation', ty: 'f32', interp: 'lerpAngle' },
      { name: 'vx',          ty: 'f32', interp: 'lerp' },
      { name: 'vy',          ty: 'f32', interp: 'lerp' },
      { name: 'engineLoad',  ty: 'f32', interp: 'lerp' },
      { name: 'condition',   ty: 'u8' },
      { name: 'size',        ty: 'u8' },
      { name: 'team',        ty: 'u8' },
    ],
  },
  // w1 (tracers) — list16 event; w2 (bombs) — indexed32 event;
  // w2e (explosions) — list16 event; c1/c2 — map construction sets
};
```

Note the file's own warning: field order and `interp` are positionally bound
to the Rust row structs, and validation only checks the count and types.

## Sounds (`config/sounds.js`)

```js
const sounds = {
  roundStart: { file: 'round-start', priority: 200, volume: 0.3 },
  victory:    { file: 'victory',     priority: 200, volume: 0.3 },
  defeat:     { file: 'defeat',      priority: 200, volume: 0.3 },
  frag:       { file: 'frag',        priority: 150, volume: 0.3 },
  gameOver:   { file: 'game-over',   priority: 150, volume: 0.3 },
  shot:       { file: 'shot',        priority: 100, volume: 0.4 },
  explosion:  { file: 'explosion',   priority: 100, volume: 0.4 },
  tankEngine: { file: 'tank-engine', priority: 50, loop: true, volume: 0.5 },
};
```

Priorities are a ranking device, not volumes: louder-mattering sounds get a
higher number so they survive the 30-voice cull.

## Client config highlights (`config/client.js`)

```js
parts: {
  gameSets: {
    c1: ['Map', 'MapRadar'],       // map set with a radar projection
    c2: ['Map'],                   // map set without one
    m1: ['Tank', 'TankRadar', 'Smoke', 'Tracks'],
    w1: ['ShotEffect'],
    w2: ['Bomb'],
    w2e: ['ExplosionEffect'],
  },
  entitiesOnCanvas: {
    Map: 'vimp', MapRadar: 'radar', TankRadar: 'radar', Tank: 'vimp',
    ShotEffect: 'vimp', Bomb: 'vimp', ExplosionEffect: 'vimp',
    Smoke: 'vimp', Tracks: 'vimp',
  },
  bakedAssets: {
    vimp: [
      { name: 'explosionTexture', component: 'ExplosionEffect',
        params: { radius: 50, blur: 2, color: 0xffffff } },
      { name: 'impactParticleTexture', component: 'ShotEffect',
        params: { radius: 4, blur: 1, color: 0xffffff } },
    ],
  },
  componentDependencies: {
    renderer:     ['Map'],
    soundManager: ['ExplosionEffect', 'ShotEffect', 'Bomb', 'Tank'],
  },
  sounds,
},

initIdList: ['vimp', 'radar', 'panel', 'chat'],

modules: {
  canvasManager: {
    canvases: {
      vimp:  { width: 960, height: 600, aspectRatio: '16:9',
               baseScale: '5:1', dynamicCamera: true, shakeCamera: true },
      radar: { width: 150, height: 150, fixSize: '150', baseScale: '1:8' },
    },
  },
  controls: {
    keySetList: [
      { 78: 'nextPlayer', 80: 'prevPlayer' },
      { 87: 'forward', 83: 'back', 65: 'left', 68: 'right',
        85: 'gunCenter', 75: 'gunLeft', 76: 'gunRight',
        74: 'fire', 78: 'nextWeapon', 80: 'prevWeapon' },
    ],
  },
},
```

## Room form (`config/game.js`)

```js
roomForm: [
  { name: 'maxPlayers', control: 'text',     label: 'Max players', numeric: true },
  { name: 'roundTime',  control: 'text',     label: 'Round time', unit: 's', numeric: true },
  { name: 'mapTime',    control: 'text',     label: 'Map time',   unit: 's', numeric: true },
  { name: 'friendlyFire', control: 'checkbox', label: 'Friendly fire' },
  { name: 'map',        control: 'select',   label: 'Map', source: 'maps' },
],
```

`default` is deliberately absent — the engine seeds it from `roomDefaults`.
`regExp` is absent too — the manifest generator computes it from the real
clamp bounds.

## A part (`client/parts/Tank.js`)

```js
import { Container, Sprite } from 'pixi.js';
import { lerp, clamp } from 'vimp-engine/lib/math.js';

export default class Tank extends Container {
  constructor(data, assets, dependencies) { … }
  update(data) { … }
  destroy(options) { … }
}
```

The engine's `lib/math.js` (`lerp`, `clamp`, …) is importable from a plugin;
`pixi.js` resolves to the engine's shared instance.

## A baker (`client/bakers/bombTexture.js`)

```js
import { Graphics, Rectangle } from 'pixi.js';

export default function bombTexture(params, renderer) {
  const { colorOuter, colorInner } = params;
  const graphics = new Graphics();
  const size = 20;
  const borderWidth = 1;

  graphics.rect(0, 0, size, size).fill(colorOuter);
  graphics
    .rect(borderWidth, borderWidth, size - borderWidth * 2, size - borderWidth * 2)
    .fill(colorInner);

  const texture = renderer.generateTexture({
    target: graphics,
    frame: new Rectangle(0, 0, size, size),
  });

  graphics.destroy(true);

  return texture;
}
```

## A chat command with a vote (`host/botCommand.js`)

```js
function initiateBotVote(ctx, gameId, count, team) {
  const userName = ctx.participants.get(gameId).name;
  const voteCategory = 'botManagement';

  if (!ctx.voteCoordinator.canCreateVote(voteCategory, gameId)) {
    return;
  }

  const voteName = count > 0 ? 'createBots' : 'removeBots';
  const payload = { name: voteName, params: [userName, count] };
  const userList = ctx.participants
    .getHumans()
    .map(u => u.gameId)
    .filter(id => id !== gameId);        // the proposer does not vote

  ctx.voteCoordinator.createVote({
    voteName, voteCategory, payload, userList, gameId,
    resultFunc: result => { /* apply or drop */ },
  });
}
```

## Game system messages (`host/systemMessages.js`)

```js
export default {
  BOT_PLAYERS_ONLY:      'b:0',   // Only active players can use /bot
  BOT_INVALID_COUNT:     'b:1',
  BOT_INVALID_TEAM:      'b:2',
  BOT_CREATED_FOR_TEAM:  'b:3',   // {0} bot(s) created for {1}
  BOT_REMOVED_FROM_TEAM: 'b:4',
  BOT_CREATED:           'b:5',
  BOT_REMOVED:           'b:6',
};
```

Group `b` is free; `s`, `v`, `m`, `c`, `n` are the engine's.

## Rust core layout

```
core/src/
├─ lib.rs            # GameCore/ClientCore structs + export_*_abi! macros
├─ config.rs         # the `game` half of the init JSON
├─ tanks.rs          # TanksSim: impl GameSim
├─ tank.rs           # actor: spawn, damage, vitals
├─ motion.rs         # movement math — SHARED by sim and predictor
├─ bomb.rs           # explosive weapon
├─ body_tag.rs       # u128 body tags, kinds numbered from 2
├─ bots/             # AI controller driven by on_ai_tick
└─ client/
   ├─ mod.rs         # ClientState glue: impl GameClientDef
   ├─ predictor.rs   # local prediction + parity tests
   └─ shot.rs        # local shot spawn, duplicate suppression
```

`motion.rs` being shared is what makes the parity test meaningful: the
predictor and the authoritative sim call the same function.
