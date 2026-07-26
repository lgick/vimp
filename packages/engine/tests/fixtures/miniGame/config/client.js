// Игровая половина клиентского CONFIG_DATA (HostPlugin.buildClientGameConfig,
// PLAN.md §3.5) — зеркало vimp-tanks/src/config/client.js, минимальная
// схема: одно полотно, одна колонка статистики сверх имени, один keySet.
export default {
  parts: {
    gameSets: {
      m1: ['Actor'],
    },
    entitiesOnCanvas: {
      Actor: 'vimp',
    },
    bakedAssets: {},
    componentDependencies: {},
    sounds: {},
  },

  initIdList: ['vimp', 'panel', 'chat'],

  modules: {
    canvasManager: {
      canvases: {
        vimp: {
          width: 640,
          height: 400,
          aspectRatio: '16:10',
          baseScale: '5:1',
          dynamicCamera: false,
          shakeCamera: false,
        },
      },
    },

    controls: {
      keySetList: [
        // spectator keyset (пусто — у фикстуры нет наблюдательных команд)
        {},
        // player keyset
        {
          87: 'forward', // forward (w)
          83: 'back', // back (s)
          74: 'fire', // fire (j)
        },
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
          v: [
            'A vote has been created',
            'Voting has started',
            'Your vote has been accepted',
            'Voting is temporarily unavailable',
            'Vote passed',
            'Vote failed',
          ],
          m: ['Current map: {0}', 'Next map: {0}'],
          c: ['Command not found'],
          n: ['Invalid name', '{0} changed name to {1}'],
          g: ['{0} scripted participant(s) spawned'],
        },
      },
    },

    panel: {
      // поле нарочно называется не health: бар обязан работать по
      // type: 'bar', а не по имени поля (Д2)
      keys: {
        h: 'energy',
      },
      fields: [
        {
          name: 'energy',
          elem: 'panel-energy',
          type: 'bar',
          max: 100,
          blocks: 10,
        },
      ],
    },

    stat: {
      params: {
        columns: ['names', 'status', 'score', 'deaths', 'latency'],
        heads: {
          1: 'team1',
        },
        bodies: {
          1: 'team1',
          2: 'spectators',
        },
        sortList: {
          team1: [
            [2, true],
            [3, false],
          ],
        },
      },
    },

    vote: {
      params: {
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

  gameInform: {
    list: ['{0} WINS!', 'ROUND START!', 'GAME OVER!'],
  },
};
