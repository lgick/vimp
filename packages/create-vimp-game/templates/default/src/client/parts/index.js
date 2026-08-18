import Map from './Map.js';
import Actor from './Actor.js';
import ShotEffect from './ShotEffect.js';

// ClientPlugin.parts: class name -> class. The names are the ones
// parts.gameSets and parts.entitiesOnCanvas use (src/config/client.js) —
// all three lists must agree, and entitiesOnCanvas is the one that actually
// registers a class with the factory.
export default {
  Map,
  Actor,
  ShotEffect,
};
