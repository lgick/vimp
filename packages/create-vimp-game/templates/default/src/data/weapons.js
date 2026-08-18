// Weapons of the game (gameConfig.parts.weapons) — the same object reaches
// the authoritative core and the predictor (core/src/config.rs, struct
// WeaponConfig).
//
// The key is the weapon name, and the core names the tracer snapshot block
// after it: `e1` here is the `e1` block of `src/config/snapshot.js`. It is
// also the panel field holding the ammo (`src/config/game.js`) — the core
// validates that pairing at construction and refuses to boot without it.
export default {
  e1: {
    // hitscan: the ray is cast on the same step the trigger is consumed, so
    // there is no projectile body and no contact handling in the core
    damage: 25,

    // ray length in world units — a bit less than the long side of the arena,
    // so the map itself limits the duel range
    range: 620,

    // SECONDS between shots (the client predictor multiplies by 1000 itself)
    fireRate: 0.35,

    // radians of random spread; it goes through the engine Rng on both sides,
    // never through Math.random — determinism is what makes a replay and a
    // host handoff reproduce the same match
    spread: 0.03,

    // ammo spent per shot; the pool is the panel value of this key
    consumption: 1,

    // the victim's canvas shakes on a hit (needs shakeCamera on the canvas,
    // `src/config/client.js`)
    cameraShake: {
      intensity: 4,
      duration: 200,
    },
  },
};
