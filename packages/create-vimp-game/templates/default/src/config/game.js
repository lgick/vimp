import snapshot from './snapshot.js';
import models from '../data/models.js';
import weapons from '../data/weapons.js';
import maps from '../data/maps/index.js';

// HostPlugin.gameConfig — the authoritative description of the game: what the
// engine meta needs (rounds, teams, panel, stat, room form) and what it hands
// over to the Rust core untouched (models, weapons, playerKeys, snapshot).
//
// The engine asserts nine paths right after import — roomDefaults.maxPlayers,
// snapshot, parts.models, parts.weapons, parts.friendlyFire, panel.fields,
// playerKeys, teams, spectatorTeam — plus `spectatorTeam` being a key of
// `teams`. Everything else is read lazily, which is why a typo elsewhere
// surfaces as a black canvas rather than an error: run `npm run
// check:contract` after every change here.
export default {
  title: '{{GAME_TITLE}}',

  parts: {
    models,
    weapons,
    // overridable per room through the lobby form below
    friendlyFire: false,
  },

  // the binary protocol layout; the engine passes it to both cores and to the
  // client, knowing nothing about the meaning of a field
  snapshot,

  // engine event -> name in the sound registry (src/config/sounds.js).
  // All five keys exist so that filling one in is editing a value, not
  // remembering the vocabulary; an unmapped cue is simply not sent, and the
  // template ships only the two sounds a match cannot do without.
  soundCues: {
    roundStart: null,
    victory: null,
    defeat: null,
    frag: null,
    death: 'death',
  },

  // the vote a player is offered right after their first frame: without it a
  // joining participant stays a spectator with no way to ask for a team
  initialVote: 'teamChange',

  maps,
  currentMap: 'arena',
  mapScale: 1,
  // fallback for a map without its own setId
  mapSetId: 'c1',
  mapsInVote: 1,

  // starting profile of a player with no saved record on the auth service.
  // The engine keeps it as opaque JSON — the game is the only reader
  playerState: {
    defaultState: { kills: 0, shots: 0 },
  },

  spectatorTeam: 'spectators',
  teams: {
    team1: 1,
    team2: 2,
    spectators: 3,
  },

  // bots: the name prefix the engine numbers, and the model they spawn with
  scripted: {
    namePrefix: 'Bot',
    defaultModel: 'a1',
  },

  // Action name -> bit and kind. The engine ships this table into both cores
  // verbatim and never interprets it: `type: 1` (one-shot) is a CONVENTION
  // core/src/actor.rs implements — `down` arms the bit, exactly one fixed step
  // consumes it, `up` is ignored. Every name here must have a key in
  // keySetList[1] (src/config/client.js) or it can never be pressed.
  playerKeys: {
    forward: { key: 1 << 0 },
    back: { key: 1 << 1 },
    left: { key: 1 << 2 },
    right: { key: 1 << 3 },
    fire: { key: 1 << 4, type: 1 },
  },

  // HUD, host half: `key` is the short wire key, `value` the starting amount —
  // and the same number is what the core hands the actor as health and ammo.
  // `health` is read by the core by that exact name; every other key must name
  // a weapon (the core refuses to boot otherwise).
  // The key 't' is reserved by the engine for the round time — never declare it.
  panel: {
    fields: {
      health: { key: 'h', value: 100 },
      e1: { key: 'a', value: 100 },
    },
    // Cell showing the active weapon. It is NOT a field: the engine writes
    // the weapon name into it whenever the core reports a change, and it does
    // so unconditionally — leaving this null makes the panel send the literal
    // key 'null' to every client, which nothing on the other side can render.
    activeKey: 'wa',
  },

  // Statistics table, host half. The engine writes exactly five names —
  // name, status, score, deaths, latency — and nothing else; `key` is the
  // column index on the wire, matched positionally by src/config/client.js.
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

  roomDefaults: {
    maxPlayers: 8,
  },

  // The lobby "create server" form. The names must be exactly the keys the
  // host honours (maxPlayers, map, roundTime, mapTime, friendlyFire) —
  // anything else is accepted by the form and silently dropped. Numeric
  // bounds are injected as `regExp` by scripts/build-game-manifest.js.
  roomForm: [
    {
      name: 'maxPlayers',
      control: 'text',
      label: 'Max players',
      numeric: true,
    },
    {
      name: 'roundTime',
      control: 'text',
      label: 'Round time',
      unit: 's',
      numeric: true,
    },
    {
      name: 'mapTime',
      control: 'text',
      label: 'Map time',
      unit: 's',
      numeric: true,
    },
    { name: 'friendlyFire', control: 'checkbox', label: 'Friendly fire' },
    { name: 'map', control: 'select', label: 'Map', source: 'maps' },
  ],
};
