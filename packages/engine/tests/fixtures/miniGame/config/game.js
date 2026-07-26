// Игровая конфигурация фикстуры «миниигра» (Этап 7 плана отделения
// движка — HostPlugin.gameConfig): нарочно минимальна и структурно
// отличается от vimp-tanks/src/config/game.js — доказывает, что
// движковая мета (Panel/Stat/RoundManager/ParticipantManager/
// CommandProcessor) настраивается произвольной схемой, а не только
// схемой танков. Одна играющая команда (team1) вместо двух у танков —
// проверка нижней границы настраиваемости Stat/RoundManager.
export default {
  parts: {
    models: { m1: { radius: 10 } },
    weapons: {},
    friendlyFire: false,
  },

  // собственная снапшот-схема (нарочно не танковая: один hot-ключ актора
  // с 4 полями и один event-ключ) — движок обязан работать с любой
  // раскладкой из gameConfig.snapshot, а не только m1/w1/…/c2
  snapshot: {
    a1: {
      id: 1,
      kind: 'indexed8',
      class: 'hot',
      fields: [
        { name: 'x', ty: 'f32', interp: 'lerp' },
        { name: 'y', ty: 'f32', interp: 'lerp' },
        { name: 'angle', ty: 'f32', interp: 'lerpAngle' },
        { name: 'team', ty: 'u8' },
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
      respawns: {
        team1: [
          [100, 100, 0],
          [200, 100, 0],
        ],
      },
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

  roomDefaults: {
    maxPlayers: 4,
  },

  // RoundManager/RTTManager (движковые) обновляют status/score/deaths/latency
  // безусловно (не через схему) — поэтому набор колонок такой же, как у
  // танков; отличие фикстуры — ОДНА играющая команда (см. teams ниже)
  stat: {
    name: {
      key: 0,
      bodyMethod: '=',
      headSync: true,
      headMethod: '#',
    },
    status: {
      key: 1,
      bodyMethod: '=',
      bodyValue: '',
      headValue: '',
    },
    score: {
      key: 2,
      bodyMethod: '+',
      bodyValue: 0,
      headMethod: '+',
      headValue: 0,
    },
    deaths: {
      key: 3,
      bodyMethod: '+',
      bodyValue: 0,
      headMethod: '+',
      headValue: 0,
    },
    latency: {
      key: 4,
      bodyMethod: '=',
    },
  },

  panel: {
    // поле нарочно не health (Д2): семантику ячейки клиенту задаёт
    // type в схеме client.js, а не имя поля
    fields: {
      energy: {
        key: 'h',
        value: 100,
      },
    },
    activeKey: null,
  },

  scripted: {
    namePrefix: 'Scripted',
    defaultModel: 'm1',
  },

  spectatorTeam: 'spectators',

  teams: {
    team1: 1,
    spectators: 2,
  },

  playerKeys: {
    forward: {
      key: 1 << 0,
    },
    back: {
      key: 1 << 1,
    },
    fire: {
      key: 1 << 2,
      type: 1,
    },
  },
};
