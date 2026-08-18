// Actor classes of the game (gameConfig.parts.models). The engine passes this
// object verbatim into BOTH cores — the authoritative one and the predictor —
// so every number here is gameplay, not decoration (core/src/config.rs,
// struct ActorConfig).
//
// The key is the model name: it is the snapshot block key of the actor
// (`src/config/snapshot.js`), the value of the `model` field of the auth form
// and `gameConfig.scripted.defaultModel`. One class is enough to play; adding
// a second one is adding a key here — nothing in the core is hard-coded to a
// name.
export default {
  a1: {
    // key of `src/data/weapons.js` the actor spawns with
    currentWeapon: 'e1',

    // diameter of the body in world units (the collider is a ball of size/2)
    size: 32,

    // units per second; the reverse cap is deliberately lower — an actor that
    // backs away as fast as it charges makes every duel a stalemate
    maxSpeed: 220,
    maxReverseSpeed: 110,

    // speed gained per second while a drive key is held / lost with none
    acceleration: 520,
    braking: 700,

    // radians per second
    turnSpeed: 3.2,

    // Rapier collider parameters. restitution 0: actors that bounce off each
    // other turn a crowd into a pinball table
    fixture: {
      density: 1,
      friction: 0.2,
      restitution: 0,
    },
  },
};
