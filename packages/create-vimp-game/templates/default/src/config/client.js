import sounds from './sounds.js';

// The game half of the client CONFIG_DATA: render entities, canvases, key
// sets, panel/stat schemas and the chat/vote texts. The engine deep-merges its
// own defaults under this object and adds `prediction` and `snapshot` itself —
// the host hands the result over through HostPlugin.buildClientGameConfig(),
// so the client never loads this file directly.
export default {
  parts: {
    // snapshot key (or map setId) -> the part classes built for it. A key
    // without an entry is a black canvas: the frame arrives and the client
    // does not know what to draw it with.
    gameSets: {
      a1: ['Actor'],
      e1: ['ShotEffect'],
      c1: ['Map'],
    },

    // part class -> canvas. This is the ONLY registration: a class listed in
    // ClientPlugin.parts and in gameSets but missing here answers
    // "Constructor for X not found." at the first frame that needs it.
    entitiesOnCanvas: {
      Map: 'vimp',
      Actor: 'vimp',
      ShotEffect: 'vimp',
    },

    // procedural textures, baked once per canvas at startup — the reason this
    // package ships no images. `name` must exist in ClientPlugin.bakers and
    // `component` names the part class that receives the result in `assets`.
    bakedAssets: {
      vimp: [
        {
          name: 'actorTexture',
          component: 'Actor',
          // white on purpose: one baked texture is tinted per team at runtime
          params: { size: 32, color: 0xffffff },
        },
      ],
    },

    // the service pool has exactly three entries — renderer, soundManager,
    // assetsBase. An unknown name is not an error: the part just gets
    // undefined and draws nothing.
    componentDependencies: {
      soundManager: ['ShotEffect'],
    },

    sounds,
  },

  // DOM ids hidden until authentication completes; 'panel' is revealed as
  // display: flex, everything else as display: block
  initIdList: ['vimp', 'panel', 'chat'],

  modules: {
    canvasManager: {
      // the engine CREATES these <canvas> elements — they are not in the HTML.
      // baseScale '2:1' means world->screen 2 at the 1920 px design width, so
      // the 768-unit arena is fully visible on a laptop.
      canvases: {
        vimp: {
          width: 960,
          height: 600,
          aspectRatio: '16:10',
          baseScale: '2:1',
          dynamicCamera: true,
          shakeCamera: true,
        },
      },
    },

    controls: {
      // [0] spectator, [1] player. The engine switches between them by the
      // KEYSET_DATA port; codes 9, 13, 27, 67 and 77 belong to the engine
      // (stat, enter, escape, chat, vote) and never reach the game.
      keySetList: [
        {
          78: 'nextPlayer', // n
          80: 'prevPlayer', // p
        },
        // every action here must be a key of gameConfig.playerKeys, and vice
        // versa: a name on one side only is a key that sends nothing
        {
          87: 'forward', // w
          83: 'back', // s
          65: 'left', // a
          68: 'right', // d
          74: 'fire', // j
        },
      ],
    },

    chat: {
      params: {
        // texts of the system message codes: the host sends 'group:index',
        // the text lives here. Groups s/v/m/c/n are the engine's — the game
        // owns 'g' (see src/host/systemMessages.js).
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
          v: [
            'A vote has been created',
            'Voting has started',
            'Your vote has been accepted',
            'Voting is temporarily unavailable',
            'Vote passed',
            'Vote failed',
          ],
          m: ['Current map: {0}', 'Next map: {0}'],
          c: ['Command not found', 'Your rank: {0}'],
          n: ['Invalid name', '{0} changed name to {1}'],
          g: ['{0} bot(s) spawned'],
        },
      },
    },

    panel: {
      // wire key (gameConfig.panel.fields[*].key) -> field name here.
      // 't' is sent by the engine itself and MUST map to a type: 'time'
      // field, or the round time never appears on the HUD.
      keys: {
        h: 'hp',
        a: 'am',
        // gameConfig.panel.activeKey — the active weapon, written by the
        // engine itself; a cell of type 'weapon' takes the .active class
        wa: 'weapon',
        t: 'time',
      },
      fields: [
        { name: 'hp', elem: 'panel-hp', type: 'bar', max: 100, blocks: 20 },
        { name: 'am', elem: 'panel-am', type: 'value' },
        { name: 'weapon', elem: 'panel-weapon', type: 'weapon' },
        { name: 'time', elem: 'panel-time', type: 'time' },
      ],
    },

    stat: {
      params: {
        // five columns, positionally matched to the host's `key` indexes —
        // the engine populates exactly these and its CSS is laid out for five
        columns: ['names', 'status', 'score', 'deaths', 'latency'],
        heads: {
          1: 'team1',
          2: 'team2',
        },
        bodies: {
          1: 'team1',
          2: 'team2',
          3: 'spectators',
        },
        // [columnIndex, descending]; sorting is numeric, a text column sorts
        // as 0
        sortList: {
          team1: [
            [2, true],
            [3, false],
          ],
          team2: [
            [2, true],
            [3, false],
          ],
        },
      },
    },

    vote: {
      params: {
        // template = [title, values?, timeOff?]; 'teams' and 'maps' are
        // substituted by the engine with the live lists
        templates: {
          teamChange: ['Choose a team', 'teams', true],
          mapChangeBySystem: ['Choose the next map'],
          mapChangeByUser: ['{0} suggested the map: {1}', ['Yes', 'No']],
        },
        menu: [
          ['teamChange', ['Switch team', 'teams']],
          ['mapChange', ['Suggest map', 'maps']],
        ],
      },
    },
  },

  // texts of the GAME_INFORM_DATA port, addressed by index
  gameInform: {
    list: ['{0} WINS!', 'ROUND START!', 'GAME OVER!'],
  },
};
