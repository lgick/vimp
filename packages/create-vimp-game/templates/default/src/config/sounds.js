// Sound registry of the client. Every entry must ship as a webm + mp3 PAIR:
// the client walks codecList and takes the first codec the browser supports,
// so a missing .mp3 breaks Safari only — i.e. never for the author.
//
// `file` is the base name in dist/sounds/ (assets/sounds/ or, after
// `npm run audio:process`, build/sounds/). Do NOT set `path`: the engine
// overwrites it with `${assetsBase}sounds/`, and a hand-written one only
// works until the game is served from the lobby.
const sounds = {
  shot: { file: 'shot', priority: 100, volume: 0.4 },
  death: { file: 'death', priority: 150, volume: 0.4 },
};

export default {
  codecList: ['webm', 'mp3'],
  sounds,
};
